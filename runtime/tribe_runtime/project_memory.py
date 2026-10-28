"""Project-scoped governance adapter over Smriti's durable Markdown memory store."""

from __future__ import annotations

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
