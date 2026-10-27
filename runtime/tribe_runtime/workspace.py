"""Constrained repository tools shared by the agent roles."""

from __future__ import annotations

import base64
import hashlib
import difflib
import mimetypes
import os
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from contextlib import ExitStack, contextmanager
from os import walk
from pathlib import Path
from pathlib import PurePosixPath

from .store import MissionStore


_locks_guard = threading.Lock()


class _PathLockEntry:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.references = 0


_path_locks: dict[Path, _PathLockEntry] = {}
_IGNORED = {".git", ".tribe", ".venv", "venv", "node_modules", "dist", "build", "target"}
_TEST_COMMANDS = {
    ("pytest",), ("python", "-m", "pytest"), ("python3", "-m", "pytest"),
    ("npm", "test"), ("npm", "run", "test"), ("pnpm", "test"), ("pnpm", "run", "test"),
    ("yarn", "test"), ("cargo", "test"), ("go", "test"), ("dotnet", "test"),
}
_MAX_DELETION_DIFF_SOURCE_BYTES = 4_000_000
_SENSITIVE_ENV_COMPONENTS = {
    "KEY", "TOKEN", "JWT", "SECRET", "PASSWORD", "CREDENTIAL", "CREDENTIALS",
    "AUTH", "AUTHORIZATION", "PROXY", "COOKIE", "REGISTRY",
}
_REPOSITORY_IMAGE_MIME_TYPES = {
    "image/avif", "image/bmp", "image/gif", "image/jpeg", "image/png",
    "image/svg+xml", "image/webp", "image/x-icon",
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def browse_repository(repository_root: Path, relative_path: str = "") -> dict[str, object]:
    """Return one safe directory listing or bounded UTF-8 file preview from a repository."""
    root = repository_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("repository_root_must_be_a_directory")
    if len(relative_path) > 1000 or "\x00" in relative_path or "\\" in relative_path:
        raise ValueError("repository_path_is_invalid")
    if relative_path in {"", "."}:
        segments: list[str] = []
    else:
        path = PurePosixPath(relative_path)
        segments = relative_path.split("/")
        if path.is_absolute() or any(segment in {"", ".", ".."} for segment in segments):
            raise ValueError("repository_path_must_be_relative_and_canonical")
    target = root.joinpath(*segments).resolve(strict=True)
    if not target.is_relative_to(root):
        raise ValueError("repository_path_is_outside_project")
    relative_parts = target.relative_to(root).parts
    if _IGNORED.intersection(relative_parts):
        raise ValueError("repository_path_is_ignored")
    relative = target.relative_to(root).as_posix() if relative_parts else ""
    if target.is_dir():
        entries = []
        truncated = False
        for child in target.iterdir():
            if child.name in _IGNORED:
                continue
            try:
                resolved = child.resolve(strict=True)
                if not resolved.is_relative_to(root):
                    continue
                child_parts = resolved.relative_to(root).parts
                if _IGNORED.intersection(child_parts):
                    continue
                stat = resolved.stat()
            except OSError:
                continue
            entries.append({
                "name": child.name,
                "path": resolved.relative_to(root).as_posix(),
                "kind": "directory" if resolved.is_dir() else "file",
                "size": None if resolved.is_dir() else stat.st_size,
            })
            if len(entries) >= 10_000:
                truncated = True
                break
        entries.sort(key=lambda item: (item["kind"] != "directory", str(item["name"]).casefold()))
        return {"kind": "directory", "path": relative, "entries": entries[:300],
                "truncated": truncated or len(entries) > 300}
    if not target.is_file():
        raise ValueError("repository_path_is_not_a_file_or_directory")
    size = target.stat().st_size
    if size > 1_000_000:
        return {"kind": "file", "path": relative, "size": size, "tooLarge": True}
    content = target.read_bytes()
    if len(content) > 1_000_000:
        return {"kind": "file", "path": relative, "size": len(content), "tooLarge": True}
    mime_type = mimetypes.guess_type(target.name)[0]
    image_preview = f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}" if mime_type in _REPOSITORY_IMAGE_MIME_TYPES else None
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        entry = {"kind": "file", "path": relative, "size": size, "binary": True}
        if image_preview:
            entry["previewDataUrl"] = image_preview
        return entry
    if b"\x00" in content[:8192]:
        entry = {"kind": "file", "path": relative, "size": size, "binary": True}
        if image_preview:
            entry["previewDataUrl"] = image_preview
        return entry
    entry = {"kind": "file", "path": relative, "size": size, "content": text}
    if image_preview:
        entry["previewDataUrl"] = image_preview
    return entry


def project_git_status(repository_root: Path) -> dict[str, object]:
    """Return a bounded, read-only Git change list for a project repository."""
    root = repository_root.resolve(strict=True)
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
            cwd=root, capture_output=True, timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"isGit": False, "branch": None, "files": []}
    if result.returncode != 0:
        return {"isGit": False, "branch": None, "files": []}
    branch_result = subprocess.run(
        ["git", "branch", "--show-current"], cwd=root, capture_output=True, timeout=4, check=False,
    )
    branch = branch_result.stdout.decode("utf-8", errors="replace").strip() if branch_result.returncode == 0 else ""
    files = []
    records = result.stdout.split(b"\0")
    for record in records[:5000]:
        if len(record) < 4 or record[2:3] != b" ":
            continue
        status = record[:2].decode("ascii", errors="replace")
        path = os.fsdecode(record[3:])
        if not path or path.startswith("/") or "\\" in path or any(part in {"", ".", ".."} for part in path.split("/")):
            continue
        files.append({"path": path, "status": status, "staged": status[0] not in {" ", "?"},
                      "unstaged": status[1] not in {" ", "?"}, "untracked": status == "??"})
    return {"isGit": True, "branch": branch or "Detached HEAD", "files": files}


def project_git_diff(repository_root: Path, relative_path: str) -> dict[str, object]:
    """Return a bounded unified diff for one changed file, without invoking a shell."""
    root = repository_root.resolve(strict=True)
    if len(relative_path) > 1000 or "\x00" in relative_path or "\\" in relative_path:
        raise ValueError("repository_path_is_invalid")
    path = PurePosixPath(relative_path)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in relative_path.split("/")):
        raise ValueError("repository_path_must_be_relative_and_canonical")
    status = project_git_status(root)
    if not status["isGit"]:
        raise ValueError("project_is_not_git_enabled")
    changed = next((item for item in status["files"] if item["path"] == relative_path), None)
    if not changed:
        raise ValueError("git_file_not_changed")
    if changed["untracked"]:
        entry = browse_repository(root, relative_path)
        if entry.get("binary") or entry.get("tooLarge"):
            return {"path": relative_path, "diff": "This file is binary or too large to preview."}
        new_lines = str(entry.get("content", "")).splitlines(keepends=True)
        diff_lines = difflib.unified_diff([], new_lines, fromfile="/dev/null", tofile=f"b/{relative_path}")
        diff = "".join(diff_lines)
    else:
        result = subprocess.run(
            ["git", "diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", relative_path],
            cwd=root, capture_output=True, timeout=8, check=False,
        )
        if result.returncode not in {0, 1}:
            raise ValueError("git_diff_could_not_be_read")
        diff = result.stdout.decode("utf-8", errors="replace")
    if len(diff) > 500_000:
        diff = diff[:500_000] + "\n… diff truncated …\n"
    return {"path": relative_path, "diff": diff or "No text changes to show."}


def _retain_path_lock(path: Path) -> _PathLockEntry:
    with _locks_guard:
        entry = _path_locks.setdefault(path, _PathLockEntry())
        entry.references += 1
        return entry


def _release_path_lock_reference(path: Path, entry: _PathLockEntry) -> None:
    with _locks_guard:
        entry.references -= 1
        if entry.references == 0 and _path_locks.get(path) is entry:
            del _path_locks[path]


class WorkspaceTools:
    def __init__(self, store: MissionStore, mission_id: str, agent_id: str,
                 work_item_id: str | None = None):
        self.store = store
        self.mission_id = mission_id
        self.agent_id = agent_id
        self.work_item_id = work_item_id
        self.repository_root = store.project_repository(mission_id)
        self.root = self.repository_root
        isolation = store.isolated_workspace(agent_id, mission_id)
        if isolation and isolation["state"] in {"active", "pending_approval"}:
            self.root = Path(isolation["path"]).resolve()

    def _require_work_claim(self) -> None:
        self.store.require_work_claim(self.mission_id, self.agent_id, self.work_item_id)

    @contextmanager
    def _path_lock(self, path: Path, timeout: float = 30):
        canonical = path.resolve()
        entry = _retain_path_lock(canonical)
        thread_lock = entry.lock
        deadline = time.monotonic() + timeout
        acquired = False
        lock_handle = None
        os_locked = False
        lock_name = hashlib.sha256(os.fsencode(os.path.normcase(str(canonical)))).hexdigest() + ".lock"
        try:
            acquired = thread_lock.acquire(timeout=max(0, deadline - time.monotonic()))
            if not acquired:
                raise TimeoutError(f"timed out waiting to edit {canonical}")
            lock_dir = self.store.data_dir / "locks"
            lock_dir.mkdir(parents=True, exist_ok=True)
            lock_handle = (lock_dir / lock_name).open("a+b")
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
                            raise TimeoutError(f"timed out waiting to edit {canonical}")
                        time.sleep(0.05)
            else:
                import fcntl

                while True:
                    try:
                        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        os_locked = True
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError(f"timed out waiting to edit {canonical}")
                        time.sleep(0.05)
            try:
                yield
            finally:
                if os_locked:
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
                if acquired:
                    thread_lock.release()
                _release_path_lock_reference(canonical, entry)

    def start_isolated_work(self) -> dict[str, str]:
        self._require_work_claim()
        existing = self.store.isolated_workspace(self.agent_id, self.mission_id)
        if existing and existing["state"] in {"active", "pending_approval"}:
            self.root = Path(existing["path"]).resolve()
            return {"path": str(self.root), "status": existing["state"]}
        if existing and existing["state"] == "integrated":
            subprocess.run(["git", "worktree", "remove", "--force", existing["path"]],
                           cwd=self.repository_root, capture_output=True, text=True, timeout=60)
            self.store.clear_isolated_workspace(self.mission_id, self.agent_id)
        status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"],
                                cwd=self.repository_root, capture_output=True, timeout=30, check=True)
        if status.stdout.strip():
            raise RuntimeError("Commit or stash existing repository changes before starting isolated work")
        worktree = self.store.data_dir / "worktrees" / self.mission_id / f"{self.agent_id}-{uuid.uuid4().hex[:8]}"
        worktree.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "worktree", "add", "--detach", str(worktree), "HEAD"],
                       cwd=self.repository_root, capture_output=True, text=True, timeout=60, check=True)
        self.store.save_isolated_workspace(self.mission_id, self.agent_id,
                                           str(self.repository_root), str(worktree))
        self.root = worktree.resolve()
        self.store.append("repo.worktree.started", self.agent_id, self.mission_id,
                          {"path": str(worktree), "repository": str(self.repository_root)})
        return {"path": str(self.root), "status": "active"}

    def request_isolated_integration(self, reason: str) -> dict[str, object]:
        self._require_work_claim()
        isolation = self.store.isolated_workspace(self.agent_id, self.mission_id)
        if not isolation or isolation["state"] != "active":
            raise ValueError("there is no active isolated workspace to integrate")
        subprocess.run(["git", "add", "--all"], cwd=self.root, capture_output=True,
                       text=True, timeout=60, check=True)
        diff = subprocess.run(["git", "diff", "--cached", "--binary", "HEAD"], cwd=self.root,
                              capture_output=True, timeout=60, check=True).stdout
        if not diff:
            raise ValueError("the isolated workspace has no changes to integrate")
        if len(diff) > 10_000_000:
            raise ValueError("the isolated change set exceeds the 10 MB review limit")
        paths_output = subprocess.run(["git", "diff", "--cached", "--name-only", "-z", "HEAD"],
                                      cwd=self.root, capture_output=True, timeout=30, check=True).stdout
        paths = [entry.decode("utf-8", errors="strict") for entry in paths_output.split(b"\0") if entry]
        if not paths or len(paths) > 200:
            raise ValueError("isolated integration must change between 1 and 200 files")
        for path in paths:
            self._validate_repository_path(path)
        digest = hashlib.sha256(diff).hexdigest()[:12]
        artifact, _ = self.store.add_artifact(self.mission_id, f"isolated-changes-{digest}.patch",
                                               "text/x-diff", self.agent_id, diff)
        interaction_id = str(uuid.uuid4())
        target = f"Apply isolated changes to {self.repository_root}"
        details = f"{reason.strip()[:1000]}\n\nFiles: {', '.join(paths[:30])}"
        self.store.save_integration_request(interaction_id, self.mission_id, self.agent_id,
                                            artifact["id"], paths)
        self.store.create_interaction(self.mission_id, "approval", "Apply isolated repository changes",
                                      details, target, self.agent_id, interaction_id=interaction_id)
        self.store.update_isolated_workspace_state(self.mission_id, self.agent_id, "pending_approval")
        return {"interactionId": interaction_id, "artifactId": artifact["id"], "files": paths,
                "status": "pending_approval"}

    def integrate_isolated_changes(self, approval_id: str) -> dict[str, object]:
        self._require_work_claim()
        isolation = self.store.isolated_workspace(self.agent_id, self.mission_id)
        request = self.store.integration_request(approval_id)
        interaction = self.store.approval(approval_id)
        if not isolation or isolation["state"] != "pending_approval" or not request or not interaction or request["status"] != "pending":
            raise ValueError("the isolated integration request is unavailable")
        target = f"Apply isolated changes to {self.repository_root}"
        if interaction["target"] != target or interaction["requested_by"] != self.agent_id:
            raise PermissionError("approval does not match this agent's isolated integration")
        if interaction["status"] != "resolved" or interaction["resolution"] != "approved_once":
            raise PermissionError("the exact isolated integration action has not been approved")
        artifact_data = self.store.artifact_content(request["artifact_id"])
        if not artifact_data:
            raise FileNotFoundError("review patch artifact is missing")
        _, patch = artifact_data
        paths = [self._validate_repository_path(path) for path in request["paths"]]
        with ExitStack() as locks:
            for path in sorted(paths, key=str):
                locks.enter_context(self._path_lock(path))
            self._require_work_claim()
            check = subprocess.run(["git", "apply", "--check", "--binary", "-"],
                                   cwd=self.repository_root, input=patch, capture_output=True, timeout=60)
            if check.returncode:
                self.store.update_isolated_workspace_state(self.mission_id, self.agent_id, "active")
                self.store.update_integration_request(approval_id, "conflict")
                raise RuntimeError(check.stderr.decode("utf-8", errors="replace")[-2000:] or
                                   "isolated changes no longer apply cleanly")
            if not self.store.consume_approval(approval_id, target):
                raise PermissionError("a matching, unused one-time approval is required")
            applied = subprocess.run(["git", "apply", "--binary", "-"], cwd=self.repository_root,
                                     input=patch, capture_output=True, timeout=60)
            if applied.returncode:
                self.store.update_isolated_workspace_state(self.mission_id, self.agent_id, "active")
                self.store.update_integration_request(approval_id, "conflict")
                raise RuntimeError(applied.stderr.decode("utf-8", errors="replace")[-2000:] or
                                   "git could not apply the approved change set")
        self.store.update_integration_request(approval_id, "applied")
        for path in paths:
            self.store.append("repo.file.changed", self.agent_id, self.mission_id,
                              {"path": path.relative_to(self.repository_root).as_posix(),
                               "change": "integrated", "source": "isolated_worktree"})
        self.store.append("repo.worktree.integrated", self.agent_id, self.mission_id,
                          {"paths": request["paths"], "artifactId": request["artifact_id"]})
        removed = subprocess.run(["git", "worktree", "remove", "--force", isolation["path"]],
                                 cwd=self.repository_root, capture_output=True, text=True, timeout=60)
        if removed.returncode == 0:
            self.store.clear_isolated_workspace(self.mission_id, self.agent_id)
            self.root = self.repository_root
        else:
            self.store.update_isolated_workspace_state(self.mission_id, self.agent_id, "integrated")
        return {"integrated": True, "files": request["paths"], "workspaceRemoved": removed.returncode == 0}

    def discard_isolated_work(self) -> dict[str, object]:
        isolation = self.store.isolated_workspace(self.agent_id, self.mission_id)
        if not isolation:
            raise ValueError("there is no isolated workspace to discard")
        path = Path(isolation["path"]).resolve()
        allowed_root = (self.store.data_dir / "worktrees" / self.mission_id).resolve()
        if (not path.is_relative_to(allowed_root) or isolation["repository"] != str(self.repository_root)
                or not path.exists()):
            raise PermissionError("isolated workspace path does not match its recorded project")
        original_state = isolation["state"]
        self.store.update_isolated_workspace_state(self.mission_id, self.agent_id, "discarding")
        removed = subprocess.run(["git", "worktree", "remove", "--force", str(path)],
                                 cwd=self.repository_root, capture_output=True, text=True, timeout=60)
        if removed.returncode:
            self.store.update_isolated_workspace_state(self.mission_id, self.agent_id, original_state)
            raise RuntimeError(removed.stderr[-2000:] or "could not remove isolated worktree")
        for interaction_id in self.store.pending_integrations(self.mission_id, self.agent_id):
            self.store.update_integration_request(interaction_id, "cancelled")
            self.store.resolve_interaction(interaction_id, "cancelled_by_user")
        self.store.clear_isolated_workspace(self.mission_id, self.agent_id)
        self.root = self.repository_root
        self.store.append("repo.worktree.discarded", "user", self.mission_id,
                          {"agentId": self.agent_id, "path": str(path)})
        return {"discarded": True, "path": str(path)}

    def _validate_repository_path(self, relative_path: str) -> Path:
        path = (self.repository_root / relative_path).resolve()
        if not path.is_relative_to(self.repository_root) or _IGNORED.intersection(path.relative_to(self.repository_root).parts):
            raise ValueError("isolated patch contains a path outside the permitted repository")
        return path

    def resolve(self, relative_path: str) -> Path:
        path = (self.root / relative_path).resolve()
        if not path.is_relative_to(self.root) or _IGNORED.intersection(path.relative_to(self.root).parts):
            raise ValueError("path is outside the permitted repository workspace")
        return path

    def read_file(self, relative_path: str) -> str:
        path = self.resolve(relative_path)
        if not path.is_file():
            raise FileNotFoundError(relative_path)
        if path.stat().st_size > 1_000_000:
            raise ValueError("file is larger than the 1 MB tool limit")
        return path.read_text(encoding="utf-8")

    def file_fingerprint(self, relative_path: str) -> str:
        """Fingerprint an existing regular file before requesting a destructive approval."""
        path = self.resolve(relative_path)
        if not path.is_file():
            raise FileNotFoundError(relative_path)
        return _sha256_file(path)

    def search(self, query: str, limit: int = 100) -> list[dict[str, str]]:
        needle = query.casefold().strip()
        if not needle or len(needle) > 200:
            raise ValueError("search text must be 1 to 200 characters")
        results: list[dict[str, str]] = []
        for directory, children, files in walk(self.root):
            children[:] = [child for child in children if child not in _IGNORED]
            for filename in files:
                path = Path(directory) / filename
                try:
                    if path.stat().st_size > 250_000:
                        continue
                    lines = path.read_text(encoding="utf-8").splitlines()
                except (OSError, UnicodeDecodeError):
                    continue
                for line_number, line in enumerate(lines, start=1):
                    if needle in line.casefold():
                        results.append({"path": path.relative_to(self.root).as_posix(), "line": str(line_number), "text": line[:500]})
                        if len(results) >= min(limit, 100):
                            return results
        return results

    def write_file(self, relative_path: str, content: str) -> dict[str, str]:
        self._require_work_claim()
        path = self.resolve(relative_path)
        if len(content.encode("utf-8")) > 1_000_000:
            raise ValueError("file content is larger than the 1 MB tool limit")
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._path_lock(path):
            self._require_work_claim()
            previous = path.read_bytes() if path.exists() else b""
            encoded = content.encode("utf-8")
            if previous == encoded:
                return {"path": path.relative_to(self.root).as_posix(), "change": "unchanged"}
            relative = path.relative_to(self.root).as_posix()
            self.store.append("repo.file.write.started", self.agent_id, self.mission_id,
                              {"path": relative, "sha256": hashlib.sha256(encoded).hexdigest(),
                               "workItemId": self.work_item_id})
            temporary_name = None
            try:
                with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as temporary:
                    temporary.write(encoded)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                    temporary_name = temporary.name
                Path(temporary_name).replace(path)
            finally:
                if temporary_name and Path(temporary_name).exists():
                    Path(temporary_name).unlink()
            change = "created" if not previous else "updated"
            self.store.append("repo.file.changed", self.agent_id, self.mission_id, {
                "path": relative, "change": change,
                "previousSha256": hashlib.sha256(previous).hexdigest() if previous else None,
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "workItemId": self.work_item_id,
            })
            try:
                previous_text = previous.decode("utf-8") if previous else ""
                current_text = encoded.decode("utf-8")
                diff = "".join(difflib.unified_diff(previous_text.splitlines(keepends=True),
                    current_text.splitlines(keepends=True), fromfile=f"a/{relative}", tofile=f"b/{relative}"))
                if diff:
                    self.store.add_artifact(self.mission_id, f"{Path(relative).name}.diff", "text/x-diff",
                                            self.agent_id, diff.encode("utf-8"))
            except UnicodeDecodeError:
                pass
            return {"path": relative, "change": change}

    def delete_file(self, relative_path: str, approval_id: str) -> str:
        self._require_work_claim()
        path = self.resolve(relative_path)
        target = str(path)
        with self._path_lock(path):
            self._require_work_claim()
            if not path.is_file():
                raise FileNotFoundError(relative_path)
            previous_bytes = None
            if path.stat().st_size <= _MAX_DELETION_DIFF_SOURCE_BYTES:
                previous_bytes = path.read_bytes()
                previous_hash = hashlib.sha256(previous_bytes).hexdigest()
            else:
                previous_hash = _sha256_file(path)
            relative = path.relative_to(self.root).as_posix()
            diff_content = None
            diff_name = None
            if previous_bytes is None:
                diff_skipped_reason = "file_too_large"
            else:
                try:
                    previous_text = previous_bytes.decode("utf-8")
                    diff = "".join(difflib.unified_diff(
                        previous_text.splitlines(keepends=True), [],
                        fromfile=f"a/{relative}", tofile=f"b/{relative}",
                    ))
                    encoded_diff = diff.encode("utf-8")
                    if encoded_diff and len(encoded_diff) <= 10_000_000:
                        diff_content = encoded_diff
                        diff_name = f"{Path(relative).name}.deletion.diff"
                        diff_skipped_reason = None
                    else:
                        diff_skipped_reason = "diff_too_large" if encoded_diff else "no_text_diff"
                except UnicodeDecodeError:
                    diff_skipped_reason = "binary_file"
            if not self.store.consume_repository_file_deletion_approval(
                approval_id, target, previous_hash, self.mission_id, self.agent_id, relative,
                diff_content, diff_name, "text/x-diff" if diff_content else None,
                diff_skipped_reason,
            ):
                raise PermissionError(
                    "a matching, unused approval for this unchanged file is required"
                )
            try:
                current_hash = _sha256_file(path)
            except OSError:
                current_hash = None
            if current_hash != previous_hash:
                self.store.abort_repository_file_deletion(
                    approval_id, self.mission_id, self.agent_id, current_hash,
                    "file_changed_after_approval",
                )
                raise PermissionError("the file changed after approval; request approval again")
            path.unlink()
        if not self.store.complete_repository_file_deletion(
            approval_id, self.mission_id, self.agent_id, previous_hash,
        ):
            raise RuntimeError("repository_file_deletion_completion_could_not_be_recorded")
        return relative

    def run_tests(
        self, argv: list[str], timeout: int = 120,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> dict[str, object]:
        self._require_work_claim()
        if not argv or len(argv) > 16 or any(not isinstance(arg, str) or len(arg) > 500 for arg in argv):
            raise ValueError("test command must have 1 to 16 bounded arguments")
        allowed = any(tuple(argv[:len(prefix)]) == prefix for prefix in _TEST_COMMANDS)
        if not allowed:
            raise PermissionError("command is outside the approved test-command set")
        run_id = str(uuid.uuid4())
        self.store.append("repo.test_run.started", self.agent_id, self.mission_id,
                          {"runId": run_id, "argv": argv, "workItemId": self.work_item_id})
        environment = {
            name: value for name, value in os.environ.items()
            if not set(name.upper().replace("-", "_").split("_")).intersection(_SENSITIVE_ENV_COMPONENTS)
        }
        from .commands import run_foreground_process

        completed = run_foreground_process(
            argv, cwd=self.root, timeout=max(1, min(timeout, 300)), env=environment,
            is_cancelled=is_cancelled,
        )
        result = {
            "runId": run_id, "argv": argv, "exitCode": completed["exit_code"],
            "stdout": completed["stdout"], "stderr": completed["stderr"],
            "cancelled": completed["cancelled"], "timedOut": completed["timed_out"],
            "workItemId": self.work_item_id,
        }
        self.store.append("repo.test_run.completed", self.agent_id, self.mission_id, result)
        report = f"Command: {' '.join(argv)}\nExit code: {result['exitCode']}\n\nSTDOUT\n{result['stdout']}\n\nSTDERR\n{result['stderr']}"
        self.store.add_artifact(self.mission_id, f"test-results-{hashlib.sha256(report.encode()).hexdigest()[:10]}.txt",
                                "text/plain", self.agent_id, report.encode("utf-8"))
        return result
