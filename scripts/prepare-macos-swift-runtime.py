"""Stage the Swift concurrency runtime needed by the macOS desktop binary."""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLCHAIN_FRAMEWORKS = Path("Toolchains/XcodeDefault.xctoolchain/usr/lib")
LIBRARY_NAME = "libswift_Concurrency.dylib"


def find_runtime(developer_dir: Path) -> Path:
    swift_root = developer_dir / TOOLCHAIN_FRAMEWORKS
    candidates = sorted(
        swift_root.glob(f"swift-*/macosx/{LIBRARY_NAME}"),
        key=lambda path: tuple(int(part) for part in path.parent.parent.name.removeprefix("swift-").split(".")),
        reverse=True,
    )
    if not candidates:
        raise RuntimeError(
            f"Could not find {LIBRARY_NAME} in the active Xcode toolchain at {swift_root}"
        )
    return candidates[0]


def main() -> None:
    if platform.system() != "Darwin":
        return

    developer_dir = Path(
        subprocess.check_output(["xcode-select", "-p"], text=True).strip()
    )
    source = find_runtime(developer_dir)
    destination_dir = ROOT / "src-tauri" / "frameworks"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / LIBRARY_NAME
    shutil.copy2(source, destination)
    print(f"Staged {LIBRARY_NAME} from the active Xcode toolchain")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Could not prepare the macOS desktop runtime: {error}", file=sys.stderr)
        raise SystemExit(1) from error
