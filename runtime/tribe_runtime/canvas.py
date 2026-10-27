"""Bounded, data-only publication formats for collaborative Canvas documents."""

from __future__ import annotations

import json
from typing import Any

MAX_DOCUMENT_BYTES = 256 * 1024
MAX_PUBLICATIONS = 8
MAX_COMMENTS = 16


def _fenced_json(text: str, language: str, limit: int, max_items: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    fence: str | None = None
    capture = False
    lines: list[str] = []
    size = 0
    for line in text.splitlines():
        if fence is not None:
            if line.rstrip() == fence:
                if capture and size <= limit:
                    try:
                        value = json.loads("\n".join(lines))
                        if isinstance(value, dict):
                            results.append(value)
                    except (json.JSONDecodeError, RecursionError):
                        pass
                fence = None
                capture = False
                lines = []
                size = 0
                if len(results) >= max_items:
                    break
            elif capture and size <= limit:
                lines.append(line)
                size += len(line.encode("utf-8", errors="replace")) + 1
            continue
        if line.startswith("```") or line.startswith("~~~"):
            marker_char = line[0]
            marker_size = len(line) - len(line.lstrip(marker_char))
            marker = marker_char * marker_size
            info = line[marker_size:].strip()
            fence = marker
            capture = info == language
    return results


def validate_content(title: Any, kind: Any, language: Any, body: Any) -> dict[str, str] | None:
    if not isinstance(title, str) or not title.strip() or len(title.encode("utf-8")) > 240:
        return None
    if kind not in {"markdown", "text", "code", "diagram"}:
        return None
    if not isinstance(language, str) or len(language.encode("utf-8")) > 40:
        return None
    if not isinstance(body, str) or len(body.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        return None
    return {"title": title.strip(), "kind": kind, "language": language, "body": body}


def _document(value: dict[str, Any]) -> dict[str, Any] | None:
    content = validate_content(value.get("title"), value.get("kind"),
                               value.get("language", ""), value.get("body"))
    if content is None:
        return None
    artifact_id, base_revision = value.get("artifact_id"), value.get("base_revision")
    if bool(artifact_id) != (base_revision is not None):
        return None
    if artifact_id is not None and (not isinstance(artifact_id, str) or len(artifact_id) > 80):
        return None
    if base_revision is not None and (not isinstance(base_revision, int) or isinstance(base_revision, bool) or base_revision < 1):
        return None
    return {
        "artifact_id": artifact_id,
        "base_revision": base_revision,
        **content,
    }


def document_publications(text: str) -> list[dict[str, Any]]:
    """Parse complete top-level canvas:v1 JSON documents; malformed blocks stay inert."""
    return [item for raw in _fenced_json(text, "canvas:v1", MAX_DOCUMENT_BYTES * 6, MAX_PUBLICATIONS)
            if (item := _document(raw)) is not None]


def comment_publications(text: str) -> list[dict[str, Any]]:
    """Parse bounded comments/replies without interpreting surrounding prose as actions."""
    comments = []
    for value in _fenced_json(text, "canvas-comment:v1", 48 * 1024, MAX_COMMENTS):
        artifact_id, body = value.get("artifact_id"), value.get("body")
        thread_id, base_revision = value.get("thread_id"), value.get("base_revision")
        quote, assignee = value.get("quote", ""), value.get("assignee")
        is_reply = isinstance(thread_id, str) and bool(thread_id.strip())
        is_new = isinstance(base_revision, int) and not isinstance(base_revision, bool)
        if not isinstance(artifact_id, str) or not artifact_id.strip() or len(artifact_id) > 80:
            continue
        if not isinstance(body, str) or not body.strip() or len(body.encode("utf-8")) > 8 * 1024:
            continue
        if not isinstance(quote, str) or len(quote.encode("utf-8")) > 4 * 1024:
            continue
        if is_reply == is_new or (is_new and base_revision < 1):
            continue
        if assignee is not None and (not isinstance(assignee, str) or len(assignee) > 80):
            continue
        comments.append({
            "artifact_id": artifact_id.strip(),
            "thread_id": thread_id.strip() if is_reply else None,
            "base_revision": base_revision if is_new else None,
            "quote": quote,
            "body": body.strip(),
            "assignee": assignee.strip().lstrip("@") if assignee else None,
        })
    return comments


def visible_message(text: str) -> str:
    """Remove valid structured publication blocks from the human-readable channel copy."""
    lines = text.splitlines()
    result: list[str] = []
    index = 0
    while index < len(lines):
        opening = lines[index]
        if not (opening.startswith("```") or opening.startswith("~~~")):
            result.append(opening)
            index += 1
            continue
        marker_char = opening[0]
        marker_size = len(opening) - len(opening.lstrip(marker_char))
        marker = marker_char * marker_size
        language = opening[marker_size:].strip()
        close = next((cursor for cursor in range(index + 1, len(lines))
                      if lines[cursor].rstrip() == marker), None)
        if close is None:
            result.append(opening)
            index += 1
            continue
        block = "\n".join(lines[index:close + 1])
        valid = bool(document_publications(block)) if language == "canvas:v1" else (
            bool(comment_publications(block)) if language == "canvas-comment:v1" else False
        )
        if not valid:
            result.extend(lines[index:close + 1])
        index = close + 1
    return "\n".join(result).strip()
