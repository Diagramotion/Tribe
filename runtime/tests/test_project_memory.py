from __future__ import annotations

import os
import json
import subprocess
import tempfile
import threading
import urllib.request
import unittest
import uuid
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from tribe_runtime import project_memory
from tribe_runtime.project_memory import (
    list_project_memory,
    read_project_memory,
    resolve_project_memory_migration,
    retire_verified_project_memory,
    review_project_memory_proposal,
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

    def insert_legacy_memory(self, title: str, content: str) -> dict[str, object]:
        entry_id = str(uuid.uuid4())
        timestamp = datetime.now(UTC).isoformat()
        event = self.store.append("knowledge.entry.saved", "user", self.mission["id"], {
            "entry": {"id": entry_id, "project_id": self.project["id"], "title": title,
                      "content": content, "created_by": "user", "updated_by": "user"},
        })
        with self.store._connect() as db:
            db.execute(
                """INSERT INTO project_knowledge(
                       id,project_id,title,content,created_by,updated_at,source_mission_id,
                       source_event_sequence,created_at,updated_by,status
                   ) VALUES (?,?,?,?,?,?,?,?,?,?, 'active')""",
                (entry_id, self.project["id"], title, content, "user", timestamp,
                 self.mission["id"], event["sequence"], timestamp, "user"),
            )
        return {"id": entry_id, "project_id": self.project["id"], "title": title,
                "content": content, "created_by": "user", "updated_by": "user",
                "source_mission_id": self.mission["id"],
                "source_event_sequence": event["sequence"], "created_at": timestamp,
                "updated_at": timestamp, "status": "active"}

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
        result = review_project_memory_proposal(
            self.store, proposal["id"], "user", "accept",
        )
        self.assertEqual(self.store.project_knowledge(self.project["id"]), [])
        self.assertEqual(read_project_memory(self.project["id"], result["entry"]["id"])["content"], "Run pytest.")
        self.assertEqual(len(list_project_memory(self.store, self.project["id"])), 1)

    def test_legacy_import_does_not_overwrite_existing_smriti_content(self) -> None:
        legacy = self.insert_legacy_memory("Project rule", "Legacy wording.")
        self.assertEqual(list_project_memory(self.store, self.project["id"])[0]["content"], "Legacy wording.")
        memory_store, _ = project_memory._store()
        memory_store.update_memory(
            id=f"tribe/{legacy['id']}", content="Canonical Smriti wording.",
        )
        entries = list_project_memory(self.store, self.project["id"])
        self.assertEqual(entries[0]["content"], "Canonical Smriti wording.")

    def test_migration_conflict_review_keeps_or_replaces_the_current_version(self) -> None:
        legacy = self.insert_legacy_memory("Project rule", "Previously saved wording.")
        second = self.insert_legacy_memory("Second rule", "Second legacy wording.")
        list_project_memory(self.store, self.project["id"])
        memory_store, _ = project_memory._store()
        memory_store.update_memory(
            id=f"tribe/{legacy['id']}", content="Current Smriti wording.",
        )
        memory_store.update_memory(
            id=f"tribe/{second['id']}", content="Second Smriti wording.",
        )

        conflict = project_memory.audit_project_memory_migration(self.store, self.project["id"])["conflicts"][0]
        self.assertEqual(conflict["legacy"]["content"], "Previously saved wording.")
        self.assertEqual(conflict["smriti"]["content"], "Current Smriti wording.")
        kept = resolve_project_memory_migration(
            self.store, self.project["id"], legacy["id"], "keep_smriti",
        )
        self.assertEqual([item["entry_id"] for item in kept["conflicts"]], [second["id"]])
        self.assertEqual(kept["reviewed"][0]["resolution"], "keep_smriti")
        self.assertEqual(read_project_memory(self.project["id"], legacy["id"])["content"], "Current Smriti wording.")

        memory_store.update_memory(
            id=f"tribe/{legacy['id']}", content="Another current version.",
        )
        restored = resolve_project_memory_migration(
            self.store, self.project["id"], legacy["id"], "use_legacy",
        )
        self.assertEqual([item["entry_id"] for item in restored["conflicts"]], [second["id"]])
        self.assertEqual(restored["reviewed"][0]["resolution"], "use_legacy")
        self.assertEqual(read_project_memory(self.project["id"], legacy["id"])["content"], "Previously saved wording.")
        resolved = resolve_project_memory_migration(
            self.store, self.project["id"], second["id"], "keep_smriti",
        )
        self.assertEqual(resolved["conflicts"], [])
        self.assertEqual(self.store.project_knowledge(self.project["id"], include_archived=True), [])
        self.assertGreaterEqual(len(resolved["reviewed"]), 3)

    def test_verified_migration_retires_legacy_content_and_keeps_hash_ledger(self) -> None:
        legacy = self.insert_legacy_memory("Project rule", "Legacy wording.")
        list_project_memory(self.store, self.project["id"])

        retired = retire_verified_project_memory(self.store)

        self.assertEqual(retired["retired"], 1)
        self.assertEqual(self.store.project_knowledge(self.project["id"], include_archived=True), [])
        ledger = self.store.project_memory_migration_ledger(self.project["id"])
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["source_kind"], "legacy")
        self.assertNotIn("content", ledger[0])
        self.assertEqual(read_project_memory(self.project["id"], legacy["id"])["content"], "Legacy wording.")
        self.assertEqual(retired["migration"]["expected"], 1)
        self.assertEqual(retired["migration"]["verified"], 1)

    def test_accepted_proposal_migration_keeps_the_user_decision(self) -> None:
        proposal = self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Test command", "Run pytest.",
        )
        review_project_memory_proposal(self.store, proposal["id"], "user", "accept")

        retired = retire_verified_project_memory(self.store, self.project["id"])

        decisions = self.store.knowledge_proposals(self.project["id"], pending_only=False)
        self.assertEqual(decisions[0]["status"], "accepted")
        self.assertEqual(decisions[0]["reviewed_by"], "user")
        self.assertEqual(retired["migration"]["expected"], 1)
        self.assertEqual(retired["migration"]["verified"], 1)
        self.assertEqual(self.store.project_memory_migration_ledger(self.project["id"])[0]["source_kind"], "proposal")

    def test_accepted_proposal_matches_existing_smriti_memory_after_legacy_retirement(self) -> None:
        existing = save_project_memory(
            self.store, self.project["id"], self.mission["id"], "user",
            "Build command", "Run npm test.",
        )
        proposal = self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Build command", "Run npm test -- --run.",
        )

        result = review_project_memory_proposal(self.store, proposal["id"], "user", "accept")

        self.assertEqual(result["proposal"]["status"], "accepted")
        self.assertEqual(result["proposal"]["memory_id"], existing["id"])
        self.assertEqual(read_project_memory(self.project["id"], existing["id"])["content"], "Run npm test -- --run.")
        self.assertEqual(len(list_project_memory(self.store, self.project["id"])), 1)

    def test_memory_migration_review_api_exposes_and_resolves_conflict(self) -> None:
        from tribe_runtime import server as runtime_server

        legacy = self.insert_legacy_memory("Project rule", "Saved version.")
        list_project_memory(self.store, self.project["id"])
        memory_store, _ = project_memory._store()
        memory_store.update_memory(id=f"tribe/{legacy['id']}", content="Current version.")

        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{http.server_port}"
                with urllib.request.urlopen(
                    f"{base}/api/knowledge?project={self.project['id']}", timeout=3,
                ) as response:
                    payload = json.loads(response.read())
                request = urllib.request.Request(
                    f"{base}/api/knowledge/migration-review",
                    data=json.dumps({
                        "projectId": self.project["id"], "entryId": legacy["id"],
                        "decision": "keep_smriti",
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    reviewed = json.loads(response.read())
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

        self.assertEqual(payload["migration"]["conflicts"][0]["smriti"]["content"], "Current version.")
        self.assertEqual(reviewed["migration"]["conflicts"], [])
        self.assertEqual(reviewed["migration"]["reviewed"][0]["resolution"], "keep_smriti")

    def test_api_accepts_proposals_through_the_project_memory_wrapper(self) -> None:
        from tribe_runtime import server as runtime_server

        proposal = self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Project rule", "Use ruff.",
        )
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/knowledge/{proposal['id']}/review",
                    data=json.dumps({"decision": "accept"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    result = json.loads(response.read())
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

        self.assertEqual(result["proposal"]["status"], "accepted")
        self.assertEqual(result["proposal"]["memory_id"], proposal["id"])
        self.assertEqual(read_project_memory(self.project["id"], proposal["id"])["content"], "Use ruff.")
        self.assertEqual(self.store.project_knowledge(self.project["id"]), [])

    def test_migration_audit_hides_other_project_content_and_prevents_overwrite(self) -> None:
        legacy = self.insert_legacy_memory("Project rule", "Legacy project wording.")
        list_project_memory(self.store, self.project["id"])
        memory_store, _ = project_memory._store()
        memory_store.update_memory(
            id=f"tribe/{legacy['id']}", content="Private other project wording.",
            meta={"scope": {"tribe_project_id": "another-project"}},
        )

        conflict = project_memory.audit_project_memory_migration(
            self.store, self.project["id"],
        )["conflicts"][0]
        self.assertEqual(conflict["smriti"]["title"], "Unavailable outside this project")
        self.assertIsNone(conflict["smriti"]["content"])
        self.assertIn("another project", conflict["smriti"]["unavailable_reason"])
        with self.assertRaisesRegex(ValueError, "memory_migration_scope_conflict_requires_copy"):
            resolve_project_memory_migration(
                self.store, self.project["id"], legacy["id"], "keep_smriti",
            )
        with self.assertRaisesRegex(ValueError, "memory_migration_scope_conflict_requires_copy"):
            resolve_project_memory_migration(
                self.store, self.project["id"], legacy["id"], "use_legacy",
            )
        retirement = retire_verified_project_memory(self.store, self.project["id"])
        self.assertEqual(retirement["retired"], 0)
        self.assertEqual(len(self.store.project_knowledge(self.project["id"], include_archived=True)), 1)
        self.assertEqual(
            read_project_memory("another-project", legacy["id"])["content"],
            "Private other project wording.",
        )

        recovered_audit = resolve_project_memory_migration(
            self.store, self.project["id"], legacy["id"], "copy_legacy_to_project",
        )
        recovered = list_project_memory(self.store, self.project["id"])
        self.assertEqual(len(recovered), 1)
        self.assertNotEqual(recovered[0]["id"], legacy["id"])
        self.assertEqual(recovered[0]["content"], "Legacy project wording.")
        self.assertEqual(recovered_audit["conflicts"], [])
        self.assertEqual(recovered_audit["verified"], 1)
        self.assertEqual(
            read_project_memory("another-project", legacy["id"])["content"],
            "Private other project wording.",
        )
        self.assertEqual(self.store.project_knowledge(self.project["id"], include_archived=True), [])
        self.assertEqual(
            self.store.project_memory_migration_reviews(self.project["id"])[0]["resolution"],
            "copy_legacy_to_project",
        )


if __name__ == "__main__":
    unittest.main()
