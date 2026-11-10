from __future__ import annotations

import http.server
import tempfile
import threading
import unittest
from pathlib import Path
from runpy import run_path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
resolve_target = run_path(str(ROOT / "scripts" / "package-runtime.py"))["resolve_target"]
verify_bundles = run_path(str(ROOT / "scripts" / "verify-desktop-bundles.py"))["verify_bundles"]
verify_desktop_main = run_path(str(ROOT / "scripts" / "verify-desktop-bundles.py"))["main"]
verify_windows_installer_contents = run_path(
    str(ROOT / "scripts" / "verify-desktop-bundles.py")
)["verify_windows_installer_contents"]
smoke_windows_app_lifecycle = run_path(
    str(ROOT / "scripts" / "verify-desktop-bundles.py")
)["smoke_windows_app_lifecycle"]
smoke_macos_app_lifecycle = run_path(
    str(ROOT / "scripts" / "verify-desktop-bundles.py")
)["smoke_macos_app_lifecycle"]
request_sidecar_shutdown = run_path(
    str(ROOT / "scripts" / "verify-desktop-bundles.py")
)["_request_sidecar_shutdown"]
smoke_runtime = run_path(str(ROOT / "scripts" / "smoke-runtime.py"))
default_executable = smoke_runtime["default_executable"]
shutdown_runtime = smoke_runtime["shutdown_runtime"]


class SidecarTargetTests(unittest.TestCase):
    def test_accepts_native_macos_and_windows_targets(self) -> None:
        self.assertEqual(
            resolve_target("aarch64-apple-darwin", None, "Darwin", "arm64"),
            "aarch64-apple-darwin",
        )
        self.assertEqual(
            resolve_target("x86_64-pc-windows-msvc", None, "Windows", "AMD64"),
            "x86_64-pc-windows-msvc",
        )

    def test_rejects_cross_compilation_and_mismatched_hosts(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "cannot target"):
            resolve_target("x86_64-apple-darwin", "aarch64-apple-darwin", "Darwin", "x86_64")
        with self.assertRaisesRegex(RuntimeError, "does not match the Windows build host"):
            resolve_target("aarch64-apple-darwin", None, "Windows", "arm64")
        with self.assertRaisesRegex(RuntimeError, "does not match the x86_64 Python runtime"):
            resolve_target("aarch64-apple-darwin", None, "Darwin", "x86_64")


class DesktopBundleTests(unittest.TestCase):
    def test_macos_smoke_uses_runtime_inside_the_app_bundle(self) -> None:
        self.assertEqual(
            default_executable(ROOT, "aarch64-apple-darwin"),
            ROOT / "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Tribe.app/Contents/MacOS/tribe-runtime",
        )

    def test_windows_smoke_uses_the_native_sidecar(self) -> None:
        self.assertEqual(
            default_executable(ROOT, "x86_64-pc-windows-msvc"),
            ROOT / "src-tauri/binaries/tribe-runtime-x86_64-pc-windows-msvc.exe",
        )

    def test_macos_bundle_must_contain_app_and_runtime_executables(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-macos-bundle-") as directory:
            root = Path(directory)
            app = root / "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Tribe.app/Contents/MacOS"
            app.mkdir(parents=True)
            (app / "tribe").write_bytes(b"app")
            (app / "tribe-runtime").write_bytes(b"runtime")
            self.assertEqual(
                verify_bundles(root, "aarch64-apple-darwin"),
                [app.parent.parent],
            )

    def test_macos_app_lifecycle_launches_bundle_and_requests_app_level_quit(self) -> None:
        import plistlib

        class Process:
            returncode = None

            def poll(self) -> int | None:
                return self.returncode

            def wait(self, timeout: int) -> int:
                self.returncode = 0
                return 0

            def terminate(self) -> None:
                self.returncode = -15

            def kill(self) -> None:
                self.returncode = -9

        with tempfile.TemporaryDirectory(prefix="tribe-macos-lifecycle-") as directory:
            app = Path(directory) / "Tribe.app"
            contents = app / "Contents"
            executable = contents / "MacOS" / "tribe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"app")
            with (contents / "Info.plist").open("wb") as info:
                plistlib.dump({"CFBundleIdentifier": "dev.tribe.desktop"}, info)

            process = Process()
            listener = Mock()
            listener.__enter__ = Mock(return_value=listener)
            listener.__exit__ = Mock(return_value=False)
            listener.connect_ex.return_value = 1
            with (
                patch("socket.socket", return_value=listener),
                patch("subprocess.Popen", return_value=process) as launch,
                patch("subprocess.run") as quit_app,
                patch("time.sleep"),
                patch(
                    "urllib.request.urlopen",
                    side_effect=AssertionError("health checks are patched below"),
                ),
                patch.dict(
                    smoke_macos_app_lifecycle.__globals__,
                    {"_runtime_is_healthy": Mock(side_effect=[False, True, False, False, False])},
                ),
            ):
                smoke_macos_app_lifecycle(app)

            launch.assert_called_once()
            self.assertEqual(launch.call_args.args[0], [str(executable)])
            quit_app.assert_called_once_with(
                ["/usr/bin/osascript", "-e", 'tell application id "dev.tribe.desktop" to quit'],
                check=True, timeout=15, stdout=-3, stderr=-3,
            )
            self.assertEqual(process.returncode, 0)

    def test_macos_app_lifecycle_rejects_invalid_bundle_identifier(self) -> None:
        import plistlib

        with tempfile.TemporaryDirectory(prefix="tribe-macos-invalid-id-") as directory:
            app = Path(directory) / "Tribe.app"
            info = app / "Contents" / "Info.plist"
            info.parent.mkdir(parents=True)
            with info.open("wb") as output:
                plistlib.dump({"CFBundleIdentifier": 'bad"; quit'}, output)
            with self.assertRaisesRegex(RuntimeError, "invalid bundle identifier"):
                smoke_macos_app_lifecycle(app)

    def test_macos_bundle_verification_runs_app_lifecycle_on_macos(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-macos-main-") as directory:
            root = Path(directory)
            app = root / "Tribe.app"
            lifecycle = Mock()
            with (
                patch("sys.platform", "darwin"),
                patch("sys.argv", ["verify-desktop-bundles.py", "--target", "aarch64-apple-darwin", "--root", str(root)]),
                patch.dict(
                    verify_desktop_main.__globals__,
                    {"verify_bundles": Mock(return_value=[app]), "smoke_macos_app_lifecycle": lifecycle},
                ),
            ):
                self.assertEqual(verify_desktop_main(), 0)

            lifecycle.assert_called_once_with(app)

    def test_macos_failure_cleanup_requests_only_local_runtime_shutdown(self) -> None:
        response = Mock(status=202)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        healthy = Mock(side_effect=[True, False])
        with (
            patch("urllib.request.urlopen", return_value=response) as urlopen,
            patch.dict(
                request_sidecar_shutdown.__globals__,
                {"_runtime_is_healthy": healthy},
            ),
            patch("time.sleep"),
        ):
            request_sidecar_shutdown("http://127.0.0.1:4317/api/health")

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:4317/api/shutdown")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Origin"), "tauri://localhost")
        self.assertEqual(request.data, b"{}")

    def test_windows_build_must_emit_both_nonempty_installer_formats(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-windows-bundle-") as directory:
            root = Path(directory)
            bundle = root / "src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
            msi = bundle / "msi" / "Tribe_0.1.0_x64_en-US.msi"
            nsis = bundle / "nsis" / "Tribe_0.1.0_x64-setup.exe"
            msi.parent.mkdir(parents=True)
            nsis.parent.mkdir(parents=True)
            msi.write_bytes(b"msi")
            nsis.write_bytes(b"nsis")
            with patch("sys.platform", "linux"):
                self.assertEqual(
                    verify_bundles(root, "x86_64-pc-windows-msvc"), [msi, nsis],
                )

    def test_windows_build_rejects_a_missing_installer_format(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-incomplete-bundle-") as directory:
            root = Path(directory)
            msi = root / "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Tribe.msi"
            msi.parent.mkdir(parents=True)
            msi.write_bytes(b"msi")
            with self.assertRaisesRegex(RuntimeError, "missing Windows installer format"):
                verify_bundles(root, "x86_64-pc-windows-msvc")

    def test_both_windows_installer_formats_smoke_the_extracted_app(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-windows-installers-") as directory:
            root = Path(directory)
            installers = [root / "Tribe.msi", root / "Tribe-setup.exe"]
            for installer in installers:
                installer.write_bytes(b"installer")

            def extract(command: list[str], **_kwargs: object) -> None:
                destination_arg = next(
                    argument for argument in command
                    if argument.startswith(("TARGETDIR=", "/D="))
                )
                destination = Path(destination_arg.split("=", 1)[1])
                application = destination / "Tribe.exe"
                application.parent.mkdir(parents=True, exist_ok=True)
                application.write_bytes(b"app")
                (application.parent / "tribe-runtime.exe").write_bytes(b"runtime")

            lifecycle = Mock()
            with patch("subprocess.run", side_effect=extract), patch.dict(
                verify_windows_installer_contents.__globals__,
                {"smoke_windows_app_lifecycle": lifecycle},
            ):
                verify_windows_installer_contents(installers)

            self.assertEqual(lifecycle.call_count, 2)
            self.assertEqual(
                [call.args[0].name for call in lifecycle.call_args_list],
                ["Tribe.exe", "Tribe.exe"],
            )

    def test_windows_lifecycle_cleans_sidecar_after_app_exits_early(self) -> None:
        class Process:
            pid = 42
            returncode = 1

            def poll(self) -> int:
                return self.returncode

        listener = Mock()
        listener.__enter__ = Mock(return_value=listener)
        listener.__exit__ = Mock(return_value=False)
        listener.connect_ex.return_value = 1
        process = Process()
        shutdown = Mock()
        healthy = Mock(return_value=True)
        with (
            patch("socket.socket", return_value=listener),
            patch("subprocess.Popen", return_value=process),
            patch.dict(
                smoke_windows_app_lifecycle.__globals__,
                {
                    "_runtime_is_healthy": healthy,
                    "_request_sidecar_shutdown": shutdown,
                },
            ),
            patch("subprocess.run") as run,
        ):
            with self.assertRaisesRegex(RuntimeError, "exited before its runtime became healthy"):
                smoke_windows_app_lifecycle(Path("Tribe.exe"))

        shutdown.assert_called_once_with("http://127.0.0.1:4317/api/health")
        run.assert_not_called()

    def test_packaged_runtime_smoke_requests_graceful_shutdown_before_waiting(self) -> None:
        class ShutdownHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.server.request = (
                    self.path,
                    self.headers.get("Origin"),
                    self.rfile.read(int(self.headers.get("Content-Length", "0"))),
                )
                self.send_response(202)
                self.end_headers()

            def log_message(self, _format: str, *_args: object) -> None:
                return

        class Process:
            waited = False

            def poll(self) -> None:
                return None

            def wait(self, timeout: int) -> int:
                self.waited = timeout == 15
                return 0

            def terminate(self) -> None:
                raise AssertionError("healthy smoke runtime should exit gracefully")

            def kill(self) -> None:
                raise AssertionError("healthy smoke runtime should not need to be killed")

        server = http.server.HTTPServer(("127.0.0.1", 0), ShutdownHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        process = Process()
        try:
            shutdown_runtime(f"http://127.0.0.1:{server.server_port}", process)
            self.assertEqual(server.request, ("/api/shutdown", "tauri://localhost", b"{}"))
            self.assertTrue(process.waited)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
