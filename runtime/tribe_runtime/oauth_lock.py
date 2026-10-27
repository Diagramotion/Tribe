"""Cross-thread and cross-process leases for one OAuth connection."""

from __future__ import annotations

import asyncio
import hashlib
import os
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator


@dataclass
class _LockEntry:
    lock: threading.Lock
    references: int = 0


_entries: dict[Path, _LockEntry] = {}
_entries_guard = threading.Lock()


class OAuthConnectionLease:
    """Serialize authentication for the same project, server and endpoint.

    The OS lock is advisory and automatically released if Tribe exits. Waiting
    is asynchronous, so a refresh or sign-in on one agent does not block the
    event loop used by other agents.
    """

    def __init__(self, lock_directory: Path, project_id: str, server_name: str, endpoint: str):
        if not project_id or not server_name or not endpoint:
            raise ValueError("oauth_lease_identity_required")
        digest = hashlib.sha256(
            f"{project_id}\0{server_name}\0{endpoint.rstrip('/')}".encode("utf-8")
        ).hexdigest()
        self._path = lock_directory.resolve() / f"mcp-oauth-{digest}.lock"

    @asynccontextmanager
    async def hold(self, *, timeout: float = 330) -> AsyncIterator[None]:
        if timeout <= 0:
            raise ValueError("oauth_lease_timeout_must_be_positive")
        path = self._path
        with _entries_guard:
            entry = _entries.setdefault(path, _LockEntry(threading.Lock()))
            entry.references += 1

        deadline = time.monotonic() + timeout
        thread_acquired = False
        lock_handle = None
        os_locked = False
        try:
            while not thread_acquired:
                thread_acquired = entry.lock.acquire(blocking=False)
                if not thread_acquired:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("timed out waiting for OAuth connection")
                    await asyncio.sleep(min(0.05, max(0, deadline - time.monotonic())))

            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            lock_handle = path.open("a+b")
            if os.name == "nt":
                import msvcrt

                lock_handle.seek(0, os.SEEK_END)
                if lock_handle.tell() == 0:
                    lock_handle.write(b"\0")
                    lock_handle.flush()
                while True:
                    lock_handle.seek(0)
                    try:
                        msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
                        os_locked = True
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("timed out waiting for OAuth connection")
                        await asyncio.sleep(min(0.05, max(0, deadline - time.monotonic())))
            else:
                import fcntl

                while True:
                    try:
                        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        os_locked = True
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("timed out waiting for OAuth connection")
                        await asyncio.sleep(min(0.05, max(0, deadline - time.monotonic())))

            yield
        finally:
            try:
                if os_locked and lock_handle is not None:
                    if os.name == "nt":
                        import msvcrt

                        lock_handle.seek(0)
                        msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
            finally:
                try:
                    if lock_handle is not None:
                        lock_handle.close()
                finally:
                    if thread_acquired:
                        entry.lock.release()
                    with _entries_guard:
                        entry.references -= 1
                        if entry.references == 0 and _entries.get(path) is entry:
                            del _entries[path]
