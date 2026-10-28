from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tribe_runtime import project_memory
from tribe_runtime.project_memory import (
    accept_project_memory,
    list_project_memory,
    read_project_memory,
    save_project_memory,
    set_project_memory_status,
)
from tribe_runtime.store import MissionStore


class ProjectMemoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="tribe-project-memory-")
        self.root = Path(self.temp.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "tribe-tests@example.invalid")
        self.git("config", "user.name", "Tribe tests")
        (self.repository / "README.md").write_text("memory test\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-qm", "base")
        self.store = MissionStore(self.root / "data" / "tribe.sqlite3")
        self.project, self.mission = self.store.create_project(
            str(self.repository), "Test project", "Test chat", "Memory scope test"
        )
        self.memory_root = self.root / "smriti"
        self.environment = patch.dict(os.environ, {"SMRITI_MEMORY_ROOT": str(self.memory_root)})
        self.environment.start()
        with project_memory._LOCK:
            project_memory._STORES.clear()

    def tearDown(self) -> None:
        with project_memory._LOCK:
            project_memory._STORES.clear()
        self.environment.stop()
        self.temp.cleanup()

    def git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", *args], cwd=self.repository, check=True, capture_output=True, text=True,
        )
        return result.stdout.strip()

    def test_project_memory_is_canonical_in_smriti_and_scope_checked(self) -> None:
        entry = save_project_memory(
            self.store, self.project["id"], self.mission["id"], "user",
            "Build command", "Run npm test.",
        )
        self.assertEqual(self.store.project_knowledge(self.project["id"]), [])
        self.assertEqual(read_project_memory(self.project["id"], entry["id"])["content"], "Run npm test.")
        self.assertEqual(len(list_project_memory(self.store, self.project["id"])), 1)

        other_repository = self.root / "other-repository"
        other_repository.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=other_repository, check=True)
        subprocess.run(["git", "config", "user.email", "tribe-tests@example.invalid"], cwd=other_repository, check=True)
        subprocess.run(["git", "config", "user.name", "Tribe tests"], cwd=other_repository, check=True)
        (other_repository / "README.md").write_text("other\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=other_repository, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=other_repository, check=True)
        other_project, other_mission = self.store.create_project(
            str(other_repository), "Other project", "Other chat", "Other scope"
        )
        with self.assertRaisesRegex(ValueError, "project_memory_not_found"):
            set_project_memory_status(
                self.store, other_project["id"], entry["id"], "archived", other_mission["id"],
            )

    def test_accepted_suggestion_syncs_to_smriti_and_is_recoverable(self) -> None:
        proposal = self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Test command", "Run pytest.",
        )
        result = accept_project_memory(
            self.store, self.store.review_knowledge_proposal(proposal["id"], "user", "accept"),
        )
        self.assertEqual(self.store.project_knowledge(self.project["id"]), [])
        self.assertEqual(read_project_memory(self.project["id"], result["entry"]["id"])["content"], "Run pytest.")
        self.assertEqual(len(list_project_memory(self.store, self.project["id"])), 1)

    def test_legacy_import_does_not_overwrite_existing_smriti_content(self) -> None:
        legacy = self.store.save_knowledge(
            self.project["id"], self.mission["id"], "user", "Project rule", "Legacy wording.",
        )
        self.assertEqual(list_project_memory(self.store, self.project["id"])[0]["content"], "Legacy wording.")
        memory_store, _ = project_memory._store()
        memory_store.update_memory(
            id=f"tribe/{legacy['id']}", content="Canonical Smriti wording.",
        )
        entries = list_project_memory(self.store, self.project["id"])
        self.assertEqual(entries[0]["content"], "Canonical Smriti wording.")


if __name__ == "__main__":
    unittest.main()
