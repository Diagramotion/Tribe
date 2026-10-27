use serde::Serialize;

#[cfg(target_os = "macos")]
const MAX_CAPTURE_EDGE: u32 = 2_200;
#[cfg(target_os = "macos")]
const MAX_CAPTURE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NativeCaptureResult {
    #[cfg(target_os = "macos")]
    Captured {
        #[serde(rename = "imageBase64")]
        image_base64: String,
        application: String,
        #[serde(rename = "windowTitle")]
        window_title: String,
        #[serde(rename = "accessibilityText")]
        accessibility_text: String,
    },
    #[cfg(target_os = "macos")]
    Cancelled,
    Unsupported,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccessStatus {
    platform: &'static str,
    screen_capture: CapabilityStatus,
    accessibility: CapabilityStatus,
    adapter_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityStatus {
    permission: &'static str,
    detail: &'static str,
}

#[tauri::command]
pub fn probe_desktop_access() -> DesktopAccessStatus {
    platform_status()
}

#[tauri::command]
pub async fn capture_selected_window() -> Result<NativeCaptureResult, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::capture_selected_window().await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(NativeCaptureResult::Unsupported)
    }
}

#[tauri::command]
pub fn open_desktop_privacy_settings(capability: String) -> Result<(), String> {
    let uri = match privacy_settings_uri(&capability) {
        Some(uri) => uri,
        None => return Err("Privacy settings are not available for this capability.".into()),
    };

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(uri)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open System Settings: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = uri;
        Err("Direct privacy settings links are not available on this platform.".into())
    }
}

fn privacy_settings_uri(capability: &str) -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        match capability {
            "screen_capture" => Some(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            ),
            "accessibility" => Some(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            ),
            _ => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = capability;
        None
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_capture_status(supported: Option<bool>) -> CapabilityStatus {
    match supported {
        Some(true) => CapabilityStatus {
            permission: "user_selection_required",
            detail: "Windows supports capture on this device. A window must be selected in the system picker before capture can begin.",
        },
        Some(false) => CapabilityStatus {
            permission: "unsupported",
            detail: "Windows reports that screen capture is not supported on this device.",
        },
        None => CapabilityStatus {
            permission: "unknown",
            detail: "Tribe could not check whether this device supports screen capture.",
        },
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{NativeCaptureResult, MAX_CAPTURE_BYTES, MAX_CAPTURE_EDGE};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use screencapturekit::{
        async_api::AsyncSCContentSharingPicker,
        content_sharing_picker::{
            SCContentSharingPicker, SCContentSharingPickerConfiguration,
            SCContentSharingPickerMode, SCPickerOutcome,
        },
        screenshot_manager::{CGImageExt, SCScreenshotManager},
        stream::configuration::SCStreamConfiguration,
    };

    pub async fn capture_selected_window() -> Result<NativeCaptureResult, String> {
        if !SCContentSharingPicker::is_available() {
            return Ok(NativeCaptureResult::Unsupported);
        }

        let mut configuration = SCContentSharingPickerConfiguration::new()
            .map_err(|error| format!("Window picker is unavailable: {error}"))?;
        configuration.set_allowed_picker_modes(&[SCContentSharingPickerMode::SingleWindow]);
        configuration.set_allows_changing_selected_content(false);

        let picker = AsyncSCContentSharingPicker::show(&configuration).await;
        let selection = match picker {
            SCPickerOutcome::Picked(selection) => selection,
            SCPickerOutcome::Cancelled => return Ok(NativeCaptureResult::Cancelled),
            SCPickerOutcome::Error(error) => return Err(format!("Window picker failed: {error}")),
        };

        let (source_width, source_height) = selection.pixel_size();
        if source_width == 0 || source_height == 0 {
            return Err("The selected window has no capturable image.".into());
        }
        let scale = (MAX_CAPTURE_EDGE as f64 / source_width.max(source_height) as f64).min(1.0);
        let width = (source_width as f64 * scale).round().max(1.0) as u32;
        let height = (source_height as f64 * scale).round().max(1.0) as u32;
        let stream_configuration = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height);
        let image = SCScreenshotManager::capture_image(&selection.filter(), &stream_configuration)
            .map_err(|error| format!("Could not capture the selected window: {error}"))?;
        let rgba = image.rgba_data()
            .map_err(|error| format!("Could not read the selected window image: {error}"))?;
        let png = encode_png(width, height, &rgba)?;
        if png.len() > MAX_CAPTURE_BYTES {
            return Err("The selected window image is too large to send safely.".into());
        }

        Ok(NativeCaptureResult::Captured {
            image_base64: STANDARD.encode(png),
            application: "Selected window".into(),
            window_title: "Chosen in the system picker".into(),
            accessibility_text: String::new(),
        })
    }

    fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "Selected window dimensions are too large.".to_string())?;
        if rgba.len() != expected {
            return Err("The selected window image has an unexpected pixel layout.".into());
        }

        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|error| format!("Could not encode the selected window: {error}"))?;
            writer.write_image_data(rgba)
                .map_err(|error| format!("Could not encode the selected window: {error}"))?;
        }
        Ok(bytes)
    }
}

#[cfg(target_os = "macos")]
fn platform_status() -> DesktopAccessStatus {
    let screen_capture_granted = unsafe { CGPreflightScreenCaptureAccess() };
    let accessibility_granted = unsafe { AXIsProcessTrusted() };
    DesktopAccessStatus {
        platform: "macos",
        screen_capture: CapabilityStatus {
            permission: if screen_capture_granted {
                "granted"
            } else {
                "required"
            },
            detail: "Screen Recording access is required to inspect a selected window.",
        },
        accessibility: CapabilityStatus {
            permission: if accessibility_granted {
                "granted"
            } else {
                "required"
            },
            detail: "Accessibility access is required to read app controls.",
        },
        adapter_available: screencapturekit::content_sharing_picker::SCContentSharingPicker::is_available(),
    }
}

#[cfg(test)]
mod tests {
    use super::{privacy_settings_uri, probe_desktop_access, windows_capture_status};

    #[test]
    fn permission_probe_reports_picker_availability_separately_from_permissions() {
        let status = probe_desktop_access();

        #[cfg(target_os = "macos")]
        {
            assert_eq!(status.platform, "macos");
            assert_eq!(
                status.adapter_available,
                screencapturekit::content_sharing_picker::SCContentSharingPicker::is_available()
            );
            assert!(matches!(
                status.screen_capture.permission,
                "granted" | "required"
            ));
            assert!(matches!(
                status.accessibility.permission,
                "granted" | "required"
            ));
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(status.platform, "windows");
            assert!(!status.adapter_available);
            assert_eq!(status.screen_capture.permission, "user_selection_required");
            assert_eq!(status.accessibility.permission, "not_required");
        }
    }

    #[test]
    fn privacy_settings_links_are_allowlisted() {
        #[cfg(target_os = "macos")]
        {
            assert!(privacy_settings_uri("screen_capture").is_some());
            assert!(privacy_settings_uri("accessibility").is_some());
        }
        assert!(privacy_settings_uri("anything_else").is_none());
    }

    #[test]
    fn windows_capture_probe_distinguishes_support_from_picker_selection() {
        assert_eq!(
            windows_capture_status(Some(true)).permission,
            "user_selection_required"
        );
        assert_eq!(windows_capture_status(Some(false)).permission, "unsupported");
        assert_eq!(windows_capture_status(None).permission, "unknown");
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "windows")]
fn platform_status() -> DesktopAccessStatus {
    use windows::Graphics::Capture::GraphicsCaptureSession;

    let capture_supported = GraphicsCaptureSession::IsSupported().ok();
    DesktopAccessStatus {
        platform: "windows",
        screen_capture: windows_capture_status(capture_supported),
        accessibility: CapabilityStatus {
            permission: "not_required",
            detail: "Windows has no general UI Automation privacy prompt; access still depends on the target app and its security level.",
        },
        adapter_available: false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_status() -> DesktopAccessStatus {
    DesktopAccessStatus {
        platform: std::env::consts::OS,
        screen_capture: CapabilityStatus {
            permission: "unsupported",
            detail: "Desktop access is not supported on this platform.",
        },
        accessibility: CapabilityStatus {
            permission: "unsupported",
            detail: "Desktop access is not supported on this platform.",
        },
        adapter_available: false,
    }
}
