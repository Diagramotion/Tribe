"""Build the Python runtime sidecar for the current Tauri target."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
OUTPUT = ROOT / "src-tauri" / "binaries"


def resolve_target(
    host_target: str,
    requested_target: str | None,
    system: str | None = None,
    machine: str | None = None,
) -> str:
    target = requested_target or host_target
    if target != host_target:
        raise RuntimeError(
            f"PyInstaller builds a native sidecar and cannot target {target} from {host_target}; "
            "run the Tauri build on a matching OS and architecture"
        )
    system = system or platform.system()
    expected_suffix = {"Darwin": "apple-darwin", "Windows": "windows-msvc"}.get(system)
    if not expected_suffix:
        raise RuntimeError(f"Desktop sidecar packaging is supported on macOS and Windows, not {system}")
    if not target.endswith(expected_suffix):
        raise RuntimeError(f"Tauri target {target} does not match the {system} build host")
    machine = (machine or platform.machine()).lower()
    host_arch = {"arm64": "aarch64", "aarch64": "aarch64", "amd64": "x86_64", "x86_64": "x86_64"}.get(machine)
    if target.split("-", 1)[0] != host_arch:
        raise RuntimeError(f"Tauri target {target} does not match the {machine} Python runtime")
    return target


def main() -> None:
    host = subprocess.check_output(["rustc", "-vV"], text=True)
    host_target = next(line.removeprefix("host: ") for line in host.splitlines() if line.startswith("host: "))
    target = resolve_target(host_target, os.environ.get("TAURI_ENV_TARGET_TRIPLE"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    work = ROOT / "build" / "runtime"
    shutil.rmtree(work, ignore_errors=True)
    python = RUNTIME / (".venv/Scripts/python.exe" if platform.system() == "Windows" else ".venv/bin/python")
    if not python.exists():
        python = Path(sys.executable)
    windows_target = target.endswith("windows-msvc")
    keyring_backend = "keyring.backends.Windows" if windows_target else "keyring.backends.macOS"
    subprocess.run([
        str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--name", "tribe-runtime", "--paths", str(RUNTIME), "--distpath", str(work / "dist"),
        "--workpath", str(work / "work"), "--specpath", str(work),
        "--collect-all", "keyring", "--collect-all", "pydantic_ai", "--collect-all", "anthropic",
        "--copy-metadata", "genai-prices",
        "--collect-all", "pydantic_ai_harness.filesystem",
        "--collect-all", "pydantic_ai_harness.shell",
        "--collect-all", "pydantic_ai_harness.skills",
        "--collect-all", "pydantic_ai_harness.step_persistence",
        "--collect-all", "pypdfium2", "--collect-all", "rapidocr",
        "--collect-all", "onnxruntime",
        "--add-data", f"{RUNTIME / 'tribe_runtime/THIRD_PARTY_NOTICES.md'}{os.pathsep}tribe_runtime",
        "--add-data", f"{RUNTIME / 'tribe_runtime/third_party/LICENSE-APACHE-2.0.txt'}{os.pathsep}tribe_runtime/third_party",
        "--hidden-import", "pydantic_ai.models.openai", "--hidden-import", "pydantic_ai.models.anthropic",
        "--hidden-import", "pydantic_ai.models.ollama", "--hidden-import", "pydantic_ai.providers.ollama",
        "--hidden-import", keyring_backend, str(RUNTIME / "entrypoint.py"),
    ], cwd=ROOT, env={**os.environ, "PYTHONPATH": str(RUNTIME)}, check=True)
    executable = work / "dist" / ("tribe-runtime.exe" if windows_target else "tribe-runtime")
    destination = OUTPUT / f"tribe-runtime-{target}{'.exe' if windows_target else ''}"
    shutil.copy2(executable, destination)
    if not windows_target:
        destination.chmod(0o755)
    print(f"Packaged {destination.name}")


if __name__ == "__main__":
    main()
