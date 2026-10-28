"""Request-only removal of superseded tool output from model context."""

from __future__ import annotations

import json
import posixpath
import shlex
from dataclasses import dataclass, replace
from typing import Any

from pydantic_ai.messages import ToolCallPart, ToolReturnPart

_READ_TOOLS = {"read_file", "read_repository_file"}
_WRITE_TOOLS = {"write_file", "edit_file", "write_repository_file", "create_directory"}
_SAFE_COMMANDS = {"pwd", "ls", "cat", "head", "tail", "rg", "grep", "find"}


def _path_key(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return posixpath.normpath(value.strip().replace("\\", "/")).casefold()


def _safe_read_command(arguments: dict[str, Any]) -> str | None:
    command = arguments.get("command")
    if not isinstance(command, str) or any(char in command for char in "|;&<>$`\n"):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if not argv:
        return None
    executable = posixpath.basename(argv[0]).casefold()
    allowed = executable in _SAFE_COMMANDS
    if executable == "git":
        allowed = len(argv) > 1 and argv[1].casefold() in {"status", "diff", "log", "show"}
    if not allowed or any(arg.casefold() in {"-delete", "--delete", "-exec", "--exec"} for arg in argv[1:]):
        return None
    return json.dumps(arguments, sort_keys=True, separators=(",", ":"))


@dataclass
class ContextPruning:
    """Prune only the outbound request projection; saved run history remains untouched."""

    async def before_model_request(self, ctx, request_context):
        messages = list(request_context.messages)
        returns: set[str] = set()
        for message in messages:
            for part in getattr(message, "parts", ()):
                if isinstance(part, ToolCallPart):
                    continue
                elif isinstance(part, ToolReturnPart):
                    returns.add(part.tool_call_id)

        stale: set[str] = set()
        latest_reads: dict[str, str] = {}
        repeated_commands: dict[str, str] = {}
        mutation_epoch = 0
        # Tool call order is retained in message/part order. Only completed calls are
        # eligible, so deferred approvals and other unresolved effects are never touched.
        for message in messages:
            for part in getattr(message, "parts", ()):
                if not isinstance(part, ToolCallPart) or part.tool_call_id not in returns:
                    continue
                try:
                    arguments = part.args_as_dict()
                except (TypeError, ValueError):
                    continue
                name = part.tool_name
                if name in _READ_TOOLS:
                    key = _path_key(arguments.get("path"))
                    if key:
                        previous = latest_reads.get(key)
                        if previous:
                            stale.add(previous)
                        latest_reads[key] = part.tool_call_id
                elif name in _WRITE_TOOLS:
                    key = _path_key(arguments.get("path"))
                    if key and key in latest_reads:
                        stale.add(latest_reads.pop(key))
                    mutation_epoch += 1
                elif name in {"run_command", "shell"}:
                    signature = _safe_read_command(arguments)
                    if signature is None:
                        mutation_epoch += 1
                        repeated_commands.clear()
                    else:
                        scoped = f"{mutation_epoch}:{signature}"
                        previous = repeated_commands.get(scoped)
                        if previous:
                            stale.add(previous)
                        repeated_commands[scoped] = part.tool_call_id

        if not stale:
            ctx.deps.context_pruning_metrics = {"results": 0, "estimated_tokens": 0}
            return request_context

        removed_chars = 0
        updated_messages = []
        for message in messages:
            parts = []
            changed = False
            for part in getattr(message, "parts", ()):
                if isinstance(part, ToolReturnPart) and part.tool_call_id in stale and isinstance(part.content, str):
                    removed_chars += len(part.content)
                    parts.append(replace(part, content="[Earlier tool output omitted; newer output is available.]"))
                    changed = True
                else:
                    parts.append(part)
            updated_messages.append(replace(message, parts=parts) if changed else message)

        ctx.deps.context_pruning_metrics = {
            "results": len(stale),
            "estimated_tokens": removed_chars // 4,
        }
        return replace(request_context, messages=updated_messages)
