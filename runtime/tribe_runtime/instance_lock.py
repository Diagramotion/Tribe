"""Cross-platform process lock for one runtime per local workspace."""

from __future__ import annotations

import os
from pathlib import Path
from typing import BinaryIO


class RuntimeAlreadyRunningError(RuntimeError):
    """Raised when another process owns this workspace's runtime lock."""


class RuntimeInstanceLock:
    def __init__(self, path: Path):
        self.path = path
        self._file: BinaryIO | None = None

    def acquire(self) -> None:
        if self._file is not None:
            raise RuntimeError("runtime_lock_already_acquired")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = self.path.open("a+b")
        try:
            if lock_file.seek(0, os.SEEK_END) == 0:
                lock_file.write(b"\0")
                lock_file.flush()
            lock_file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            lock_file.close()
            raise RuntimeAlreadyRunningError(
                "another Tribe runtime is already using this workspace"
            ) from error
        self._file = lock_file

    def release(self) -> None:
        lock_file, self._file = self._file, None
        if lock_file is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()

    def __enter__(self) -> RuntimeInstanceLock:
        self.acquire()
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback) -> None:
        self.release()
