"""Concise, privacy-aware summaries for durable agent tool activity."""

from __future__ import annotations

import json
import re
import shlex
from typing import Any
from urllib.parse import urlsplit

_NODE_TAP_SUMMARY = {
    "tests": re.compile(r"(?m)^# tests (\d+)\s*$"),
    "pass": re.compile(r"(?m)^# pass (\d+)\s*$"),
    "fail": re.compile(r"(?m)^# fail (\d+)\s*$"),
}
_EXIT_CODE = re.compile(r"(?m)^\[exit code: (-?\d+)\]\s*$")


def node_test_run_evidence(command: str, output: object) -> dict[str, object] | None:
    """Recognise a completed Node TAP test run emitted by Harness Shell.

    Harness returns output as a string and omits a zero exit-code marker. Only
    accept a direct `node --test` invocation with a complete TAP summary so an
    arbitrary shell command or partial/timeout output cannot satisfy review.
    """
    if not isinstance(output, str) or "[Command timed out" in output:
        return None
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        return None
    if len(argv) < 3 or argv[:2] != ["node", "--test"]:
        return None
    if any(token in {"&&", "||", ";", "|", ">", "<"} for token in argv):
        return None

    counts: dict[str, int] = {}
    for label, pattern in _NODE_TAP_SUMMARY.items():
        match = pattern.search(output)
        if not match:
            return None
        counts[label] = int(match.group(1))
    if counts["tests"] < 1 or counts["pass"] + counts["fail"] != counts["tests"]:
        return None

    exit_match = _EXIT_CODE.search(output)
    exit_code = int(exit_match.group(1)) if exit_match else (0 if counts["fail"] == 0 else 1)
    if exit_code == 0 and counts["fail"] != 0:
        return None
    return {"argv": argv, "exitCode": exit_code, "stdout": output, "stderr": "",
            "testCount": counts["tests"], "passed": counts["pass"], "failed": counts["fail"]}


_BROWSER_ACTIONS = {
    "open": ("opening a page", "opened a page"),
    "new_tab": ("opening a new page", "opened a new page"),
    "close_tab": ("closing a page", "closed a page"),
    "screenshot": ("capturing a page preview", "captured a page preview"),
    "select": ("choosing a page option", "chose a page option"),
    "hover": ("moving over a page control", "moved over a page control"),
    "resize": ("resizing the browser", "resized the browser"),
    "press": ("using the page keyboard", "used the page keyboard"),
    "scroll": ("scrolling the page", "scrolled the page"),
    "navigate": ("opening a page", "opened a page"),
    "state": ("checking the browser", "checked the browser"),
    "diagnostics": ("checking page diagnostics", "checked page diagnostics"),
    "site_storage": ("checking site storage", "checked site storage"),
    "navigate_back": ("going back in the browser", "went back in the browser"),
    "go_back": ("going back in the browser", "went back in the browser"),
    "go_forward": ("moving forward in the browser", "moved forward in the browser"),
    "snapshot": ("inspecting a page", "inspected a page"),
    "click": ("interacting with a page", "interacted with a page"),
    "click_at": ("interacting with a page", "interacted with a page"),
    "click_by_text": ("interacting with a page", "interacted with a page"),
    "type": ("entering text on a page", "entered text on a page"),
    "fill": ("filling a page form", "filled a page form"),
    "fill_form": ("filling a page form", "filled a page form"),
    "upload": ("asking to select files for a page", "selected files for a page"),
    "press_key": ("using the page keyboard", "used the page keyboard"),
    "drag": ("interacting with a page", "interacted with a page"),
    "select_option": ("choosing a page option", "chose a page option"),
    "wait_for": ("waiting for the page", "finished waiting for the page"),
    "take_screenshot": ("capturing a page screenshot", "captured a page screenshot"),
    "console_messages": ("checking page messages", "checked page messages"),
    "network_requests": ("reviewing page network activity", "reviewed page network activity"),
    "viewport": ("changing the browser size", "changed the browser size"),
    "reload": ("reloading the page", "reloaded the page"),
    "back": ("going back in the browser", "went back in the browser"),
    "forward": ("moving forward in the browser", "moved forward in the browser"),
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
        if action in {"navigate", "open", "new_tab"}:
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
