"""Durable SQLite event and work store.

Events are the source of truth for mission communication and user decisions.
Task rows are a projection used for atomic self-claiming by agent workers.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import uuid
import zipfile
from collections import defaultdict
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .canvas import comment_publications, document_publications, validate_content, visible_message
from .credentials import provider_for_model

SCHEMA_VERSION = 29
DEFAULT_AGENT_RUN_TOKEN_LIMIT = 128_000
TERMINAL_AGENT_RUN_STATUSES = {"completed", "failed", "interrupted"}

# Store input validation remains ValueError-based so HTTP routes return 422 responses.


def _is_supported_git_remote(remote: str) -> bool:
    if remote.startswith("git@"):
        return re.fullmatch(r"git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+", remote) is not None
    try:
        parsed = urlsplit(remote)
        if not parsed.hostname or not parsed.path or parsed.password is not None:
            return False
        if parsed.scheme == "https":
            return parsed.username is None
        return (
            parsed.scheme == "ssh" and parsed.username in {None, "git"}
            and re.fullmatch(r"/[A-Za-z0-9._~%/-]+", parsed.path) is not None
        )
    except ValueError:
        return False


def now() -> str:
    return datetime.now(UTC).isoformat()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class MissionStore:
    def __init__(self, path: Path):
        self.path = path
        self.data_dir = path.parent
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialise()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        try:
            yield connection
        finally:
            connection.close()

    def backup_to(self, destination: Path) -> None:
        """Write a consistent SQLite snapshot, including committed WAL data."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self._connect() as source:
            target = sqlite3.connect(destination, timeout=10)
            try:
                source.backup(target, pages=256, sleep=0.01)
                integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise RuntimeError(f"database_backup_integrity_check_failed:{integrity}")
            finally:
                target.close()

    @staticmethod
    def _snapshot_database(source_path: Path, destination: Path) -> None:
        """Snapshot an auxiliary SQLite database, including its committed WAL data."""
        with closing(sqlite3.connect(source_path, timeout=10)) as source:
            target = sqlite3.connect(destination, timeout=10)
            try:
                source.backup(target, pages=256, sleep=0.01)
                integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise RuntimeError(f"database_backup_integrity_check_failed:{integrity}")
            finally:
                target.close()

    def write_workspace_backup(self, destination: Path) -> None:
        """Write a portable database-and-artifact archive with integrity metadata."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="tribe-workspace-backup-") as temporary:
            snapshot = Path(temporary) / "tribe.sqlite3"
            self.backup_to(snapshot)
            agent_state = None
            agent_state_source = self.data_dir / "agent_steps.sqlite3"
            if agent_state_source.is_file():
                if agent_state_source.stat().st_size > 2_000_000_000:
                    raise RuntimeError("workspace_backup_agent_state_too_large")
                agent_state_snapshot = Path(temporary) / "agent_steps.sqlite3"
                self._snapshot_database(agent_state_source, agent_state_snapshot)
                if agent_state_snapshot.stat().st_size > 2_000_000_000:
                    raise RuntimeError("workspace_backup_agent_state_too_large")
                agent_state = {
                    "path": "agent_steps.sqlite3",
                    "size": agent_state_snapshot.stat().st_size,
                    "sha256": _sha256_file(agent_state_snapshot),
                }
            with closing(sqlite3.connect(snapshot)) as db:
                db.row_factory = sqlite3.Row
                artifacts = [dict(row) for row in db.execute(
                    "SELECT id,mission_id,name,path FROM artifacts ORDER BY mission_id,id"
                )]
            artifact_root = (self.data_dir / "artifacts").resolve()
            entries: list[tuple[str, Path, dict[str, Any]]] = []
            for index, artifact in enumerate(artifacts):
                source = Path(artifact["path"]).resolve(strict=True)
                if not source.is_relative_to(artifact_root) or source.stat().st_size > 10_000_000:
                    raise RuntimeError("workspace_backup_artifact_path_invalid")
                content_hash = hashlib.sha256(source.read_bytes()).hexdigest()
                archive_path = f"artifacts/{index:08d}.bin"
                entries.append((archive_path, source, {
                    "id": artifact["id"],
                    "missionId": artifact["mission_id"],
                    "name": artifact["name"],
                    "path": archive_path,
                    "size": source.stat().st_size,
                    "sha256": content_hash,
                }))
            manifest = {
                "format": "tribe-workspace-backup",
                "version": 1,
                "createdAt": now(),
                "database": "tribe.sqlite3",
                "artifacts": [entry[2] for entry in entries],
                "agentState": agent_state,
            }
            temporary_archive = Path(temporary) / "workspace.tribe-backup"
            with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.write(snapshot, "tribe.sqlite3")
                if agent_state is not None:
                    archive.write(Path(temporary) / agent_state["path"], agent_state["path"])
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
                for archive_path, source, _ in entries:
                    archive.write(source, archive_path)
            temporary_destination = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
            try:
                shutil.copyfile(temporary_archive, temporary_destination)
                temporary_destination.replace(destination)
            finally:
                temporary_destination.unlink(missing_ok=True)

    @classmethod
    def restore_workspace_backup(
        cls, source: Path, destination_data_dir: Path, *, artifact_data_dir: Path | None = None,
    ) -> MissionStore:
        """Restore a portable backup into a new or empty local data directory."""
        destination_data_dir = destination_data_dir.resolve()
        artifact_data_dir = (artifact_data_dir or destination_data_dir).resolve()
        if destination_data_dir.exists() and any(destination_data_dir.iterdir()):
            raise ValueError("workspace_restore_destination_not_empty")
        destination_data_dir.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="tribe-workspace-restore-", dir=destination_data_dir.parent,
        ) as temporary:
            staging = Path(temporary) / "restored"
            staging.mkdir()
            try:
                with zipfile.ZipFile(source) as archive:
                    names = archive.namelist()
                    if len(names) != len(set(names)) or "manifest.json" not in names:
                        raise ValueError("workspace_backup_archive_invalid")
                    manifest_info = archive.getinfo("manifest.json")
                    if manifest_info.file_size > 5_000_000:
                        raise ValueError("workspace_backup_manifest_too_large")
                    database_info = archive.getinfo("tribe.sqlite3")
                    if database_info.file_size > 2_000_000_000:
                        raise ValueError("workspace_backup_database_too_large")
                    manifest = json.loads(archive.read("manifest.json"))
                    if (not isinstance(manifest, dict)
                            or manifest.get("format") != "tribe-workspace-backup" or manifest.get("version") != 1
                            or manifest.get("database") != "tribe.sqlite3"
                            or not isinstance(manifest.get("artifacts"), list)):
                        raise ValueError("workspace_backup_manifest_invalid")
                    artifact_entries = manifest["artifacts"]
                    expected_names = {"manifest.json", "tribe.sqlite3"}
                    agent_state = manifest.get("agentState")
                    if agent_state is not None:
                        if (not isinstance(agent_state, dict) or agent_state.get("path") != "agent_steps.sqlite3"
                                or not isinstance(agent_state.get("sha256"), str)
                                or len(agent_state["sha256"]) != 64):
                            raise ValueError("workspace_backup_agent_state_invalid")
                        agent_state_size = agent_state.get("size")
                        if (not isinstance(agent_state_size, int) or isinstance(agent_state_size, bool)
                                or not 0 <= agent_state_size <= 2_000_000_000
                                or archive.getinfo(agent_state["path"]).file_size != agent_state_size):
                            raise ValueError("workspace_backup_agent_state_invalid")
                        expected_names.add(agent_state["path"])
                    total_artifact_bytes = 0
                    for index, item in enumerate(artifact_entries):
                        if not isinstance(item, dict) or item.get("path") != f"artifacts/{index:08d}.bin":
                            raise ValueError("workspace_backup_artifact_manifest_invalid")
                        if (not isinstance(item.get("id"), str) or not isinstance(item.get("missionId"), str)
                                or not isinstance(item.get("name"), str) or not isinstance(item.get("sha256"), str)
                                or len(item["sha256"]) != 64):
                            raise ValueError("workspace_backup_artifact_manifest_invalid")
                        size = item.get("size")
                        if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= 10_000_000:
                            raise ValueError("workspace_backup_artifact_size_invalid")
                        if archive.getinfo(item["path"]).file_size != size:
                            raise ValueError("workspace_backup_artifact_size_invalid")
                        total_artifact_bytes += size
                        expected_names.add(item["path"])
                    if total_artifact_bytes > 2_000_000_000 or set(names) != expected_names:
                        raise ValueError("workspace_backup_archive_contents_invalid")
                    database_path = staging / "tribe.sqlite3"
                    with archive.open("tribe.sqlite3") as database_source, database_path.open("wb") as database_target:
                        shutil.copyfileobj(database_source, database_target)
                    artifacts_root = staging / "artifacts"
                    artifacts_root.mkdir()
                    for item in artifact_entries:
                        payload = archive.read(item["path"])
                        if len(payload) != item["size"] or hashlib.sha256(payload).hexdigest() != item["sha256"]:
                            raise ValueError("workspace_backup_artifact_checksum_failed")
                        (artifacts_root / Path(item["path"]).name).write_bytes(payload)
                    if agent_state is not None:
                        agent_state_path = staging / agent_state["path"]
                        with archive.open(agent_state["path"]) as archive_source, agent_state_path.open("wb") as target:
                            shutil.copyfileobj(archive_source, target)
                        if (_sha256_file(agent_state_path) != agent_state["sha256"]
                                or agent_state_path.stat().st_size != agent_state["size"]):
                            raise ValueError("workspace_backup_agent_state_checksum_failed")
            except (zipfile.BadZipFile, KeyError, json.JSONDecodeError) as error:
                raise ValueError("workspace_backup_archive_invalid") from error

            try:
                with closing(sqlite3.connect(staging / "tribe.sqlite3")) as db:
                    version = db.execute("PRAGMA user_version").fetchone()[0]
                    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
                    if version > SCHEMA_VERSION or integrity != "ok":
                        raise ValueError("workspace_backup_database_invalid")
                    rows = db.execute("SELECT id,mission_id FROM artifacts ORDER BY mission_id,id").fetchall()
                    declared = sorted((item["id"], item["missionId"]) for item in artifact_entries)
                    if sorted((row[0], row[1]) for row in rows) != declared:
                        raise ValueError("workspace_backup_artifact_index_mismatch")
                    for item in artifact_entries:
                        try:
                            artifact_id = str(uuid.UUID(item["id"]))
                            mission_id = str(uuid.UUID(item["missionId"]))
                        except (ValueError, TypeError, AttributeError) as error:
                            raise ValueError("workspace_backup_artifact_identity_invalid") from error
                        content_path = artifact_data_dir / "artifacts" / mission_id / artifact_id
                        db.execute("UPDATE artifacts SET path=? WHERE id=?", (str(content_path), artifact_id))
                    db.commit()
                    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise ValueError("workspace_backup_database_invalid")
                if (staging / "agent_steps.sqlite3").exists():
                    with closing(sqlite3.connect(staging / "agent_steps.sqlite3")) as db:
                        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                            raise ValueError("workspace_backup_agent_state_invalid")
            except sqlite3.DatabaseError as error:
                raise ValueError("workspace_backup_database_invalid") from error
            target_artifacts = staging / "artifacts"
            target_artifacts.mkdir(exist_ok=True)
            for index, item in enumerate(artifact_entries):
                artifact_id = str(uuid.UUID(item["id"]))
                mission_id = str(uuid.UUID(item["missionId"]))
                mission_root = target_artifacts / mission_id
                mission_root.mkdir(exist_ok=True)
                (staging / "artifacts" / f"{index:08d}.bin").replace(mission_root / artifact_id)
            destination_data_dir.parent.mkdir(parents=True, exist_ok=True)
            if destination_data_dir.exists():
                destination_data_dir.rmdir()
            staging.replace(destination_data_dir)
        return cls(destination_data_dir / "tribe.sqlite3")

    def _initialise(self) -> None:
        with self._connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"Database schema version {version} is newer than this runtime supports ({SCHEMA_VERSION})"
                )
            db.execute("PRAGMA journal_mode = WAL")
            if version == SCHEMA_VERSION:
                return
            if version == 1:
                try:
                    db.executescript("""
                    BEGIN IMMEDIATE;
                    ALTER TABLE projects ADD COLUMN goal TEXT NOT NULL DEFAULT '';
                    UPDATE projects SET goal = COALESCE(
                        (SELECT goal FROM missions WHERE missions.project_id = projects.id
                         ORDER BY missions.created_at ASC LIMIT 1), ''
                    );
                    COMMIT;
                    """)
                    version = 2
                except Exception:
                    if db.in_transaction:
                        db.rollback()
                    raise
            if version == 2:
                try:
                    db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS deferred_tool_approvals (
                        interaction_id TEXT PRIMARY KEY,
                        mission_id TEXT NOT NULL,
                        agent_id TEXT NOT NULL,
                        trigger_sequence INTEGER NOT NULL,
                        conversation_id TEXT NOT NULL,
                        tool_call_id TEXT NOT NULL,
                        tool_name TEXT NOT NULL,
                        tool_arguments TEXT NOT NULL,
                        message_history TEXT NOT NULL,
                        target TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS deferred_tool_approvals_agent
                        ON deferred_tool_approvals(mission_id, agent_id, status, trigger_sequence);
                    PRAGMA user_version = 3;
                    COMMIT;
                    """)
                    version = 3
                except Exception:
                    if db.in_transaction:
                        db.rollback()
                    raise
            if version == 3:
                try:
                    db.executescript("""
                    BEGIN IMMEDIATE;
                    ALTER TABLE deferred_tool_approvals ADD COLUMN run_id TEXT NOT NULL DEFAULT '';
                    PRAGMA user_version = 4;
                    COMMIT;
                    """)
                    version = 4
                except Exception:
                    if db.in_transaction:
                        db.rollback()
                    raise
            try:
                db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, repository TEXT NOT NULL,
                    goal TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_reference_files (
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    relative_path TEXT NOT NULL, added_at TEXT NOT NULL,
                    PRIMARY KEY(project_id, relative_path)
                );
                CREATE TABLE IF NOT EXISTS project_agent_roles (
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    agent_id TEXT NOT NULL,
                    added_at TEXT NOT NULL,
                    PRIMARY KEY(project_id, agent_id)
                );
                CREATE TABLE IF NOT EXISTS missions (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, background INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                    project_id TEXT NOT NULL, mission_id TEXT NOT NULL, event_type TEXT NOT NULL,
                    actor_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS events_mission_sequence ON events(mission_id, sequence);
                CREATE UNIQUE INDEX IF NOT EXISTS projects_repository_unique ON projects(repository);
                CREATE TABLE IF NOT EXISTS work_items (
                    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, title TEXT NOT NULL,
                    detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ready',
                    owner TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS work_claims ON work_items(mission_id, status, lease_until);
                CREATE TABLE IF NOT EXISTS work_item_dependencies (
                    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
                    depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
                    PRIMARY KEY(work_item_id, depends_on_id), CHECK(work_item_id != depends_on_id)
                );
                CREATE INDEX IF NOT EXISTS work_item_dependency_parent ON work_item_dependencies(depends_on_id);
                CREATE TABLE IF NOT EXISTS interactions (
                    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, interaction_type TEXT NOT NULL,
                    title TEXT NOT NULL, details TEXT NOT NULL, target TEXT,
                    status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL,
                    created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, name TEXT NOT NULL,
                    media_type TEXT NOT NULL, path TEXT NOT NULL, created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS artifacts_mission_created_id
                    ON artifacts(mission_id, created_at DESC, id DESC);
                CREATE TABLE IF NOT EXISTS artifact_review_threads (
                    id TEXT PRIMARY KEY,
                    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                    mission_id TEXT NOT NULL,
                    version_hash TEXT NOT NULL,
                    anchor_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_by TEXT,
                    resolved_at TEXT
                );
                CREATE INDEX IF NOT EXISTS artifact_review_threads_artifact
                    ON artifact_review_threads(artifact_id, created_at, id);
                CREATE TABLE IF NOT EXISTS artifact_review_comments (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL REFERENCES artifact_review_threads(id) ON DELETE CASCADE,
                    body TEXT NOT NULL,
                    author_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS artifact_review_comments_thread
                    ON artifact_review_comments(thread_id, created_at, id);
                CREATE TABLE IF NOT EXISTS canvas_documents (
                    id TEXT PRIMARY KEY,
                    mission_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('markdown','text','code','diagram')),
                    language TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL,
                    author TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS canvas_documents_mission_updated
                    ON canvas_documents(mission_id, updated_at DESC, id);
                CREATE TABLE IF NOT EXISTS mission_canvas_links (
                    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
                    artifact_id TEXT NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
                    linked_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(mission_id, artifact_id)
                );
                CREATE INDEX IF NOT EXISTS mission_canvas_links_artifact
                    ON mission_canvas_links(artifact_id, mission_id);
                CREATE TABLE IF NOT EXISTS canvas_versions (
                    artifact_id TEXT NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
                    mission_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('markdown','text','code','diagram')),
                    language TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL,
                    author TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    PRIMARY KEY(artifact_id, revision)
                );
                CREATE TABLE IF NOT EXISTS canvas_proposals (
                    id TEXT PRIMARY KEY,
                    artifact_id TEXT NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
                    mission_id TEXT NOT NULL,
                    base_revision INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('markdown','text','code','diagram')),
                    language TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL,
                    author TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','accepted','dismissed','stale')),
                    source_event_sequence INTEGER,
                    reviewed_by TEXT,
                    reviewed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS canvas_proposals_mission_status
                    ON canvas_proposals(mission_id, status, created_at DESC);
                CREATE TABLE IF NOT EXISTS canvas_comment_threads (
                    id TEXT PRIMARY KEY,
                    artifact_id TEXT NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
                    mission_id TEXT NOT NULL,
                    base_revision INTEGER NOT NULL,
                    start_offset INTEGER,
                    end_offset INTEGER,
                    quote TEXT NOT NULL DEFAULT '',
                    assignee TEXT,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    resolved_by TEXT
                );
                CREATE INDEX IF NOT EXISTS canvas_comment_threads_artifact
                    ON canvas_comment_threads(artifact_id, resolved_at, created_at);
                CREATE TABLE IF NOT EXISTS canvas_comments (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL REFERENCES canvas_comment_threads(id) ON DELETE CASCADE,
                    artifact_id TEXT NOT NULL,
                    mission_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    author TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    source_event_sequence INTEGER
                );
                CREATE INDEX IF NOT EXISTS canvas_comments_thread
                    ON canvas_comments(thread_id, created_at, id);
                CREATE TABLE IF NOT EXISTS agent_offsets (
                    agent_id TEXT NOT NULL, mission_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                    updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, mission_id)
                );
                CREATE TABLE IF NOT EXISTS agent_event_runs (
                    agent_id TEXT NOT NULL, mission_id TEXT NOT NULL,
                    trigger_sequence INTEGER NOT NULL, status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0, output_text TEXT NOT NULL DEFAULT '',
                    work_item_id TEXT, error TEXT, usage_model TEXT,
                    requests INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(agent_id, mission_id, trigger_sequence)
                );
                CREATE TABLE IF NOT EXISTS isolated_workspaces (
                    mission_id TEXT NOT NULL, agent_id TEXT NOT NULL, repository TEXT NOT NULL,
                    path TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY(mission_id, agent_id)
                );
                CREATE TABLE IF NOT EXISTS integration_requests (
                    interaction_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
                    paths TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS approval_consumptions (
                    interaction_id TEXT PRIMARY KEY, consumed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS repository_file_deletion_approvals (
                    interaction_id TEXT PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
                    sha256 TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS repository_file_deletions (
                    approval_id TEXT PRIMARY KEY,
                    mission_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'started',
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    diff_content BLOB,
                    diff_name TEXT,
                    diff_media_type TEXT,
                    diff_skipped_reason TEXT,
                    diff_artifact_id TEXT
                );
                CREATE INDEX IF NOT EXISTS repository_file_deletions_status
                    ON repository_file_deletions(status, mission_id);
                CREATE TABLE IF NOT EXISTS deferred_tool_approvals (
                    interaction_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL, trigger_sequence INTEGER NOT NULL,
                    run_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL, tool_arguments TEXT NOT NULL,
                    message_history TEXT NOT NULL, target TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS deferred_tool_approvals_agent
                    ON deferred_tool_approvals(mission_id, agent_id, status, trigger_sequence);
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_knowledge (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    title TEXT NOT NULL, content TEXT NOT NULL, created_by TEXT NOT NULL,
                    updated_at TEXT NOT NULL, UNIQUE(project_id, title)
                );
                CREATE TABLE IF NOT EXISTS knowledge_proposals (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    mission_id TEXT NOT NULL REFERENCES missions(id), title TEXT NOT NULL,
                    content TEXT NOT NULL, proposed_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                    source_event_sequence INTEGER, created_at TEXT NOT NULL,
                    reviewed_by TEXT, reviewed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS knowledge_proposals_project
                    ON knowledge_proposals(project_id,status,created_at DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS knowledge_proposals_pending_unique
                    ON knowledge_proposals(project_id,title) WHERE status='pending';
                CREATE TABLE IF NOT EXISTS background_runs (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mission_id TEXT NOT NULL,
                    argv TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER,
                    status TEXT NOT NULL, exit_code INTEGER, output TEXT NOT NULL DEFAULT '',
                    started_at TEXT NOT NULL, finished_at TEXT
                );
                CREATE INDEX IF NOT EXISTS background_runs_mission
                    ON background_runs(mission_id, started_at DESC);
                CREATE TABLE IF NOT EXISTS project_usage_budgets (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    monthly_tokens_limit INTEGER, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_web_access (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    allowed_domains TEXT NOT NULL DEFAULT '[]',
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_computer_access (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_interactive_access (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_command_tools (
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    executable TEXT NOT NULL, added_at TEXT NOT NULL,
                    PRIMARY KEY(project_id, executable)
                );
                CREATE TABLE IF NOT EXISTS usage_reservations (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    mission_id TEXT NOT NULL REFERENCES missions(id), agent_id TEXT NOT NULL,
                    trigger_sequence INTEGER NOT NULL, attempt INTEGER NOT NULL,
                    period TEXT NOT NULL, reserved_tokens INTEGER NOT NULL,
                    actual_tokens INTEGER, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(agent_id, mission_id, trigger_sequence, attempt)
                );
                CREATE INDEX IF NOT EXISTS usage_reservations_period
                    ON usage_reservations(project_id, period, status);
                CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    title TEXT NOT NULL, prompt TEXT NOT NULL, cadence TEXT NOT NULL,
                    timezone TEXT NOT NULL, delivery_time TEXT NOT NULL DEFAULT '09:00',
                    next_run_at TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, next_run_at);
                CREATE TABLE IF NOT EXISTS scheduled_runs (
                    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id),
                    mission_id TEXT NOT NULL REFERENCES missions(id), scheduled_for TEXT NOT NULL,
                    started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error TEXT
                );
                CREATE INDEX IF NOT EXISTS scheduled_runs_history
                    ON scheduled_runs(schedule_id, started_at DESC, id DESC);
                """)
                mission_columns = {row[1] for row in db.execute("PRAGMA table_info(missions)")}
                if "background" not in mission_columns:
                    db.execute("ALTER TABLE missions ADD COLUMN background INTEGER NOT NULL DEFAULT 0")
                if "archived_at" not in mission_columns:
                    db.execute("ALTER TABLE missions ADD COLUMN archived_at TEXT")
                for column, definition in (
                    ("recipe_id", "TEXT"),
                    ("recipe_version", "INTEGER"),
                    ("recipe_snapshot", "TEXT"),
                    ("model_preference", "TEXT"),
                    ("effort_preference", "TEXT"),
                    ("blocked_reason", "TEXT"),
                    ("blocked_at", "TEXT"),
                ):
                    if column not in mission_columns:
                        db.execute(f"ALTER TABLE missions ADD COLUMN {column} {definition}")
                run_columns = {row[1] for row in db.execute("PRAGMA table_info(agent_event_runs)")}
                for column, definition in (
                    ("usage_model", "TEXT"),
                    ("requests", "INTEGER NOT NULL DEFAULT 0"),
                    ("tool_calls", "INTEGER NOT NULL DEFAULT 0"),
                    ("input_tokens", "INTEGER NOT NULL DEFAULT 0"),
                    ("output_tokens", "INTEGER NOT NULL DEFAULT 0"),
                    ("cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"),
                    ("cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"),
                    ("cost_usd", "TEXT"),
                ):
                    if column not in run_columns:
                        db.execute(f"ALTER TABLE agent_event_runs ADD COLUMN {column} {definition}")
                project_columns = {row[1] for row in db.execute("PRAGMA table_info(projects)")}
                if "goal" not in project_columns:
                    db.execute("ALTER TABLE projects ADD COLUMN goal TEXT NOT NULL DEFAULT ''")
                    db.execute("""
                        UPDATE projects SET goal = COALESCE(
                            (SELECT goal FROM missions WHERE missions.project_id = projects.id
                             ORDER BY missions.created_at ASC LIMIT 1), ''
                        )
                    """)
                knowledge_columns = {row[1] for row in db.execute("PRAGMA table_info(project_knowledge)")}
                for column, definition in (
                    ("source_mission_id", "TEXT"),
                    ("source_event_sequence", "INTEGER"),
                    ("created_at", "TEXT NOT NULL DEFAULT ''"),
                    ("updated_by", "TEXT NOT NULL DEFAULT 'user'"),
                    ("status", "TEXT NOT NULL DEFAULT 'active'"),
                ):
                    if column not in knowledge_columns:
                        db.execute(f"ALTER TABLE project_knowledge ADD COLUMN {column} {definition}")
                db.execute("UPDATE project_knowledge SET created_at=updated_at WHERE created_at=''")
                schedule_columns = {row[1] for row in db.execute("PRAGMA table_info(schedules)")}
                if "delivery_time" not in schedule_columns:
                    db.execute("ALTER TABLE schedules ADD COLUMN delivery_time TEXT NOT NULL DEFAULT '09:00'")
                    for row in db.execute("SELECT id, timezone, next_run_at FROM schedules WHERE cadence IN ('daily','weekly')"):
                        try:
                            local_due = datetime.fromisoformat(row["next_run_at"]).astimezone(ZoneInfo(row["timezone"]))
                            delivery_time = local_due.strftime("%H:%M")
                        except (ValueError, ZoneInfoNotFoundError):
                            delivery_time = "09:00"
                        db.execute("UPDATE schedules SET delivery_time=? WHERE id=?", (delivery_time, row["id"]))
                usage_budget_columns = {row[1] for row in db.execute("PRAGMA table_info(project_usage_budgets)")}
                if "max_run_cost_usd" not in usage_budget_columns:
                    db.execute("ALTER TABLE project_usage_budgets ADD COLUMN max_run_cost_usd TEXT")
                if "max_run_tokens" not in usage_budget_columns:
                    db.execute("ALTER TABLE project_usage_budgets ADD COLUMN max_run_tokens INTEGER")
                deletion_columns = {
                    row[1] for row in db.execute("PRAGMA table_info(repository_file_deletions)")
                }
                for column, definition in (
                    ("diff_content", "BLOB"),
                    ("diff_name", "TEXT"),
                    ("diff_media_type", "TEXT"),
                    ("diff_skipped_reason", "TEXT"),
                    ("diff_artifact_id", "TEXT"),
                ):
                    if column not in deletion_columns:
                        db.execute(
                            f"ALTER TABLE repository_file_deletions ADD COLUMN {column} {definition}"
                        )
                db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                db.commit()
            except Exception:
                if db.in_transaction:
                    db.rollback()
                raise

    @staticmethod
    def _append(db: sqlite3.Connection, event_type: str, actor_id: str, mission_id: str,
                payload: dict[str, Any]) -> dict[str, Any]:
        mission = db.execute("SELECT project_id,archived_at FROM missions WHERE id = ?", (mission_id,)).fetchone()
        if not mission:
            raise ValueError("mission_not_found")
        if mission["archived_at"] and event_type not in {"mission.archived", "mission.restored"}:
            raise ValueError("mission_archived")
        event = {
            "id": str(uuid.uuid4()), "missionId": mission_id, "type": event_type,
            "actorId": actor_id, "payload": payload, "createdAt": now(),
        }
        cursor = db.execute(
            "INSERT INTO events(id, project_id, mission_id, event_type, actor_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (event["id"], mission["project_id"], mission_id, event_type, actor_id, json.dumps(payload), event["createdAt"]),
        )
        event["sequence"] = cursor.lastrowid
        return event

    @staticmethod
    def _auto_block_mission_for_user_request(
        db: sqlite3.Connection, mission_id: str, actor_id: str,
    ) -> dict[str, Any] | None:
        mission = db.execute(
            "SELECT status,blocked_reason FROM missions WHERE id=?", (mission_id,)
        ).fetchone()
        if not mission or mission["status"] != "active":
            return None
        timestamp = now()
        work_available = db.execute(
            """SELECT 1 FROM work_items item
               WHERE item.mission_id=?
                 AND (item.status='ready' OR (item.status='claimed' AND item.lease_until>=?)
                      OR (item.status='claimed' AND item.lease_until<?))
                 AND NOT EXISTS (
                   SELECT 1 FROM work_item_dependencies links
                   JOIN work_items dependency ON dependency.id=links.depends_on_id
                   WHERE links.work_item_id=item.id AND dependency.status!='done'
                 ) LIMIT 1""",
            (mission_id, timestamp, timestamp),
        ).fetchone()
        if mission["blocked_reason"]:
            if mission["blocked_reason"].startswith("Waiting for your response:") and work_available:
                db.execute("UPDATE missions SET blocked_reason=NULL,blocked_at=NULL WHERE id=?", (mission_id,))
                return MissionStore._append(db, "mission.unblocked", actor_id, mission_id, {
                    "reason": "runnable plan work became available",
                })
            return None
        request = db.execute(
            "SELECT id,title FROM interactions WHERE mission_id=? AND status='pending' ORDER BY created_at,id LIMIT 1",
            (mission_id,),
        ).fetchone()
        if not request:
            return None
        if work_available:
            return None
        reason = f"Waiting for your response: {request['title']}"
        db.execute("UPDATE missions SET blocked_reason=?,blocked_at=? WHERE id=?",
                   (reason, timestamp, mission_id))
        return MissionStore._append(db, "mission.blocked", actor_id, mission_id, {
            "reason": reason, "pendingRequests": [{"id": request["id"], "title": request["title"]}],
            "inferred": True,
        })

    def append(self, event_type: str, actor_id: str, mission_id: str,
               payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            event = self._append(db, event_type, actor_id, mission_id, payload)
            db.commit()
        return event

    def bootstrap(self, project_id: str | None = None, mission_id: str | None = None,
                  select_default_mission: bool = True) -> dict[str, Any]:
        with self._connect() as db:
            projects = [dict(row) for row in db.execute("SELECT * FROM projects ORDER BY created_at DESC")]
            references_by_project: dict[str, list[str]] = {}
            for row in db.execute("SELECT project_id,relative_path FROM project_reference_files ORDER BY relative_path COLLATE NOCASE"):
                references_by_project.setdefault(row["project_id"], []).append(row["relative_path"])
            for item in projects:
                item["referenceFiles"] = references_by_project.get(item["id"], [])
            missions_by_project: dict[str, list[dict[str, Any]]] = {}
            for row in db.execute("SELECT * FROM missions ORDER BY created_at DESC"):
                missions_by_project.setdefault(row["project_id"], []).append(dict(row))
            for item in projects:
                item["missions"] = missions_by_project.get(item["id"], [])
            project = next((item for item in projects if item["id"] == project_id), None) if project_id else None
            project = project or next((item for item in projects if item["repository"] == str(Path.cwd().resolve())), None) or (projects[0] if projects else None)
            if project is None:
                return {"project": None, "projects": [], "mission": None, "missions": [], "events": [], "hasMoreEvents": False, "workItems": [], "interactions": [], "artifacts": [], "commandRuns": [], "knowledge": [], "knowledgeProposals": [], "cursor": 0}
            missions = missions_by_project.get(project["id"], [])
            mission = next((item for item in missions if item["id"] == mission_id), None) if mission_id else None
            if select_default_mission:
                mission = mission or next((item for item in missions if not item.get("archived_at") and item["status"] == "active" and not item.get("background")), None) or next((item for item in missions if not item.get("archived_at") and item["status"] == "active"), None) or next((item for item in missions if not item.get("archived_at")), None)
            if mission and json.loads(mission.get("recipe_snapshot") or "{}").get("id") == "goal-driven-sdlc":
                mission["workflow_context"] = self._workflow_context(db, mission["id"])
            cursor = db.execute("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE mission_id = ?", (mission["id"],)).fetchone()[0] if mission else 0
            events, has_more_events = self._events_before(db, mission["id"], cursor + 1, 200) if mission else ([], False)
            return {
                "project": project,
                "projects": projects,
                "mission": mission,
                "missions": missions,
                "events": events,
                "hasMoreEvents": has_more_events,
                "workItems": [self._work_item(db, row) for row in db.execute(
                    "SELECT * FROM work_items WHERE mission_id = ? ORDER BY created_at, id", (mission["id"],))] if mission else [],
                "interactions": [dict(row) for row in db.execute("SELECT * FROM interactions WHERE mission_id = ? AND status = 'pending' ORDER BY created_at", (mission["id"],))] if mission else [],
                "artifacts": [dict(row) for row in db.execute("SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at DESC", (mission["id"],))] if mission else [],
                "commandRuns": [self._background_run(dict(row)) for row in db.execute(
                    "SELECT * FROM background_runs WHERE mission_id = ? ORDER BY started_at DESC", (mission["id"],)
                )] if mission else [],
                "knowledge": [dict(row) for row in db.execute(
                    """SELECT k.*,m.title AS source_mission_title FROM project_knowledge k
                       LEFT JOIN missions m ON m.id=k.source_mission_id
                       WHERE k.project_id=? ORDER BY k.title COLLATE NOCASE""",
                    (project["id"],),
                )],
                "knowledgeProposals": [dict(row) for row in db.execute(
                    """SELECT p.*,m.title AS source_mission_title FROM knowledge_proposals p
                       JOIN missions m ON m.id=p.mission_id WHERE p.project_id=? AND p.status='pending'
                       ORDER BY p.created_at DESC""", (project["id"],),
                )],
                "cursor": cursor,
            }

    @staticmethod
    def _validated_project_reference_files(repository: Path, paths: list[str] | None) -> list[str]:
        if paths is None:
            return []
        if not isinstance(paths, list) or len(paths) > 10:
            raise ValueError("project_reference_files_limit_exceeded")
        root = repository.resolve(strict=True)
        validated: list[str] = []
        for raw_path in paths:
            if not isinstance(raw_path, str) or not raw_path.strip():
                raise ValueError("project_reference_path_invalid")
            normalized = raw_path.strip().replace("\\", "/")
            pure = PurePosixPath(normalized)
            if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
                raise ValueError("project_reference_path_invalid")
            relative_path = pure.as_posix()
            if relative_path in validated:
                continue
            if pure.suffix.lower() not in {".md", ".mdx", ".rst", ".txt"}:
                raise ValueError("project_reference_file_type_unsupported")
            try:
                source = (root / Path(*pure.parts)).resolve(strict=True)
                if not source.is_relative_to(root) or not source.is_file():
                    raise ValueError("project_reference_path_invalid")
                if source.stat().st_size > 15_000:
                    raise ValueError("project_reference_file_too_large")
                source.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as error:
                raise ValueError("project_reference_file_unreadable") from error
            validated.append(relative_path)
        return validated

    @staticmethod
    def _project_reference_files(db: sqlite3.Connection, project_id: str) -> list[str]:
        return [row[0] for row in db.execute(
            "SELECT relative_path FROM project_reference_files WHERE project_id=? ORDER BY relative_path COLLATE NOCASE",
            (project_id,),
        )]

    def project_agent_ids(self, project_id: str, available_agent_ids: list[str] | None = None) -> list[str]:
        with self._connect() as db:
            rows = [row[0] for row in db.execute(
                "SELECT agent_id FROM project_agent_roles WHERE project_id=? ORDER BY added_at, agent_id",
                (project_id,),
            )]
            configured = db.execute(
                "SELECT 1 FROM project_agent_roles WHERE project_id=? LIMIT 1", (project_id,),
            ).fetchone()
        return rows if configured else list(available_agent_ids or [])

    def ensure_project_agent_memberships(self, agent_ids: list[str]) -> None:
        """Snapshot the current workspace roster onto projects without an explicit team."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            projects = [row[0] for row in db.execute("SELECT id FROM projects")]
            for project_id in projects:
                existing = db.execute(
                    "SELECT 1 FROM project_agent_roles WHERE project_id=? LIMIT 1", (project_id,),
                ).fetchone()
                if existing:
                    continue
                db.executemany(
                    "INSERT OR IGNORE INTO project_agent_roles(project_id,agent_id,added_at) VALUES (?,?,?)",
                    [(project_id, agent_id, now()) for agent_id in agent_ids],
                )
            db.commit()

    def remove_agent_from_project_teams(self, agent_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM project_agent_roles WHERE agent_id=?", (agent_id,))

    def set_project_agent_ids(self, project_id: str, agent_ids: list[str],
                              available_agent_ids: list[str], required_agent_id: str) -> list[str]:
        if not isinstance(agent_ids, list) or any(not isinstance(item, str) for item in agent_ids):
            raise ValueError("project_team_invalid")
        selected = list(dict.fromkeys(agent_ids))
        available = set(available_agent_ids)
        if any(agent_id not in available for agent_id in selected):
            raise ValueError("project_team_agent_not_found")
        if required_agent_id not in selected:
            raise ValueError("project_team_planner_required")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                db.rollback()
                raise ValueError("project_not_found")
            db.execute("DELETE FROM project_agent_roles WHERE project_id=?", (project_id,))
            db.executemany(
                "INSERT INTO project_agent_roles(project_id,agent_id,added_at) VALUES (?,?,?)",
                [(project_id, agent_id, now()) for agent_id in selected],
            )
            db.commit()
        return selected

    def create_project(self, repository_path: str, name: str, mission_title: str,
                       goal: str, project_goal: str | None = None,
                       workflow: dict[str, Any] | None = None,
                       reference_files: list[str] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        candidate = Path(repository_path).expanduser().resolve(strict=True)
        if not candidate.is_dir():
            raise ValueError("repository_path_must_be_a_directory")
        check = subprocess.run(["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=False, timeout=5)
        if check.returncode != 0:
            raise ValueError("project_path_must_be_a_git_repository")
        repository = Path(check.stdout.strip()).resolve(strict=True)
        reference_files = self._validated_project_reference_files(repository, reference_files)
        project = {"id": str(uuid.uuid4()), "name": name.strip(), "repository": str(repository),
                   "goal": (project_goal or goal).strip(), "created_at": now(), "referenceFiles": reference_files}
        mission = {"id": str(uuid.uuid4()), "project_id": project["id"], "title": mission_title.strip(),
                   "goal": goal.strip(), "status": "active", "created_at": now()}
        if workflow:
            mission.update({"recipe_id": workflow["id"], "recipe_version": workflow["version"],
                            "recipe_snapshot": json.dumps(workflow, ensure_ascii=False)})
        else:
            mission.update({"recipe_id": None, "recipe_version": None, "recipe_snapshot": None})
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM projects WHERE repository = ?", (str(repository),)).fetchone()
            if existing:
                db.rollback()
                raise ValueError("project_for_repository_already_exists")
            db.execute("INSERT INTO projects(id, name, repository, goal, created_at) VALUES (?, ?, ?, ?, ?)",
                       (project["id"], project["name"], project["repository"], project["goal"], project["created_at"]))
            db.executemany(
                "INSERT INTO project_reference_files(project_id,relative_path,added_at) VALUES (?,?,?)",
                [(project["id"], path, now()) for path in reference_files],
            )
            db.execute("INSERT INTO missions(id,project_id,title,goal,status,created_at,recipe_id,recipe_version,recipe_snapshot) VALUES (?,?,?,?,?,?,?,?,?)",
                       (mission["id"], mission["project_id"], mission["title"], mission["goal"], mission["status"],
                        mission["created_at"], mission["recipe_id"], mission["recipe_version"], mission["recipe_snapshot"]))
            event_payload = {"title": mission["title"], "goal": mission["goal"]}
            if workflow:
                event_payload["workflow"] = workflow
            self._append(db, "mission.created", "user", mission["id"], event_payload)
            if reference_files:
                self._append(db, "project.references.updated", "user", mission["id"], {
                    "referenceFiles": reference_files,
                })
            db.commit()
        return project, mission

    def register_project(self, repository_path: str, name: str) -> dict[str, Any]:
        candidate = Path(repository_path).expanduser().resolve(strict=True)
        if not candidate.is_dir():
            raise ValueError("repository_path_must_be_a_directory")
        check = subprocess.run(["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=False, timeout=5)
        if check.returncode != 0:
            raise ValueError("project_path_must_be_a_git_repository")
        repository = Path(check.stdout.strip()).resolve(strict=True)
        project = {
            "id": str(uuid.uuid4()), "name": name.strip(), "repository": str(repository),
            "goal": "", "created_at": now(), "referenceFiles": [], "missions": [],
        }
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id FROM projects WHERE repository = ?", (str(repository),)).fetchone()
            if existing:
                db.rollback()
                raise ValueError("project_for_repository_already_exists")
            db.execute(
                "INSERT INTO projects(id, name, repository, goal, created_at) VALUES (?, ?, ?, ?, ?)",
                (project["id"], project["name"], project["repository"], project["goal"], project["created_at"]),
            )
            db.commit()
        return project

    def clone_project(self, remote_url: str, parent_path: str, name: str) -> dict[str, Any]:
        remote = remote_url.strip()
        project_name = name.strip()
        name_parts = project_name.replace("\\", "/").split("/")
        if not project_name or len(project_name) > 200 or len(name_parts) != 1 or project_name in {".", ".."}:
            raise ValueError("project_name_invalid")
        if len(remote) > 2048 or not _is_supported_git_remote(remote):
            raise ValueError("repository_url_invalid")
        parent = Path(parent_path).expanduser().resolve(strict=True)
        if not parent.is_dir():
            raise ValueError("clone_destination_must_be_a_directory")
        target = parent / project_name
        if target.exists() or target.is_symlink():
            raise ValueError("clone_destination_already_exists")
        staging = Path(tempfile.mkdtemp(prefix=".tribe-clone-", dir=parent))
        try:
            try:
                result = subprocess.run(
                    ["git", "clone", "--", remote, str(staging)],
                    capture_output=True, text=True, check=False, timeout=300,
                    env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
                )
            except FileNotFoundError as error:
                raise RuntimeError("Git is required to clone a repository.") from error
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("Repository cloning timed out. Check your connection and try again.") from error
            if result.returncode != 0:
                raise RuntimeError("Git could not clone this repository. Check the address and your access.")
            os.replace(staging, target)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return self.register_project(str(target), project_name)

    def update_project_goal(self, project_id: str, mission_id: str, goal: str,
                            reference_files: list[str] | None = None) -> dict[str, Any] | None:
        goal = goal.strip()
        if not goal or len(goal) > 10_000:
            raise ValueError("project_goal_must_be_1_to_10000_characters")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            project = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not project:
                db.rollback()
                return None
            mission = db.execute("SELECT id, project_id FROM missions WHERE id = ?", (mission_id,)).fetchone() if mission_id else None
            if mission_id and (not mission or mission["project_id"] != project_id):
                db.rollback()
                raise ValueError("mission_does_not_belong_to_project")
            event_mission_id = mission["id"] if mission else None
            if event_mission_id is None:
                latest_mission = db.execute(
                    "SELECT id FROM missions WHERE project_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
                    (project_id,),
                ).fetchone()
                event_mission_id = latest_mission["id"] if latest_mission else None
            updated_references = (self._validated_project_reference_files(Path(project["repository"]), reference_files)
                                  if reference_files is not None else self._project_reference_files(db, project_id))
            current_references = self._project_reference_files(db, project_id)
            if project["goal"] != goal:
                db.execute("UPDATE projects SET goal = ? WHERE id = ?", (goal, project_id))
                if event_mission_id:
                    self._append(db, "project.goal.updated", "user", event_mission_id, {"projectGoal": goal})
            if current_references != updated_references:
                db.execute("DELETE FROM project_reference_files WHERE project_id=?", (project_id,))
                db.executemany(
                    "INSERT INTO project_reference_files(project_id,relative_path,added_at) VALUES (?,?,?)",
                    [(project_id, path, now()) for path in updated_references],
                )
                if event_mission_id:
                    self._append(db, "project.references.updated", "user", event_mission_id, {
                        "referenceFiles": updated_references,
                    })
            updated = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            db.commit()
            payload = dict(updated)
            payload["referenceFiles"] = updated_references
            return payload

    def _validate_mission_model_preferences(self, model: str | None, effort: str | None) -> None:
        if model is not None:
            if not isinstance(model, str) or len(model) > 200:
                raise ValueError("model_preference_invalid")
            catalog_entry = next((item for item in self.model_catalog() if item["id"] == model), None)
            if not catalog_entry or not catalog_entry.get("allowed"):
                raise ValueError("model_not_allowed")
            if catalog_entry.get("toolCalling") is False:
                raise ValueError("model_does_not_support_agent_tools")
            supported_efforts = catalog_entry.get("reasoningEfforts")
            if effort is not None and isinstance(supported_efforts, list) and effort not in supported_efforts:
                raise ValueError("model_effort_not_supported")
        if effort is not None and effort not in {"minimal", "low", "medium", "high", "xhigh", "max"}:
            raise ValueError("effort_preference_invalid")
        if effort is not None and model is None:
            default_model = self.get_setting("model")
            default_entry = next((item for item in self.model_catalog() if item["id"] == default_model), None)
            if (default_entry or {}).get("toolCalling") is False:
                raise ValueError("model_does_not_support_agent_tools")
            supported_efforts = (default_entry or {}).get("reasoningEfforts")
            if isinstance(supported_efforts, list) and effort not in supported_efforts:
                raise ValueError("model_effort_not_supported")

    def create_mission(self, project_id: str, title: str, goal: str,
                       workflow: dict[str, Any] | None = None,
                       initial_message: str | None = None,
                       selected_skills: list[str] | None = None,
                       model_preference: str | None = None,
                       effort_preference: str | None = None) -> dict[str, Any]:
        self._validate_mission_model_preferences(model_preference, effort_preference)
        mission = {"id": str(uuid.uuid4()), "project_id": project_id, "title": title,
                   "goal": goal, "status": "active", "created_at": now(),
                   "model_preference": model_preference, "effort_preference": effort_preference}
        if workflow:
            mission.update({
                "recipe_id": workflow["id"], "recipe_version": workflow["version"],
                "recipe_snapshot": json.dumps(workflow, ensure_ascii=False),
            })
        else:
            mission.update({"recipe_id": None, "recipe_version": None, "recipe_snapshot": None})
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            project = db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not project:
                db.rollback()
                raise ValueError("project_not_found")
            active = db.execute("SELECT id, title FROM missions WHERE project_id = ? AND status = 'active' AND background = 0", (mission["project_id"],)).fetchall()
            db.execute("UPDATE missions SET status = 'paused' WHERE project_id = ? AND status = 'active' AND background = 0", (mission["project_id"],))
            for previous in active:
                self._append(db, "mission.paused", "user", previous["id"], {"reason": "another mission was started"})
            db.execute("INSERT INTO missions(id,project_id,title,goal,status,created_at,recipe_id,recipe_version,recipe_snapshot,model_preference,effort_preference) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       (mission["id"], project_id, title, goal, mission["status"], mission["created_at"],
                        mission["recipe_id"], mission["recipe_version"], mission["recipe_snapshot"],
                        model_preference, effort_preference))
            event_payload = {"title": title, "goal": goal}
            if workflow:
                event_payload["workflow"] = workflow
            if selected_skills:
                event_payload["selectedSkills"] = list(dict.fromkeys(selected_skills))
            if model_preference:
                event_payload["modelPreference"] = model_preference
            if effort_preference:
                event_payload["effortPreference"] = effort_preference
            event_payload["hasInitialMessage"] = bool(initial_message)
            self._append(db, "mission.created", "user", mission["id"], event_payload)
            if initial_message:
                self._append(db, "message.created", "user", mission["id"], {
                    "text": initial_message, "recipient": None,
                })
            db.commit()
        return mission

    def activate_mission(self, mission_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id = ?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                return None
            if mission["archived_at"]:
                db.rollback()
                return None
            if mission["status"] == "completed":
                db.rollback()
                return None
            if mission["background"]:
                if mission["status"] == "paused":
                    db.execute("UPDATE missions SET status='active' WHERE id=?", (mission_id,))
                    self._append(db, "mission.resumed", "user", mission_id, {"background": True})
                db.commit()
                updated = dict(mission)
                updated["status"] = "active"
                return updated
            active = db.execute("SELECT id FROM missions WHERE project_id = ? AND status = 'active' AND id != ? AND background = 0", (mission["project_id"], mission_id)).fetchall()
            db.execute("UPDATE missions SET status = 'paused' WHERE project_id = ? AND status = 'active' AND background = 0", (mission["project_id"],))
            for previous in active:
                self._append(db, "mission.paused", "user", previous["id"], {"reason": "another mission was resumed"})
            db.execute("UPDATE missions SET status = 'active' WHERE id = ?", (mission_id,))
            self._append(db, "mission.resumed", "user", mission_id, {})
            db.commit()
            updated = dict(mission)
            updated["status"] = "active"
            return updated

    def pause_mission(self, mission_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id = ?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                return None
            if mission["archived_at"]:
                db.rollback()
                return None
            if mission["status"] == "completed":
                db.commit()
                return dict(mission)
            if mission["status"] == "active":
                db.execute("UPDATE missions SET status = 'paused' WHERE id = ?", (mission_id,))
                self._append(db, "mission.paused", "user", mission_id, {"reason": "paused by user"})
            db.commit()
            updated = dict(mission)
            updated["status"] = "paused"
            return updated

    def archive_mission(self, mission_id: str, actor_id: str = "user") -> dict[str, Any] | None:
        """Hide an inactive mission while retaining its complete history and data."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id = ?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                return None
            if mission["archived_at"]:
                db.commit()
                return dict(mission)
            if mission["status"] == "active" or mission["background"]:
                db.rollback()
                raise ValueError("pause_mission_before_archiving")
            pending_request = db.execute(
                "SELECT 1 FROM interactions WHERE mission_id=? AND status='pending' LIMIT 1", (mission_id,)
            ).fetchone()
            running_agent = db.execute(
                "SELECT 1 FROM agent_event_runs WHERE mission_id=? AND status='running' LIMIT 1", (mission_id,)
            ).fetchone()
            running_command = db.execute(
                "SELECT 1 FROM background_runs WHERE mission_id=? AND status='running' LIMIT 1", (mission_id,)
            ).fetchone()
            if pending_request or running_agent or running_command:
                db.rollback()
                raise ValueError("mission_has_unfinished_work")
            timestamp = now()
            db.execute("UPDATE missions SET archived_at=? WHERE id=?", (timestamp, mission_id))
            self._append(db, "mission.archived", actor_id, mission_id, {"title": mission["title"]})
            updated = dict(db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone())
            db.commit()
            return updated

    def restore_mission(self, mission_id: str, actor_id: str = "user") -> dict[str, Any] | None:
        """Restore an archived mission to its prior paused or completed state."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id = ?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                return None
            if not mission["archived_at"]:
                db.commit()
                return dict(mission)
            db.execute("UPDATE missions SET archived_at=NULL WHERE id=?", (mission_id,))
            self._append(db, "mission.restored", actor_id, mission_id, {"title": mission["title"]})
            updated = dict(db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone())
            db.commit()
            return updated

    def delete_mission(self, mission_id: str) -> dict[str, Any] | None:
        """Permanently remove an archived chat and its chat-owned data."""
        artifact_paths: list[Path] = []
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                return None
            if not mission["archived_at"] or mission["status"] == "active" or mission["background"]:
                db.rollback()
                raise ValueError("archive_chat_before_deleting")
            pending_request = db.execute(
                "SELECT 1 FROM interactions WHERE mission_id=? AND status='pending' LIMIT 1", (mission_id,)
            ).fetchone()
            running_agent = db.execute(
                "SELECT 1 FROM agent_event_runs WHERE mission_id=? AND status IN ('running','cancelling') LIMIT 1",
                (mission_id,),
            ).fetchone()
            running_command = db.execute(
                "SELECT 1 FROM background_runs WHERE mission_id=? AND status='running' LIMIT 1", (mission_id,)
            ).fetchone()
            isolated_work = db.execute(
                "SELECT 1 FROM isolated_workspaces WHERE mission_id=? LIMIT 1", (mission_id,)
            ).fetchone()
            if pending_request or running_agent or running_command:
                db.rollback()
                raise ValueError("chat_has_unfinished_work")
            if isolated_work:
                db.rollback()
                raise ValueError("discard_isolated_work_before_deleting")

            artifact_root = (self.data_dir / "artifacts").resolve()
            for row in db.execute("SELECT path FROM artifacts WHERE mission_id=?", (mission_id,)):
                path = Path(row["path"]).resolve()
                if not path.is_relative_to(artifact_root):
                    db.rollback()
                    raise ValueError("artifact_path_invalid")
                artifact_paths.append(path)

            step_database = self.data_dir / "agent_steps.sqlite3"
            if step_database.is_file():
                db.execute("ATTACH DATABASE ? AS agent_steps", (str(step_database),))
                step_tables = {row[0] for row in db.execute(
                    "SELECT name FROM agent_steps.sqlite_master WHERE type='table'",
                )}
                if "runs" in step_tables:
                    conversations = [row[0] for row in db.execute(
                        "SELECT conversation_id FROM agent_steps.runs WHERE conversation_id IS NOT NULL",
                    ) if row[0].startswith(f"tribe:{mission_id}:")]
                    if conversations:
                        conversation_placeholders = ",".join("?" for _ in conversations)
                        run_ids = [row[0] for row in db.execute(
                            f"SELECT run_id FROM agent_steps.runs WHERE conversation_id IN ({conversation_placeholders})",
                            conversations,
                        )]
                        if run_ids:
                            run_placeholders = ",".join("?" for _ in run_ids)
                            step_media_hashes: set[str] = set()
                            if "snapshots" in step_tables:
                                snapshots = list(db.execute(
                                    f"SELECT seq,messages FROM agent_steps.snapshots WHERE run_id IN ({run_placeholders})",
                                    run_ids,
                                ))
                                snapshot_ids = [row[0] for row in snapshots]
                                if snapshot_ids and "snapshot_message_refs" in step_tables and "snapshot_messages" in step_tables:
                                    snapshot_placeholders = ",".join("?" for _ in snapshot_ids)
                                    for row in db.execute(
                                        "SELECT message FROM agent_steps.snapshot_messages WHERE sha256 IN "
                                        "(SELECT sha256 FROM agent_steps.snapshot_message_refs "
                                        f"WHERE snapshot_seq IN ({snapshot_placeholders}))",
                                        snapshot_ids,
                                    ):
                                        step_media_hashes.update(re.findall(r"media\+sha256://([a-f0-9]{64})", row[0]))
                                for snapshot in snapshots:
                                    step_media_hashes.update(re.findall(r"media\+sha256://([a-f0-9]{64})", snapshot[1] or ""))
                            if "events" in step_tables:
                                for row in db.execute(
                                    f"SELECT metadata FROM agent_steps.events WHERE run_id IN ({run_placeholders})",
                                    run_ids,
                                ):
                                    step_media_hashes.update(re.findall(r"media\+sha256://([a-f0-9]{64})", row[0] or ""))
                            for table in ("events", "snapshots", "snapshot_idempotency_keys", "tool_effects"):
                                if table in step_tables:
                                    db.execute(
                                        f"DELETE FROM agent_steps.{table} WHERE run_id IN ({run_placeholders})",
                                        run_ids,
                                    )
                            db.execute(
                                f"DELETE FROM agent_steps.runs WHERE run_id IN ({run_placeholders})",
                                run_ids,
                            )
                            if "media" in step_tables:
                                for media_hash in step_media_hashes:
                                    marker = f"%media+sha256://{media_hash}%"
                                    referenced = any(db.execute(
                                        f"SELECT 1 FROM agent_steps.{table} WHERE {column} LIKE ? LIMIT 1",
                                        (marker,),
                                    ).fetchone() for table, column in (
                                        ("snapshot_messages", "message"), ("snapshots", "messages"), ("events", "metadata"),
                                    ) if table in step_tables)
                                    if not referenced:
                                        db.execute("DELETE FROM agent_steps.media WHERE sha256=?", (media_hash,))

            work_item_ids = [row[0] for row in db.execute(
                "SELECT id FROM work_items WHERE mission_id=?", (mission_id,),
            )]
            if work_item_ids:
                placeholders = ",".join("?" for _ in work_item_ids)
                db.execute(
                    f"DELETE FROM work_item_dependencies WHERE work_item_id IN ({placeholders}) "
                    f"OR depends_on_id IN ({placeholders})",
                    (*work_item_ids, *work_item_ids),
                )

            tables = [row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )]
            for table in tables:
                if table in {"missions", "projects", "work_item_dependencies"}:
                    continue
                columns = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
                if "mission_id" in columns:
                    safe_table = table.replace('"', '""')
                    db.execute(f'DELETE FROM "{safe_table}" WHERE mission_id=?', (mission_id,))
            db.execute("DELETE FROM missions WHERE id=?", (mission_id,))
            db.commit()
            if step_database.is_file():
                db.execute("DETACH DATABASE agent_steps")

        for path in artifact_paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        artifact_directory = (self.data_dir / "artifacts" / mission_id)
        try:
            artifact_directory.rmdir()
        except OSError:
            pass
        return {"id": mission_id, "title": mission["title"]}

    def delete_project(self, project_id: str) -> dict[str, Any] | None:
        """Delete a project's Tribe data and chats while leaving its repository untouched."""
        artifact_paths: list[Path] = []
        mission_ids: list[str] = []
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            project = db.execute("SELECT id,name FROM projects WHERE id=?", (project_id,)).fetchone()
            if not project:
                db.rollback()
                return None
            mission_ids = [row[0] for row in db.execute(
                "SELECT id FROM missions WHERE project_id=?", (project_id,),
            )]
            if mission_ids:
                placeholders = ",".join("?" for _ in mission_ids)
                unfinished = any(db.execute(query, tuple(mission_ids)).fetchone() for query in (
                    f"SELECT 1 FROM interactions WHERE mission_id IN ({placeholders}) AND status='pending' LIMIT 1",
                    f"SELECT 1 FROM agent_event_runs WHERE mission_id IN ({placeholders}) AND status IN ('running','cancelling') LIMIT 1",
                    f"SELECT 1 FROM background_runs WHERE mission_id IN ({placeholders}) AND status='running' LIMIT 1",
                    f"SELECT 1 FROM scheduled_runs WHERE mission_id IN ({placeholders}) AND status IN ('running','paused','blocked') LIMIT 1",
                    f"SELECT 1 FROM isolated_workspaces WHERE mission_id IN ({placeholders}) LIMIT 1",
                    f"SELECT 1 FROM repository_file_deletions WHERE mission_id IN ({placeholders}) AND status='started' LIMIT 1",
                ))
                if unfinished:
                    db.rollback()
                    raise ValueError("project_has_unfinished_work")

                artifact_root = (self.data_dir / "artifacts").resolve()
                for row in db.execute(
                    f"SELECT path FROM artifacts WHERE mission_id IN ({placeholders})", tuple(mission_ids),
                ):
                    path = Path(row["path"]).resolve()
                    if not path.is_relative_to(artifact_root):
                        db.rollback()
                        raise ValueError("artifact_path_invalid")
                    artifact_paths.append(path)

                step_database = self.data_dir / "agent_steps.sqlite3"
                if step_database.is_file():
                    db.execute("ATTACH DATABASE ? AS agent_steps", (str(step_database),))
                    step_tables = {row[0] for row in db.execute(
                        "SELECT name FROM agent_steps.sqlite_master WHERE type='table'",
                    )}
                    run_ids: list[str] = []
                    for mission_id in mission_ids:
                        conversation_prefix = f"tribe:{mission_id}:"
                        run_ids.extend(row[0] for row in db.execute(
                            "SELECT run_id FROM agent_steps.runs WHERE conversation_id LIKE ?",
                            (f"{conversation_prefix}%",),
                        ))
                    for offset in range(0, len(run_ids), 400):
                        batch = run_ids[offset:offset + 400]
                        run_placeholders = ",".join("?" for _ in batch)
                        step_media_hashes: set[str] = set()
                        if "snapshots" in step_tables:
                            snapshots = list(db.execute(
                                f"SELECT seq,messages FROM agent_steps.snapshots WHERE run_id IN ({run_placeholders})",
                                batch,
                            ))
                            snapshot_ids = [row[0] for row in snapshots]
                            for snapshot in snapshots:
                                step_media_hashes.update(re.findall(r"media\+sha256://([a-f0-9]{64})", snapshot[1] or ""))
                            if snapshot_ids and {"snapshot_message_refs", "snapshot_messages"}.issubset(step_tables):
                                snapshot_placeholders = ",".join("?" for _ in snapshot_ids)
                                for row in db.execute(
                                    "SELECT message FROM agent_steps.snapshot_messages WHERE sha256 IN "
                                    "(SELECT sha256 FROM agent_steps.snapshot_message_refs "
                                    f"WHERE snapshot_seq IN ({snapshot_placeholders}))",
                                    snapshot_ids,
                                ):
                                    step_media_hashes.update(re.findall(r"media\+sha256://([a-f0-9]{64})", row[0]))
                        if "events" in step_tables:
                            for row in db.execute(
                                f"SELECT metadata FROM agent_steps.events WHERE run_id IN ({run_placeholders})",
                                batch,
                            ):
                                step_media_hashes.update(re.findall(r"media\+sha256://([a-f0-9]{64})", row[0] or ""))
                        for table in ("events", "snapshots", "snapshot_idempotency_keys", "tool_effects"):
                            if table in step_tables:
                                db.execute(
                                    f"DELETE FROM agent_steps.{table} WHERE run_id IN ({run_placeholders})", batch,
                                )
                        db.execute(f"DELETE FROM agent_steps.runs WHERE run_id IN ({run_placeholders})", batch)
                        if "media" in step_tables:
                            for media_hash in step_media_hashes:
                                marker = f"%media+sha256://{media_hash}%"
                                referenced = any(db.execute(
                                    f"SELECT 1 FROM agent_steps.{table} WHERE {column} LIKE ? LIMIT 1",
                                    (marker,),
                                ).fetchone() for table, column in (
                                    ("snapshot_messages", "message"), ("snapshots", "messages"),
                                    ("events", "metadata"),
                                ) if table in step_tables)
                                if not referenced:
                                    db.execute("DELETE FROM agent_steps.media WHERE sha256=?", (media_hash,))

                work_item_ids = [row[0] for row in db.execute(
                    f"SELECT id FROM work_items WHERE mission_id IN ({placeholders})", tuple(mission_ids),
                )]
                for offset in range(0, len(work_item_ids), 400):
                    batch = work_item_ids[offset:offset + 400]
                    work_placeholders = ",".join("?" for _ in batch)
                    db.execute(
                        f"DELETE FROM work_item_dependencies WHERE work_item_id IN ({work_placeholders}) "
                        f"OR depends_on_id IN ({work_placeholders})", (*batch, *batch),
                    )

                schedule_ids = [row[0] for row in db.execute(
                    "SELECT id FROM schedules WHERE project_id=?", (project_id,),
                )]
                if schedule_ids:
                    schedule_placeholders = ",".join("?" for _ in schedule_ids)
                    db.execute(
                        f"DELETE FROM scheduled_runs WHERE schedule_id IN ({schedule_placeholders})", schedule_ids,
                    )
                tables = [row[0] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )]
                for table in tables:
                    if table in {"missions", "projects", "work_item_dependencies"}:
                        continue
                    safe_table = table.replace('"', '""')
                    columns = {row[1] for row in db.execute(f'PRAGMA table_info("{safe_table}")')}
                    if "mission_id" in columns:
                        for offset in range(0, len(mission_ids), 400):
                            batch = mission_ids[offset:offset + 400]
                            if batch:
                                batch_placeholders = ",".join("?" for _ in batch)
                                db.execute(
                                    f'DELETE FROM "{safe_table}" WHERE mission_id IN ({batch_placeholders})', batch,
                                )
                    elif "schedule_id" in columns and schedule_ids:
                        schedule_placeholders = ",".join("?" for _ in schedule_ids)
                        db.execute(
                            f'DELETE FROM "{safe_table}" WHERE schedule_id IN ({schedule_placeholders})', schedule_ids,
                        )
                    if "project_id" in columns:
                        db.execute(f'DELETE FROM "{safe_table}" WHERE project_id=?', (project_id,))
                db.execute("DELETE FROM missions WHERE project_id=?", (project_id,))
            schedule_ids = [row[0] for row in db.execute(
                "SELECT id FROM schedules WHERE project_id=?", (project_id,),
            )]
            if schedule_ids:
                schedule_placeholders = ",".join("?" for _ in schedule_ids)
                db.execute(
                    f"DELETE FROM scheduled_runs WHERE schedule_id IN ({schedule_placeholders})", schedule_ids,
                )
            for table in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            ):
                table_name = table[0]
                if table_name in {"missions", "projects", "work_item_dependencies"}:
                    continue
                safe_table = table_name.replace('"', '""')
                columns = {row[1] for row in db.execute(f'PRAGMA table_info("{safe_table}")')}
                if "project_id" in columns:
                    db.execute(f'DELETE FROM "{safe_table}" WHERE project_id=?', (project_id,))
                elif "schedule_id" in columns and schedule_ids:
                    schedule_placeholders = ",".join("?" for _ in schedule_ids)
                    db.execute(
                        f'DELETE FROM "{safe_table}" WHERE schedule_id IN ({schedule_placeholders})', schedule_ids,
                    )
            db.execute("DELETE FROM projects WHERE id=?", (project_id,))
            db.commit()

        for path in artifact_paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        artifact_root = (self.data_dir / "artifacts").resolve()
        for mission_id in mission_ids:
            mission_artifacts = (artifact_root / mission_id).resolve()
            if mission_artifacts.is_relative_to(artifact_root):
                shutil.rmtree(mission_artifacts, ignore_errors=True)
        return {"id": project_id, "name": project["name"], "chatCount": len(mission_ids)}

    @staticmethod
    def _schedule_due(cadence: str, zone: ZoneInfo, delivery_time: str, after: datetime) -> datetime:
        local = after.astimezone(zone)
        if cadence == "hourly":
            return after.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        if cadence == "once":
            return after.astimezone(UTC)
        target_time = time.fromisoformat(delivery_time)
        if cadence == "daily":
            day = local.date()
        else:
            day = local.date() + timedelta(days=(7 - local.weekday()) % 7)
        candidate = datetime.combine(day, target_time, tzinfo=zone)
        if candidate <= local:
            day += timedelta(days=1 if cadence == "daily" else 7)
            candidate = datetime.combine(day, target_time, tzinfo=zone)
        return candidate.astimezone(UTC)

    def create_schedule(self, project_id: str, title: str, prompt: str, cadence: str, timezone: str,
                        delivery_time: str = "09:00") -> dict[str, Any]:
        if cadence not in {"hourly", "daily", "weekly", "once"}:
            raise ValueError("cadence_must_be_once_hourly_daily_or_weekly")
        try:
            zone = ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("timezone_must_be_a_valid_IANA_timezone") from error
        try:
            parsed_delivery_time = time.fromisoformat(delivery_time)
            if len(delivery_time) != 5 or parsed_delivery_time.strftime("%H:%M") != delivery_time:
                raise ValueError
        except (TypeError, ValueError) as error:
            raise ValueError("delivery_time_must_be_HH_MM") from error
        current = datetime.now(UTC)
        due = self._schedule_due(cadence, zone, delivery_time, current)
        stamp = now()
        schedule = {"id": str(uuid.uuid4()), "project_id": project_id, "title": title, "prompt": prompt,
                    "cadence": cadence, "timezone": timezone, "delivery_time": delivery_time,
                    "next_run_at": due.isoformat(),
                    "status": "active", "created_at": stamp, "updated_at": stamp}
        with self._lock, self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            db.execute("INSERT INTO schedules (id,project_id,title,prompt,cadence,timezone,delivery_time,next_run_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", tuple(schedule.values()))
        return schedule

    def schedules(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            schedules = [dict(row) for row in db.execute("SELECT * FROM schedules WHERE project_id=? ORDER BY created_at DESC", (project_id,))]
            for schedule in schedules:
                schedule["runs_total"] = db.execute(
                    "SELECT COUNT(*) FROM scheduled_runs WHERE schedule_id=?", (schedule["id"],)
                ).fetchone()[0]
                schedule["runs"] = [dict(row) for row in db.execute(
                    "SELECT scheduled_runs.*, missions.title AS mission_title FROM scheduled_runs "
                    "JOIN missions ON missions.id=scheduled_runs.mission_id "
                    "WHERE schedule_id=? ORDER BY started_at DESC, scheduled_runs.id DESC LIMIT 10",
                    (schedule["id"],)
                )]
            return schedules

    def schedule_runs(self, schedule_id: str, limit: int = 10,
                      before_started_at: str | None = None,
                      before_id: str | None = None) -> dict[str, Any] | None:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise ValueError("schedule_run_limit_must_be_between_1_and_50")
        if (before_started_at is None) != (before_id is None):
            raise ValueError("schedule_run_cursor_requires_started_at_and_id")
        if before_started_at is not None and (
            not isinstance(before_started_at, str) or not before_started_at or len(before_started_at) > 64
            or not isinstance(before_id, str) or not before_id or len(before_id) > 64
        ):
            raise ValueError("schedule_run_cursor_is_invalid")
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM schedules WHERE id=?", (schedule_id,)).fetchone():
                return None
            total = db.execute(
                "SELECT COUNT(*) FROM scheduled_runs WHERE schedule_id=?", (schedule_id,)
            ).fetchone()[0]
            cursor_filter = ""
            parameters: list[Any] = [schedule_id]
            if before_started_at is not None:
                cursor_filter = "AND (started_at < ? OR (started_at = ? AND scheduled_runs.id < ?))"
                parameters.extend((before_started_at, before_started_at, before_id))
            parameters.append(limit + 1)
            rows = db.execute(
                f"""SELECT scheduled_runs.*, missions.title AS mission_title FROM scheduled_runs
                    JOIN missions ON missions.id=scheduled_runs.mission_id
                    WHERE schedule_id=? {cursor_filter}
                    ORDER BY started_at DESC, scheduled_runs.id DESC LIMIT ?""",
                parameters,
            ).fetchall()
            has_more = len(rows) > limit
            runs = [dict(row) for row in rows[:limit]]
            return {"runs": runs, "total": total, "has_more": has_more}

    def update_schedule(self, schedule_id: str, action: str) -> dict[str, Any] | None:
        if action not in {"pause", "resume", "run-now", "cancel"}:
            raise ValueError("invalid_schedule_action")
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone()
            if not row:
                return None
            status = row["status"]
            allowed = {
                "pause": {"active"},
                "resume": {"paused"},
                "run-now": {"active"},
                "cancel": {"active", "paused"},
            }
            if status not in allowed[action]:
                raise ValueError(f"schedule_cannot_{action}_from_{status}")
            if action == "run-now" and db.execute(
                "SELECT 1 FROM scheduled_runs WHERE schedule_id=? AND status IN ('running','paused','blocked')", (schedule_id,)
            ).fetchone():
                raise ValueError("This schedule already has a mission in progress. Resume or finish it before starting another.")
            status = {"pause": "paused", "resume": "active", "run-now": "active", "cancel": "cancelled"}[action]
            due = now() if action == "run-now" else row["next_run_at"]
            db.execute("UPDATE schedules SET status=?, next_run_at=?, updated_at=? WHERE id=?", (status, due, now(), schedule_id))
            return dict(db.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone())

    def claim_due_schedules(self) -> list[dict[str, Any]]:
        claimed = []
        current = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT * FROM schedules s WHERE status='active' AND next_run_at<=? AND NOT EXISTS (SELECT 1 FROM scheduled_runs r WHERE r.schedule_id=s.id AND r.status IN ('running','paused','blocked'))", (current,)).fetchall()
            for schedule in rows:
                mission_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
                title = f"{schedule['title']} · {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M')}"
                db.execute("INSERT INTO missions(id,project_id,title,goal,status,created_at,background) VALUES (?,?,?,?,?,?,1)", (mission_id, schedule["project_id"], title, schedule["prompt"], "active", current))
                event = self._append(db, "mission.created", "scheduler", mission_id, {"title": title, "goal": schedule["prompt"], "scheduleId": schedule["id"], "background": True})
                db.execute("INSERT INTO scheduled_runs VALUES (?,?,?,?,?,?,?,NULL)", (run_id, schedule["id"], mission_id, schedule["next_run_at"], current, None, "running"))
                next_status = "active"
                if next_status == "active":
                    zone = ZoneInfo(schedule["timezone"])
                    due = self._schedule_due(schedule["cadence"], zone, schedule["delivery_time"],
                                             datetime.fromisoformat(current))
                    next_run = due.isoformat()
                else:
                    next_run = schedule["next_run_at"]
                db.execute("UPDATE schedules SET status=?,next_run_at=?,updated_at=? WHERE id=?", (next_status, next_run, current, schedule["id"]))
                claimed.append({"missionId": mission_id, "event": event, "scheduleId": schedule["id"], "runId": run_id})
            db.commit()
        return claimed

    def finish_scheduled_run(self, mission_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE scheduled_runs SET status='completed',finished_at=? WHERE mission_id=? AND status IN ('running','paused','blocked')", (now(), mission_id))

    def reconcile_scheduled_runs(self) -> None:
        """Keep schedule history aligned with the live state of its mission."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                """SELECT run.mission_id,run.schedule_id,run.status,mission.status AS mission_status,
                          mission.blocked_reason
                   FROM scheduled_runs run JOIN missions mission ON mission.id=run.mission_id
                   WHERE run.status IN ('running','paused','blocked')"""
            ).fetchall()
            timestamp = now()
            for run in rows:
                if run["mission_status"] == "completed":
                    status = "completed"
                elif run["mission_status"] == "paused":
                    status = "paused"
                elif run["blocked_reason"]:
                    status = "blocked"
                else:
                    status = "running"
                if status == run["status"]:
                    continue
                finished_at = timestamp if status == "completed" else None
                db.execute(
                    "UPDATE scheduled_runs SET status=?,finished_at=? WHERE mission_id=?",
                    (status, finished_at, run["mission_id"]),
                )
                if status == "completed":
                    db.execute(
                        """UPDATE schedules SET status='completed',updated_at=?
                           WHERE id=? AND cadence='once' AND status IN ('active','paused')""",
                        (timestamp, run["schedule_id"]),
                    )
            db.commit()

    def running_scheduled_missions(self) -> list[str]:
        with self._connect() as db:
            return [row[0] for row in db.execute("SELECT mission_id FROM scheduled_runs WHERE status='running'")]

    def record_review_checkpoint(self, mission_id: str, reviewer_id: str, disposition: str,
                                 summary: str, verification_event_id: str,
                                 findings: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        summary = summary.strip() if isinstance(summary, str) else ""
        findings = findings or []
        if reviewer_id != "reviewer":
            raise PermissionError("only the independent reviewer may record a review checkpoint")
        if not isinstance(disposition, str) or disposition not in {"approved", "changes_requested"}:
            raise ValueError("review_disposition_must_be_approved_or_changes_requested")
        if not summary or len(summary) > 2000:
            raise ValueError("review_checkpoint_requires_a_summary_of_at_most_2000_characters")
        if not isinstance(findings, list) or len(findings) > 20:
            raise ValueError("review_checkpoint_supports_at_most_20_findings")
        normalised_findings: list[dict[str, str]] = []
        for finding in findings:
            if not isinstance(finding, dict):
                raise ValueError("review_findings_must_include_severity_file_and_issue")  # noqa: TRY004
            severity, path, issue = finding.get("severity"), finding.get("file"), finding.get("issue")
            if not isinstance(severity, str) or severity not in {"critical", "high", "medium", "low", "info"}:
                raise ValueError("review_finding_severity_is_invalid")
            if not isinstance(path, str) or not path.strip() or len(path.strip()) > 500:
                raise ValueError("review_finding_requires_a_repository_path")
            if not isinstance(issue, str) or not issue.strip() or len(issue.strip()) > 2000:
                raise ValueError("review_finding_requires_a_concise_issue")
            normalised_findings.append({"severity": severity, "file": path.strip(), "issue": issue.strip()})
        if disposition == "approved" and any(
            finding["severity"] in {"critical", "high"} for finding in normalised_findings
        ):
            raise ValueError("approved_review_cannot_include_critical_or_high_findings")
        if disposition == "changes_requested" and not normalised_findings:
            raise ValueError("changes_requested_requires_at_least_one_finding")

        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT status,recipe_snapshot FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if mission["status"] != "active":
                db.rollback()
                raise ValueError("mission_must_be_active_to_record_review")
            workflow = json.loads(mission["recipe_snapshot"] or "{}")
            if workflow.get("id") != "goal-driven-sdlc":
                db.rollback()
                raise ValueError("review_checkpoints_are_only_available_for_goal_driven_sdlc")
            if not self._current_plan_checkpoint(db, mission_id):
                db.rollback()
                raise ValueError("goal_driven_sdlc_requires_a_finalized_plan_before_review")
            latest_change = db.execute(
                "SELECT id,sequence FROM events WHERE mission_id=? "
                "AND event_type IN ('repo.file.changed','repo.worktree.integrated') "
                "ORDER BY sequence DESC LIMIT 1", (mission_id,),
            ).fetchone()
            latest_test = db.execute(
                "SELECT id,sequence,json_extract(payload,'$.exitCode') AS exit_code "
                "FROM events WHERE mission_id=? AND event_type='repo.test_run.completed' "
                "ORDER BY sequence DESC LIMIT 1", (mission_id,),
            ).fetchone()
            if not latest_test or latest_test["exit_code"] != 0:
                db.rollback()
                raise ValueError("review_requires_latest_test_run_to_pass")
            if latest_test["id"] != verification_event_id:
                db.rollback()
                raise ValueError("review_must_reference_the_latest_successful_test_run")
            if latest_change and latest_test["sequence"] <= latest_change["sequence"]:
                db.rollback()
                raise ValueError("review_verification_must_follow_latest_change")
            unfinished_work = db.execute(
                "SELECT COUNT(*) FROM work_items WHERE mission_id=? AND status!='done'",
                (mission_id,),
            ).fetchone()[0]
            if unfinished_work:
                db.rollback()
                raise ValueError("goal_driven_sdlc_review_requires_all_plan_work_items_done")
            event = self._append(db, "review.checkpoint.recorded", reviewer_id, mission_id, {
                "disposition": disposition,
                "summary": summary,
                "changeEventId": latest_change["id"] if latest_change else None,
                "verificationEventId": latest_test["id"],
                "findings": normalised_findings,
            })
            work_items = []
            if disposition == "changes_requested":
                for finding in normalised_findings:
                    item = {
                        "id": str(uuid.uuid4()), "mission_id": mission_id,
                        "title": f"Address review finding in {finding['file']}"[:500],
                        "detail": f"{finding['severity'].upper()} · {finding['file']}\n{finding['issue']}",
                        "status": "ready", "owner": None, "lease_until": None,
                        "created_at": now(), "updated_at": now(),
                    }
                    db.execute("INSERT INTO work_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(item.values()))
                    item = self._work_item(
                        db, db.execute("SELECT * FROM work_items WHERE id=?", (item["id"],)).fetchone()
                    )
                    work_items.append(item)
                    self._append(db, "plan.item.created", reviewer_id, mission_id, {"workItem": item})
            db.commit()
            return {"event": event, "workItems": work_items}

    def complete_mission(self, mission_id: str, reviewer_id: str, summary: str,
                         acceptance_evidence: list[str] | None = None,
                         evidence_refs: list[str] | None = None, *,
                         acceptance_checks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        summary = summary.strip()
        legacy_evidence = [item.strip() for item in (acceptance_evidence or [])
                           if isinstance(item, str) and item.strip()]
        if not summary or len(summary) > 5000:
            raise ValueError("completion_requires_a_summary_and_1_to_20_acceptance_evidence_items")
        if acceptance_checks is None:
            legacy_refs = [item.strip() for item in (evidence_refs or [])
                           if isinstance(item, str) and item.strip()]
            checks = [{"criterion": criterion, "evidence_refs": legacy_refs}
                      for criterion in legacy_evidence]
        else:
            checks = acceptance_checks
        if not 1 <= len(checks) <= 20:
            raise ValueError("completion_requires_1_to_20_acceptance_checks")
        normalised_checks: list[dict[str, Any]] = []
        for check in checks:
            if not isinstance(check, dict):
                raise ValueError("acceptance_checks_must_map_each_criterion_to_evidence")  # noqa: TRY004
            criterion = check.get("criterion")
            refs = check.get("evidence_refs")
            if not isinstance(criterion, str) or not criterion.strip() or len(criterion.strip()) > 2000:
                raise ValueError("each_acceptance_check_needs_a_concise_criterion")
            if not isinstance(refs, list):
                raise ValueError("each_acceptance_check_needs_evidence_references")  # noqa: TRY004
            references_for_check = list(dict.fromkeys(
                reference.strip() for reference in refs
                if isinstance(reference, str) and reference.strip()
            ))
            if any(len(reference) > 200 for reference in references_for_check):
                raise ValueError("each_acceptance_check_needs_1_to_10_valid_evidence_references")
            if len(references_for_check) > 10:
                raise ValueError("each_acceptance_check_needs_1_to_10_valid_evidence_references")
            normalised_checks.append({"criterion": criterion.strip(), "evidence_refs": references_for_check})
        evidence = [item["criterion"] for item in normalised_checks]
        if any(len(item) > 2000 for item in evidence):
            raise ValueError("acceptance_evidence_items_must_be_at_most_2000_characters")
        references = list(dict.fromkeys(
            reference for check in normalised_checks for reference in check["evidence_refs"]
        ))
        if len(references) > 20:
            raise ValueError("completion_supports_at_most_20_unique_evidence_references")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id = ?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if mission["status"] != "active":
                db.rollback()
                raise ValueError("mission_must_be_active_to_complete")
            tasks = db.execute(
                "SELECT COUNT(*) AS total, SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS unfinished "
                "FROM work_items WHERE mission_id = ?", (mission_id,),
            ).fetchone()
            if not tasks["total"] or tasks["unfinished"]:
                db.rollback()
                raise ValueError("all_mission_work_items_must_be_done_before_completion")
            review = db.execute(
                "SELECT 1 FROM work_items WHERE mission_id = ? AND owner = ? AND status = 'done' LIMIT 1",
                (mission_id, reviewer_id),
            ).fetchone()
            if not review:
                db.rollback()
                raise ValueError("independent_reviewer_must_complete_a_work_item_before_mission_completion")
            pending = db.execute(
                "SELECT 1 FROM interactions WHERE mission_id = ? AND status = 'pending' LIMIT 1",
                (mission_id,),
            ).fetchone()
            if pending:
                db.rollback()
                raise ValueError("resolve_pending_user_requests_before_mission_completion")
            if any(not check["evidence_refs"] for check in normalised_checks):
                db.rollback()
                raise ValueError("each_acceptance_check_needs_1_to_10_valid_evidence_references")
            verified = []
            verified_by_id: dict[str, dict[str, Any]] = {}
            for reference in references:
                event_row = db.execute(
                    "SELECT id,sequence,event_type,actor_id,payload,created_at FROM events WHERE id=? AND mission_id=?",
                    (reference, mission_id),
                ).fetchone()
                if event_row and event_row["event_type"] == "repo.test_run.completed":
                    payload = json.loads(event_row["payload"])
                    if payload.get("exitCode") == 0:
                        command = payload.get("argv")
                        label = " ".join(str(part) for part in command)[:200] if isinstance(command, list) else "Test run"
                        verified.append({"id": reference, "type": "test_run", "label": label or "Test run",
                                         "actor": event_row["actor_id"], "sequence": event_row["sequence"]})
                        verified_by_id[reference] = verified[-1]
                        continue
                if event_row and event_row["event_type"] == "repo.command.completed":
                    payload = json.loads(event_row["payload"])
                    if payload.get("status") == "completed" and payload.get("exitCode") == 0:
                        command = payload.get("argv")
                        label = " ".join(str(part) for part in command)[:200] if isinstance(command, list) else "Command"
                        verified.append({"id": reference, "type": "command", "label": label or "Command",
                                         "actor": event_row["actor_id"], "sequence": event_row["sequence"]})
                        verified_by_id[reference] = verified[-1]
                        continue
                artifact = db.execute(
                    "SELECT id,name,created_by FROM artifacts WHERE id=? AND mission_id=?",
                    (reference, mission_id),
                ).fetchone()
                if artifact:
                    verified.append({"id": artifact["id"], "type": "artifact", "label": artifact["name"],
                                     "actor": artifact["created_by"]})
                    verified_by_id[reference] = verified[-1]
                    continue
                db.rollback()
                raise ValueError("verification_evidence_must_reference_a_mission_artifact_or_successful_run")
            mapped_checks = [{
                "criterion": check["criterion"],
                "evidence": [verified_by_id[reference] for reference in check["evidence_refs"]],
            } for check in normalised_checks]
            workflow = json.loads(mission["recipe_snapshot"] or "{}")
            if workflow.get("id") == "goal-driven-sdlc":
                plan_checkpoint = self._current_plan_checkpoint(db, mission_id)
                if not plan_checkpoint:
                    db.rollback()
                    raise ValueError("goal_driven_sdlc_requires_a_finalized_plan")
                finalized_plan = json.loads(plan_checkpoint["payload"])
                plan_criteria = finalized_plan.get("acceptanceCriteria", [])
                finalized_criteria = [
                    item["criterion"] if isinstance(item, dict) else item
                    for item in plan_criteria
                ]
                submitted_criteria = [check["criterion"] for check in normalised_checks]
                if submitted_criteria != finalized_criteria:
                    db.rollback()
                    raise ValueError("completion_checks_must_match_the_finalized_plan_criteria")
                task_mapping = {
                    item["criterion"]: item.get("workItems", [])
                    for item in plan_criteria if isinstance(item, dict)
                }
                for check in mapped_checks:
                    if check["criterion"] in task_mapping:
                        check["planItems"] = task_mapping[check["criterion"]]
                latest_change = db.execute(
                    "SELECT id,sequence FROM events WHERE mission_id = ? "
                    "AND event_type IN ('repo.file.changed', 'repo.worktree.integrated') "
                    "ORDER BY sequence DESC LIMIT 1",
                    (mission_id,),
                ).fetchone()
                latest_test = db.execute(
                    "SELECT id,sequence,json_extract(payload,'$.exitCode') AS exit_code "
                    "FROM events WHERE mission_id=? AND event_type='repo.test_run.completed' "
                    "ORDER BY sequence DESC LIMIT 1", (mission_id,),
                ).fetchone()
                if not latest_test or latest_test["exit_code"] != 0:
                    db.rollback()
                    raise ValueError("goal_driven_sdlc_requires_latest_test_run_to_pass")
                if latest_change is not None:
                    test_evidence = [item for item in verified if item["type"] == "test_run"]
                    if not test_evidence or latest_test["id"] not in {item["id"] for item in test_evidence}:
                        db.rollback()
                        raise ValueError("goal_driven_sdlc_requires_latest_successful_test_run_after_latest_change")
                    if latest_test["sequence"] <= latest_change["sequence"]:
                        db.rollback()
                        raise ValueError("goal_driven_sdlc_verification_must_follow_latest_change")
                elif not any(item["id"] == latest_test["id"] for item in verified):
                    db.rollback()
                    raise ValueError("goal_driven_sdlc_completion_must_cite_latest_successful_test_run")
                checkpoint = db.execute(
                    "SELECT sequence FROM events WHERE mission_id=? AND event_type='review.checkpoint.recorded' "
                    "AND json_extract(payload,'$.disposition')='approved' "
                    "AND json_extract(payload,'$.verificationEventId')=? "
                    "AND json_extract(payload,'$.changeEventId') IS ? "
                    "ORDER BY sequence DESC LIMIT 1",
                    (mission_id, latest_test["id"], latest_change["id"] if latest_change else None),
                ).fetchone()
                if not checkpoint or checkpoint["sequence"] <= latest_test["sequence"]:
                    db.rollback()
                    raise ValueError("goal_driven_sdlc_requires_approved_review_checkpoint_for_latest_verification")
                reviewer_completion = db.execute(
                    "SELECT MAX(e.sequence) FROM events e "
                    "JOIN work_items w ON w.id = json_extract(e.payload, '$.workItem.id') "
                    "WHERE e.mission_id = ? AND e.event_type = 'plan.item.completed' "
                    "AND w.owner = ? AND w.status = 'done'",
                    (mission_id, reviewer_id),
                ).fetchone()[0]
                if reviewer_completion is None or reviewer_completion <= latest_test["sequence"]:
                    db.rollback()
                    raise ValueError("goal_driven_sdlc_independent_review_must_follow_latest_verification")
            db.execute("UPDATE missions SET status = 'completed' WHERE id = ?", (mission_id,))
            event = self._append(db, "mission.completed", reviewer_id, mission_id, {
                "summary": summary, "acceptanceEvidence": evidence,
                "acceptanceChecks": mapped_checks, "evidenceRefs": verified,
            })
            db.commit()
            completed = dict(mission)
            completed["status"] = "completed"
            return {"mission": completed, "event": event}

    def review_mission_outcome(self, mission_id: str, outcome: str, notes: str = "") -> dict[str, Any]:
        outcome = outcome.strip().lower()
        notes = notes.strip()
        if outcome not in {"accepted", "follow_up", "rejected"}:
            raise ValueError("outcome_must_be_accepted_follow_up_or_rejected")
        if len(notes) > 5000:
            raise ValueError("outcome_notes_must_be_at_most_5000_characters")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT status FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if mission["status"] != "completed":
                db.rollback()
                raise ValueError("mission_must_be_completed_before_outcome_review")
            event = self._append(db, "mission.outcome.reviewed", "user", mission_id, {
                "outcome": outcome,
                "notes": notes,
            })
            db.commit()
        return event

    def mark_mission_blocked(self, mission_id: str, agent_id: str, reason: str) -> dict[str, Any]:
        reason = reason.strip()
        if not reason or len(reason) > 2000:
            raise ValueError("blocked_reason_must_be_1_to_2000_characters")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if mission["status"] != "active":
                db.rollback()
                raise ValueError("only_active_missions_can_be_marked_blocked")
            if mission["blocked_reason"]:
                db.commit()
                return {"mission": dict(mission), "event": None}
            pending = db.execute(
                "SELECT id,title FROM interactions WHERE mission_id=? AND status='pending' ORDER BY created_at,id",
                (mission_id,),
            ).fetchall()
            if not pending:
                db.rollback()
                raise ValueError("mission_block_requires_a_pending_user_request")
            timestamp = now()
            db.execute("UPDATE missions SET blocked_reason=?,blocked_at=? WHERE id=?",
                       (reason, timestamp, mission_id))
            event = self._append(db, "mission.blocked", agent_id, mission_id, {
                "reason": reason,
                "pendingRequests": [{"id": row["id"], "title": row["title"]} for row in pending],
            })
            db.commit()
            updated = dict(mission)
            updated.update(blocked_reason=reason, blocked_at=timestamp)
            return {"mission": updated, "event": event}

    def mission(self, mission_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM missions WHERE id = ?", (mission_id,)).fetchone()
            if not row:
                return None
            mission = dict(row)
            if json.loads(mission.get("recipe_snapshot") or "{}").get("id") == "goal-driven-sdlc":
                mission["workflow_context"] = self._workflow_context(db, mission_id)
            return mission

    def set_mission_model_preferences(
        self, mission_id: str, model: str | None, effort: str | None,
    ) -> dict[str, Any] | None:
        self._validate_mission_model_preferences(model, effort)
        with self._connect() as db:
            db.execute("UPDATE missions SET model_preference=?, effort_preference=? WHERE id=?",
                       (model, effort, mission_id))
            if db.total_changes == 0:
                return None
            row = db.execute("SELECT * FROM missions WHERE id=?", (mission_id,)).fetchone()
            return dict(row) if row else None

    def project(self, project_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not row:
                return None
            project = dict(row)
            project["referenceFiles"] = self._project_reference_files(db, project_id)
            return project

    def mission_ids_for_project(self, project_id: str) -> list[str]:
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            return [row["id"] for row in db.execute(
                "SELECT id FROM missions WHERE project_id = ?", (project_id,),
            )]

    def project_artifacts(self, project_id: str, query: str = "", before: str | None = None,
                          before_id: str | None = None, limit: int = 50) -> dict[str, Any]:
        """List project artifacts newest-first, with stable keyset pagination."""
        query = query.strip()
        if len(query) > 100:
            raise ValueError("artifact_search_too_long")
        if not 1 <= limit <= 100:
            raise ValueError("artifact_page_limit_out_of_range")
        if bool(before) != bool(before_id):
            raise ValueError("artifact_cursor_invalid")
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            filters = ["m.project_id = ?"]
            parameters: list[Any] = [project_id]
            if query:
                filters.append("instr(lower(a.name || ' ' || a.media_type || ' ' || a.created_by || ' ' || m.title), lower(?)) > 0")
                parameters.append(query)
            if before:
                filters.append("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))")
                parameters.extend((before, before, before_id))
            where = " AND ".join(filters)
            total_filters = filters[:1 + bool(query)]
            total_parameters = parameters[:len(total_filters)]
            total = db.execute(
                "SELECT COUNT(*) FROM artifacts a JOIN missions m ON m.id = a.mission_id "
                f"WHERE {' AND '.join(total_filters)}", total_parameters,
            ).fetchone()[0]
            rows = db.execute(
                "SELECT a.id,a.mission_id,a.name,a.media_type,a.created_by,a.created_at,"
                "m.title AS mission_title FROM artifacts a "
                "JOIN missions m ON m.id = a.mission_id "
                f"WHERE {where} ORDER BY a.created_at DESC,a.id DESC LIMIT ?",
                [*parameters, limit + 1],
            ).fetchall()
        has_more = len(rows) > limit
        artifacts = [dict(row) for row in rows[:limit]]
        last = artifacts[-1] if artifacts and has_more else None
        return {
            "artifacts": artifacts,
            "total": total,
            "hasMore": has_more,
            "nextCursor": {"createdAt": last["created_at"], "id": last["id"]} if last else None,
        }

    def write_project_audit_export(self, project_id: str, destination: Path) -> None:
        """Write a portable event archive incrementally, without repository or artifact files."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db, destination.open("w", encoding="utf-8") as output:
            project = db.execute(
                "SELECT id,name,goal,created_at FROM projects WHERE id=?", (project_id,)
            ).fetchone()
            if not project:
                raise ValueError("project_not_found")
            metadata = {
                "format": "tribe.project-audit", "schemaVersion": 1,
                "exportedAt": now(), "project": dict(project),
            }
            output.write("{")
            for index, (key, value) in enumerate(metadata.items()):
                if index:
                    output.write(",")
                json.dump(key, output)
                output.write(":")
                json.dump(value, output, ensure_ascii=False)
            output.write(',"missions":[')
            first_mission = True
            mission_rows = db.execute(
                """SELECT id,title,goal,status,created_at,background FROM missions
                   WHERE project_id=? ORDER BY created_at,id""", (project_id,),
            )
            for mission in mission_rows:
                if not first_mission:
                    output.write(",")
                first_mission = False
                output.write("{")
                for index, (key, value) in enumerate(dict(mission).items()):
                    if index:
                        output.write(",")
                    json.dump(key, output)
                    output.write(":")
                    json.dump(value, output, ensure_ascii=False)
                output.write(',"events":[')
                first_event = True
                event_rows = db.execute(
                    """SELECT id,sequence,event_type,actor_id,payload,created_at FROM events
                       WHERE project_id=? AND mission_id=? ORDER BY sequence""",
                    (project_id, mission["id"]),
                )
                for event in event_rows:
                    if not first_event:
                        output.write(",")
                    first_event = False
                    payload = json.loads(event["payload"])
                    if event["event_type"] == "artifact.created" and isinstance(payload, dict):
                        artifact_payload = payload.get("artifact")
                        if isinstance(artifact_payload, dict):
                            artifact_payload.pop("path", None)
                    json.dump({
                        "id": event["id"], "sequence": event["sequence"],
                        "type": event["event_type"], "actorId": event["actor_id"],
                        "payload": payload, "createdAt": event["created_at"],
                    }, output, ensure_ascii=False)
                output.write('],"artifacts":[')
                artifact_rows = db.execute(
                    """SELECT id,name,media_type,created_by,created_at FROM artifacts
                       WHERE mission_id=? ORDER BY created_at,id""", (mission["id"],),
                )
                for index, artifact in enumerate(artifact_rows):
                    if index:
                        output.write(",")
                    json.dump(dict(artifact), output, ensure_ascii=False)
                output.write("]}")
            output.write('],"notice":"Event payloads may contain user or agent messages, tool details and repository paths. Repository files, artifact contents and artifact file paths are not included."}')

    def project_for_mission(self, mission_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT projects.* FROM projects JOIN missions ON missions.project_id = projects.id WHERE missions.id = ?",
                (mission_id,),
            ).fetchone()
            if not row:
                return None
            project = dict(row)
            project["referenceFiles"] = self._project_reference_files(db, project["id"])
            return project

    def project_repository(self, mission_id: str) -> Path:
        with self._connect() as db:
            row = db.execute("SELECT projects.repository FROM projects JOIN missions ON missions.project_id = projects.id WHERE missions.id = ?", (mission_id,)).fetchone()
            if not row:
                raise ValueError("mission_not_found")
            return Path(row[0]).resolve(strict=True)

    def repository_for_project(self, project_id: str) -> Path:
        with self._connect() as db:
            row = db.execute("SELECT repository FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not row:
                raise ValueError("project_not_found")
            return Path(row[0]).resolve(strict=True)

    def create_background_run(self, mission_id: str, argv: list[str], cwd: str, pid: int) -> dict[str, Any]:
        mission = self.mission(mission_id)
        if not mission:
            raise ValueError("mission_not_found")
        run = {"id": str(uuid.uuid4()), "project_id": mission["project_id"], "mission_id": mission_id,
               "argv": json.dumps(argv), "cwd": cwd, "pid": pid, "status": "running",
               "exit_code": None, "output": "", "started_at": now(), "finished_at": None}
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO background_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(run.values()))
            self._append(db, "repo.command.started", "user", mission_id,
                         {"runId": run["id"], "argv": argv, "cwd": cwd})
            db.commit()
        return self._background_run(run)

    @staticmethod
    def _background_run(row: dict[str, Any]) -> dict[str, Any]:
        return {**row, "argv": json.loads(row["argv"])}

    def background_runs(self, mission_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [self._background_run(dict(row)) for row in db.execute(
                "SELECT * FROM background_runs WHERE mission_id = ? ORDER BY started_at DESC", (mission_id,))]

    def background_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM background_runs WHERE id = ?", (run_id,)).fetchone()
            return self._background_run(dict(row)) if row else None

    def recover_background_runs(self) -> None:
        """Mark runs whose monitor belonged to a previous runtime as interrupted."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id, mission_id FROM background_runs WHERE status = 'running'").fetchall()
            for row in rows:
                db.execute("UPDATE background_runs SET status = 'interrupted', finished_at = ? WHERE id = ?",
                           (now(), row["id"]))
                self._append(db, "repo.command.completed", "runtime", row["mission_id"],
                             {"runId": row["id"], "status": "interrupted", "exitCode": None})
            db.commit()

    def update_background_output(self, run_id: str, output: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE background_runs SET output = substr(output || ?, -200000) WHERE id = ? AND status = 'running'",
                       (output, run_id))

    def finish_background_run(self, run_id: str, status: str, exit_code: int | None) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM background_runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                db.rollback()
                return None
            if row["status"] == "running":
                db.execute("UPDATE background_runs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?",
                           (status, exit_code, now(), run_id))
                self._append(db, "repo.command.completed", "user", row["mission_id"],
                             {"runId": run_id, "status": status, "exitCode": exit_code})
            updated = dict(db.execute("SELECT * FROM background_runs WHERE id = ?", (run_id,)).fetchone())
            db.commit()
            return self._background_run(updated)

    def active_missions(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM missions WHERE status = 'active' AND archived_at IS NULL")]

    def workspace_restore_blockers(self) -> list[str]:
        """Return live work that must finish before replacing the local workspace."""
        with self._connect() as db:
            blockers = []
            if db.execute("SELECT 1 FROM missions WHERE status='active' AND archived_at IS NULL LIMIT 1").fetchone():
                blockers.append("active_missions")
            if db.execute("SELECT 1 FROM agent_event_runs WHERE status IN ('running','cancelling') LIMIT 1").fetchone():
                blockers.append("running_agents")
            if db.execute("SELECT 1 FROM background_runs WHERE status='running' LIMIT 1").fetchone():
                blockers.append("running_commands")
            if db.execute("SELECT 1 FROM scheduled_runs WHERE status='running' LIMIT 1").fetchone():
                blockers.append("running_schedules")
            return blockers

    def get_setting(self, key: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None

    def set_setting(self, key: str, value: str) -> None:
        with self._connect() as db:
            db.execute("INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", (key, value, now()))

    def provider_connections(self) -> dict[str, dict[str, Any]]:
        raw = self.get_setting("provider_connections")
        try:
            value = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}
        if not isinstance(value, dict):
            return {}
        return {
            provider: connection for provider, connection in value.items()
            if isinstance(provider, str) and isinstance(connection, dict)
        }

    def provider_connection(self, provider: str) -> dict[str, Any]:
        return self.provider_connections().get(provider.strip().lower(), {})

    def set_provider_connection(self, provider: str, base_url: str, *, verified: bool = False) -> dict[str, Any]:
        provider = provider.strip().lower()
        provider_for_model(f"{provider}:connection")
        connections = self.provider_connections()
        previous = connections.get(provider, {})
        connection = {**previous, "baseUrl": base_url or None, "updatedAt": now()}
        if verified:
            connection["status"] = "verified"
            connection["lastVerifiedAt"] = now()
        elif previous.get("baseUrl") == (base_url or None) and previous.get("lastVerifiedAt"):
            connection["status"] = "verified"
            connection["lastVerifiedAt"] = previous["lastVerifiedAt"]
        else:
            connection["status"] = "configured"
        connections[provider] = connection
        self.set_setting("provider_connections", json.dumps(connections, ensure_ascii=False))
        return connections[provider]

    def set_provider_enabled(self, provider: str, enabled: bool) -> dict[str, Any]:
        provider = provider.strip().lower()
        provider_for_model(f"{provider}:connection")
        connections = self.provider_connections()
        previous = connections.get(provider, {})
        connection = {**previous, "enabled": bool(enabled), "updatedAt": now()}
        connections[provider] = connection
        self.set_setting("provider_connections", json.dumps(connections, ensure_ascii=False))
        return connection

    def model_catalog(self) -> list[dict[str, Any]]:
        raw = self.get_setting("model_catalog")
        try:
            models = json.loads(raw) if raw else []
        except json.JSONDecodeError:
            return []
        if not isinstance(models, list):
            return []
        return sorted(
            [item for item in models if isinstance(item, dict) and isinstance(item.get("id"), str)],
            key=lambda item: (str(item.get("provider", "")).casefold(), str(item.get("name", "")).casefold()),
        )

    def merge_provider_model_catalog(
        self, provider: str, discovered: list[dict[str, Any]], default_model: str | None = None,
    ) -> list[dict[str, Any]]:
        provider = provider.strip().lower()
        provider_for_model(f"{provider}:catalog")
        current = {item["id"]: item for item in self.model_catalog()}
        timestamp = now()
        for item in discovered:
            if not isinstance(item, dict):
                continue
            model_name = item.get("id")
            if not isinstance(model_name, str) or not model_name.strip() or len(model_name) > 180:
                continue
            identifier = f"{provider}:{model_name.strip()}"
            previous = current.get(identifier, {})
            input_modalities = item.get("inputModalities")
            output_modalities = item.get("outputModalities")
            reasoning_efforts = item.get("reasoningEfforts")
            overrides = previous.get("metadataOverrides") if isinstance(previous.get("metadataOverrides"), dict) else {}
            discovered = previous.get("discoveredMetadata") if isinstance(previous.get("discoveredMetadata"), dict) else {}
            discovered = dict(discovered)
            reported = {
                "contextWindow": item.get("contextWindow") if isinstance(item.get("contextWindow"), int) and not isinstance(item.get("contextWindow"), bool) else None,
                "maxOutputTokens": item.get("maxOutputTokens") if isinstance(item.get("maxOutputTokens"), int) and not isinstance(item.get("maxOutputTokens"), bool) else None,
                "inputModalities": input_modalities if isinstance(input_modalities, list) else None,
                "outputModalities": output_modalities if isinstance(output_modalities, list) else None,
                "toolCalling": item.get("toolCalling") if isinstance(item.get("toolCalling"), bool) else None,
                "reasoningEfforts": reasoning_efforts if isinstance(reasoning_efforts, list) else None,
                "inputPricePerMillionUsd": item.get("inputPricePerMillionUsd"),
                "outputPricePerMillionUsd": item.get("outputPricePerMillionUsd"),
            }
            for field, value in reported.items():
                if value is not None:
                    discovered[field] = value
                else:
                    discovered.setdefault(field, previous.get(field))
            record = {
                "id": identifier,
                "provider": provider,
                "providerModelId": model_name.strip(),
                "name": str(item.get("name") or model_name).strip()[:200],
                "displayName": previous.get("displayName"),
                "allowed": bool(previous.get("allowed")) or identifier == default_model,
                "metadataSource": str(item.get("metadataSource") or previous.get("metadataSource") or "unknown"),
                "metadataOverrides": overrides,
                "discoveredMetadata": discovered,
                "discoveredAt": timestamp,
            }
            for field in reported:
                record[field] = overrides.get(field, discovered.get(field))
            record["metadataUpdatedAt"] = previous.get("metadataUpdatedAt")
            current[identifier] = record
        catalog = sorted(current.values(), key=lambda item: (item["provider"].casefold(), item["name"].casefold()))
        self.set_setting("model_catalog", json.dumps(catalog, ensure_ascii=False))
        return catalog

    def register_configured_model(self, identifier: str) -> list[dict[str, Any]]:
        provider = provider_for_model(identifier)
        _, _, model_name = identifier.partition(":")
        if not model_name or len(identifier) > 200:
            raise ValueError("model_identifier_invalid")
        catalog = {item["id"]: item for item in self.model_catalog()}
        item = catalog.get(identifier, {
            "id": identifier, "provider": provider, "providerModelId": model_name,
            "name": model_name, "contextWindow": None, "maxOutputTokens": None,
            "inputModalities": None, "outputModalities": None, "toolCalling": None,
            "reasoningEfforts": None, "metadataSource": "configured manually",
        })
        item["allowed"] = True
        item["discoveredAt"] = item.get("discoveredAt") or now()
        catalog[identifier] = item
        ordered = sorted(catalog.values(), key=lambda model: (model["provider"].casefold(), model["name"].casefold()))
        self.set_setting("model_catalog", json.dumps(ordered, ensure_ascii=False))
        return ordered

    def set_model_allowed(self, identifier: str, allowed: bool) -> list[dict[str, Any]]:
        if not isinstance(allowed, bool):
            raise ValueError("model_allowed_must_be_boolean")
        models = self.model_catalog()
        model = next((item for item in models if item["id"] == identifier), None)
        if not model:
            raise ValueError("model_not_in_catalog")
        if not allowed and self.get_setting("model") == identifier:
            raise ValueError("workspace_default_model_must_remain_allowed")
        model["allowed"] = allowed
        self.set_setting("model_catalog", json.dumps(models, ensure_ascii=False))
        return models

    def update_model_metadata(self, identifier: str, metadata: dict[str, Any]) -> list[dict[str, Any]]:
        models = self.model_catalog()
        model = next((item for item in models if item["id"] == identifier), None)
        if not model:
            raise ValueError("model_not_in_catalog")
        if metadata.get("resetProviderData") is True:
            discovered = model.get("discoveredMetadata")
            if not isinstance(discovered, dict):
                discovered = {}
            for field in (
                "contextWindow", "maxOutputTokens", "inputModalities", "outputModalities",
                "toolCalling", "reasoningEfforts", "inputPricePerMillionUsd", "outputPricePerMillionUsd",
            ):
                model[field] = discovered.get(field)
            model["metadataOverrides"] = {}
            model["metadataUpdatedAt"] = now()
            self.set_setting("model_catalog", json.dumps(models, ensure_ascii=False))
            return models
        overrides = model.get("metadataOverrides")
        if not isinstance(overrides, dict):
            overrides = {}
        display_name = metadata.get("displayName")
        if display_name is not None and not isinstance(display_name, str):
            raise ValueError("displayName_invalid")
        if isinstance(display_name, str) and len(display_name.strip()) > 120:
            raise ValueError("displayName_invalid")
        if "displayName" in metadata:
            model["displayName"] = display_name.strip() or None if isinstance(display_name, str) else None
        for field in ("contextWindow", "maxOutputTokens"):
            value = metadata.get(field)
            if value is not None and (not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 10_000_000_000):
                raise ValueError(f"{field}_invalid")
            overrides[field] = value
        for field in ("inputModalities", "outputModalities"):
            value = metadata.get(field)
            if value is not None and (
                not isinstance(value, list) or len(value) > 8
                or any(not isinstance(item, str) or item not in {"text", "image", "audio", "video"} for item in value)
                or len(set(value)) != len(value)
            ):
                raise ValueError(f"{field}_invalid")
            overrides[field] = value
        tool_calling = metadata.get("toolCalling")
        if tool_calling is not None and not isinstance(tool_calling, bool):
            raise ValueError("toolCalling_invalid")
        overrides["toolCalling"] = tool_calling
        efforts = metadata.get("reasoningEfforts")
        allowed_efforts = {"minimal", "low", "medium", "high", "xhigh", "max"}
        if efforts is not None and (
            not isinstance(efforts, list) or len(efforts) > 6
            or any(not isinstance(item, str) or item not in allowed_efforts for item in efforts)
            or len(set(efforts)) != len(efforts)
        ):
            raise ValueError("reasoningEfforts_invalid")
        overrides["reasoningEfforts"] = efforts
        for field in ("inputPricePerMillionUsd", "outputPricePerMillionUsd"):
            value = metadata.get(field)
            if value is not None:
                try:
                    price = Decimal(str(value))
                except (InvalidOperation, ValueError):
                    raise ValueError(f"{field}_invalid") from None
                if not price.is_finite() or price < 0 or price > Decimal("1000000"):
                    raise ValueError(f"{field}_invalid")
                value = str(price)
            overrides[field] = value
        model.update(overrides)
        model["metadataOverrides"] = overrides
        model["metadataSource"] = "user edited"
        model["metadataUpdatedAt"] = now()
        self.set_setting("model_catalog", json.dumps(models, ensure_ascii=False))
        return models

    @staticmethod
    def _knowledge_entry(db: sqlite3.Connection, entry_id: str) -> dict[str, Any]:
        row = db.execute(
            """SELECT k.*,m.title AS source_mission_title FROM project_knowledge k
               LEFT JOIN missions m ON m.id=k.source_mission_id WHERE k.id=?""", (entry_id,),
        ).fetchone()
        return dict(row)

    def save_knowledge(self, project_id: str, mission_id: str | None, actor_id: str,
                       title: str, content: str) -> dict[str, Any]:
        title, content = title.strip(), content.strip()
        if not title or len(title) > 200 or not content or len(content) > 20_000:
            raise ValueError("knowledge_title_and_content_required")
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT project_id,title FROM missions WHERE id=?", (mission_id,)).fetchone() if mission_id else None
            if mission_id and (not mission or mission["project_id"] != project_id):
                db.rollback()
                raise ValueError("mission_does_not_belong_to_project")
            existing = db.execute(
                "SELECT id,created_at FROM project_knowledge WHERE project_id=? AND title=?",
                (project_id, title),
            ).fetchone()
            entry_id = existing["id"] if existing else str(uuid.uuid4())
            created_at = existing["created_at"] if existing and existing["created_at"] else timestamp
            db.execute(
                """INSERT INTO project_knowledge(
                       id,project_id,title,content,created_by,updated_at,source_mission_id,
                       source_event_sequence,created_at,updated_by,status
                   ) VALUES (?,?,?,?,?,?,?,?,?,?, 'active')
                   ON CONFLICT(project_id,title) DO UPDATE SET content=excluded.content,
                       updated_at=excluded.updated_at,source_mission_id=excluded.source_mission_id,
                       source_event_sequence=excluded.source_event_sequence,
                       updated_by=excluded.updated_by,status='active'""",
                (entry_id, project_id, title, content, actor_id, timestamp, mission_id,
                 None, created_at, actor_id),
            )
            event = self._append(db, "knowledge.entry.saved", actor_id, mission_id, {
                "entry": self._knowledge_entry(db, entry_id),
            }) if mission_id else None
            if event:
                db.execute("UPDATE project_knowledge SET source_event_sequence=? WHERE id=?",
                           (event["sequence"], entry_id))
            entry = self._knowledge_entry(db, entry_id)
            db.commit()
            return entry

    def project_knowledge(self, project_id: str, include_archived: bool = False) -> list[dict[str, Any]]:
        status_filter = "" if include_archived else " AND k.status='active'"
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                f"""SELECT k.*,m.title AS source_mission_title FROM project_knowledge k
                    LEFT JOIN missions m ON m.id=k.source_mission_id
                    WHERE k.project_id=?{status_filter} ORDER BY k.title COLLATE NOCASE""",
                (project_id,),
            )]

    def knowledge_proposals(self, project_id: str, pending_only: bool = True) -> list[dict[str, Any]]:
        status_filter = " AND p.status='pending'" if pending_only else ""
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                f"""SELECT p.*,m.title AS source_mission_title FROM knowledge_proposals p
                    JOIN missions m ON m.id=p.mission_id WHERE p.project_id=?{status_filter}
                    ORDER BY p.created_at DESC""", (project_id,),
            )]

    def propose_knowledge(self, project_id: str, mission_id: str, agent_id: str,
                          title: str, content: str) -> dict[str, Any]:
        title, content = title.strip(), content.strip()
        if not title or len(title) > 200 or not content or len(content) > 20_000:
            raise ValueError("knowledge_title_and_content_required")
        proposal_id, timestamp = str(uuid.uuid4()), now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute("SELECT project_id,title FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not mission or mission["project_id"] != project_id:
                db.rollback()
                raise ValueError("mission_does_not_belong_to_project")
            pending = db.execute(
                "SELECT * FROM knowledge_proposals WHERE project_id=? AND title=? AND status='pending'",
                (project_id, title),
            ).fetchone()
            if pending:
                if pending["content"] == content:
                    db.rollback()
                    return dict(db.execute(
                        """SELECT p.*,m.title AS source_mission_title FROM knowledge_proposals p
                           JOIN missions m ON m.id=p.mission_id WHERE p.id=?""", (pending["id"],),
                    ).fetchone())
                db.rollback()
                raise ValueError("knowledge_proposal_already_pending_for_title")
            db.execute(
                """INSERT INTO knowledge_proposals(
                       id,project_id,mission_id,title,content,proposed_by,status,created_at
                   ) VALUES (?,?,?,?,?,?,'pending',?)""",
                (proposal_id, project_id, mission_id, title, content, agent_id, timestamp),
            )
            event_proposal = dict(db.execute("SELECT * FROM knowledge_proposals WHERE id=?", (proposal_id,)).fetchone())
            event_proposal["source_mission_title"] = mission["title"]
            event = self._append(db, "knowledge.proposed", agent_id, mission_id, {"proposal": event_proposal})
            db.execute("UPDATE knowledge_proposals SET source_event_sequence=? WHERE id=?",
                       (event["sequence"], proposal_id))
            proposal = dict(db.execute(
                """SELECT p.*,m.title AS source_mission_title FROM knowledge_proposals p
                   JOIN missions m ON m.id=p.mission_id WHERE p.id=?""", (proposal_id,),
            ).fetchone())
            db.commit()
            return proposal

    def review_knowledge_proposal(self, proposal_id: str, actor_id: str,
                                  decision: str) -> dict[str, Any]:
        if decision not in {"accept", "dismiss"}:
            raise ValueError("knowledge_decision_must_be_accept_or_dismiss")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM knowledge_proposals WHERE id=?", (proposal_id,)).fetchone()
            if not row or row["status"] != "pending":
                db.rollback()
                raise ValueError("knowledge_proposal_missing_or_already_reviewed")
            timestamp = now()
            status = "accepted" if decision == "accept" else "dismissed"
            db.execute(
                "UPDATE knowledge_proposals SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?",
                (status, actor_id, timestamp, proposal_id),
            )
            entry = None
            if decision == "accept":
                existing = db.execute(
                    "SELECT id,created_at FROM project_knowledge WHERE project_id=? AND title=?",
                    (row["project_id"], row["title"]),
                ).fetchone()
                entry_id = existing["id"] if existing else str(uuid.uuid4())
                created_at = existing["created_at"] if existing and existing["created_at"] else timestamp
                db.execute(
                    """INSERT INTO project_knowledge(
                           id,project_id,title,content,created_by,updated_at,source_mission_id,
                           source_event_sequence,created_at,updated_by,status
                       ) VALUES (?,?,?,?,?,?,?,?,?,?, 'active')
                       ON CONFLICT(project_id,title) DO UPDATE SET content=excluded.content,
                           updated_at=excluded.updated_at,source_mission_id=excluded.source_mission_id,
                           source_event_sequence=excluded.source_event_sequence,
                           updated_by=excluded.updated_by,status='active'""",
                    (entry_id, row["project_id"], row["title"], row["content"], row["proposed_by"],
                     timestamp, row["mission_id"], row["source_event_sequence"], created_at, actor_id),
                )
                entry = dict(db.execute("SELECT * FROM project_knowledge WHERE id=?", (entry_id,)).fetchone())
            proposal = dict(db.execute(
                """SELECT p.*,m.title AS source_mission_title FROM knowledge_proposals p
                   JOIN missions m ON m.id=p.mission_id WHERE p.id=?""", (proposal_id,),
            ).fetchone())
            self._append(db, "knowledge.proposal.reviewed", actor_id, row["mission_id"], {
                "proposal": proposal, "entry": entry, "decision": decision,
            })
            db.commit()
            return {"proposal": proposal, "entry": entry}

    def archive_knowledge(self, knowledge_id: str, mission_id: str, actor_id: str = "user") -> dict[str, Any]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            entry = db.execute("SELECT * FROM project_knowledge WHERE id=?", (knowledge_id,)).fetchone()
            mission = db.execute("SELECT project_id FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not entry or not mission or mission["project_id"] != entry["project_id"]:
                db.rollback()
                raise ValueError("knowledge_entry_or_mission_not_found")
            db.execute("UPDATE project_knowledge SET status='archived',updated_by=?,updated_at=? WHERE id=?",
                       (actor_id, now(), knowledge_id))
            updated = self._knowledge_entry(db, knowledge_id)
            self._append(db, "knowledge.entry.archived", actor_id, mission_id, {"entry": updated})
            db.commit()
            return updated

    def restore_knowledge(self, knowledge_id: str, mission_id: str, actor_id: str = "user") -> dict[str, Any]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            entry = db.execute("SELECT * FROM project_knowledge WHERE id=?", (knowledge_id,)).fetchone()
            mission = db.execute("SELECT project_id FROM missions WHERE id=?", (mission_id,)).fetchone()
            if not entry or not mission or mission["project_id"] != entry["project_id"]:
                db.rollback()
                raise ValueError("knowledge_entry_or_mission_not_found")
            db.execute("UPDATE project_knowledge SET status='active',updated_by=?,updated_at=? WHERE id=?",
                       (actor_id, now(), knowledge_id))
            updated = self._knowledge_entry(db, knowledge_id)
            self._append(db, "knowledge.entry.restored", actor_id, mission_id, {"entry": updated})
            db.commit()
            return updated

    def latest_sequence(self, mission_id: str) -> int:
        with self._connect() as db:
            return db.execute("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE mission_id = ?", (mission_id,)).fetchone()[0]

    def agent_offset(self, agent_id: str, mission_id: str) -> int | None:
        with self._connect() as db:
            row = db.execute("SELECT sequence FROM agent_offsets WHERE agent_id = ? AND mission_id = ?", (agent_id, mission_id)).fetchone()
            return int(row[0]) if row else None

    def save_agent_offset(self, agent_id: str, mission_id: str, sequence: int) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO agent_offsets VALUES (?, ?, ?, ?)
                   ON CONFLICT(agent_id, mission_id) DO UPDATE SET
                   sequence = MAX(agent_offsets.sequence, excluded.sequence),
                   updated_at = excluded.updated_at""",
                (agent_id, mission_id, sequence, now()),
            )

    def agent_event_run(self, agent_id: str, mission_id: str, trigger_sequence: int) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM agent_event_runs WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            return dict(row) if row else None

    @classmethod
    def _interrupt_agent_run(cls, db: sqlite3.Connection, row: sqlite3.Row,
                             reason: str, timestamp: str) -> bool:
        if row["status"] in TERMINAL_AGENT_RUN_STATUSES:
            return False
        agent_id, mission_id, trigger = row["agent_id"], row["mission_id"], row["trigger_sequence"]
        tool_events = db.execute(
            """SELECT event_type,payload,created_at FROM events
               WHERE mission_id=? AND actor_id=?
                 AND event_type IN ('agent.tool.started','agent.tool.completed','agent.tool.interrupted')
                 AND created_at>=? ORDER BY sequence""",
            (mission_id, agent_id, row["created_at"]),
        ).fetchall()
        completed_calls: set[str] = set()
        started_calls: dict[str, dict[str, Any]] = {}
        for tool_event in tool_events:
            try:
                payload = json.loads(tool_event["payload"])
            except (TypeError, json.JSONDecodeError):
                continue
            call_trigger = payload.get("triggerSequence")
            # Older runs did not include their trigger sequence on tool events.
            if call_trigger is not None and call_trigger != trigger:
                continue
            tool_call_id = payload.get("toolCallId")
            if not isinstance(tool_call_id, str) or not tool_call_id:
                continue
            if tool_event["event_type"] == "agent.tool.started":
                started_calls[tool_call_id] = payload
            else:
                completed_calls.add(tool_call_id)
        for tool_call_id, payload in started_calls.items():
            if tool_call_id in completed_calls:
                continue
            cls._append(db, "agent.tool.interrupted", agent_id, mission_id, {
                "toolName": payload.get("toolName", ""),
                "toolCallId": tool_call_id,
                "triggerSequence": trigger,
                "summary": payload.get("summary", ""),
                "activityLabels": payload.get("activityLabels"),
                "workItemId": payload.get("workItemId"),
                "outcome": "unknown",
            })
        cls._append(db, "agent.run.interrupted", agent_id, mission_id, {
            "triggerSequence": trigger, "workItemId": row["work_item_id"], "error": reason,
            "cancelledByUser": row["status"] == "cancelling",
        })
        cls._append(db, "agent.activity", agent_id, mission_id, {
            "status": "Needs attention", "triggerSequence": trigger,
            "detail": "Run interrupted; check for partial repository or tool changes before continuing.",
        })
        db.execute(
            """UPDATE agent_event_runs SET status='interrupted',error=?,updated_at=?
               WHERE agent_id=? AND mission_id=? AND trigger_sequence=?""",
            (reason, timestamp, agent_id, mission_id, trigger),
        )
        db.execute(
            """UPDATE usage_reservations SET status='unknown',updated_at=?
               WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND status='reserved'""",
            (timestamp, agent_id, mission_id, trigger),
        )
        claims = db.execute(
            "SELECT * FROM work_items WHERE mission_id=? AND owner=? AND status='claimed'",
            (mission_id, agent_id),
        ).fetchall()
        for claim in claims:
            item = cls._work_item(db, claim)
            db.execute(
                "UPDATE work_items SET status='ready',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
                (timestamp, claim["id"]),
            )
            item.update(status="ready", owner=None, lease_until=None, updated_at=timestamp)
            cls._append(db, "plan.item.updated", agent_id, mission_id, {
                "workItem": item, "reason": "owner run interrupted; claim released for safe recovery",
            })
        cls._save_agent_offset(db, agent_id, mission_id, trigger, timestamp)
        return True

    def interrupt_agent_event(self, agent_id: str, mission_id: str, trigger_sequence: int,
                              reason: str) -> bool:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM agent_event_runs WHERE agent_id=? AND mission_id=? AND trigger_sequence=?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            if not row:
                db.rollback()
                return False
            interrupted = self._interrupt_agent_run(db, row, reason[:2000], timestamp)
            db.commit()
            return interrupted

    def request_agent_run_cancel(self, agent_id: str, mission_id: str,
                                 trigger_sequence: int) -> bool:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status FROM agent_event_runs WHERE agent_id=? AND mission_id=? AND trigger_sequence=?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            if not row or row["status"] != "running":
                db.rollback()
                return False
            db.execute(
                "UPDATE agent_event_runs SET status='cancelling',updated_at=? WHERE agent_id=? AND mission_id=? AND trigger_sequence=?",
                (timestamp, agent_id, mission_id, trigger_sequence),
            )
            self._append(db, "agent.run.cancellation.requested", "user", mission_id, {
                "agentId": agent_id, "triggerSequence": trigger_sequence,
            })
            self._append(db, "agent.activity", agent_id, mission_id, {
                "status": "Stopping", "triggerSequence": trigger_sequence,
                "detail": "Finishing cancellation and checking for partial side effects.",
            })
            db.commit()
            return True

    def recover_interrupted_agent_runs(self) -> int:
        """Fail closed on abandoned runs, except approvals with a resumable frontier."""
        timestamp = now()
        recovered = 0
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT * FROM agent_event_runs WHERE status IN ('running','cancelling') ORDER BY created_at"
            ).fetchall()
            for row in rows:
                pending_approval = db.execute(
                    """SELECT 1 FROM deferred_tool_approvals d
                       WHERE d.agent_id=? AND d.mission_id=? AND d.trigger_sequence=?
                         AND d.status IN ('pending','consumed') LIMIT 1""",
                    (row["agent_id"], row["mission_id"], row["trigger_sequence"]),
                ).fetchone()
                if pending_approval:
                    continue
                reason = (
                    "The runtime stopped before this agent run committed. Its tool side effects may have an "
                    "unknown outcome, so Tribe did not replay it. Inspect the mission activity and repository, "
                    "then message the agent to continue."
                )
                recovered += int(self._interrupt_agent_run(db, row, reason, timestamp))
            db.commit()
        return recovered

    def begin_agent_event(self, agent_id: str, mission_id: str, trigger_sequence: int) -> dict[str, Any]:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM agent_event_runs WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            if row:
                db.commit()
                result = dict(row)
                result["claimed"] = False
                return result
            db.execute(
                """INSERT INTO agent_event_runs (
                    agent_id, mission_id, trigger_sequence, status, attempts,
                    output_text, work_item_id, error, created_at, updated_at
                ) VALUES (?, ?, ?, 'running', 1, '', NULL, NULL, ?, ?)""",
                (agent_id, mission_id, trigger_sequence, timestamp, timestamp),
            )
            updated = dict(db.execute(
                "SELECT * FROM agent_event_runs WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone())
            db.commit()
            updated["claimed"] = True
            return updated

    def interrupt_dead_agent_worker(self, agent_id: str, mission_id: str) -> int:
        """Quarantine abandoned runs before a replacement role consumer starts."""
        timestamp = now()
        recovered = 0
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                """SELECT * FROM agent_event_runs
                   WHERE agent_id=? AND mission_id=? AND status IN ('running','cancelling')""",
                (agent_id, mission_id),
            ).fetchall()
            for row in rows:
                reason = (
                    "The agent worker stopped before this run committed. Its tool side effects may have an "
                    "unknown outcome, so Tribe did not replay it. Inspect mission activity and repository state, "
                    "then message the agent to continue."
                )
                recovered += int(self._interrupt_agent_run(db, row, reason, timestamp))
            db.commit()
        return recovered

    @staticmethod
    def _save_agent_offset(db: sqlite3.Connection, agent_id: str, mission_id: str,
                           sequence: int, timestamp: str) -> None:
        db.execute(
            """INSERT INTO agent_offsets VALUES (?, ?, ?, ?)
               ON CONFLICT(agent_id, mission_id) DO UPDATE SET
               sequence = MAX(agent_offsets.sequence, excluded.sequence), updated_at = excluded.updated_at""",
            (agent_id, mission_id, sequence, timestamp),
        )

    def complete_agent_event(self, agent_id: str, mission_id: str, trigger_sequence: int,
                             output_text: str, work_item_id: str | None,
                             usage_model: str | None = None,
                             usage: dict[str, int | str | None] | None = None,
                             usage_attempt: int | None = None,
                             interactive_artifact_ids: tuple[str, ...] = ()) -> None:
        timestamp = now()
        usage_reported = usage is not None
        raw_usage = usage or {}
        usage_values = {
            key: max(0, value) if isinstance(value, int) and not isinstance(value, bool) else 0
            for key, value in raw_usage.items() if key != "cost_usd"
        }
        cost_usd = None
        try:
            parsed_cost = Decimal(str(raw_usage.get("cost_usd")))
            if parsed_cost.is_finite() and parsed_cost >= 0:
                cost_usd = format(parsed_cost, "f")
        except (InvalidOperation, TypeError, ValueError):
            pass
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM agent_event_runs WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            if not row:
                db.rollback()
                raise ValueError("agent_event_run_not_found")
            if row["status"] in TERMINAL_AGENT_RUN_STATUSES:
                db.commit()
                return
            if row["status"] == "cancelling":
                self._interrupt_agent_run(
                    db, row,
                    "This run was stopped by you. Its in-flight side effects may have an unknown outcome. "
                    "Inspect the repository and tool history before asking the agent to continue.",
                    timestamp,
                )
                db.commit()
                return
            if output_text and output_text.lower() not in {"no-op", "no action", "no useful action is needed."}:
                try:
                    started_at = datetime.fromisoformat(row["created_at"])
                    finished_at = datetime.fromisoformat(timestamp)
                    duration_ms = max(0, round((finished_at - started_at).total_seconds() * 1000))
                except (TypeError, ValueError):
                    duration_ms = None
                valid_interactive_ids = []
                project_access = db.execute(
                    "SELECT enabled FROM project_interactive_access WHERE project_id=(SELECT project_id FROM missions WHERE id=?)",
                    (mission_id,),
                ).fetchone()
                if project_access and project_access["enabled"]:
                    for artifact_id in interactive_artifact_ids:
                        artifact = db.execute(
                            "SELECT id FROM artifacts WHERE id=? AND mission_id=? AND created_by=? AND media_type=?",
                            (artifact_id, mission_id, agent_id, "application/vnd.tribe.interactive+html"),
                        ).fetchone()
                        if artifact and artifact_id not in valid_interactive_ids:
                            valid_interactive_ids.append(artifact_id)
                self._append(db, "agent.message.created", agent_id, mission_id, {
                    "text": output_text, "recipient": None,
                    "triggerSequence": trigger_sequence, "workItemId": work_item_id,
                    "durationMs": duration_ms,
                    "inputTokens": usage_values.get("input_tokens") if usage_reported else None,
                    "outputTokens": usage_values.get("output_tokens") if usage_reported else None,
                    "interactiveArtifactIds": valid_interactive_ids,
                })
            self._append(db, "agent.activity", agent_id, mission_id, {
                "status": "Ready", "triggerSequence": trigger_sequence,
            })
            if any(usage_values.values()) or cost_usd is not None:
                self._append(db, "agent.usage.recorded", agent_id, mission_id, {
                    "triggerSequence": trigger_sequence, "model": usage_model,
                    **usage_values, "cost_usd": cost_usd,
                })
            db.execute(
                """UPDATE agent_event_runs SET status = 'completed', output_text = ?,
                   work_item_id = ?, error = NULL, usage_model = ?, requests = ?,
                   tool_calls = ?, input_tokens = ?, output_tokens = ?,
                   cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, updated_at = ?
                   WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?""",
                (output_text, work_item_id, usage_model,
                 usage_values.get("requests", 0), usage_values.get("tool_calls", 0),
                 usage_values.get("input_tokens", 0), usage_values.get("output_tokens", 0),
                 usage_values.get("cache_read_tokens", 0), usage_values.get("cache_write_tokens", 0),
                 cost_usd, timestamp, agent_id, mission_id, trigger_sequence),
            )
            if usage_attempt is not None:
                actual_tokens = (
                    usage_values.get("input_tokens", 0) + usage_values.get("output_tokens", 0)
                    if usage_reported else None
                )
                db.execute(
                    """UPDATE usage_reservations SET status=?,actual_tokens=?,updated_at=?
                       WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND attempt=?""",
                    ("settled" if actual_tokens is not None else "unknown", actual_tokens,
                     timestamp, agent_id, mission_id, trigger_sequence, usage_attempt),
                )
            self._save_agent_offset(db, agent_id, mission_id, trigger_sequence, timestamp)
            db.commit()

    def project_usage(self, project_id: str) -> dict[str, Any]:
        with self._connect() as db:
            period_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
            totals = db.execute(
                """SELECT COUNT(*) AS runs, COALESCE(SUM(requests),0) AS requests,
                          COALESCE(SUM(tool_calls),0) AS tool_calls,
                          COALESCE(SUM(input_tokens),0) AS input_tokens,
                          COALESCE(SUM(output_tokens),0) AS output_tokens,
                          COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
                          COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens
                   FROM agent_event_runs runs JOIN missions ON missions.id=runs.mission_id
                   WHERE missions.project_id=? AND runs.status='completed'""", (project_id,)
            ).fetchone()
            by_model = [dict(row) for row in db.execute(
                """SELECT usage_model AS model, COALESCE(SUM(requests),0) AS requests,
                          COALESCE(SUM(input_tokens),0) AS input_tokens,
                          COALESCE(SUM(output_tokens),0) AS output_tokens
                   FROM agent_event_runs runs JOIN missions ON missions.id=runs.mission_id
                   WHERE missions.project_id=? AND runs.status='completed' AND usage_model IS NOT NULL
                   GROUP BY usage_model ORDER BY usage_model""", (project_id,)
            )]
            by_agent = [dict(row) for row in db.execute(
                """SELECT agent_id AS agent, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS input_tokens,
                          COALESCE(SUM(output_tokens),0) AS output_tokens
                   FROM agent_event_runs runs JOIN missions ON missions.id=runs.mission_id
                   WHERE missions.project_id=? AND runs.status='completed'
                   GROUP BY agent_id ORDER BY agent_id""", (project_id,)
            )]
            cost_rows = db.execute(
                """SELECT usage_model, agent_id, cost_usd FROM agent_event_runs runs
                   JOIN missions ON missions.id=runs.mission_id
                   WHERE missions.project_id=? AND runs.status='completed'""", (project_id,)
            ).fetchall()
            total_cost = Decimal(0)
            priced_runs = 0
            model_costs: dict[str, Decimal] = defaultdict(Decimal)
            agent_costs: dict[str, Decimal] = defaultdict(Decimal)
            model_priced_runs: dict[str, int] = defaultdict(int)
            agent_priced_runs: dict[str, int] = defaultdict(int)
            for row in cost_rows:
                if row["cost_usd"] is None:
                    continue
                try:
                    cost = Decimal(row["cost_usd"])
                except (InvalidOperation, TypeError, ValueError):
                    continue
                if not cost.is_finite() or cost < 0:
                    continue
                priced_runs += 1
                total_cost += cost
                if row["usage_model"]:
                    model_costs[row["usage_model"]] += cost
                    model_priced_runs[row["usage_model"]] += 1
                agent_costs[row["agent_id"]] += cost
                agent_priced_runs[row["agent_id"]] += 1
            for item in by_model:
                item["cost_usd"] = (
                    format(model_costs[item["model"]], "f")
                    if model_priced_runs[item["model"]] else None
                )
                item["priced_runs"] = model_priced_runs[item["model"]]
            for item in by_agent:
                item["cost_usd"] = (
                    format(agent_costs[item["agent"]], "f")
                    if agent_priced_runs[item["agent"]] else None
                )
                item["priced_runs"] = agent_priced_runs[item["agent"]]
            totals_data = dict(totals)
            totals_data.update({
                "cost_usd": format(total_cost, "f") if priced_runs else None,
                "priced_runs": priced_runs,
                "unpriced_runs": max(0, int(totals["runs"]) - priced_runs),
            })
            budget = db.execute(
                "SELECT monthly_tokens_limit,max_run_cost_usd,max_run_tokens FROM project_usage_budgets WHERE project_id=?",
                (project_id,),
            ).fetchone()
            monthly_used = db.execute(
                """SELECT COALESCE(SUM(input_tokens + output_tokens),0)
                   FROM agent_event_runs runs JOIN missions ON missions.id=runs.mission_id
                   WHERE missions.project_id=? AND runs.status='completed' AND runs.updated_at>=?""",
                (project_id, period_start),
            ).fetchone()[0]
            month_cost_rows = db.execute(
                """SELECT usage_model,agent_id,cost_usd FROM agent_event_runs runs
                   JOIN missions ON missions.id=runs.mission_id
                   WHERE missions.project_id=? AND runs.status='completed' AND runs.updated_at>=?""",
                (project_id, period_start),
            ).fetchall()
            month_estimated_cost = Decimal(0)
            month_priced_runs = 0
            month_model_costs: dict[str, dict[str, Any]] = defaultdict(
                lambda: {"cost": Decimal(0), "pricedRuns": 0, "unpricedRuns": 0}
            )
            month_agent_costs: dict[str, dict[str, Any]] = defaultdict(
                lambda: {"cost": Decimal(0), "pricedRuns": 0, "unpricedRuns": 0}
            )
            for row in month_cost_rows:
                model = row["usage_model"] or "Unknown model"
                agent = row["agent_id"] or "Unknown role"
                model_total = month_model_costs[model]
                agent_total = month_agent_costs[agent]
                try:
                    cost = Decimal(row["cost_usd"])
                except (InvalidOperation, TypeError, ValueError):
                    cost = None
                if cost is None or not cost.is_finite() or cost < 0:
                    model_total["unpricedRuns"] += 1
                    agent_total["unpricedRuns"] += 1
                    continue
                month_estimated_cost += cost
                month_priced_runs += 1
                model_total["cost"] += cost
                model_total["pricedRuns"] += 1
                agent_total["cost"] += cost
                agent_total["pricedRuns"] += 1

            def month_breakdown(
                groups: dict[str, dict[str, Any]], name: str,
            ) -> list[dict[str, Any]]:
                items = [
                    {
                        name: group,
                        "estimatedCostUsd": (
                            format(values["cost"], "f") if values["pricedRuns"] else None
                        ),
                        "pricedRuns": values["pricedRuns"],
                        "unpricedRuns": values["unpricedRuns"],
                    }
                    for group, values in groups.items()
                ]
                return sorted(
                    items,
                    key=lambda item: (
                        Decimal(item["estimatedCostUsd"] or "0"),
                        item["pricedRuns"],
                        item[name].casefold(),
                    ),
                    reverse=True,
                )
            reservation_totals = db.execute(
                """SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_tokens ELSE 0 END),0) AS active,
                          COALESCE(SUM(CASE WHEN status='unknown' THEN reserved_tokens ELSE 0 END),0) AS unknown
                   FROM usage_reservations
                   WHERE project_id=? AND period=? AND status IN ('reserved','unknown')""",
                (project_id, period_start[:7]),
            ).fetchone()
            reserved = int(reservation_totals["active"])
            unknown = int(reservation_totals["unknown"])
            limit = budget["monthly_tokens_limit"] if budget else None
            max_run_cost = budget["max_run_cost_usd"] if budget else None
            max_run_tokens = budget["max_run_tokens"] if budget else None
            return {
                "totals": totals_data, "byModel": by_model, "byAgent": by_agent,
                "monthToDate": {
                    "period": period_start[:7],
                    "completedRuns": len(month_cost_rows),
                    "pricedRuns": month_priced_runs,
                    "unpricedRuns": max(0, len(month_cost_rows) - month_priced_runs),
                    "estimatedCostUsd": (
                        format(month_estimated_cost, "f") if month_priced_runs else None
                    ),
                    "tokens": int(monthly_used),
                    "byModel": month_breakdown(month_model_costs, "model"),
                    "byAgent": month_breakdown(month_agent_costs, "agent"),
                },
                "budget": {"monthlyTokenLimit": limit, "usedTokens": monthly_used,
                           "reservedTokens": reserved, "unknownTokens": unknown,
                           "maxRunCostUsd": max_run_cost, "maxRunTokens": max_run_tokens,
                           "remainingTokens": None if limit is None else max(0, limit - monthly_used - reserved - unknown)},
            }

    def usage_cost_limit_for_run(self, mission_id: str) -> Decimal | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT usage.max_run_cost_usd FROM missions
                   LEFT JOIN project_usage_budgets usage ON usage.project_id=missions.project_id
                   WHERE missions.id=?""",
                (mission_id,),
            ).fetchone()
        if not row or row[0] is None:
            return None
        return Decimal(row[0])

    def set_project_usage_budget(
        self, project_id: str, monthly_tokens_limit: int | None,
        max_run_cost_usd: str | float | None | object = ...,
        max_run_tokens: int | None | object = ...,
    ) -> dict[str, Any]:
        if monthly_tokens_limit is not None and (
            isinstance(monthly_tokens_limit, bool) or not isinstance(monthly_tokens_limit, int)
            or not 1 <= monthly_tokens_limit <= 10**12
        ):
            raise ValueError("monthly_token_limit_must_be_between_1_and_1000000000000_or_null")
        if max_run_cost_usd is ...:
            max_run_cost_value = ...
        elif max_run_cost_usd is None:
            max_run_cost_value = None
        else:
            try:
                parsed_cost = Decimal(str(max_run_cost_usd))
            except (InvalidOperation, ValueError):
                raise ValueError("max_run_cost_must_be_a_positive_usd_amount_or_null") from None
            if (not parsed_cost.is_finite() or parsed_cost <= 0 or parsed_cost > Decimal(1000000)):
                raise ValueError("max_run_cost_must_be_between_0_000001_and_1000000_usd_or_null")
            max_run_cost_value = format(parsed_cost.normalize(), "f")
        if max_run_tokens is not ... and max_run_tokens is not None and (
            isinstance(max_run_tokens, bool) or not isinstance(max_run_tokens, int)
            or not 1 <= max_run_tokens <= 1_000_000_000
        ):
            raise ValueError("max_run_tokens_must_be_between_1_and_1000000000_or_null")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                db.rollback()
                raise ValueError("project_not_found")
            current = db.execute(
                "SELECT max_run_cost_usd,max_run_tokens FROM project_usage_budgets WHERE project_id=?",
                (project_id,),
            ).fetchone()
            if max_run_cost_value is ...:
                max_run_cost_value = current[0] if current else None
            if max_run_tokens is ...:
                max_run_tokens = current[1] if current else None
            db.execute(
                """INSERT INTO project_usage_budgets(
                       project_id,monthly_tokens_limit,max_run_cost_usd,max_run_tokens,updated_at
                   ) VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
                   monthly_tokens_limit=excluded.monthly_tokens_limit,
                   max_run_cost_usd=excluded.max_run_cost_usd,
                   max_run_tokens=excluded.max_run_tokens,updated_at=excluded.updated_at""",
                (project_id, monthly_tokens_limit, max_run_cost_value, max_run_tokens, now()),
            )
            mission = db.execute(
                """SELECT id FROM missions WHERE project_id=?
                   ORDER BY (status='active' AND background=0) DESC,created_at DESC LIMIT 1""",
                (project_id,),
            ).fetchone()
            if mission:
                self._append(db, "project.usage_budget.updated", "user", mission[0], {
                    "monthlyTokensLimit": monthly_tokens_limit,
                    "maxRunCostUsd": max_run_cost_value,
                    "maxRunTokens": max_run_tokens,
                })
            db.commit()
        return self.project_usage(project_id)["budget"]

    def project_computer_access(self, project_id: str) -> dict[str, bool]:
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            row = db.execute(
                "SELECT enabled FROM project_computer_access WHERE project_id=?", (project_id,)
            ).fetchone()
            return {"enabled": bool(row["enabled"])} if row else {"enabled": False}

    def project_interactive_access(self, project_id: str) -> dict[str, bool]:
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            row = db.execute(
                "SELECT enabled FROM project_interactive_access WHERE project_id=?", (project_id,)
            ).fetchone()
            return {"enabled": bool(row["enabled"])} if row else {"enabled": False}

    def set_project_interactive_access(self, project_id: str, enabled: bool) -> dict[str, bool]:
        if not isinstance(enabled, bool):
            raise TypeError("enabled_must_be_boolean")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                db.rollback()
                raise ValueError("project_not_found")
            db.execute(
                """INSERT INTO project_interactive_access(project_id,enabled,updated_at)
                   VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET
                   enabled=excluded.enabled,updated_at=excluded.updated_at""",
                (project_id, int(enabled), now()),
            )
            mission = db.execute(
                """SELECT id FROM missions WHERE project_id=?
                   ORDER BY (status='active' AND background=0) DESC,created_at DESC LIMIT 1""",
                (project_id,),
            ).fetchone()
            if mission:
                self._append(db, "project.interactive_access.updated", "user", mission[0], {
                    "enabled": enabled,
                })
            db.commit()
        return {"enabled": enabled}

    def record_interactive_artifact_action(
        self, mission_id: str, artifact_id: str, recipient: str, action: str, data: Any,
    ) -> dict[str, Any]:
        if not isinstance(data, (dict, list, str, int, float, bool, type(None))):
            raise TypeError("interactive_action_data_invalid")
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > 12_000:
            raise ValueError("interactive_action_data_too_large")
        if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,63}", str(action)):
            raise ValueError("interactive_action_name_invalid")
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", str(recipient)):
            raise ValueError("interactive_action_recipient_invalid")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute(
                """SELECT m.status,m.archived_at,m.project_id,pia.enabled FROM missions m
                   LEFT JOIN project_interactive_access pia ON pia.project_id=m.project_id
                   WHERE m.id=?""",
                (mission_id,),
            ).fetchone()
            artifact = db.execute(
                "SELECT id,name,media_type FROM artifacts WHERE id=? AND mission_id=?",
                (artifact_id, mission_id),
            ).fetchone()
            if not artifact or artifact["media_type"] != "application/vnd.tribe.interactive+html":
                raise ValueError("interactive_artifact_not_found")
            if not mission or mission["status"] != "active" or mission["archived_at"]:
                raise PermissionError("This chat is not active.")
            if not mission["enabled"]:
                raise PermissionError("Interactive apps are disabled for this project.")
            if not db.execute(
                "SELECT 1 FROM project_agent_roles WHERE project_id=? AND agent_id=?",
                (mission["project_id"], recipient),
            ).fetchone():
                raise ValueError("interactive_action_recipient_unavailable")
            payload = {"artifactId": artifact_id, "artifactName": artifact["name"],
                       "recipient": recipient, "action": action, "data": data}
            event = self._append(db, "interactive_artifact.action.created", "user", mission_id, payload)
            db.commit()
        return {"event": event}

    def set_project_computer_access(self, project_id: str, enabled: bool) -> dict[str, bool]:
        if not isinstance(enabled, bool):
            raise TypeError("enabled_must_be_boolean")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                db.rollback()
                raise ValueError("project_not_found")
            db.execute(
                """INSERT INTO project_computer_access(project_id,enabled,updated_at)
                   VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET
                   enabled=excluded.enabled,updated_at=excluded.updated_at""",
                (project_id, int(enabled), now()),
            )
            mission = db.execute(
                """SELECT id FROM missions WHERE project_id=?
                   ORDER BY (status='active' AND background=0) DESC,created_at DESC LIMIT 1""",
                (project_id,),
            ).fetchone()
            if mission:
                self._append(db, "project.computer_access.updated", "user", mission[0], {
                    "enabled": enabled,
                })
            db.commit()
        return {"enabled": enabled}

    def project_web_access(self, project_id: str) -> dict[str, Any]:
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            row = db.execute("SELECT * FROM project_web_access WHERE project_id=?", (project_id,)).fetchone()
            return {"enabled": bool(row["enabled"]),
                    "allowedDomains": json.loads(row["allowed_domains"])} if row else {
                        "enabled": False, "allowedDomains": []
                    }

    def set_project_web_access(self, project_id: str, enabled: bool,
                               allowed_domains: list[str]) -> dict[str, Any]:
        import re

        if not isinstance(enabled, bool):
            raise TypeError("enabled_must_be_boolean")
        if not isinstance(allowed_domains, list) or len(allowed_domains) > 100:
            raise TypeError("allowed_domains_must_be_a_list_of_at_most_100_domains")
        domains: list[str] = []
        hostname_pattern = re.compile(
            r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)"
            r"(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*"
        )
        for item in allowed_domains:
            if not isinstance(item, str):
                raise TypeError("allowed_domains_must_contain_hostnames")
            domain = item.strip().lower().rstrip(".")
            if not hostname_pattern.fullmatch(domain):
                raise ValueError("allowed_domains_must_be_exact_hostnames_without_wildcards")
            if domain not in domains:
                domains.append(domain)
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                db.rollback()
                raise ValueError("project_not_found")
            db.execute(
                """INSERT INTO project_web_access(project_id,enabled,allowed_domains,updated_at)
                   VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
                   enabled=excluded.enabled,allowed_domains=excluded.allowed_domains,
                   updated_at=excluded.updated_at""",
                (project_id, int(enabled), json.dumps(domains), now()),
            )
            mission = db.execute(
                """SELECT id FROM missions WHERE project_id=?
                   ORDER BY (status='active' AND background=0) DESC,created_at DESC LIMIT 1""",
                (project_id,),
            ).fetchone()
            if mission:
                self._append(db, "project.web_access.updated", "user", mission[0], {
                    "enabled": enabled, "allowedDomains": domains,
                })
            db.commit()
        return {"enabled": enabled, "allowedDomains": domains}

    def project_command_tools(self, project_id: str) -> list[str]:
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ValueError("project_not_found")
            rows = db.execute(
                "SELECT executable FROM project_command_tools WHERE project_id=? ORDER BY executable COLLATE NOCASE",
                (project_id,),
            )
            return [row["executable"] for row in rows]

    def set_project_command_tools(self, project_id: str, executables: list[str]) -> list[str]:
        import re

        if not isinstance(executables, list) or len(executables) > 100:
            raise ValueError("command_tools_must_be_a_list_of_at_most_100_names")
        names: list[str] = []
        for value in executables:
            if not isinstance(value, str):
                raise ValueError("command_tool_names_must_be_strings")  # noqa: TRY004
            name = value.strip()
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}", name):
                raise ValueError("command_tool_must_be_an_executable_name_without_a_path")
            if name not in names:
                names.append(name)
        names.sort(key=str.casefold)
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                db.rollback()
                raise ValueError("project_not_found")
            db.execute("DELETE FROM project_command_tools WHERE project_id=?", (project_id,))
            timestamp = now()
            db.executemany(
                "INSERT INTO project_command_tools(project_id,executable,added_at) VALUES (?,?,?)",
                [(project_id, name, timestamp) for name in names],
            )
            mission = db.execute(
                "SELECT id FROM missions WHERE project_id=? ORDER BY created_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
            if mission:
                self._append(db, "project.command_tools.updated", "user", mission[0], {
                    "executables": names,
                })
            db.commit()
        return names

    def usage_budget_limit_for_mission(self, mission_id: str) -> int | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT monthly_tokens_limit FROM project_usage_budgets
                   JOIN missions ON missions.project_id=project_usage_budgets.project_id
                   WHERE missions.id=?""", (mission_id,)
            ).fetchone()
            return int(row[0]) if row and row[0] is not None else None

    def reserve_agent_usage(self, agent_id: str, mission_id: str, trigger_sequence: int,
                            attempt: int, default_limit: int = DEFAULT_AGENT_RUN_TOKEN_LIMIT) -> int | None:
        timestamp = now()
        period = timestamp[:7]
        period_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute(
                "SELECT project_id FROM missions WHERE id=?", (mission_id,)
            ).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            existing = db.execute(
                """SELECT reserved_tokens,status FROM usage_reservations
                   WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND attempt=?""",
                (agent_id, mission_id, trigger_sequence, attempt),
            ).fetchone()
            if existing:
                db.commit()
                return int(existing[0]) if existing[1] == "reserved" else None
            project_id = mission[0]
            budget = db.execute(
                "SELECT monthly_tokens_limit,max_run_tokens FROM project_usage_budgets WHERE project_id=?", (project_id,)
            ).fetchone()
            configured_run_limit = budget["max_run_tokens"] if budget else None
            token_limit = int(configured_run_limit) if configured_run_limit is not None else default_limit
            if budget and budget[0] is not None:
                used = db.execute(
                    """SELECT COALESCE(SUM(input_tokens + output_tokens),0)
                       FROM agent_event_runs runs JOIN missions ON missions.id=runs.mission_id
                       WHERE missions.project_id=? AND runs.status='completed' AND runs.updated_at>=?""",
                    (project_id, period_start),
                ).fetchone()[0]
                reserved = db.execute(
                    """SELECT COALESCE(SUM(reserved_tokens),0) FROM usage_reservations
                       WHERE project_id=? AND period=? AND status IN ('reserved','unknown')""",
                    (project_id, period),
                ).fetchone()[0]
                token_limit = min(token_limit, int(budget[0]) - int(used) - int(reserved))
                if token_limit <= 0:
                    db.commit()
                    return None
            db.execute(
                """INSERT INTO usage_reservations
                   (id,project_id,mission_id,agent_id,trigger_sequence,attempt,period,
                    reserved_tokens,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,'reserved',?,?)""",
                (str(uuid.uuid4()), project_id, mission_id, agent_id, trigger_sequence,
                 attempt, period, token_limit, timestamp, timestamp),
            )
            db.commit()
            return token_limit

    def usage_token_limit_for_run(self, agent_id: str, mission_id: str,
                                  trigger_sequence: int) -> int | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT reserved_tokens FROM usage_reservations
                   WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND status='reserved'
                   ORDER BY attempt DESC LIMIT 1""",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            return int(row[0]) if row else None

    def mark_usage_reservation_unknown(self, agent_id: str, mission_id: str,
                                       trigger_sequence: int, attempt: int) -> None:
        with self._lock, self._connect() as db:
            db.execute(
                """UPDATE usage_reservations SET status='unknown',updated_at=?
                   WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND attempt=?
                   AND status='reserved'""",
                (now(), agent_id, mission_id, trigger_sequence, attempt),
            )

    def release_usage_reservation(self, agent_id: str, mission_id: str,
                                  trigger_sequence: int, attempt: int) -> None:
        with self._lock, self._connect() as db:
            db.execute(
                """UPDATE usage_reservations SET status='released',reserved_tokens=0,updated_at=?
                   WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND attempt=?
                   AND status='reserved'""",
                (now(), agent_id, mission_id, trigger_sequence, attempt),
            )

    def recover_usage_reservations(self) -> int:
        with self._lock, self._connect() as db:
            cursor = db.execute(
                "UPDATE usage_reservations SET status='unknown',updated_at=? WHERE status='reserved'",
                (now(),),
            )
            return cursor.rowcount

    def fail_agent_event(self, agent_id: str, mission_id: str, trigger_sequence: int,
                         attempts: int, error: str, usage_attempt: int | None = None) -> None:
        timestamp = now()
        safe_error = error[:2000]
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM agent_event_runs WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?",
                (agent_id, mission_id, trigger_sequence),
            ).fetchone()
            if not row:
                db.rollback()
                raise ValueError("agent_event_run_not_found")
            if row["status"] in TERMINAL_AGENT_RUN_STATUSES:
                db.commit()
                return
            if row["status"] == "cancelling":
                self._interrupt_agent_run(
                    db, row,
                    "This run was stopped by you. Its in-flight side effects may have an unknown outcome. "
                    "Inspect the repository and tool history before asking the agent to continue.",
                    timestamp,
                )
                db.commit()
                return
            self._append(db, "agent.run.failed", agent_id, mission_id, {
                "triggerSequence": trigger_sequence, "attempts": attempts, "error": safe_error,
            })
            self._append(db, "agent.activity", agent_id, mission_id, {
                "status": "Needs attention", "triggerSequence": trigger_sequence,
            })
            db.execute(
                """UPDATE agent_event_runs SET status = 'failed', error = ?, updated_at = ?
                   WHERE agent_id = ? AND mission_id = ? AND trigger_sequence = ?""",
                (safe_error, timestamp, agent_id, mission_id, trigger_sequence),
            )
            if usage_attempt is not None:
                db.execute(
                    """UPDATE usage_reservations SET status='unknown',updated_at=?
                       WHERE agent_id=? AND mission_id=? AND trigger_sequence=? AND attempt=?""",
                    (timestamp, agent_id, mission_id, trigger_sequence, usage_attempt),
                )
            self._save_agent_offset(db, agent_id, mission_id, trigger_sequence, timestamp)
            db.commit()

    def isolated_workspace(self, agent_id: str, mission_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM isolated_workspaces WHERE agent_id = ? AND mission_id = ?", (agent_id, mission_id)).fetchone()
            return dict(row) if row else None

    def isolated_workspaces_for_mission(self, mission_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM isolated_workspaces WHERE mission_id = ? ORDER BY agent_id", (mission_id,)
            )]

    def pending_integrations(self, mission_id: str, agent_id: str) -> list[str]:
        with self._connect() as db:
            return [row[0] for row in db.execute(
                "SELECT interaction_id FROM integration_requests WHERE mission_id = ? AND agent_id = ? AND status = 'pending'",
                (mission_id, agent_id),
            )]

    def save_isolated_workspace(self, mission_id: str, agent_id: str, repository: str,
                                path: str, state: str = "active") -> dict[str, Any]:
        record = {"mission_id": mission_id, "agent_id": agent_id, "repository": repository,
                  "path": path, "state": state, "updated_at": now()}
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO isolated_workspaces VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(mission_id, agent_id) DO UPDATE SET repository = excluded.repository, path = excluded.path, state = excluded.state, updated_at = excluded.updated_at", tuple(record.values()))
        return record

    def update_isolated_workspace_state(self, mission_id: str, agent_id: str, state: str) -> None:
        with self._connect() as db:
            db.execute("UPDATE isolated_workspaces SET state = ?, updated_at = ? WHERE mission_id = ? AND agent_id = ?", (state, now(), mission_id, agent_id))

    def clear_isolated_workspace(self, mission_id: str, agent_id: str) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM isolated_workspaces WHERE mission_id = ? AND agent_id = ?", (mission_id, agent_id))

    def save_integration_request(self, interaction_id: str, mission_id: str, agent_id: str,
                                 artifact_id: str, paths: list[str]) -> None:
        with self._connect() as db:
            db.execute("INSERT INTO integration_requests VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                       (interaction_id, mission_id, agent_id, artifact_id, json.dumps(paths), now()))

    def integration_request(self, interaction_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM integration_requests WHERE interaction_id = ?", (interaction_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result["paths"] = json.loads(result["paths"])
            return result

    def update_integration_request(self, interaction_id: str, status: str) -> None:
        with self._connect() as db:
            db.execute("UPDATE integration_requests SET status = ? WHERE interaction_id = ?", (status, interaction_id))

    def complete_work(self, work_item_id: str, agent_id: str, result: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            timestamp = now()
            scope = db.execute(
                "SELECT mission_id FROM work_items WHERE id = ?", (work_item_id,),
            ).fetchone()
            if scope:
                mission = db.execute(
                    "SELECT recipe_id FROM missions WHERE id = ?", (scope["mission_id"],),
                ).fetchone()
                if (mission and mission["recipe_id"] == "goal-driven-sdlc"
                        and not self._current_plan_checkpoint(db, scope["mission_id"])):
                    db.rollback()
                    raise PermissionError(
                        "goal-driven SDLC work cannot be completed while the finalized plan is stale"
                    )
            row = db.execute(
                "SELECT * FROM work_items WHERE id = ? AND owner = ? AND status = 'claimed' AND lease_until >= ?",
                (work_item_id, agent_id, timestamp),
            ).fetchone()
            if not row:
                db.rollback()
                return None
            item = self._work_item(db, row)
            db.execute("UPDATE work_items SET status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?", (now(), work_item_id))
            item.update(status="done", lease_until=None, updated_at=now(), blocked_by=[])
            self._append(db, "plan.item.completed", agent_id, item["mission_id"], {"workItem": item, "result": result[:5000]})
            self._auto_block_mission_for_user_request(db, item["mission_id"], agent_id)
            db.commit()
            return item

    def approval(self, interaction_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM interactions WHERE id = ?", (interaction_id,)).fetchone()
            return dict(row) if row else None

    def deferred_tool_approvals(
        self, mission_id: str, agent_id: str, trigger_sequence: int | None = None,
    ) -> list[dict[str, Any]]:
        query = """SELECT d.*, i.status AS interaction_status, i.resolution
                   FROM deferred_tool_approvals d JOIN interactions i ON i.id = d.interaction_id
                   WHERE d.mission_id = ? AND d.agent_id = ?"""
        values: list[Any] = [mission_id, agent_id]
        if trigger_sequence is not None:
            query += " AND d.trigger_sequence = ?"
            values.append(trigger_sequence)
        query += " ORDER BY d.trigger_sequence, d.created_at"
        with self._connect() as db:
            rows = db.execute(query, values)
            result = [dict(row) for row in rows]
        for row in result:
            row["tool_arguments"] = json.loads(row["tool_arguments"])
        return result

    def update_deferred_tool_approval(self, interaction_id: str, status: str) -> None:
        if status not in {"pending", "approved", "denied", "consumed", "unknown_after_crash"}:
            raise ValueError("invalid_deferred_tool_approval_status")
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE deferred_tool_approvals SET status = ?, updated_at = ? WHERE interaction_id = ?",
                (status, now(), interaction_id),
            )

    def consume_approval(self, interaction_id: str, target: str) -> bool:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM interactions WHERE id = ?", (interaction_id,)).fetchone()
            consumed = db.execute("SELECT 1 FROM approval_consumptions WHERE interaction_id = ?", (interaction_id,)).fetchone()
            if not row or row["interaction_type"] != "approval" or row["status"] != "resolved" or row["resolution"] != "approved_once" or row["target"] != target or consumed:
                db.rollback()
                return False
            db.execute("INSERT INTO approval_consumptions VALUES (?, ?)", (interaction_id, now()))
            self._append(db, "interaction.approval.consumed", row["requested_by"], row["mission_id"], {"interactionId": interaction_id, "target": target})
            db.commit()
            return True

    def consume_repository_file_deletion_approval(
        self, interaction_id: str, target: str, current_sha256: str,
        mission_id: str, agent_id: str, relative_path: str,
        diff_content: bytes | None = None, diff_name: str | None = None,
        diff_media_type: str | None = None, diff_skipped_reason: str | None = None,
    ) -> bool:
        """Consume an exact, one-use deletion approval and record its start atomically."""
        if diff_content is not None and len(diff_content) > 10_000_000:
            raise ValueError("repository_deletion_diff_exceeds_artifact_limit")
        safe_diff_name = Path(diff_name).name.strip()[:255] if diff_name else None
        if diff_content and not safe_diff_name:
            raise ValueError("repository_deletion_diff_name_required")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT i.*, a.sha256 AS expected_sha256
                   FROM interactions i
                   JOIN repository_file_deletion_approvals a ON a.interaction_id = i.id
                   WHERE i.id = ?""", (interaction_id,),
            ).fetchone()
            consumed = db.execute(
                "SELECT 1 FROM approval_consumptions WHERE interaction_id = ?",
                (interaction_id,),
            ).fetchone()
            if (
                not row or row["mission_id"] != mission_id
                or row["interaction_type"] != "approval"
                or row["status"] != "resolved" or row["resolution"] != "approved_once"
                or row["target"] != target or row["expected_sha256"] != current_sha256
                or consumed
            ):
                db.rollback()
                return False
            timestamp = now()
            db.execute(
                "INSERT INTO approval_consumptions VALUES (?, ?)",
                (interaction_id, timestamp),
            )
            self._append(db, "interaction.approval.consumed", agent_id, mission_id, {
                "interactionId": interaction_id, "target": target,
                "fileFingerprint": {"algorithm": "sha256", "value": current_sha256},
            })
            self._append(db, "repo.file.delete.started", agent_id, mission_id, {
                "path": relative_path, "approvalId": interaction_id,
                "sha256": current_sha256,
            })
            db.execute(
                """INSERT INTO repository_file_deletions (
                       approval_id, mission_id, agent_id, path, sha256, status, started_at,
                       diff_content, diff_name, diff_media_type, diff_skipped_reason
                   ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?)""",
                (interaction_id, mission_id, agent_id, relative_path, current_sha256, timestamp,
                 diff_content, safe_diff_name, diff_media_type, diff_skipped_reason),
            )
            db.commit()
            return True

    def complete_repository_file_deletion(
        self, approval_id: str, mission_id: str, agent_id: str, sha256: str,
    ) -> bool:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            operation = db.execute(
                "SELECT * FROM repository_file_deletions WHERE approval_id = ?",
                (approval_id,),
            ).fetchone()
            if (
                not operation or operation["mission_id"] != mission_id
                or operation["agent_id"] != agent_id or operation["sha256"] != sha256
                or operation["status"] != "started"
            ):
                db.rollback()
                return False
            db.execute(
                "UPDATE repository_file_deletions SET status='deleted',finished_at=? WHERE approval_id=?",
                (timestamp, approval_id),
            )
            self._append(db, "repo.file.deleted", agent_id, mission_id, {
                "path": operation["path"], "approvalId": approval_id,
                "sha256": sha256,
                "diffPending": bool(operation["diff_content"]),
                "diffUnavailableReason": operation["diff_skipped_reason"],
            })
            db.commit()
        self.publish_pending_repository_file_deletion_artifacts(approval_id)
        return True

    def publish_pending_repository_file_deletion_artifacts(
        self, approval_id: str | None = None,
    ) -> int:
        """Publish deletion diffs idempotently after the delete outcome is durable."""
        parameters: tuple[Any, ...] = ()
        query = """SELECT * FROM repository_file_deletions
                   WHERE status IN ('deleted','recovered_deleted')
                     AND diff_content IS NOT NULL AND diff_artifact_id IS NULL"""
        if approval_id:
            query += " AND approval_id=?"
            parameters = (approval_id,)
        query += " ORDER BY started_at,approval_id"
        with self._connect() as db:
            pending = [dict(row) for row in db.execute(query, parameters)]

        published = 0
        for operation in pending:
            artifact_id = str(uuid.uuid5(
                uuid.NAMESPACE_URL, f"tribe:repository-deletion:{operation['approval_id']}"
            ))
            stored_path = self.data_dir / "artifacts" / operation["mission_id"] / artifact_id
            temporary_path = stored_path.with_suffix(".tmp")
            artifact = {
                "id": artifact_id, "mission_id": operation["mission_id"],
                "name": operation["diff_name"],
                "media_type": operation["diff_media_type"] or "text/x-diff",
                "path": str(stored_path), "created_by": operation["agent_id"],
                "created_at": now(),
            }
            try:
                stored_path.parent.mkdir(parents=True, exist_ok=True)
                temporary_path.write_bytes(operation["diff_content"])
                temporary_path.replace(stored_path)
                with self._lock, self._connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    current = db.execute(
                        "SELECT * FROM repository_file_deletions WHERE approval_id=?",
                        (operation["approval_id"],),
                    ).fetchone()
                    if (
                        not current or current["status"] not in {"deleted", "recovered_deleted"}
                        or current["diff_content"] is None or current["diff_artifact_id"]
                    ):
                        db.rollback()
                        continue
                    existing = db.execute(
                        "SELECT id FROM artifacts WHERE id=?", (artifact_id,),
                    ).fetchone()
                    if not existing:
                        db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)", tuple(artifact.values()))
                        self._append(db, "artifact.created", operation["agent_id"],
                            operation["mission_id"], {"artifact": artifact})
                    db.execute(
                        """UPDATE repository_file_deletions
                           SET diff_artifact_id=?,diff_content=NULL WHERE approval_id=?""",
                        (artifact_id, operation["approval_id"]),
                    )
                    db.commit()
                    published += int(not existing)
            except (OSError, sqlite3.Error):
                temporary_path.unlink(missing_ok=True)
                continue
        return published

    def abort_repository_file_deletion(
        self, approval_id: str, mission_id: str, agent_id: str,
        actual_sha256: str | None, reason: str,
    ) -> bool:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            operation = db.execute(
                "SELECT * FROM repository_file_deletions WHERE approval_id = ?",
                (approval_id,),
            ).fetchone()
            if (
                not operation or operation["mission_id"] != mission_id
                or operation["agent_id"] != agent_id or operation["status"] != "started"
            ):
                db.rollback()
                return False
            db.execute(
                """UPDATE repository_file_deletions
                   SET status='aborted',finished_at=?,diff_content=NULL WHERE approval_id=?""",
                (timestamp, approval_id),
            )
            self._append(db, "repo.file.delete.aborted", agent_id, mission_id, {
                "path": operation["path"], "approvalId": approval_id,
                "expectedSha256": operation["sha256"], "actualSha256": actual_sha256,
                "reason": reason,
            })
            db.commit()
            return True

    def reconcile_repository_file_deletions(self) -> int:
        """Resolve interrupted deletions from filesystem evidence without repeating them."""
        resolved = 0
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            starts = db.execute(
                "SELECT * FROM events WHERE event_type='repo.file.delete.started' ORDER BY sequence"
            ).fetchall()
            known = {
                row[0] for row in db.execute(
                    "SELECT approval_id FROM repository_file_deletions"
                )
            }
            terminal: set[str] = set()
            for event in db.execute(
                """SELECT payload FROM events
                   WHERE event_type IN ('repo.file.deleted','repo.file.delete.aborted')"""
            ):
                approval_id = json.loads(event["payload"]).get("approvalId")
                if approval_id:
                    terminal.add(approval_id)
            for event in starts:
                payload = json.loads(event["payload"])
                approval_id = payload.get("approvalId")
                if not approval_id or approval_id in known or approval_id in terminal:
                    continue
                db.execute(
                    """INSERT INTO repository_file_deletions (
                           approval_id, mission_id, agent_id, path, sha256, status, started_at
                       ) VALUES (?, ?, ?, ?, ?, 'started', ?)""",
                    (approval_id, event["mission_id"], event["actor_id"],
                     payload.get("path", ""), payload.get("sha256", ""), event["created_at"]),
                )
                known.add(approval_id)

            pending = db.execute(
                "SELECT * FROM repository_file_deletions WHERE status='started' ORDER BY started_at"
            ).fetchall()
            for operation in pending:
                outcome = "needs_attention"
                reason = "repository_state_could_not_be_verified"
                actual_sha256 = None
                try:
                    project = db.execute(
                        """SELECT p.repository FROM projects p JOIN missions m ON m.project_id=p.id
                           WHERE m.id=?""", (operation["mission_id"],),
                    ).fetchone()
                    if not project:
                        raise ValueError("project_not_found")
                    root = Path(project["repository"]).resolve(strict=True)
                    relative = operation["path"]
                    relative_path = PurePosixPath(relative)
                    if (
                        not relative or "\\" in relative or "\x00" in relative
                        or relative_path.is_absolute()
                        or any(part in {"", ".", ".."} for part in relative.split("/"))
                    ):
                        raise ValueError("repository_path_is_not_canonical")
                    target = root.joinpath(*relative.split("/"))
                    resolved_target = target.resolve()
                    if not resolved_target.is_relative_to(root):
                        raise ValueError("repository_path_is_outside_project")
                    if not target.exists():
                        outcome = "deleted"
                        reason = "target_absent_after_restart"
                    elif target.is_file() and operation["sha256"]:
                        digest = hashlib.sha256()
                        with target.open("rb") as source:
                            for chunk in iter(lambda: source.read(128 * 1024), b""):
                                digest.update(chunk)
                        actual_sha256 = digest.hexdigest()
                        if actual_sha256 == operation["sha256"]:
                            outcome = "not_deleted"
                            reason = "approved_file_is_still_present"
                        else:
                            reason = "file_content_changed_during_interrupted_deletion"
                    elif target.is_file():
                        reason = "legacy_deletion_has_no_file_fingerprint"
                    else:
                        reason = "repository_target_is_not_a_regular_file"
                except (OSError, RuntimeError, ValueError):
                    pass

                status = {
                    "deleted": "recovered_deleted",
                    "not_deleted": "recovered_not_deleted",
                    "needs_attention": "needs_attention",
                }[outcome]
                db.execute(
                    """UPDATE repository_file_deletions SET status=?,finished_at=?,
                           diff_content=CASE WHEN ?='deleted' THEN diff_content ELSE NULL END
                       WHERE approval_id=? AND status='started'""",
                    (status, timestamp, outcome, operation["approval_id"]),
                )
                self._append(db, "repo.file.delete.recovered", operation["agent_id"],
                    operation["mission_id"], {
                        "path": operation["path"], "approvalId": operation["approval_id"],
                        "outcome": outcome, "reason": reason,
                        "expectedSha256": operation["sha256"], "actualSha256": actual_sha256,
                    })
                resolved += 1
            db.commit()
        self.publish_pending_repository_file_deletion_artifacts()
        return resolved

    def consume_deferred_tool_approval(self, interaction_id: str, target: str) -> bool:
        """Consume a deferred approval and mark its frontier in the same transaction."""
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT i.* FROM interactions i
                   JOIN deferred_tool_approvals d ON d.interaction_id = i.id
                   WHERE i.id = ?""", (interaction_id,),
            ).fetchone()
            consumed = db.execute(
                "SELECT 1 FROM approval_consumptions WHERE interaction_id = ?",
                (interaction_id,),
            ).fetchone()
            if (
                not row or row["interaction_type"] != "approval"
                or row["status"] != "resolved" or row["resolution"] != "approved_once"
                or row["target"] != target or consumed
            ):
                db.rollback()
                return False
            db.execute(
                "INSERT INTO approval_consumptions VALUES (?, ?)",
                (interaction_id, timestamp),
            )
            db.execute(
                """UPDATE deferred_tool_approvals SET status = 'consumed', updated_at = ?
                   WHERE interaction_id = ?""", (timestamp, interaction_id),
            )
            self._append(
                db, "interaction.approval.consumed", row["requested_by"],
                row["mission_id"], {"interactionId": interaction_id, "target": target},
            )
            db.commit()
            return True

    @staticmethod
    def _events(db: sqlite3.Connection, mission_id: str, after: int,
                limit: int | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM events WHERE mission_id = ? AND sequence > ? ORDER BY sequence"
        parameters: tuple[Any, ...] = (mission_id, after)
        if limit is not None:
            query += " LIMIT ?"
            parameters += (limit,)
        rows = db.execute(query, parameters)
        return [{
            "id": row["id"], "sequence": row["sequence"], "missionId": row["mission_id"],
            "type": row["event_type"], "actorId": row["actor_id"],
            "payload": json.loads(row["payload"]), "createdAt": row["created_at"],
        } for row in rows]

    @staticmethod
    def _events_before(db: sqlite3.Connection, mission_id: str, before: int,
                       limit: int) -> tuple[list[dict[str, Any]], bool]:
        page_size = min(max(limit, 1), 500)
        rows = list(db.execute(
            "SELECT * FROM events WHERE mission_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
            (mission_id, before, page_size + 1),
        ))
        has_more = len(rows) > page_size
        rows = list(reversed(rows[:page_size]))
        return ([{
            "id": row["id"], "sequence": row["sequence"], "missionId": row["mission_id"],
            "type": row["event_type"], "actorId": row["actor_id"],
            "payload": json.loads(row["payload"]), "createdAt": row["created_at"],
        } for row in rows], has_more)

    def events_before(self, mission_id: str, before: int, limit: int = 200) -> tuple[list[dict[str, Any]], bool]:
        with self._connect() as db:
            return self._events_before(db, mission_id, before, limit)

    def events_after(self, mission_id: str, sequence: int) -> list[dict[str, Any]]:
        with self._connect() as db:
            return self._events(db, mission_id, sequence)

    def has_event_from_actor_after(self, mission_id: str, sequence: int,
                                   actor_id: str) -> bool:
        """Check for actor activity after a cursor without materialising event payloads."""
        with self._connect() as db:
            return db.execute(
                "SELECT 1 FROM events WHERE mission_id=? AND sequence>? AND actor_id=? LIMIT 1",
                (mission_id, sequence, actor_id),
            ).fetchone() is not None

    def events_after_page(self, mission_id: str, sequence: int,
                          limit: int = 200) -> tuple[list[dict[str, Any]], bool]:
        page_size = min(max(limit, 1), 500)
        with self._connect() as db:
            events = self._events(db, mission_id, sequence, page_size + 1)
        return events[:page_size], len(events) > page_size

    @staticmethod
    def _work_item(db: sqlite3.Connection, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        item = dict(row)
        dependencies = db.execute(
            "SELECT dependency.id, dependency.title, dependency.status FROM work_item_dependencies links "
            "JOIN work_items dependency ON dependency.id = links.depends_on_id "
            "WHERE links.work_item_id = ? ORDER BY dependency.created_at, dependency.id", (item["id"],)
        ).fetchall()
        item["depends_on"] = [dependency["id"] for dependency in dependencies]
        item["dependencies"] = [dict(dependency) for dependency in dependencies]
        item["blocked_by"] = [dependency["id"] for dependency in dependencies if dependency["status"] != "done"]
        if item["status"] == "ready" and item["blocked_by"]:
            item["status"] = "blocked"
        return item

    @staticmethod
    def _current_plan_checkpoint(db: sqlite3.Connection, mission_id: str) -> sqlite3.Row | None:
        checkpoint = db.execute(
            "SELECT sequence,payload FROM events WHERE mission_id=? AND event_type='plan.finalized' "
            "ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        if not checkpoint:
            return None
        changed = db.execute(
            "SELECT MAX(sequence) FROM events WHERE mission_id=? "
            "AND event_type IN ('plan.item.created','plan.item.updated','sdlc.discovery.completed')",
            (mission_id,),
        ).fetchone()[0]
        return checkpoint if changed is None or checkpoint["sequence"] > changed else None

    @staticmethod
    def _workflow_context(db: sqlite3.Connection, mission_id: str) -> dict[str, Any]:
        """Return compact durable SDLC evidence for the mission header projection."""
        discovery_row = db.execute(
            "SELECT id,sequence,payload FROM events WHERE mission_id=? "
            "AND event_type='sdlc.discovery.completed' ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        discovery = None
        if discovery_row:
            payload = json.loads(discovery_row["payload"])
            discovery = {
                "id": discovery_row["id"],
                "sequence": discovery_row["sequence"],
                "summary": payload.get("summary", ""),
                "evidence": payload.get("evidence", []),
            }
        plan = db.execute(
            "SELECT sequence FROM events WHERE mission_id=? AND event_type='plan.finalized' "
            "ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        plan_change = db.execute(
            "SELECT MAX(sequence) FROM events WHERE mission_id=? "
            "AND event_type IN ('plan.item.created','plan.item.updated')", (mission_id,),
        ).fetchone()[0]
        change = db.execute(
            "SELECT id,sequence FROM events WHERE mission_id=? "
            "AND event_type IN ('repo.file.changed','repo.worktree.integrated') "
            "ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        latest_test = db.execute(
            "SELECT id,sequence,json_extract(payload,'$.exitCode') AS exitCode "
            "FROM events WHERE mission_id=? AND event_type='repo.test_run.completed' "
            "ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        verification = db.execute(
            "SELECT id,sequence FROM events WHERE mission_id=? AND event_type='repo.test_run.completed' "
            "AND json_extract(payload,'$.exitCode')=0 ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        review_row = db.execute(
            "SELECT id,sequence,payload FROM events WHERE mission_id=? "
            "AND event_type='review.checkpoint.recorded' ORDER BY sequence DESC LIMIT 1", (mission_id,),
        ).fetchone()
        review = None
        if review_row:
            payload = json.loads(review_row["payload"])
            review = {
                "id": review_row["id"],
                "sequence": review_row["sequence"],
                "disposition": payload.get("disposition"),
                "verificationEventId": payload.get("verificationEventId"),
                "changeEventId": payload.get("changeEventId"),
            }
        return {
            "discovery": discovery,
            "planFinalizedSequence": plan["sequence"] if plan else None,
            "latestPlanChangeSequence": plan_change,
            "latestChange": dict(change) if change else None,
            "latestTest": dict(latest_test) if latest_test else None,
            "latestSuccessfulTest": dict(verification) if verification else None,
            "latestReview": review,
        }

    def complete_discovery(self, mission_id: str, planner_id: str, summary: str,
                           evidence_paths: list[str]) -> dict[str, Any]:
        """Record the planner's repository findings before the first v7 SDLC plan."""
        if planner_id != "planner":
            raise PermissionError("only the planner may complete discovery")
        if not isinstance(summary, str) or not 30 <= len(summary.strip()) <= 4000:
            raise ValueError("discovery_summary_must_be_30_to_4000_characters")
        if not isinstance(evidence_paths, list) or len(evidence_paths) > 20:
            raise ValueError("discovery_evidence_must_contain_at_most_20_repository_files")

        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute(
                "SELECT status,recipe_id,recipe_version,project_id FROM missions WHERE id=?", (mission_id,),
            ).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if (mission["status"] != "active" or mission["recipe_id"] != "goal-driven-sdlc"
                    or mission["recipe_version"] < 7):
                db.rollback()
                raise ValueError("discovery_checkpoint_requires_active_goal_driven_sdlc_v7_mission")
            project = db.execute("SELECT repository FROM projects WHERE id=?", (mission["project_id"],)).fetchone()
            if not project:
                db.rollback()
                raise ValueError("project_not_found")
            try:
                root = Path(project["repository"]).resolve(strict=True)
                if not root.is_dir():
                    raise ValueError("repository_unavailable")
                evidence: list[dict[str, str]] = []
                seen: set[str] = set()
                for raw_path in evidence_paths:
                    if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 500:
                        raise ValueError("discovery_evidence_path_invalid")
                    normalised = raw_path.strip().replace("\\", "/")
                    relative = PurePosixPath(normalised)
                    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
                        raise ValueError("discovery_evidence_path_invalid")
                    canonical = relative.as_posix()
                    if canonical in seen:
                        continue
                    source = (root / Path(*relative.parts)).resolve(strict=True)
                    if not source.is_relative_to(root) or not source.is_file():
                        raise ValueError("discovery_evidence_must_reference_repository_files")
                    if source.stat().st_size > 10_000_000:
                        raise ValueError("discovery_evidence_file_too_large")
                    source.read_bytes().decode("utf-8")
                    evidence.append({"path": canonical, "sha256": _sha256_file(source)})
                    seen.add(canonical)
            except (OSError, UnicodeError) as error:
                db.rollback()
                raise ValueError("discovery_evidence_file_unreadable") from error

            event = self._append(db, "sdlc.discovery.completed", planner_id, mission_id, {
                "summary": summary.strip(), "evidence": evidence,
            })
            self._release_claims_for_stale_plan(db, mission_id, planner_id)
            db.commit()
            return event

    def finalize_plan(self, mission_id: str, planner_id: str,
                      acceptance_criteria: list[dict[str, Any]]) -> dict[str, Any]:
        if planner_id != "planner":
            raise PermissionError("only the planner may finalize the mission plan")
        if not isinstance(acceptance_criteria, list) or not 1 <= len(acceptance_criteria) <= 20:
            raise ValueError("plan_requires_1_to_20_acceptance_criteria")
        criteria: list[dict[str, Any]] = []
        criterion_names: set[str] = set()
        for item in acceptance_criteria:
            if not isinstance(item, dict):
                raise ValueError("each_acceptance_criterion_needs_task_ids")  # noqa: TRY004
            criterion = item.get("criterion")
            work_item_ids = item.get("work_item_ids")
            if not isinstance(criterion, str) or not criterion.strip() or len(criterion.strip()) > 2000:
                raise ValueError("each_acceptance_criterion_must_be_1_to_2000_characters")
            if not isinstance(work_item_ids, list) or not 1 <= len(work_item_ids) <= 50 or any(
                not isinstance(work_item_id, str) or not work_item_id for work_item_id in work_item_ids
            ):
                raise ValueError("each_acceptance_criterion_needs_1_to_50_task_ids")
            value = criterion.strip()
            if value in criterion_names:
                raise ValueError("plan_acceptance_criteria_must_be_unique")
            criterion_names.add(value)
            criteria.append({
                "criterion": value,
                "workItemIds": list(dict.fromkeys(work_item_ids)),
            })
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute(
                "SELECT status,recipe_id,recipe_version FROM missions WHERE id=?", (mission_id,),
            ).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if mission["status"] != "active" or mission["recipe_id"] != "goal-driven-sdlc":
                db.rollback()
                raise ValueError("only_active_goal_driven_sdlc_missions_can_finalize_a_plan")
            discovery = db.execute(
                "SELECT id,sequence FROM events WHERE mission_id=? AND event_type='sdlc.discovery.completed' "
                "ORDER BY sequence DESC LIMIT 1", (mission_id,),
            ).fetchone()
            if mission["recipe_version"] >= 7 and discovery is None:
                db.rollback()
                raise ValueError("discovery_checkpoint_required_before_plan_finalization")
            item_ids = [row[0] for row in db.execute(
                "SELECT id FROM work_items WHERE mission_id=? ORDER BY created_at,id", (mission_id,),
            )]
            if not item_ids:
                db.rollback()
                raise ValueError("plan_requires_at_least_one_work_item")
            items = {row["id"]: row for row in db.execute(
                "SELECT id,title FROM work_items WHERE mission_id=?", (mission_id,),
            )}
            referenced_ids = {work_item_id for item in criteria for work_item_id in item["workItemIds"]}
            if referenced_ids - items.keys():
                db.rollback()
                raise ValueError("plan_criteria_tasks_must_belong_to_this_mission")
            if set(item_ids) - referenced_ids:
                db.rollback()
                raise ValueError("every_plan_task_must_support_an_acceptance_criterion")
            for item in criteria:
                item["workItems"] = [
                    {"id": work_item_id, "title": items[work_item_id]["title"]}
                    for work_item_id in item.pop("workItemIds")
                ]
            event = self._append(db, "plan.finalized", planner_id, mission_id, {
                "acceptanceCriteria": criteria,
                "workItemIds": item_ids,
                "discoveryEventId": discovery["id"] if discovery else None,
            })
            db.commit()
            return event

    def create_work_item(self, mission_id: str, title: str, detail: str = "",
                         actor_id: str = "user", depends_on: list[str] | None = None) -> dict[str, Any]:
        title, detail = title.strip(), detail.strip()
        if not title or len(title) > 500 or len(detail) > 5000:
            raise ValueError("work item title must be 1 to 500 characters and detail at most 5000")
        if depends_on is not None and any(not isinstance(item, str) for item in depends_on):
            raise ValueError("work item dependencies must be task IDs")
        dependency_ids = list(dict.fromkeys(depends_on or []))
        if len(dependency_ids) > 50:
            raise ValueError("work item dependencies must contain at most 50 task IDs")
        item = {"id": str(uuid.uuid4()), "mission_id": mission_id, "title": title,
                "detail": detail, "status": "ready", "owner": None, "lease_until": None,
                "created_at": now(), "updated_at": now()}
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if dependency_ids:
                placeholders = ",".join("?" for _ in dependency_ids)
                found = {row["id"] for row in db.execute(
                    f"SELECT id FROM work_items WHERE mission_id = ? AND id IN ({placeholders})",
                    (mission_id, *dependency_ids),
                )}
                if found != set(dependency_ids):
                    db.rollback()
                    raise ValueError("work item dependencies must belong to this mission")
            db.execute("INSERT INTO work_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(item.values()))
            db.executemany("INSERT INTO work_item_dependencies VALUES (?, ?)",
                           [(item["id"], dependency) for dependency in dependency_ids])
            item = self._work_item(db, db.execute("SELECT * FROM work_items WHERE id = ?", (item["id"],)).fetchone())
            self._append(db, "plan.item.created", actor_id, mission_id, {"workItem": item})
            self._release_claims_for_stale_plan(db, mission_id, actor_id)
            self._auto_block_mission_for_user_request(db, mission_id, actor_id)
            db.commit()
        return item

    def work_items(self, mission_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [self._work_item(db, row) for row in db.execute(
                "SELECT * FROM work_items WHERE mission_id = ? ORDER BY created_at, id", (mission_id,))]

    @classmethod
    def _release_claims_for_stale_plan(cls, db: sqlite3.Connection, mission_id: str,
                                       actor_id: str) -> None:
        mission = db.execute(
            "SELECT recipe_id FROM missions WHERE id = ?", (mission_id,),
        ).fetchone()
        if (not mission or mission["recipe_id"] != "goal-driven-sdlc"
                or cls._current_plan_checkpoint(db, mission_id)):
            return
        claims = db.execute(
            "SELECT * FROM work_items WHERE mission_id=? AND status='claimed' ORDER BY created_at,id",
            (mission_id,),
        ).fetchall()
        for claim in claims:
            timestamp = now()
            db.execute(
                "UPDATE work_items SET status='ready',owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
                (timestamp, claim["id"]),
            )
            item = cls._work_item(
                db, db.execute("SELECT * FROM work_items WHERE id=?", (claim["id"],)).fetchone(),
            )
            cls._append(db, "plan.item.updated", actor_id, mission_id, {
                "workItem": item,
                "reason": "plan changed; claim released until the planner finalises the updated plan",
            })

    def revise_work_item(self, mission_id: str, work_item_id: str, agent_id: str,
                         title: str, detail: str) -> dict[str, Any]:
        title, detail = title.strip(), detail.strip()
        if not title or len(title) > 500 or len(detail) > 5000:
            raise ValueError("work item title must be 1 to 500 characters and detail at most 5000")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM work_items WHERE id = ? AND mission_id = ?",
                (work_item_id, mission_id),
            ).fetchone()
            if not row:
                db.rollback()
                raise ValueError("work_item_not_found")
            if row["status"] == "done":
                db.rollback()
                raise ValueError("completed work items cannot be revised")
            if row["status"] == "claimed" and (
                row["owner"] != agent_id or not row["lease_until"] or row["lease_until"] < now()
            ):
                db.rollback()
                raise PermissionError("only the current claim owner may revise a claimed work item")
            updated_at = now()
            db.execute(
                "UPDATE work_items SET title = ?, detail = ?, updated_at = ? WHERE id = ?",
                (title, detail, updated_at, work_item_id),
            )
            item = self._work_item(db, db.execute("SELECT * FROM work_items WHERE id = ?", (work_item_id,)).fetchone())
            self._append(db, "plan.item.updated", agent_id, mission_id, {"workItem": item})
            self._release_claims_for_stale_plan(db, mission_id, agent_id)
            db.commit()
            return item

    def claim_work(self, mission_id: str, agent_id: str, lease_seconds: int = 900,
                   work_item_id: str | None = None) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            mission = db.execute(
                "SELECT recipe_id FROM missions WHERE id = ?", (mission_id,),
            ).fetchone()
            if not mission:
                db.rollback()
                raise ValueError("mission_not_found")
            if (mission["recipe_id"] == "goal-driven-sdlc"
                    and not self._current_plan_checkpoint(db, mission_id)):
                db.rollback()
                raise PermissionError(
                    "goal-driven SDLC work can only be claimed from a current finalized plan"
                )
            timestamp = now()
            active = db.execute(
                "SELECT * FROM work_items WHERE mission_id = ? AND owner = ? AND status = 'claimed' AND lease_until >= ? ORDER BY created_at LIMIT 1",
                (mission_id, agent_id, timestamp),
            ).fetchone()
            if active:
                db.commit()
                if work_item_id is None or active["id"] == work_item_id:
                    return self._work_item(db, active)
                return None
            query = """SELECT item.* FROM work_items item
                       WHERE item.mission_id = ?
                         AND (item.status = 'ready' OR (item.status = 'claimed' AND item.lease_until < ?))
                         AND NOT EXISTS (
                           SELECT 1 FROM work_item_dependencies links
                           JOIN work_items dependency ON dependency.id = links.depends_on_id
                           WHERE links.work_item_id = item.id AND dependency.status != 'done'
                         )"""
            values: tuple[Any, ...] = (mission_id, timestamp)
            if work_item_id is not None:
                query += " AND item.id = ?"
                values += (work_item_id,)
            query += " ORDER BY item.created_at, item.id LIMIT 1"
            row = db.execute(query, values).fetchone()
            if not row:
                db.commit()
                return None
            lease_until = datetime.fromtimestamp(datetime.now(UTC).timestamp() + lease_seconds, UTC).isoformat()
            db.execute("UPDATE work_items SET status = 'claimed', owner = ?, lease_until = ?, updated_at = ? WHERE id = ?", (agent_id, lease_until, now(), row["id"]))
            claimed = self._work_item(db, db.execute("SELECT * FROM work_items WHERE id = ?", (row["id"],)).fetchone())
            self._append(db, "plan.item.claimed", agent_id, mission_id, {"workItem": claimed})
            db.commit()
            return claimed

    def renew_work_claims(self, mission_id: str, agent_id: str, lease_seconds: int = 900) -> int:
        timestamp = now()
        lease_until = datetime.fromtimestamp(
            datetime.now(UTC).timestamp() + max(60, lease_seconds), UTC
        ).isoformat()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            cursor = db.execute(
                "UPDATE work_items SET lease_until = ?, updated_at = ? WHERE mission_id = ? AND owner = ? AND status = 'claimed' AND lease_until >= ?",
                (lease_until, timestamp, mission_id, agent_id, timestamp),
            )
            db.commit()
            return cursor.rowcount

    def active_work_item_id(self, mission_id: str, agent_id: str) -> str | None:
        timestamp = now()
        with self._connect() as db:
            row = db.execute(
                "SELECT id FROM work_items WHERE mission_id = ? AND owner = ? AND status = 'claimed' AND lease_until >= ? ORDER BY updated_at DESC LIMIT 1",
                (mission_id, agent_id, timestamp),
            ).fetchone()
            return row[0] if row else None

    def require_work_claim(self, mission_id: str, agent_id: str, work_item_id: str | None) -> None:
        """Enforce plan ownership before repository actions in the goal-driven workflow."""
        with self._connect() as db:
            mission = db.execute(
                "SELECT recipe_id FROM missions WHERE id = ?", (mission_id,)
            ).fetchone()
            if not mission:
                raise ValueError("mission_not_found")
            if mission["recipe_id"] != "goal-driven-sdlc":
                return
            if not self._current_plan_checkpoint(db, mission_id):
                raise PermissionError("goal-driven SDLC repository actions require a current finalized plan")
            if not work_item_id:
                raise PermissionError("goal-driven SDLC repository actions require a claimed plan item")
            claim = db.execute(
                """SELECT 1 FROM work_items
                   WHERE id = ? AND mission_id = ? AND owner = ? AND status = 'claimed'
                     AND lease_until >= ?""",
                (work_item_id, mission_id, agent_id, now()),
            ).fetchone()
            if not claim:
                raise PermissionError("goal-driven SDLC repository actions require your live plan-item claim")

    def create_interaction(self, mission_id: str, interaction_type: str, title: str,
                           details: str, target: str | None, requested_by: str,
                           interaction_id: str | None = None) -> dict[str, Any]:
        interaction = {"id": interaction_id or str(uuid.uuid4()), "mission_id": mission_id,
                       "interaction_type": interaction_type, "title": title,
                       "details": details, "target": target, "status": "pending",
                       "requested_by": requested_by, "created_at": now(),
                       "resolved_at": None, "resolution": None}
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(interaction.values()))
            self._append(db, f"interaction.{interaction_type}.requested", requested_by, mission_id, {"interaction": interaction})
            interaction["blocked_event"] = self._auto_block_mission_for_user_request(
                db, mission_id, requested_by
            )
            db.commit()
        return interaction

    def create_repository_file_deletion_approval(
        self, mission_id: str, title: str, details: str, target: str,
        requested_by: str, sha256: str,
    ) -> dict[str, Any]:
        """Request approval to delete one repository file at its current content version."""
        if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
            raise ValueError("repository_file_approval_requires_a_sha256_fingerprint")
        interaction = {
            "id": str(uuid.uuid4()), "mission_id": mission_id,
            "interaction_type": "approval", "title": title, "details": details,
            "target": target, "status": "pending", "requested_by": requested_by,
            "created_at": now(), "resolved_at": None, "resolution": None,
        }
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tuple(interaction.values()),
            )
            db.execute(
                "INSERT INTO repository_file_deletion_approvals VALUES (?, ?)",
                (interaction["id"], sha256),
            )
            self._append(db, "interaction.approval.requested", requested_by, mission_id, {
                "interaction": interaction,
                "fileFingerprint": {"algorithm": "sha256", "value": sha256},
            })
            interaction["blocked_event"] = self._auto_block_mission_for_user_request(
                db, mission_id, requested_by,
            )
            db.commit()
        return interaction

    def create_deferred_tool_interaction(
        self, *, mission_id: str, requested_by: str, title: str, details: str,
        target: str, trigger_sequence: int, run_id: str, conversation_id: str,
        tool_call_id: str, tool_name: str, tool_arguments: dict[str, Any],
        message_history: str, tool_summary: str = "",
        activity_labels: dict[str, str] | None = None,
        work_item_id: str | None = None,
    ) -> dict[str, Any]:
        """Atomically publish an approval request with its resumable tool frontier."""
        interaction = {
            "id": str(uuid.uuid4()), "mission_id": mission_id,
            "interaction_type": "approval", "title": title, "details": details,
            "target": target, "status": "pending", "requested_by": requested_by,
            "created_at": now(), "resolved_at": None, "resolution": None,
        }
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO interactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tuple(interaction.values()),
            )
            db.execute(
                """INSERT INTO deferred_tool_approvals (
                    interaction_id, mission_id, agent_id, trigger_sequence, run_id,
                    conversation_id, tool_call_id, tool_name, tool_arguments,
                    message_history, target, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
                (interaction["id"], mission_id, requested_by, trigger_sequence,
                 run_id, conversation_id, tool_call_id, tool_name,
                 json.dumps(tool_arguments), message_history, target,
                 interaction["created_at"], interaction["created_at"]),
            )
            self._append(
                db, "interaction.approval.requested", requested_by, mission_id,
                {"interaction": interaction},
            )
            self._append(db, "agent.tool.waiting_for_user", requested_by, mission_id, {
                "toolName": tool_name, "toolCallId": tool_call_id,
                "triggerSequence": trigger_sequence, "interactionId": interaction["id"],
                "summary": tool_summary[:240], "activityLabels": activity_labels,
                "workItemId": work_item_id, "outcome": "approval_pending",
            })
            interaction["blocked_event"] = self._auto_block_mission_for_user_request(
                db, mission_id, requested_by
            )
            db.commit()
        return interaction

    def pending_interactions(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("""
                SELECT interactions.*, missions.title AS mission_title,
                       missions.goal AS mission_goal, missions.status AS mission_status,
                       projects.id AS project_id, projects.name AS project_name,
                       projects.goal AS project_goal, projects.repository AS repository
                FROM interactions
                JOIN missions ON missions.id = interactions.mission_id
                JOIN projects ON projects.id = missions.project_id
                WHERE interactions.status = 'pending'
                ORDER BY interactions.created_at ASC, interactions.id ASC
            """).fetchall()
            return [dict(row) for row in rows]

    def add_artifact(self, mission_id: str, name: str, media_type: str, created_by: str,
                     content: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
        artifact_id = str(uuid.uuid4())
        safe_name = Path(name).name.strip()[:255]
        if not safe_name or len(content) > 10_000_000:
            raise ValueError("artifact name or size is invalid")
        stored_path = self.data_dir / "artifacts" / mission_id / artifact_id
        stored_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = stored_path.with_suffix(".tmp")
        temporary_path.write_bytes(content)
        artifact = {"id": artifact_id, "mission_id": mission_id, "name": safe_name,
                    "media_type": media_type[:255] or "application/octet-stream",
                    "path": str(stored_path), "created_by": created_by[:100], "created_at": now()}
        try:
            temporary_path.replace(stored_path)
            with self._lock, self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)", tuple(artifact.values()))
                event = self._append(db, "artifact.created", created_by, mission_id, {"artifact": artifact})
                db.commit()
            return artifact, event
        except Exception:
            stored_path.unlink(missing_ok=True)
            temporary_path.unlink(missing_ok=True)
            raise

    def artifact_content(
        self, artifact_id: str, mission_id: str | None = None,
    ) -> tuple[dict[str, Any], bytes] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM artifacts WHERE id = ? AND (? IS NULL OR mission_id = ?)",
                (artifact_id, mission_id, mission_id),
            ).fetchone()
            if not row:
                return None
            artifact = dict(row)
        path = Path(artifact["path"]).resolve(strict=True)
        allowed_root = (self.data_dir / "artifacts").resolve(strict=True)
        if not path.is_relative_to(allowed_root) or path.stat().st_size > 10_000_000:
            raise ValueError("artifact_path_invalid")
        return artifact, path.read_bytes()

    def mission_artifacts(self, mission_id: str, limit: int = 100) -> list[dict[str, Any]]:
        page_size = min(max(limit, 1), 200)
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT id, name, media_type, created_by, created_at FROM artifacts "
                "WHERE mission_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
                (mission_id, page_size),
            )]

    def artifact_reviews(self, artifact_id: str, mission_id: str | None = None) -> list[dict[str, Any]]:
        """Return review threads anchored to the artifact's immutable content version."""
        with self._connect() as db:
            artifact = db.execute(
                "SELECT id FROM artifacts WHERE id = ? AND (? IS NULL OR mission_id = ?)",
                (artifact_id, mission_id, mission_id),
            ).fetchone()
            if not artifact:
                raise ValueError("artifact_not_found")
            threads = db.execute(
                "SELECT * FROM artifact_review_threads WHERE artifact_id = ? "
                "ORDER BY created_at, id", (artifact_id,),
            ).fetchall()
            result = []
            for thread in threads:
                item = dict(thread)
                item["anchor"] = json.loads(item.pop("anchor_json"))
                item["comments"] = [dict(comment) for comment in db.execute(
                    "SELECT id, body, author_id, created_at FROM artifact_review_comments "
                    "WHERE thread_id = ? ORDER BY created_at, id", (thread["id"],),
                )]
                result.append(item)
            return result

    def add_artifact_review_comment(
        self, artifact_id: str, body: str, author_id: str,
        anchor: dict[str, Any] | None = None, thread_id: str | None = None,
        mission_id: str | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        body, author_id = body.strip(), author_id.strip()[:100]
        if not body or len(body) > 5000:
            raise ValueError("comment_must_be_1_to_5000_characters")
        if not author_id:
            raise ValueError("comment_author_required")
        anchor = anchor or {}
        if not isinstance(anchor, dict) or len(json.dumps(anchor)) > 2000:
            raise ValueError("artifact_comment_anchor_invalid")
        comment_id = str(uuid.uuid4())
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            artifact = db.execute(
                "SELECT * FROM artifacts WHERE id = ? AND (? IS NULL OR mission_id = ?)",
                (artifact_id, mission_id, mission_id),
            ).fetchone()
            if not artifact:
                db.rollback()
                raise ValueError("artifact_not_found")
            if thread_id:
                thread = db.execute(
                    "SELECT * FROM artifact_review_threads WHERE id = ? AND artifact_id = ?",
                    (thread_id, artifact_id),
                ).fetchone()
                if not thread:
                    db.rollback()
                    raise ValueError("artifact_review_thread_not_found")
                if thread["status"] != "open":
                    db.rollback()
                    raise ValueError("artifact_review_thread_resolved")
            else:
                thread_id = str(uuid.uuid4())
                artifact_path = Path(artifact["path"]).resolve(strict=True)
                allowed_root = (self.data_dir / "artifacts").resolve(strict=True)
                if not artifact_path.is_relative_to(allowed_root) or artifact_path.stat().st_size > 10_000_000:
                    db.rollback()
                    raise ValueError("artifact_path_invalid")
                content = artifact_path.read_bytes()
                version_hash = hashlib.sha256(content).hexdigest()
                db.execute(
                    "INSERT INTO artifact_review_threads "
                    "(id, artifact_id, mission_id, version_hash, anchor_json, status, created_by, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
                    (thread_id, artifact_id, artifact["mission_id"], version_hash,
                     json.dumps(anchor, separators=(",", ":")), author_id, timestamp),
                )
            db.execute(
                "INSERT INTO artifact_review_comments VALUES (?, ?, ?, ?, ?)",
                (comment_id, thread_id, body, author_id, timestamp),
            )
            thread = db.execute(
                "SELECT * FROM artifact_review_threads WHERE id = ?", (thread_id,),
            ).fetchone()
            comment = {"id": comment_id, "body": body, "author_id": author_id,
                       "created_at": timestamp}
            payload = {"artifactId": artifact_id, "threadId": thread_id,
                       "comment": comment, "anchor": json.loads(thread["anchor_json"]),
                       "versionHash": thread["version_hash"]}
            event = self._append(
                db, "artifact.review.comment.created", author_id,
                artifact["mission_id"], payload,
            )
            db.commit()
            return {"threadId": thread_id, "comment": comment}, event

    def resolve_artifact_review_thread(
        self, thread_id: str, actor_id: str = "user",
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            thread = db.execute(
                "SELECT * FROM artifact_review_threads WHERE id = ? AND status = 'open'",
                (thread_id,),
            ).fetchone()
            if not thread:
                db.rollback()
                return None
            timestamp = now()
            db.execute(
                "UPDATE artifact_review_threads SET status='resolved', resolved_by=?, resolved_at=? WHERE id=?",
                (actor_id, timestamp, thread_id),
            )
            resolved = dict(thread)
            resolved.update(status="resolved", resolved_by=actor_id, resolved_at=timestamp)
            event = self._append(
                db, "artifact.review.thread.resolved", actor_id, thread["mission_id"],
                {"artifactId": thread["artifact_id"], "threadId": thread_id,
                 "versionHash": thread["version_hash"]},
            )
            db.commit()
            return resolved, event

    def reopen_artifact_review_thread(
        self, thread_id: str, actor_id: str = "user",
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        actor_id = actor_id.strip()[:100]
        if not actor_id:
            raise ValueError("review_thread_actor_required")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            thread = db.execute(
                "SELECT * FROM artifact_review_threads WHERE id = ? AND status = 'resolved'",
                (thread_id,),
            ).fetchone()
            if not thread:
                db.rollback()
                return None
            db.execute(
                "UPDATE artifact_review_threads SET status='open', resolved_by=NULL, resolved_at=NULL WHERE id=?",
                (thread_id,),
            )
            reopened = dict(thread)
            reopened.update(status="open", resolved_by=None, resolved_at=None)
            event = self._append(
                db, "artifact.review.thread.reopened", actor_id, thread["mission_id"],
                {"artifactId": thread["artifact_id"], "threadId": thread_id,
                 "versionHash": thread["version_hash"]},
            )
            db.commit()
            return reopened, event

    @staticmethod
    def _canvas_accessible(db: sqlite3.Connection, mission_id: str, artifact_id: str) -> bool:
        return db.execute(
            "SELECT 1 FROM canvas_documents d WHERE d.id=? AND "
            "(d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
            "WHERE l.mission_id=? AND l.artifact_id=d.id))",
            (artifact_id, mission_id, mission_id),
        ).fetchone() is not None

    def link_canvas_document(self, mission_id: str, artifact_id: str,
                             actor: str = "user") -> tuple[dict[str, Any], dict[str, Any]]:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            target = db.execute("SELECT project_id FROM missions WHERE id=?", (mission_id,)).fetchone()
            source = db.execute(
                "SELECT m.id,m.project_id FROM canvas_documents d JOIN missions m ON m.id=d.mission_id "
                "WHERE d.id=?", (artifact_id,),
            ).fetchone()
            if not target or not source:
                db.rollback()
                raise ValueError("canvas_document_not_found")
            if target["project_id"] != source["project_id"]:
                db.rollback()
                raise ValueError("canvas_document_project_mismatch")
            if mission_id == source["id"]:
                db.rollback()
                raise ValueError("canvas_document_already_available")
            try:
                db.execute(
                    "INSERT INTO mission_canvas_links VALUES (?,?,?,?)",
                    (mission_id, artifact_id, actor, timestamp),
                )
            except sqlite3.IntegrityError as error:
                db.rollback()
                if self._canvas_accessible(db, mission_id, artifact_id):
                    raise ValueError("canvas_document_already_linked") from error
                raise
            document = dict(db.execute(
                "SELECT d.*,m.project_id,m.title AS mission_title FROM canvas_documents d "
                "JOIN missions m ON m.id=d.mission_id WHERE d.id=?", (artifact_id,),
            ).fetchone())
            event = self._append(db, "canvas.document.linked", actor, mission_id, {
                "artifactId": artifact_id, "sourceMissionId": source["id"],
                "title": document["title"], "revision": document["revision"],
            })
            db.commit()
            return document, event

    def unlink_canvas_document(self, mission_id: str, artifact_id: str,
                               actor: str = "user") -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            link = db.execute(
                "SELECT l.*,d.title FROM mission_canvas_links l JOIN canvas_documents d ON d.id=l.artifact_id "
                "WHERE l.mission_id=? AND l.artifact_id=?", (mission_id, artifact_id),
            ).fetchone()
            if not link:
                db.rollback()
                return None
            db.execute(
                "DELETE FROM mission_canvas_links WHERE mission_id=? AND artifact_id=?",
                (mission_id, artifact_id),
            )
            event = self._append(db, "canvas.document.unlinked", actor, mission_id, {
                "artifactId": artifact_id, "title": link["title"],
            })
            db.commit()
            return {**dict(link), "event": event}

    def canvas_documents(self, mission_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT d.id,d.mission_id,d.title,d.kind,d.language,d.revision,d.author,"
                "m.project_id,m.title AS mission_title,"
                "CASE WHEN d.mission_id=? THEN 0 ELSE 1 END AS is_linked,"
                "d.created_at,d.updated_at,"
                "(SELECT COUNT(*) FROM canvas_proposals p WHERE p.artifact_id=d.id AND p.mission_id=? AND p.status='pending') AS pending_proposals,"
                "(SELECT COUNT(*) FROM canvas_comment_threads t WHERE t.artifact_id=d.id AND t.mission_id=? AND t.resolved_at IS NULL) AS open_comments "
                "FROM canvas_documents d JOIN missions m ON m.id=d.mission_id "
                "WHERE d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
                "WHERE l.mission_id=? AND l.artifact_id=d.id) ORDER BY d.updated_at DESC,d.id",
                (mission_id, mission_id, mission_id, mission_id, mission_id),
            )]

    def create_canvas_document(
        self, mission_id: str, title: str = "Untitled document", kind: str = "markdown",
        language: str = "", body: str = "", author: str = "user",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        content = validate_content(title, kind, language, body)
        if content is None:
            raise ValueError("canvas_content_invalid")
        timestamp, artifact_id = now(), str(uuid.uuid4())
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM missions WHERE id=?", (mission_id,)).fetchone():
                db.rollback()
                raise ValueError("mission_not_found")
            db.execute(
                "INSERT INTO canvas_documents VALUES (?,?,?,?,?,1,?,?,?)",
                (artifact_id, mission_id, content["title"], content["kind"],
                 content["language"], author, timestamp, timestamp),
            )
            db.execute(
                "INSERT INTO canvas_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
                (artifact_id, mission_id, 1, content["title"], content["kind"],
                 content["language"], content["body"], author, timestamp, "Created by user"),
            )
            event = self._append(db, "canvas.document.created", author, mission_id, {
                "artifactId": artifact_id, "title": content["title"],
                "kind": content["kind"], "revision": 1,
            })
            db.commit()
            return {
                "id": artifact_id, "mission_id": mission_id, **content, "revision": 1,
                "author": author, "created_at": timestamp, "updated_at": timestamp,
            }, event

    def project_canvas_documents(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT d.id,d.mission_id,m.project_id,d.title,d.kind,d.language,d.revision,d.author,"
                "d.created_at,d.updated_at,m.title AS mission_title,"
                "(SELECT COUNT(*) FROM canvas_proposals p WHERE p.artifact_id=d.id AND p.status='pending') AS pending_proposals,"
                "(SELECT COUNT(*) FROM canvas_comment_threads t WHERE t.artifact_id=d.id AND t.resolved_at IS NULL) AS open_comments "
                "FROM canvas_documents d JOIN missions m ON m.id=d.mission_id "
                "WHERE m.project_id=? ORDER BY d.updated_at DESC,d.id", (project_id,),
            )]

    def canvas_document(self, mission_id: str, artifact_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT d.*,m.project_id,m.title AS mission_title FROM canvas_documents d "
                "JOIN missions m ON m.id=d.mission_id WHERE d.id=? AND "
                "(d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
                "WHERE l.mission_id=? AND l.artifact_id=d.id))",
                (artifact_id, mission_id, mission_id),
            ).fetchone()
            if not row:
                return None
            document = dict(row)
            current = db.execute(
                "SELECT title,kind,language,body,author,created_at,reason FROM canvas_versions "
                "WHERE artifact_id=? AND revision=?", (artifact_id, row["revision"]),
            ).fetchone()
            document["current"] = dict(current) if current else None
            document["versions"] = [dict(version) for version in db.execute(
                "SELECT revision,title,kind,language,author,created_at,reason,mission_id FROM canvas_versions "
                "WHERE artifact_id=? ORDER BY revision DESC LIMIT 50", (artifact_id,),
            )]
            document["proposals"] = [dict(proposal) for proposal in db.execute(
                "SELECT * FROM canvas_proposals WHERE artifact_id=? AND mission_id=? "
                "ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 50",
                (artifact_id, mission_id),
            )]
            threads = []
            for thread in db.execute(
                "SELECT * FROM canvas_comment_threads WHERE artifact_id=? AND mission_id=? ORDER BY created_at,id",
                (artifact_id, mission_id),
            ):
                item = dict(thread)
                item["comments"] = [dict(comment) for comment in db.execute(
                    "SELECT id,body,author,created_at FROM canvas_comments "
                    "WHERE thread_id=? ORDER BY created_at,id", (thread["id"],),
                )]
                threads.append(item)
            document["threads"] = threads
            return document

    def canvas_version(self, mission_id: str, artifact_id: str, revision: int) -> dict[str, Any] | None:
        with self._connect() as db:
            if not self._canvas_accessible(db, mission_id, artifact_id):
                return None
            row = db.execute(
                "SELECT revision,title,kind,language,body,author,created_at,reason "
                "FROM canvas_versions WHERE artifact_id=? AND revision=?",
                (artifact_id, revision),
            ).fetchone()
            return dict(row) if row else None

    def save_canvas_document(
        self, mission_id: str, artifact_id: str, expected_revision: int,
        title: str, kind: str, language: str, body: str, author: str = "user",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        content = validate_content(title, kind, language, body)
        if content is None:
            raise ValueError("canvas_content_invalid")
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 1:
            raise ValueError("canvas_revision_invalid")
        timestamp, next_revision = now(), expected_revision + 1
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            document = db.execute(
                "SELECT * FROM canvas_documents d WHERE d.id=? AND "
                "(d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
                "WHERE l.mission_id=? AND l.artifact_id=d.id))",
                (artifact_id, mission_id, mission_id),
            ).fetchone()
            if not document:
                db.rollback()
                raise ValueError("canvas_document_not_found")
            if document["revision"] != expected_revision:
                db.rollback()
                raise ValueError("canvas_revision_conflict")
            db.execute(
                "INSERT INTO canvas_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
                (artifact_id, mission_id, next_revision, content["title"], content["kind"],
                 content["language"], content["body"], author, timestamp, "Edited by user"),
            )
            db.execute(
                "UPDATE canvas_documents SET title=?,kind=?,language=?,revision=?,updated_at=? "
                "WHERE id=?",
                (content["title"], content["kind"], content["language"], next_revision,
                 timestamp, artifact_id),
            )
            updated = dict(db.execute(
                "SELECT * FROM canvas_documents WHERE id=?", (artifact_id,),
            ).fetchone())
            event = self._append(db, "canvas.version.saved", author, mission_id, {
                "artifactId": artifact_id, "revision": next_revision,
                "baseRevision": expected_revision, "title": content["title"],
            })
            db.commit()
            return updated, event

    def review_canvas_proposal(
        self, mission_id: str, proposal_id: str, decision: str, actor: str = "user",
        accepted_content: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if decision not in {"accept", "dismiss"}:
            raise ValueError("canvas_proposal_decision_invalid")
        if accepted_content is not None:
            if decision != "accept" or not isinstance(accepted_content, dict):
                raise ValueError("canvas_proposal_content_invalid")
            accepted_content = validate_content(
                accepted_content.get("title"), accepted_content.get("kind"),
                accepted_content.get("language", ""), accepted_content.get("body"),
            )
            if accepted_content is None:
                raise ValueError("canvas_proposal_content_invalid")
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            proposal = db.execute(
                "SELECT * FROM canvas_proposals WHERE id=? AND mission_id=? AND status='pending'",
                (proposal_id, mission_id),
            ).fetchone()
            if not proposal:
                db.rollback()
                raise ValueError("canvas_proposal_not_pending")
            document = db.execute(
                "SELECT * FROM canvas_documents d WHERE d.id=? AND "
                "(d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
                "WHERE l.mission_id=? AND l.artifact_id=d.id))",
                (proposal["artifact_id"], mission_id, mission_id),
            ).fetchone()
            if not document:
                db.rollback()
                raise ValueError("canvas_document_not_found")
            if decision == "accept" and document["revision"] != proposal["base_revision"]:
                db.execute(
                    "UPDATE canvas_proposals SET status='stale',reviewed_by=?,reviewed_at=? WHERE id=?",
                    (actor, timestamp, proposal_id),
                )
                event = self._append(db, "canvas.proposal.stale", actor, mission_id, {
                    "artifactId": proposal["artifact_id"], "proposalId": proposal_id,
                    "baseRevision": proposal["base_revision"], "currentRevision": document["revision"],
                })
                db.commit()
                raise ValueError("canvas_proposal_stale")
            if decision == "dismiss":
                db.execute(
                    "UPDATE canvas_proposals SET status='dismissed',reviewed_by=?,reviewed_at=? WHERE id=?",
                    (actor, timestamp, proposal_id),
                )
                event = self._append(db, "canvas.proposal.dismissed", actor, mission_id, {
                    "artifactId": proposal["artifact_id"], "proposalId": proposal_id,
                })
            else:
                next_revision = document["revision"] + 1
                content = accepted_content or {
                    "title": proposal["title"], "kind": proposal["kind"],
                    "language": proposal["language"], "body": proposal["body"],
                }
                db.execute(
                    "INSERT INTO canvas_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (proposal["artifact_id"], mission_id, next_revision, content["title"],
                     content["kind"], content["language"], content["body"],
                     actor, timestamp, f"Accepted proposal from {proposal['author']}"),
                )
                db.execute(
                    "UPDATE canvas_documents SET title=?,kind=?,language=?,revision=?,updated_at=? WHERE id=?",
                    (content["title"], content["kind"], content["language"],
                     next_revision, timestamp, proposal["artifact_id"]),
                )
                db.execute(
                    "UPDATE canvas_proposals SET status='accepted',reviewed_by=?,reviewed_at=? WHERE id=?",
                    (actor, timestamp, proposal_id),
                )
                stale = db.execute(
                    "SELECT id,mission_id FROM canvas_proposals WHERE artifact_id=? AND status='pending' AND id!=?",
                    (proposal["artifact_id"], proposal_id),
                ).fetchall()
                for item in stale:
                    db.execute(
                        "UPDATE canvas_proposals SET status='stale',reviewed_by=?,reviewed_at=? WHERE id=?",
                        (actor, timestamp, item["id"]),
                    )
                    self._append(db, "canvas.proposal.stale", actor, item["mission_id"], {
                        "artifactId": proposal["artifact_id"], "proposalId": item["id"],
                        "baseRevision": proposal["base_revision"], "currentRevision": next_revision,
                    })
                event = self._append(db, "canvas.proposal.accepted", actor, mission_id, {
                    "artifactId": proposal["artifact_id"], "proposalId": proposal_id,
                    "revision": next_revision, "baseRevision": proposal["base_revision"],
                    "title": content["title"],
                    "selectedContent": accepted_content is not None,
                })
            updated = dict(db.execute(
                "SELECT * FROM canvas_proposals WHERE id=?", (proposal_id,),
            ).fetchone())
            db.commit()
            return updated, event

    def create_canvas_comment(
        self, mission_id: str, artifact_id: str, body: str, author: str,
        *, base_revision: int | None = None, quote: str = "",
        start_offset: int | None = None, end_offset: int | None = None,
        thread_id: str | None = None, assignee: str | None = None,
        source_event_sequence: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        body, author = body.strip(), author.strip()[:100]
        if not body or len(body.encode("utf-8")) > 8 * 1024:
            raise ValueError("canvas_comment_invalid")
        if not isinstance(quote, str):
            raise ValueError("canvas_comment_quote_invalid")  # noqa: TRY004
        if len(quote.encode("utf-8")) > 4 * 1024:
            raise ValueError("canvas_comment_quote_too_long")
        if base_revision is not None and (
            not isinstance(base_revision, int) or isinstance(base_revision, bool) or base_revision < 1
        ):
            raise ValueError("canvas_comment_revision_invalid")
        if thread_id is not None and (not isinstance(thread_id, str) or len(thread_id) > 80):
            raise ValueError("canvas_comment_thread_invalid")
        if (start_offset is not None and (not isinstance(start_offset, int) or isinstance(start_offset, bool))) or (
            end_offset is not None and (not isinstance(end_offset, int) or isinstance(end_offset, bool))
        ):
            raise ValueError("canvas_comment_selection_invalid")
        if (start_offset is None) != (end_offset is None) or (
            start_offset is not None and (start_offset < 0 or end_offset < start_offset)
        ):
            raise ValueError("canvas_comment_selection_invalid")
        if assignee is not None:
            if not isinstance(assignee, str):
                raise ValueError("canvas_comment_assignee_invalid")
            assignee = assignee.strip().lstrip("@") or None
            if assignee and (len(assignee) > 80 or not all(c.isascii() and (c.isalnum() or c in "-_.") for c in assignee)):
                raise ValueError("canvas_comment_assignee_invalid")
        timestamp, comment_id = now(), str(uuid.uuid4())
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            document = db.execute(
                "SELECT * FROM canvas_documents d WHERE d.id=? AND "
                "(d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
                "WHERE l.mission_id=? AND l.artifact_id=d.id))",
                (artifact_id, mission_id, mission_id),
            ).fetchone()
            if not document:
                db.rollback()
                raise ValueError("canvas_document_not_found")
            if thread_id:
                thread = db.execute(
                    "SELECT * FROM canvas_comment_threads WHERE id=? AND artifact_id=? AND mission_id=?",
                    (thread_id, artifact_id, mission_id),
                ).fetchone()
                if not thread or thread["resolved_at"]:
                    db.rollback()
                    raise ValueError("canvas_comment_thread_not_open")
                if assignee is not None:
                    db.execute("UPDATE canvas_comment_threads SET assignee=? WHERE id=?", (assignee, thread_id))
            else:
                if base_revision is None or not db.execute(
                    "SELECT 1 FROM canvas_versions WHERE artifact_id=? AND revision=?",
                    (artifact_id, base_revision),
                ).fetchone():
                    db.rollback()
                    raise ValueError("canvas_comment_revision_not_found")
                thread_id = str(uuid.uuid4())
                db.execute(
                    "INSERT INTO canvas_comment_threads VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)",
                    (thread_id, artifact_id, mission_id, base_revision, start_offset,
                     end_offset, quote, assignee, timestamp),
                )
            db.execute(
                "INSERT INTO canvas_comments VALUES (?,?,?,?,?,?,?,?)",
                (comment_id, thread_id, artifact_id, mission_id, body, author,
                 timestamp, source_event_sequence),
            )
            payload = {"artifactId": artifact_id, "threadId": thread_id,
                       "comment": {"id": comment_id, "body": body, "author": author,
                                   "createdAt": timestamp},
                       "assignee": assignee}
            event = self._append(db, "canvas.comment.created", author, mission_id, payload)
            db.commit()
            return {"threadId": thread_id, "comment": payload["comment"]}, event

    def resolve_canvas_comment(self, mission_id: str, thread_id: str,
                               actor: str = "user") -> tuple[dict[str, Any], dict[str, Any]] | None:
        timestamp = now()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            thread = db.execute(
                "SELECT * FROM canvas_comment_threads WHERE id=? AND mission_id=? AND resolved_at IS NULL",
                (thread_id, mission_id),
            ).fetchone()
            if not thread:
                db.rollback()
                return None
            db.execute(
                "UPDATE canvas_comment_threads SET resolved_at=?,resolved_by=? WHERE id=?",
                (timestamp, actor, thread_id),
            )
            event = self._append(db, "canvas.comment.resolved", actor, mission_id, {
                "artifactId": thread["artifact_id"], "threadId": thread_id,
                "baseRevision": thread["base_revision"],
            })
            updated = dict(db.execute(
                "SELECT * FROM canvas_comment_threads WHERE id=?", (thread_id,),
            ).fetchone())
            db.commit()
            return updated, event

    def append_agent_update(self, mission_id: str, agent_id: str, text: str,
                            recipient: str | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        """Append an agent post and its Canvas publications in one transaction."""
        documents = document_publications(text)
        comments = comment_publications(text)
        visible = visible_message(text) or (
            "Shared a document." if documents else "Added a document comment."
        )
        payload = {"text": visible, "recipient": recipient, **(metadata or {})}
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            event = self._append(db, "agent.message.created", agent_id, mission_id, payload)
            if recipient is None:
                for content in documents:
                    timestamp = now()
                    artifact_id = content["artifact_id"]
                    if artifact_id is None:
                        artifact_id = str(uuid.uuid4())
                        db.execute(
                            "INSERT INTO canvas_documents VALUES (?,?,?,?,?,1,?,?,?)",
                            (artifact_id, mission_id, content["title"], content["kind"],
                             content["language"], agent_id, timestamp, timestamp),
                        )
                        db.execute(
                            "INSERT INTO canvas_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (artifact_id, mission_id, 1, content["title"], content["kind"],
                             content["language"], content["body"], agent_id, timestamp,
                             "Created by agent"),
                        )
                        self._append(db, "canvas.document.created", agent_id, mission_id, {
                            "artifactId": artifact_id, "title": content["title"],
                            "kind": content["kind"], "revision": 1,
                            "sourceEventSequence": event["sequence"],
                        })
                    else:
                        document = db.execute(
                            "SELECT 1 FROM canvas_documents d WHERE d.id=? AND "
                            "(d.mission_id=? OR EXISTS (SELECT 1 FROM mission_canvas_links l "
                            "WHERE l.mission_id=? AND l.artifact_id=d.id))",
                            (artifact_id, mission_id, mission_id),
                        ).fetchone()
                        base_exists = db.execute(
                            "SELECT 1 FROM canvas_versions WHERE artifact_id=? AND revision=?",
                            (artifact_id, content["base_revision"]),
                        ).fetchone()
                        if not document or not base_exists:
                            continue
                        proposal_id, timestamp = str(uuid.uuid4()), now()
                        db.execute(
                            "INSERT INTO canvas_proposals "
                            "(id,artifact_id,mission_id,base_revision,title,kind,language,body,author,created_at,status,source_event_sequence) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)",
                            (proposal_id, artifact_id, mission_id, content["base_revision"],
                             content["title"], content["kind"], content["language"],
                             content["body"], agent_id, timestamp, event["sequence"]),
                        )
                        self._append(db, "canvas.proposal.created", agent_id, mission_id, {
                            "artifactId": artifact_id, "proposalId": proposal_id,
                            "baseRevision": content["base_revision"],
                            "title": content["title"], "sourceEventSequence": event["sequence"],
                        })
                for comment in comments:
                    artifact_id = comment["artifact_id"]
                    if comment["thread_id"]:
                        thread = db.execute(
                            "SELECT * FROM canvas_comment_threads WHERE id=? AND artifact_id=? AND mission_id=? AND resolved_at IS NULL",
                            (comment["thread_id"], artifact_id, mission_id),
                        ).fetchone()
                        if not thread:
                            continue
                        thread_id = comment["thread_id"]
                        if comment["assignee"] is not None:
                            db.execute("UPDATE canvas_comment_threads SET assignee=? WHERE id=?",
                                       (comment["assignee"], thread_id))
                    else:
                        revision_exists = db.execute(
                            "SELECT 1 FROM canvas_versions WHERE artifact_id=? AND revision=?",
                            (artifact_id, comment["base_revision"]),
                        ).fetchone()
                        if not revision_exists:
                            continue
                        thread_id = str(uuid.uuid4())
                        db.execute(
                            "INSERT INTO canvas_comment_threads VALUES (?,?,?,?,NULL,NULL,?,?,?,NULL,NULL)",
                            (thread_id, artifact_id, mission_id, comment["base_revision"],
                             comment["quote"], comment["assignee"], now()),
                        )
                    comment_id, timestamp = str(uuid.uuid4()), now()
                    db.execute(
                        "INSERT INTO canvas_comments VALUES (?,?,?,?,?,?,?,?)",
                        (comment_id, thread_id, artifact_id, mission_id, comment["body"],
                         agent_id, timestamp, event["sequence"]),
                    )
                    self._append(db, "canvas.comment.created", agent_id, mission_id, {
                        "artifactId": artifact_id, "threadId": thread_id,
                        "comment": {"id": comment_id, "body": comment["body"],
                                    "author": agent_id, "createdAt": timestamp},
                        "assignee": comment["assignee"],
                    })
            db.commit()
            return event

    def resolve_interaction(self, interaction_id: str, resolution: str) -> dict[str, Any] | None:
        if not resolution.strip() or len(resolution) > 5000:
            raise ValueError("resolution must be 1 to 5000 characters")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM interactions WHERE id = ? AND status = 'pending'", (interaction_id,)).fetchone()
            if not row:
                db.rollback()
                return None
            interaction = dict(row)
            timestamp = now()
            db.execute("UPDATE interactions SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?", (timestamp, resolution, interaction_id))
            interaction.update(status="resolved", resolved_at=timestamp, resolution=resolution)
            interaction["event"] = self._append(
                db,
                f"interaction.{interaction['interaction_type']}.resolved",
                "user",
                interaction["mission_id"],
                {"interaction": dict(interaction)},
            )
            remaining = db.execute(
                "SELECT COUNT(*) FROM interactions WHERE mission_id=? AND status='pending'",
                (interaction["mission_id"],),
            ).fetchone()[0]
            blocked = db.execute("SELECT blocked_reason FROM missions WHERE id=?",
                                 (interaction["mission_id"],)).fetchone()
            if not remaining and blocked and blocked["blocked_reason"]:
                db.execute("UPDATE missions SET blocked_reason=NULL,blocked_at=NULL WHERE id=?",
                           (interaction["mission_id"],))
                interaction["unblocked_event"] = self._append(
                    db, "mission.unblocked", "user", interaction["mission_id"],
                    {"reason": "all pending user requests were resolved"},
                )
            db.commit()
            return interaction


def default_data_directory() -> Path:
    return Path(os.environ.get("TRIBE_DATA_DIR", Path.home() / ".tribe")).expanduser()


def default_store() -> MissionStore:
    root = default_data_directory()
    from .workspace_restore import activate_pending_workspace_restore

    restore_error = activate_pending_workspace_restore(root)
    if restore_error:
        print(restore_error, flush=True)
    return MissionStore(root / "tribe.sqlite3")
