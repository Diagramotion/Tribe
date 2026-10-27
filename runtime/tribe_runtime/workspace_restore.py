"""Validate and stage a workspace backup for activation on the next runtime start."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .store import MissionStore

MAX_BACKUP_BYTES = 6_000_000_000
PRESERVED_DIRECTORIES = ("agents", "recipes", "mcp")


class WorkspaceRestore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir.resolve()
        self.parent = self.data_dir.parent
        self.prefix = f".{self.data_dir.name}.restore-"
        self.marker = self.parent / f"{self.prefix}pending.json"
        self.committed = self.parent / f"{self.prefix}committed.json"

    def stage(self, archive: Path) -> dict[str, Any]:
        """Validate an archive and prepare an isolated replacement without touching live data."""
        if self.marker.exists():
            raise ValueError("workspace_restore_already_pending")
        if archive.stat().st_size > MAX_BACKUP_BYTES:
            raise ValueError("workspace_backup_too_large")

        stage = self.parent / f"{self.prefix}stage-{uuid.uuid4().hex}"
        rollback = self.parent / f"{self.prefix}rollback-{uuid.uuid4().hex}"
        stage.mkdir()
        try:
            restored = MissionStore.restore_workspace_backup(
                archive, stage, artifact_data_dir=self.data_dir,
            )
            preserved = self._copy_local_configuration(stage)
            with restored._connect() as db:
                counts = {
                    "projects": db.execute("SELECT count(*) FROM projects").fetchone()[0],
                    "missions": db.execute("SELECT count(*) FROM missions").fetchone()[0],
                    "artifacts": db.execute("SELECT count(*) FROM artifacts").fetchone()[0],
                }
            marker = {
                "format": "tribe-pending-workspace-restore",
                "version": 1,
                "stage": stage.name,
                "rollback": rollback.name,
                "createdAt": datetime.now(UTC).isoformat(),
            }
            self._write_marker(marker)
            return {**counts, "preservedSettings": preserved}
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise

    def activate_pending(self) -> str | None:
        """Promote a staged workspace before the store opens; roll back on startup failure."""
        if not self.marker.exists():
            return None
        try:
            marker = json.loads(self.marker.read_text(encoding="utf-8"))
            if marker.get("format") != "tribe-pending-workspace-restore" or marker.get("version") != 1:
                raise ValueError("workspace_restore_marker_invalid")
            stage = self._sibling(marker.get("stage"), "stage-")
            rollback = self._sibling(marker.get("rollback"), "rollback-")

            if self.data_dir.exists() and not rollback.exists():
                self.data_dir.replace(rollback)
            if not self.data_dir.exists():
                if stage.exists():
                    stage.replace(self.data_dir)
                elif rollback.exists():
                    rollback.replace(self.data_dir)
                    raise RuntimeError("workspace_restore_stage_missing")
                else:
                    raise RuntimeError("workspace_restore_recovery_paths_missing")
            elif stage.exists():
                raise RuntimeError("workspace_restore_recovery_state_ambiguous")

            # Opening the promoted database runs any supported schema migration before commit.
            MissionStore(self.data_dir / "tribe.sqlite3")
            self._write_json(self.committed, {
                "format": "tribe-workspace-restore-commit",
                "version": 1,
                "rollback": rollback.name if rollback.exists() else None,
            })
            self.marker.unlink(missing_ok=True)
            self._prune_rollbacks(rollback)
            return None
        except Exception as error:  # noqa: BLE001 - startup must recover the previous workspace
            self._roll_back_failed_activation()
            return f"Workspace restore could not be activated: {error}"

    def finalize_activation(self) -> str | None:
        """Discard the previous workspace after the restored runtime has bound successfully."""
        if not self.committed.exists():
            return None
        try:
            commit = json.loads(self.committed.read_text(encoding="utf-8"))
            if commit.get("format") != "tribe-workspace-restore-commit" or commit.get("version") != 1:
                raise ValueError("workspace_restore_commit_invalid")
            rollback_name = commit.get("rollback")
            if rollback_name is not None:
                rollback = self._sibling(rollback_name, "rollback-")
                if rollback.is_dir() and not rollback.is_symlink():
                    shutil.rmtree(rollback)
            self.committed.unlink(missing_ok=True)
            return None
        except (OSError, ValueError, json.JSONDecodeError) as error:
            return f"Workspace restore cleanup failed: {error}"

    def _copy_local_configuration(self, stage: Path) -> list[str]:
        preserved = []
        if not self.data_dir.is_dir():
            return preserved
        for name in PRESERVED_DIRECTORIES:
            source = self.data_dir / name
            destination = stage / name
            if source.is_dir() and not source.is_symlink():
                self._copy_tree_without_symlinks(source, destination)
                preserved.append(name)
        return preserved

    @staticmethod
    def _copy_tree_without_symlinks(source: Path, destination: Path) -> None:
        for current, directories, filenames in os.walk(source, followlinks=False):
            current_path = Path(current)
            relative = current_path.relative_to(source)
            target = destination / relative
            target.mkdir(parents=True, exist_ok=True)
            directories[:] = [
                directory for directory in directories
                if not (current_path / directory).is_symlink()
            ]
            for filename in filenames:
                source_file = current_path / filename
                if source_file.is_file() and not source_file.is_symlink():
                    shutil.copy2(source_file, target / filename)

    def _sibling(self, value: Any, expected_prefix: str) -> Path:
        if not isinstance(value, str) or not value.startswith(self.prefix + expected_prefix):
            raise ValueError("workspace_restore_marker_invalid")
        path = self.parent / value
        if path.parent.resolve() != self.parent:
            raise ValueError("workspace_restore_marker_invalid")
        return path

    def _write_marker(self, value: dict[str, Any]) -> None:
        self._write_json(self.marker, value)

    @staticmethod
    def _write_json(destination: Path, value: dict[str, Any]) -> None:
        temporary = destination.with_name(f"{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)

    def _roll_back_failed_activation(self) -> None:
        try:
            marker = json.loads(self.marker.read_text(encoding="utf-8"))
            rollback = self._sibling(marker.get("rollback"), "rollback-")
            stage_name = marker.get("stage")
            stage = self._sibling(stage_name, "stage-")
            if rollback.exists():
                if self.data_dir.exists():
                    failed = self.parent / f"{self.prefix}failed-{uuid.uuid4().hex}"
                    self.data_dir.replace(failed)
                rollback.replace(self.data_dir)
            elif self.data_dir.exists():
                # On first launch there may be no previous workspace to restore.
                # Quarantine the rejected import so normal startup can initialise cleanly.
                failed = self.parent / f"{self.prefix}failed-{uuid.uuid4().hex}"
                self.data_dir.replace(failed)
            shutil.rmtree(stage, ignore_errors=True)
            self.marker.unlink(missing_ok=True)
        except (OSError, ValueError, json.JSONDecodeError):
            # Leave recovery evidence in place rather than deleting a potentially valid copy.
            return

    def _prune_rollbacks(self, keep: Path) -> None:
        for candidate in self.parent.glob(f"{self.prefix}rollback-*"):
            if candidate != keep and candidate.is_dir() and not candidate.is_symlink():
                shutil.rmtree(candidate, ignore_errors=True)


def activate_pending_workspace_restore(data_dir: Path) -> str | None:
    return WorkspaceRestore(data_dir).activate_pending()
