"""Concise, privacy-aware summaries for durable agent tool activity."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit


_BROWSER_ACTIONS = {
    "navigate": ("opening a page", "opened a page"),
    "navigate_back": ("going back in the browser", "went back in the browser"),
    "go_back": ("going back in the browser", "went back in the browser"),
    "go_forward": ("moving forward in the browser", "moved forward in the browser"),
    "snapshot": ("inspecting a page", "inspected a page"),
    "click": ("interacting with a page", "interacted with a page"),
    "click_by_text": ("interacting with a page", "interacted with a page"),
    "type": ("entering text on a page", "entered text on a page"),
    "fill": ("filling a page form", "filled a page form"),
    "fill_form": ("filling a page form", "filled a page form"),
    "press_key": ("using the page keyboard", "used the page keyboard"),
    "hover": ("interacting with a page", "interacted with a page"),
    "drag": ("interacting with a page", "interacted with a page"),
    "select_option": ("choosing a page option", "chose a page option"),
    "wait_for": ("waiting for the page", "finished waiting for the page"),
    "take_screenshot": ("capturing a page screenshot", "captured a page screenshot"),
    "console_messages": ("checking page messages", "checked page messages"),
    "network_requests": ("reviewing page network activity", "reviewed page network activity"),
    "resize": ("resizing the browser", "resized the browser"),
    "tabs": ("checking browser tabs", "checked browser tabs"),
    "handle_dialog": ("responding to a page dialog", "responded to a page dialog"),
    "file_upload": ("selecting a page upload", "selected a page upload"),
    "close": ("closing the browser", "closed the browser"),
}


def _arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = {"command": value}
    return value if isinstance(value, dict) else {}


def _browser_action(tool_name: str) -> str | None:
    name = tool_name.casefold().replace("__", "_")
    marker = "browser_"
    index = name.rfind(marker)
    if index < 0:
        return None
    return name[index + len(marker):]


def _safe_web_host(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return ""
        host = parsed.hostname.encode("idna").decode("ascii").lower()
        port = parsed.port
        if port and not ((parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443)):
            host = f"{host}:{port}"
        return host[:200]
    except (UnicodeError, ValueError):
        return ""


def summarize_tool_arguments(tool_name: str, value: Any) -> str:
    """Return a bounded summary safe to store in mission activity.

    Browser form values, scripts, selectors, query strings and fragments are
    deliberately omitted: they can contain private page content or secrets.
    """
    arguments = _arguments(value)
    action = _browser_action(tool_name)
    if action is not None:
        if action == "navigate":
            target = next((arguments.get(key) for key in ("url", "uri", "target_url")
                           if isinstance(arguments.get(key), str)), None)
            host = _safe_web_host(target)
            return f"{host}" if host else ""
        if action in _BROWSER_ACTIONS:
            return ""

    path = arguments.get("path") or arguments.get("file_path")
    if isinstance(path, str):
        return path[:240]
    command = arguments.get("command")
    if isinstance(command, str):
        command = re.sub(
            r"(?i)(api[_-]?key|token|password|secret)(\s*[=:]\s*)([^\s]+)",
            r"\1\2[redacted]", command,
        )
        return command[:240]
    argv = arguments.get("argv")
    if isinstance(argv, list):
        return " ".join(str(item) for item in argv[:8])[:240]
    query = arguments.get("query") or arguments.get("pattern")
    return query[:160] if isinstance(query, str) else ""


def browser_activity_labels(tool_name: str) -> dict[str, str] | None:
    """Map Playwright browser tools to concise user-facing activity labels."""
    action = _browser_action(tool_name)
    labels = _BROWSER_ACTIONS.get(action) if action is not None else None
    return {"working": labels[0], "finished": labels[1]} if labels else None
