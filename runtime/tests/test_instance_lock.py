from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tribe_runtime.instance_lock import RuntimeInstanceLock


CHILD_LOCK_CHECK = """
import sys
from pathlib import Path
from tribe_runtime.instance_lock import RuntimeAlreadyRunningError, RuntimeInstanceLock
try:
    with RuntimeInstanceLock(Path(sys.argv[1])):
        print('acquired')
except RuntimeAlreadyRunningError:
    print('already-running')
"""

CHILD_LOCK_HOLD = """
import sys
import time
from pathlib import Path
from tribe_runtime.instance_lock import RuntimeInstanceLock
with RuntimeInstanceLock(Path(sys.argv[1])):
    Path(sys.argv[2]).touch()
    time.sleep(60)
"""


class RuntimeInstanceLockTests(unittest.TestCase):
    def test_workspace_lock_rejects_another_process_and_releases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.lock"
            lock = RuntimeInstanceLock(path)
            lock.acquire()
            try:
                rejected = subprocess.run(
                    [sys.executable, "-c", CHILD_LOCK_CHECK, str(path)],
                    check=True, capture_output=True, text=True,
                )
                self.assertEqual(rejected.stdout.strip(), "already-running")
            finally:
                lock.release()

            acquired = subprocess.run(
                [sys.executable, "-c", CHILD_LOCK_CHECK, str(path)],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(acquired.stdout.strip(), "acquired")

    def test_context_manager_releases_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.lock"
            with RuntimeInstanceLock(path):
                self.assertTrue(path.exists())
            with RuntimeInstanceLock(path):
                pass

    def test_process_exit_releases_workspace_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.lock"
            ready = Path(directory) / "lock-held"
            process = subprocess.Popen(
                [sys.executable, "-c", CHILD_LOCK_HOLD, str(path), str(ready)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not ready.exists() and process.poll() is None:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "child did not acquire the workspace lock")
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
                if process.stderr:
                    process.stderr.close()

            acquired = subprocess.run(
                [sys.executable, "-c", CHILD_LOCK_CHECK, str(path)],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(acquired.stdout.strip(), "acquired")

    def test_second_runtime_fails_before_opening_its_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "workspace"
            lock = RuntimeInstanceLock(data_dir / "runtime.lock")
            lock.acquire()
            try:
                environment = {**os.environ, "TRIBE_DATA_DIR": str(data_dir), "TRIBE_PORT": "0"}
                result = subprocess.run(
                    [sys.executable, "-m", "tribe_runtime.server"],
                    check=False, capture_output=True, text=True, env=environment,
                )
            finally:
                lock.release()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already using this workspace", result.stderr)
            self.assertFalse((data_dir / "tribe.sqlite3").exists())


if __name__ == "__main__":
    unittest.main()
