"""Redact transient computer observations from durable agent checkpoints."""

from __future__ import annotations

from dataclasses import replace
from typing import Any


class TransientMediaStepStore:
    """Delegate step persistence while replacing selected tool results in saved history.

    The live Pydantic AI run keeps its original messages and can use the observation.
    Only the checkpoint copy is changed, so a later continuation must request a fresh
    observation instead of recovering a screenshot or accessibility text from disk.
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

        from pydantic_ai.messages import ToolReturnPart

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
                else part
                for part in parts
            ]
            messages.append(replace(message, parts=updated_parts))

        await self._store.save_snapshot(replace(snapshot, messages=messages))
