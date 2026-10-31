"""Project-scoped governance adapter over Smriti's durable Markdown memory store."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from .store import MissionStore

_LOCK = threading.RLock()
_STORES: dict[Path, Any] = {}


def _root() -> Path:
    configured = os.environ.get("SMRITI_MEMORY_ROOT", "~/.smriti/memory")
    return Path(configured).expanduser().resolve()


def _store():
    try:
        from smriti_mcp.frontmatter import parse_markdown
        from smriti_mcp.store import MemoryStore
    except ImportError as error:
        raise RuntimeError("Install smriti-mcp to enable project memory.") from error
    root = _root()
    with _LOCK:
        memory_store = _STORES.get(root)
        if memory_store is None:
            memory_store = MemoryStore(root)
            _STORES[root] = memory_store
    return memory_store, parse_markdown


def _memory_id(entry_id: str) -> str:
    return f"tribe/{entry_id}"


def _write(project_id: str, entry: dict[str, Any], *, only_missing: bool = False) -> None:
    memory_store, _ = _store()
    identifier = _memory_id(str(entry["id"]))
    metadata = {
        "title": str(entry["title"])[:200],
        "category": "project",
        "status": str(entry.get("status") or "active"),
        "short_description": str(entry["content"]).strip().splitlines()[0][:200],
        "scope": {"tribe_project_id": project_id},
        "source_agent": str(entry.get("updated_by") or entry.get("created_by") or "tribe"),
    }
    try:
        existing_text = memory_store.get_memory(identifier)
    except (FileNotFoundError, ValueError):
        memory_store.create_memory(meta=metadata, content=entry["content"], id=identifier)
    else:
        if only_missing:
            return
        from smriti_mcp.frontmatter import parse_markdown
        existing_meta, existing_content = parse_markdown(existing_text)
        if (existing_content.strip() != entry["content"].strip()
                or existing_meta.get("title") != metadata["title"]
                or existing_meta.get("status") != metadata["status"]
                or existing_meta.get("scope") != metadata["scope"]
                or existing_meta.get("source_agent") != metadata["source_agent"]):
            memory_store.update_memory(id=identifier, meta=metadata, content=entry["content"])


def _migrate_accepted(store: MissionStore, project_id: str) -> None:
    """Import legacy accepted entries idempotently; keep proposal decisions in Tribe."""
    for entry in store.project_knowledge(project_id, include_archived=True):
        _write(project_id, entry, only_missing=True)
    for proposal in store.knowledge_proposals(project_id, pending_only=False):
        if proposal.get("status") != "accepted":
            continue
        _write(project_id, {
            "id": proposal.get("memory_id") or proposal["id"], "title": proposal["title"],
            "content": proposal["content"], "status": "active",
            "created_by": proposal.get("proposed_by", "tribe"),
            "updated_by": proposal.get("reviewed_by", "tribe"),
        }, only_missing=True)


def migrate_all_project_memory(store: MissionStore) -> int:
    """Idempotently move every accepted legacy entry into its project-scoped Smriti store."""
    project_ids = store.project_ids()
    for project_id in project_ids:
        _migrate_accepted(store, project_id)
    return len(project_ids)


def _expected_entries(store: MissionStore, project_filter: str | None = None
                      ) -> list[tuple[str, dict[str, Any], str, str]]:
    expected: list[tuple[str, dict[str, Any], str, str]] = []
    project_ids = [project_filter] if project_filter else store.project_ids()
    retired_keys = {
        (item["project_id"], item["source_kind"], item["source_id"])
        for item in store.project_memory_migration_ledger(project_filter)
    }
    for project_id in project_ids:
        expected.extend(
            (project_id, entry, "legacy", str(entry["id"]))
            for entry in store.project_knowledge(project_id, include_archived=True)
            if (project_id, "legacy", str(entry["id"])) not in retired_keys
        )
        for proposal in store.knowledge_proposals(project_id, pending_only=False):
            if (proposal.get("status") == "accepted"
                    and (project_id, "proposal", str(proposal["id"])) not in retired_keys):
                expected.append((project_id, {
                    "id": proposal.get("memory_id") or proposal["id"],
                    "title": proposal["title"], "content": proposal["content"],
                    "status": "active", "created_by": proposal.get("proposed_by") or "tribe",
                    "updated_by": proposal.get("reviewed_by") or "tribe",
                }, "proposal", str(proposal["id"])))
    return expected


def _entry_fingerprint(project_id: str, entry: dict[str, Any]) -> str:
    value = {
        "title": str(entry["title"])[:200],
        "content": str(entry["content"]).strip(),
        "status": str(entry.get("status") or "active"),
        "category": entry.get("category", "project"),
        "scope": entry.get("scope", {"tribe_project_id": project_id}),
        "source_agent": str(entry.get("source_agent") or entry.get("updated_by")
                             or entry.get("created_by") or "tribe"),
    }
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def audit_project_memory_migration(store: MissionStore,
                                   project_filter: str | None = None) -> dict[str, Any]:
    """Verify accepted legacy entries match their project-scoped Smriti copies."""
    memory_store, parse_markdown = _store()
    expected = _expected_entries(store, project_filter)

    missing: list[dict[str, str]] = []
    conflicts: list[dict[str, Any]] = []
    reviewed: list[dict[str, Any]] = []
    verified = 0
    for project_id, entry, _source_kind, _source_id in expected:
        identifier = _memory_id(str(entry["id"]))
        try:
            document = memory_store.get_memory(identifier)
        except (FileNotFoundError, ValueError):
            missing.append({"project_id": project_id, "entry_id": str(entry["id"]),
                            "title": str(entry["title"])})
            continue
        metadata, content = parse_markdown(document)
        legacy = {
            "id": str(entry["id"]), "title": str(entry["title"]),
            "content": str(entry["content"]).strip(),
            "status": str(entry.get("status") or "active"),
            "created_by": entry.get("created_by") or "tribe",
            "updated_by": entry.get("updated_by") or entry.get("created_by") or "tribe",
        }
        smriti_record = {
            "id": str(entry["id"]), "title": str(metadata.get("title") or "Untitled memory"),
            "content": content.strip(), "status": str(metadata.get("status") or "active"),
            "source_agent": str(metadata.get("source_agent") or "tribe"),
            "scope": metadata.get("scope") or {},
            "category": metadata.get("category"),
        }
        legacy_hash = _entry_fingerprint(project_id, legacy)
        smriti_hash = _entry_fingerprint(project_id, smriti_record)
        scope_matches = (
            smriti_record["category"] == "project"
            and smriti_record["scope"].get("tribe_project_id") == project_id
        )
        smriti = smriti_record | {"unavailable_reason": None} if scope_matches else {
            "id": str(entry["id"]), "title": "Unavailable outside this project",
            "content": None, "status": None, "unavailable_reason": "This memory is scoped to another project.",
        }
        review = store.project_memory_migration_review(
            project_id, str(entry["id"]), legacy_hash, smriti_hash,
        )
        mismatches = []
        if (metadata.get("scope") or {}).get("tribe_project_id") != project_id:
            mismatches.append("scope")
        if metadata.get("category") != "project":
            mismatches.append("category")
        if metadata.get("title") != str(entry["title"])[:200]:
            mismatches.append("title")
        if metadata.get("status", "active") != str(entry.get("status") or "active"):
            mismatches.append("status")
        if content.strip() != str(entry["content"]).strip():
            mismatches.append("content")
        expected_source = str(entry.get("updated_by") or entry.get("created_by") or "tribe")
        if (metadata.get("source_agent") or "tribe") != expected_source:
            mismatches.append("source")
        if mismatches:
            issue = {
                "project_id": project_id, "entry_id": str(entry["id"]),
                "source_kind": _source_kind, "source_id": _source_id,
                "title": str(entry["title"]), "fields": mismatches,
                "legacy": legacy, "smriti": smriti,
                "legacy_hash": legacy_hash, "smriti_hash": smriti_hash,
            }
            if review:
                reviewed.append(issue | {"resolution": review["resolution"],
                                         "reviewed_by": review["reviewed_by"],
                                         "reviewed_at": review["reviewed_at"]})
            else:
                conflicts.append(issue)
        else:
            verified += 1
            if review:
                reviewed.append({
                    "project_id": project_id, "entry_id": str(entry["id"]),
                    "title": str(entry["title"]), "fields": [],
                    "resolution": review["resolution"], "reviewed_by": review["reviewed_by"],
                    "reviewed_at": review["reviewed_at"],
                })
    retired = store.project_memory_migration_ledger(project_filter)
    review_history: dict[tuple[str, str, str], dict[str, Any]] = {}
    for review_project in ([project_filter] if project_filter else store.project_ids()):
        for item in store.project_memory_migration_reviews(review_project):
            review_history[(review_project, item["entry_id"], item["reviewed_at"])] = item
    for item in retired:
        identifier = _memory_id(item["memory_id"])
        try:
            document = memory_store.get_memory(identifier)
        except (FileNotFoundError, ValueError):
            missing.append({"project_id": item["project_id"], "entry_id": item["memory_id"],
                            "title": item["title"], "retired": True})
            continue
        metadata, content = parse_markdown(document)
        scope_matches = (
            metadata.get("category") == "project"
            and (metadata.get("scope") or {}).get("tribe_project_id") == item["project_id"]
        )
        if not scope_matches:
            conflicts.append({
                "project_id": item["project_id"], "entry_id": item["memory_id"],
                "title": "Unavailable outside this project", "fields":["scope"],
                "legacy": {"content": "Previously saved version was retired after verification."},
                "smriti": {
                    "title": "Unavailable outside this project", "content": None,
                    "unavailable_reason": "This memory is scoped to another project.",
                },
                "legacy_hash": item["source_hash"], "smriti_hash": item["smriti_hash"],
                "retired": True,
            })
        else:
            verified += 1
        for (review_project, entry_id, _reviewed_at), review in review_history.items():
            if (review_project == item["project_id"]
                    and entry_id in {item["memory_id"], item["source_id"]}):
                reviewed.append({
                    "project_id": item["project_id"], "entry_id": item["memory_id"],
                    "title": item["title"], "fields": [],
                    "resolution": review["resolution"], "reviewed_by": review["reviewed_by"],
                    "reviewed_at": review["reviewed_at"],
                })
    return {
        "projects": len([project_filter] if project_filter else store.project_ids()),
        "expected": len(expected) + len(retired), "verified": verified, "missing": missing,
        "conflicts": conflicts, "reviewed": reviewed,
    }


def retire_verified_project_memory(store: MissionStore,
                                  project_filter: str | None = None) -> dict[str, Any]:
    """Keep migration fingerprints and proposal decisions, then clear verified legacy content."""
    audit = audit_project_memory_migration(store, project_filter)
    if audit["missing"] or audit["conflicts"]:
        return {"migrated": 0, "retired": 0, "migration": audit}
    memory_store, parse_markdown = _store()
    records: list[dict[str, Any]] = []
    for project_id, entry, source_kind, source_id in _expected_entries(store, project_filter):
        memory_id = str(entry["id"])
        identifier = _memory_id(memory_id)
        try:
            metadata, content = parse_markdown(memory_store.get_memory(identifier))
        except (FileNotFoundError, ValueError):
            return {"migrated": 0, "retired": 0,
                    "migration": audit_project_memory_migration(store, project_filter)}
        source = {
            "id": memory_id, "title": str(entry["title"]),
            "content": str(entry["content"]).strip(),
            "status": str(entry.get("status") or "active"),
            "created_by": entry.get("created_by") or "tribe",
            "updated_by": entry.get("updated_by") or entry.get("created_by") or "tribe",
        }
        smriti_record = {
            "id": memory_id, "title": str(metadata.get("title") or "Untitled memory"),
            "content": content.strip(), "status": str(metadata.get("status") or "active"),
            "source_agent": str(metadata.get("source_agent") or "tribe"),
            "scope": metadata.get("scope") or {}, "category": metadata.get("category"),
        }
        source_hash = _entry_fingerprint(project_id, source)
        smriti_hash = _entry_fingerprint(project_id, smriti_record)
        if (smriti_record["category"] != "project"
                or smriti_record["scope"].get("tribe_project_id") != project_id):
            return {"migrated": 0, "retired": 0,
                    "migration": audit_project_memory_migration(store, project_filter)}
        review = store.project_memory_migration_review(
            project_id, memory_id, source_hash, smriti_hash,
        )
        fields_match = (
            smriti_record["title"] == source["title"][:200]
            and smriti_record["content"] == source["content"]
            and smriti_record["status"] == source["status"]
            and smriti_record["source_agent"] == source["updated_by"]
        )
        if not fields_match and not review:
            return {"migrated": 0, "retired": 0,
                    "migration": audit_project_memory_migration(store, project_filter)}
        records.append({
            "project_id": project_id, "source_kind": source_kind, "source_id": source_id,
            "memory_id": memory_id, "source_hash": source_hash,
            "smriti_hash": smriti_hash, "title": str(entry["title"]),
        })
    migrated = store.record_project_memory_migrations(records)
    retired = sum(item["source_kind"] == "legacy" for item in records)
    return {"migrated": migrated, "retired": retired,
            "migration": audit_project_memory_migration(store, project_filter)}


def resolve_project_memory_migration(store: MissionStore, project_id: str, entry_id: str,
                                     resolution: str, reviewed_by: str = "user") -> dict[str, Any]:
    if resolution not in {"keep_smriti", "use_legacy", "copy_legacy_to_project"}:
        raise ValueError("memory_migration_resolution_invalid")
    audit = audit_project_memory_migration(store, project_id)
    conflict = next((item for item in audit["conflicts"] if item["entry_id"] == entry_id), None)
    if conflict is None:
        raise ValueError("memory_migration_conflict_not_found")
    if {"scope", "category"}.intersection(conflict["fields"]):
        if resolution != "copy_legacy_to_project":
            raise ValueError("memory_migration_scope_conflict_requires_copy")
        # Never read or overwrite the foreign Smriti record. Copy the reviewed
        # legacy content under a fresh identifier and verify its project scope
        # before retiring the legacy source.
        recovered = dict(conflict["legacy"])
        recovered["id"] = str(uuid.uuid4())
        _write(project_id, recovered)
        current = read_project_memory(project_id, recovered["id"])
        if current is None:
            raise ValueError("memory_migration_recovery_verification_failed")
        source_hash = conflict["legacy_hash"]
        smriti_hash = _entry_fingerprint(project_id, current | {
            "source_agent": current.get("updated_by") or current.get("created_by") or "tribe",
        })
        store.record_project_memory_migration_review(
            project_id, entry_id, source_hash, conflict["smriti_hash"],
            resolution, reviewed_by,
        )
        store.record_project_memory_migrations([{
            "project_id": project_id, "source_kind": conflict["source_kind"],
            "source_id": conflict["source_id"],
            "memory_id": recovered["id"], "source_hash": source_hash,
            "smriti_hash": smriti_hash, "title": str(recovered["title"]),
        }])
        return audit_project_memory_migration(store, project_id)
    if resolution == "use_legacy":
        _write(project_id, conflict["legacy"])
        current = read_project_memory(project_id, entry_id)
        if current is None:
            raise ValueError("memory_migration_conflict_not_found")
        smriti_hash = _entry_fingerprint(project_id, current | {
            "source_agent": current.get("updated_by") or current.get("created_by") or "tribe",
        })
    else:
        smriti_hash = conflict["smriti_hash"]
    store.record_project_memory_migration_review(
        project_id, entry_id, conflict["legacy_hash"], smriti_hash, resolution, reviewed_by,
    )
    return retire_verified_project_memory(store, project_id)["migration"]


def list_project_memory(store: MissionStore, project_id: str,
                        include_archived: bool = False) -> list[dict[str, Any]]:
    _migrate_accepted(store, project_id)
    memory_store, parse_markdown = _store()
    notes = memory_store.list_memories(category="project", limit=10000)
    entries = []
    for note in notes:
        if (note.get("scope") or {}).get("tribe_project_id") != project_id:
            continue
        status = note.get("status") or "active"
        if not include_archived and status != "active":
            continue
        identifier = str(note["id"])
        try:
            metadata, content = parse_markdown(memory_store.get_memory(identifier))
        except (OSError, ValueError):
            continue
        tribe_id = identifier.removeprefix("tribe/")
        entries.append({
            "id": tribe_id,
            "project_id": project_id,
            "title": note.get("title", metadata.get("title", "Untitled memory")),
            "content": content.strip(),
            "status": status,
            "created_by": note.get("source_agent") or "Smriti",
            "updated_by": note.get("source_agent") or "Smriti",
            "updated_at": note.get("updated_at"),
        })
    return sorted(entries, key=lambda item: item["title"].casefold())


def search_project_memory(store: MissionStore, project_id: str, query: str,
                          limit: int = 10) -> list[dict[str, Any]]:
    _migrate_accepted(store, project_id)
    memory_store, _ = _store()
    results = memory_store.search_memory(
        query=query.strip(), limit=max(1, min(limit, 20)), include_content=True,
        filters={"category": "project", "status": "active",
                 "scope": {"tribe_project_id": project_id}},
    )
    return [{
        "id": str(item["id"]).removeprefix("tribe/"),
        "title": item.get("title", "Untitled memory"),
        "content": item.get("content", ""),
        "score": item.get("score"),
    } for item in results]


def read_project_memory(project_id: str, entry_id: str) -> dict[str, Any] | None:
    memory_store, parse_markdown = _store()
    try:
        document = memory_store.get_memory(_memory_id(entry_id))
    except (FileNotFoundError, ValueError):
        return None
    metadata, content = parse_markdown(document)
    if (metadata.get("category") != "project"
            or (metadata.get("scope") or {}).get("tribe_project_id") != project_id):
        return None
    return {
        "id": entry_id, "title": metadata.get("title", "Untitled memory"),
        "content": content.strip(), "status": metadata.get("status", "active"),
        "updated_at": metadata.get("updated_at"),
        "created_by": metadata.get("source_agent") or "Smriti",
        "updated_by": metadata.get("source_agent") or "Smriti",
    }


def save_project_memory(store: MissionStore, project_id: str, mission_id: str | None,
                        actor_id: str, title: str, content: str) -> dict[str, Any]:
    title, content = title.strip(), content.strip()
    if not title or len(title) > 200 or not content or len(content) > 20_000:
        raise ValueError("knowledge_title_and_content_required")
    mission = store.mission(mission_id) if mission_id else None
    if mission_id and (not mission or mission["project_id"] != project_id):
        raise ValueError("mission_does_not_belong_to_project")
    existing = next((entry for entry in list_project_memory(store, project_id, True)
                     if entry["title"].casefold() == title.casefold()), None)
    entry = {
        "id": existing["id"] if existing else str(uuid.uuid4()),
        "project_id": project_id,
        "title": title,
        "content": content,
        "status": "active",
        "created_by": existing.get("created_by", actor_id) if existing else actor_id,
        "updated_by": actor_id,
        "updated_at": None,
        "source_mission_id": mission_id,
        "source_mission_title": mission.get("title") if mission else None,
    }
    _write(project_id, entry)
    entry.update(read_project_memory(project_id, entry["id"]) or {})
    if mission_id:
        store.append("knowledge.entry.saved", actor_id, mission_id, {"entry": entry})
    return entry


def accept_project_memory(store: MissionStore, result: dict[str, Any]) -> dict[str, Any]:
    entry = result.get("entry")
    if isinstance(entry, dict):
        _write(str(entry["project_id"]), entry)
    return result


def review_project_memory_proposal(store: MissionStore, proposal_id: str,
                                  actor_id: str, decision: str) -> dict[str, Any]:
    proposal = store.knowledge_proposal(proposal_id)
    if decision == "accept" and proposal:
        existing = next((entry for entry in list_project_memory(
            store, proposal["project_id"], include_archived=True,
        ) if entry["title"].casefold() == proposal["title"].casefold()), None)
        memory_id = existing["id"] if existing else proposal_id
    else:
        memory_id = None
    result = store.review_knowledge_proposal(proposal_id, actor_id, decision, memory_id)
    return accept_project_memory(store, result) if decision == "accept" else result


def set_project_memory_status(store: MissionStore, project_id: str, entry_id: str,
                              status: str, mission_id: str, actor_id: str = "user") -> dict[str, Any]:
    if status not in {"active", "archived"}:
        raise ValueError("project_memory_status_invalid")
    memory_store, _ = _store()
    identifier = _memory_id(entry_id)
    try:
        mission = store.mission(mission_id)
        entry = read_project_memory(project_id, entry_id)
        if entry is None or not mission or mission["project_id"] != project_id:
            raise ValueError("project_memory_not_found")
        memory_store.update_memory(id=identifier, meta={
            "status": status,
        })
    except FileNotFoundError as error:
        raise ValueError("project_memory_not_found") from error
    entry["status"] = status
    entry["updated_by"] = actor_id
    store.append("knowledge.entry.archived" if status == "archived" else "knowledge.entry.restored",
                 actor_id, mission_id, {"entry": entry})
    return entry
