"""Redact transient computer observations from durable agent checkpoints."""

from __future__ import annotations

from dataclasses import replace
from typing import Any


class TransientMediaStepStore:
    """Delegate step persistence while replacing selected tool results in saved history.

    The live Pydantic AI run keeps original messages and can use observations. Saved
    checkpoints omit transient browser/computer outputs and redact browser call input,
    so a later continuation must take a fresh observation and cannot replay a page action.
    """

    def __init__(self, store: Any, *, transient_tool_names: set[str]):
        self._store = store
        self._transient_tool_names = frozenset(transient_tool_names)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._store, name)

    async def save_snapshot(self, snapshot: Any) -> None:
        if not self._transient_tool_names:
            await self._store.save_snapshot(snapshot)
            return

        from pydantic_ai.messages import ToolCallPart, ToolReturnPart

        messages = []
        for message in snapshot.messages:
            parts = getattr(message, "parts", None)
            if not parts:
                messages.append(message)
                continue
            updated_parts = [
                replace(
                    part,
                    content="Transient computer observation omitted from saved history. Request a fresh observation after resuming.",
                )
                if isinstance(part, ToolReturnPart) and part.tool_name in self._transient_tool_names
                else replace(part, args="{}")
                if isinstance(part, ToolCallPart) and part.tool_name.startswith("browser_")
                else part
                for part in parts
            ]
            messages.append(replace(message, parts=updated_parts))

        await self._store.save_snapshot(replace(snapshot, messages=messages))


def sanitized_browser_messages(messages: list[Any]) -> list[Any]:
    """Return safe copies of model messages without page contents or browser inputs."""
    from pydantic_ai.messages import ToolCallPart, ToolReturnPart

    safe_messages = []
    for message in messages:
        parts = getattr(message, "parts", None)
        if not parts:
            safe_messages.append(message)
            continue
        safe_parts = []
        for part in parts:
            if isinstance(part, ToolCallPart) and part.tool_name.startswith("browser_"):
                safe_parts.append(replace(part, args="{}"))
            elif isinstance(part, ToolReturnPart) and part.tool_name.startswith("browser_"):
                safe_parts.append(replace(
                    part,
                    content="Transient browser result omitted from saved history. Request a fresh browser observation after resuming.",
                ))
            else:
                safe_parts.append(part)
        safe_messages.append(replace(message, parts=safe_parts))
    return safe_messages
