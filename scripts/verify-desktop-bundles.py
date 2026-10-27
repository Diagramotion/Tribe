"""Verify that the requested desktop installers and runtime sidecars were packaged."""

from __future__ import annotations

import argparse
import ctypes
import json
import plistlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from ctypes import wintypes
from pathlib import Path


def verify_bundles(root: Path, target: str) -> list[Path]:
    bundle_root = root / "src-tauri" / "target" / target / "release" / "bundle"
    if target.endswith("apple-darwin"):
        app = bundle_root / "macos" / "Tribe.app"
        required = [app / "Contents" / "MacOS" / "tribe", app / "Contents" / "MacOS" / "tribe-runtime"]
        missing = [path for path in required if not path.is_file() or path.stat().st_size == 0]
        if missing:
            raise RuntimeError(
                "macOS app bundle is incomplete: " + ", ".join(str(path.relative_to(root)) for path in missing)
            )
        return [app]

    if target.endswith("windows-msvc"):
        installers = [
            *sorted((bundle_root / "msi").glob("*.msi")),
            *sorted((bundle_root / "nsis").glob("*-setup.exe")),
        ]
        if not installers:
            raise RuntimeError(f"no Windows MSI or NSIS installer found under {bundle_root}")
        empty = [path for path in installers if path.stat().st_size == 0]
        if empty:
            raise RuntimeError("empty Windows installer(s): " + ", ".join(str(path) for path in empty))
        kinds = {path.suffix.lower() for path in installers}
        missing_kinds = {".msi", ".exe"} - kinds
        if missing_kinds:
            raise RuntimeError("missing Windows installer format(s): " + ", ".join(sorted(missing_kinds)))
        if sys.platform == "win32":
            verify_windows_installer_contents(installers)
        return installers

    raise ValueError(f"unsupported desktop target: {target}")


def verify_windows_installer_contents(installers: list[Path]) -> None:
    """Extract each Windows installer to a temporary directory and verify its sidecar."""
    for installer in installers:
        with tempfile.TemporaryDirectory(prefix="tribe-installer-smoke-") as temporary:
            destination = Path(temporary) / "installed"
            destination.mkdir()
            if installer.suffix.lower() == ".msi":
                subprocess.run(
                    ["msiexec.exe", "/a", str(installer), "/qn", f"TARGETDIR={destination}"],
                    check=True,
                    timeout=180,
                )
            else:
                subprocess.run(
                    [str(installer), "/S", f"/D={destination}"],
                    check=True,
                    timeout=180,
                )
            executables = [
                path for path in destination.rglob("*")
                if path.is_file() and path.name.casefold() in {"tribe.exe", "tribe-runtime.exe"}
            ]
            names = {path.name.casefold() for path in executables}
            if (not {"tribe.exe", "tribe-runtime.exe"}.issubset(names)
                    or any(path.stat().st_size == 0 for path in executables)):
                raise RuntimeError(
                    f"Windows installer did not contain a usable app and runtime sidecar: {installer.name}"
                )
            app = next(path for path in executables if path.name.casefold() == "tribe.exe")
            smoke_windows_app_lifecycle(app)


def smoke_macos_app_lifecycle(app: Path) -> None:
    """Launch the packaged macOS app, verify its sidecar, then request a clean quit."""
    endpoint = "http://127.0.0.1:4317/api/health"
    executable = app / "Contents" / "MacOS" / "tribe"
    info_plist = app / "Contents" / "Info.plist"
    try:
        bundle_id = plistlib.loads(info_plist.read_bytes()).get("CFBundleIdentifier")
    except (OSError, plistlib.InvalidFileException) as error:
        raise RuntimeError(f"could not read packaged macOS app identifier: {info_plist}") from error
    if not isinstance(bundle_id, str) or not bundle_id or any(
        character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"
        for character in bundle_id
    ):
        raise RuntimeError("packaged macOS app has an invalid bundle identifier")

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.settimeout(0.2)
        if listener.connect_ex(("127.0.0.1", 4317)) == 0:
            raise RuntimeError("port 4317 is already in use; cannot verify the packaged desktop app")

    with tempfile.TemporaryFile(mode="w+b") as log:
        process = subprocess.Popen(
            [str(executable)], cwd=app.parent, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(
                        "packaged macOS app exited before its runtime became healthy:\n"
                        + _read_log_tail(log)
                    )
                if _runtime_is_healthy(endpoint):
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError(
                    "packaged macOS app did not start its runtime within 60 seconds:\n"
                    + _read_log_tail(log)
                )

            subprocess.run(
                ["/usr/bin/osascript", "-e", f'tell application id "{bundle_id}" to quit'],
                check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                process.wait(timeout=25)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("packaged macOS app did not exit after its app-level quit request") from error
            if process.returncode != 0:
                raise RuntimeError(f"packaged macOS app exited with code {process.returncode}")

            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and _runtime_is_healthy(endpoint):
                time.sleep(0.1)
            if _runtime_is_healthy(endpoint):
                raise RuntimeError("runtime sidecar remained available after the macOS app exited")
            print("Packaged macOS app started and shut down its runtime cleanly")
        finally:
            if process.poll() is None:
                try:
                    subprocess.run(
                        ["/usr/bin/osascript", "-e", f'tell application id "{bundle_id}" to quit'],
                        check=False, timeout=10,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass

            if process.poll() is None or _runtime_is_healthy(endpoint):
                _request_sidecar_shutdown(endpoint)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def _request_sidecar_shutdown(endpoint: str) -> None:
    """Best-effort cleanup for a sidecar if app-level quit or startup failed."""
    request = urllib.request.Request(
        endpoint.removesuffix("health") + "shutdown",
        data=b"{}",
        headers={"Content-Type": "application/json", "Origin": "tauri://localhost"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 202:
                return
    except (OSError, urllib.error.URLError):
        return

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and _runtime_is_healthy(endpoint):
        time.sleep(0.1)


def smoke_windows_app_lifecycle(app: Path) -> None:
    """Launch the installed desktop app, check its sidecar, then close it cleanly."""
    endpoint = "http://127.0.0.1:4317/api/health"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.settimeout(0.2)
        if listener.connect_ex(("127.0.0.1", 4317)) == 0:
            raise RuntimeError("port 4317 is already in use; cannot verify the packaged desktop app")

    with tempfile.TemporaryFile(mode="w+b") as log:
        process = subprocess.Popen(
            [str(app)], cwd=app.parent, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(
                        "packaged Windows app exited before its runtime became healthy:\n"
                        + _read_log_tail(log)
                    )
                if _runtime_is_healthy(endpoint):
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError(
                    "packaged Windows app did not start its runtime within 60 seconds:\n"
                    + _read_log_tail(log)
                )

            windows = _visible_windows_for_process(process.pid)
            if not windows:
                raise RuntimeError("packaged Windows app started without a visible main window")
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            post_message = user32.PostMessageW
            post_message.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            post_message.restype = wintypes.BOOL
            close_requests = [post_message(hwnd, 0x0010, 0, 0) for hwnd in windows]
            if not any(close_requests):
                raise RuntimeError("could not request a graceful close of the packaged Windows app")
            try:
                process.wait(timeout=25)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("packaged Windows app did not exit after its window was closed") from error
            if process.returncode != 0:
                raise RuntimeError(f"packaged Windows app exited with code {process.returncode}")

            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and _runtime_is_healthy(endpoint):
                time.sleep(0.1)
            if _runtime_is_healthy(endpoint):
                raise RuntimeError("runtime sidecar remained available after the Windows app exited")
            print("Packaged Windows app started and shut down its runtime cleanly")
        finally:
            if process.poll() is None or _runtime_is_healthy(endpoint):
                _request_sidecar_shutdown(endpoint)
            if process.poll() is None:
                subprocess.run(
                    ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                    check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                if _runtime_is_healthy(endpoint):
                    _request_sidecar_shutdown(endpoint)


def _visible_windows_for_process(process_id: int) -> list[int]:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    windows: list[int] = []
    enum_windows = user32.EnumWindows
    enum_windows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    enum_windows.restype = wintypes.BOOL
    get_window_process_id = user32.GetWindowThreadProcessId
    get_window_process_id.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    get_window_process_id.restype = wintypes.DWORD
    is_window_visible = user32.IsWindowVisible
    is_window_visible.argtypes = [wintypes.HWND]
    is_window_visible.restype = wintypes.BOOL

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd: int, _parameter: int) -> bool:
        owner = wintypes.DWORD()
        get_window_process_id(hwnd, ctypes.byref(owner))
        if owner.value == process_id and is_window_visible(hwnd):
            windows.append(hwnd)
        return True

    enum_windows(visit, 0)
    return windows


def _runtime_is_healthy(endpoint: str) -> bool:
    try:
        with urllib.request.urlopen(endpoint, timeout=0.5) as response:
            payload = json.loads(response.read())
        return response.status == 200 and payload.get("status") == "ok" and payload.get("runtime") == "local"
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return False


def _read_log_tail(log) -> str:
    log.flush()
    log.seek(max(0, log.tell() - 4000))
    return log.read().decode("utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    paths = verify_bundles(args.root, args.target)
    if sys.platform == "darwin" and args.target.endswith("apple-darwin"):
        smoke_macos_app_lifecycle(paths[0])
    for path in paths:
        print(path.relative_to(args.root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
