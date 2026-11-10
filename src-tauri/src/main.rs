use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

mod computer_use;

const RUNTIME_PORT: u16 = 4317;

struct RuntimeProcess {
    child: Mutex<Option<CommandChild>>,
    exit_requested: AtomicBool,
    terminated: Arc<AtomicBool>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            computer_use::probe_desktop_access,
            computer_use::open_desktop_privacy_settings,
            computer_use::capture_selected_window
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.manage(RuntimeProcess {
                    child: Mutex::new(None),
                    exit_requested: AtomicBool::new(false),
                    terminated: Arc::new(AtomicBool::new(true)),
                });
                return Ok(());
            }
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let sidecar = app.shell().sidecar("tribe-runtime")?;
            let agent_dir = app.path().resource_dir()?.join("agents");
            let (mut events, child) = sidecar
                .env("TRIBE_DATA_DIR", data_dir.as_os_str())
                .env("TRIBE_AGENT_DIR", agent_dir.as_os_str())
                .env("TRIBE_PORT", runtime_port().to_string())
                .set_process_group(true)
                .spawn()
                .map_err(|error| {
                    eprintln!("Tribe runtime sidecar failed to start: {error}");
                    error
                })?;
            let terminated = Arc::new(AtomicBool::new(false));
            let monitor = Arc::clone(&terminated);
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Error(error) => eprintln!("Tribe runtime: {error}"),
                        CommandEvent::Terminated(_) => {
                            monitor.store(true, Ordering::Release);
                        }
                        _ => {}
                    }
                }
                monitor.store(true, Ordering::Release);
            });
            app.manage(RuntimeProcess {
                child: Mutex::new(Some(child)),
                exit_requested: AtomicBool::new(false),
                terminated,
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialise Tribe desktop")
        .run(|app, event| match event {
            RunEvent::ExitRequested { code, api, .. } => {
                if let Some(process) = app.try_state::<RuntimeProcess>() {
                    let has_child = process
                        .child
                        .lock()
                        .map(|child| child.is_some())
                        .unwrap_or(false);
                    let terminated = process.terminated.load(Ordering::Acquire);
                    if should_shutdown_runtime(has_child, terminated) {
                        api.prevent_exit();
                        if !process.exit_requested.swap(true, Ordering::AcqRel) {
                            let app = app.clone();
                            let terminated = Arc::clone(&process.terminated);
                            let code = code.unwrap_or(0);
                            thread::spawn(move || {
                                request_runtime_shutdown(runtime_port());
                                let deadline = Instant::now() + Duration::from_secs(15);
                                while !terminated.load(Ordering::Acquire)
                                    && Instant::now() < deadline
                                {
                                    thread::sleep(Duration::from_millis(50));
                                }
                                if !terminated.load(Ordering::Acquire) {
                                    if let Some(process) = app.try_state::<RuntimeProcess>() {
                                        if let Ok(mut child) = process.child.lock() {
                                            if let Some(child) = child.take() {
                                                let _ = child.kill();
                                            }
                                        }
                                    }
                                }
                                app.exit(code);
                            });
                        }
                    }
                }
            }
            RunEvent::Exit => {
                if let Some(process) = app.try_state::<RuntimeProcess>() {
                    let has_child = process
                        .child
                        .lock()
                        .map(|child| child.is_some())
                        .unwrap_or(false);
                    let terminated = process.terminated.load(Ordering::Acquire);
                    if should_shutdown_runtime(has_child, terminated)
                        && !process.exit_requested.swap(true, Ordering::AcqRel)
                    {
                        request_runtime_shutdown(runtime_port());
                        let deadline = Instant::now() + Duration::from_secs(15);
                        while !process.terminated.load(Ordering::Acquire)
                            && Instant::now() < deadline
                        {
                            thread::sleep(Duration::from_millis(50));
                        }
                        if !process.terminated.load(Ordering::Acquire) {
                            if let Ok(mut child) = process.child.lock() {
                                if let Some(child) = child.take() {
                                    let _ = child.kill();
                                }
                            }
                        } else if let Ok(mut child) = process.child.lock() {
                            child.take();
                        }
                    }
                }
            }
            _ => {}
        });
}

fn runtime_port() -> u16 {
    std::env::var("TRIBE_RUNTIME_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(RUNTIME_PORT)
}

fn should_shutdown_runtime(has_child: bool, terminated: bool) -> bool {
    has_child && !terminated
}

fn request_runtime_shutdown(port: u16) {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let request = format!(
                "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: tauri://localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut response = [0_u8; 256];
                if let Ok(size) = stream.read(&mut response) {
                    if shutdown_accepted(&response[..size]) {
                        return;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn shutdown_accepted(response: &[u8]) -> bool {
    std::str::from_utf8(response)
        .ok()
        .and_then(|text| text.lines().next())
        .and_then(|status| status.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        == Some(202)
}

#[cfg(test)]
mod tests {
    use super::{should_shutdown_runtime, shutdown_accepted};

    #[test]
    fn accepts_shutdown_status_independent_of_http_version() {
        assert!(shutdown_accepted(b"HTTP/1.0 202 Accepted\r\n"));
        assert!(shutdown_accepted(b"HTTP/1.1 202 Accepted\r\n"));
        assert!(!shutdown_accepted(b"HTTP/1.0 400 Bad Request\r\n"));
        assert!(!shutdown_accepted(b"not an HTTP status\r\n"));
    }

    #[test]
    fn only_shuts_down_a_live_runtime_child_owned_by_this_app() {
        assert!(should_shutdown_runtime(true, false));
        assert!(!should_shutdown_runtime(false, false));
        assert!(!should_shutdown_runtime(true, true));
    }
}
