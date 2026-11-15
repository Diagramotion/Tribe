"""Concise, privacy-aware summaries for durable agent tool activity."""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .credentials import redact_shell_command

_NODE_TAP_SUMMARY = {
    "tests": re.compile(r"(?m)^# tests (\d+)\s*$"),
    "pass": re.compile(r"(?m)^# pass (\d+)\s*$"),
    "fail": re.compile(r"(?m)^# fail (\d+)\s*$"),
}
_EXIT_CODE = re.compile(r"(?m)^\[exit code: (-?\d+)\]\s*$")


def _is_executing_pytest(argv: list[str]) -> bool:
    """Exclude successful pytest information/collection commands from test events."""
    test_argv = argv
    if argv[:2] == ["uv", "run"]:
        index = 2
        while index < len(argv):
            if argv[index] in {"--project", "--extra"} and index + 1 < len(argv):
                index += 2
            else:
                break
        test_argv = argv[index:]

    if test_argv[:1] == ["pytest"]:
        options = test_argv[1:]
    elif len(test_argv) >= 3 and test_argv[0] in {"python", "python3"} and test_argv[1:3] == ["-m", "pytest"]:
        options = test_argv[3:]
    else:
        return True

    # These options exit successfully without executing tests. Keep this guard
    # separate from the execution allowlist: such commands may still be run in Runs.
    non_run_options = {
        "-h", "--help", "-V", "--version", "--collect-only", "--co", "-co",
        "--fixtures", "--fixtures-per-test", "--markers", "--setup-plan", "--setup-only",
    }
    return not any(option in non_run_options for option in options)


def local_repository_test_argv(argv: object, cwd: str | Path | None = None) -> list[str] | None:
    """Return argv only for an allowlisted local test command with repository paths."""
    if (not isinstance(argv, list) or not argv or len(argv) > 16
            or any(not isinstance(arg, str) or len(arg) > 500 for arg in argv)):
        return None
    # Import lazily: workspace owns the allowlist and imports MissionStore.
    from .workspace import is_approved_repository_test_command

    if not is_approved_repository_test_command(argv) or not _is_executing_pytest(argv):
        return None
    # A repository trigger must not be caused by a command that explicitly points
    # outside the project checkout, including through an in-repository symlink.
    root = None
    if cwd is not None:
        try:
            root = Path(cwd).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
    for argument in argv:
        normalized = argument.replace("\\", "/")
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized):
            return None
        if ".." in normalized.split("/"):
            return None
        # Also inspect option values such as --rootdir=/tmp/outside.
        option_value = normalized.partition("=")[2] if normalized.startswith("-") else normalized
        if option_value.startswith("/") or re.match(r"^[A-Za-z]:/", option_value):
            return None
        if root is not None and not argument.startswith("-"):
            path_value = argument.split("::", 1)[0]
            candidate = Path(path_value)
            if not candidate.is_absolute():
                candidate = root / candidate
            try:
                resolved = candidate.resolve(strict=False)
                if resolved.exists() and not resolved.is_relative_to(root):
                    return None
            except (OSError, RuntimeError):
                return None
    return list(argv)


def repository_test_command_argv(command: object, cwd: str | Path | None = None) -> list[str] | None:
    """Return argv only for a single, allowlisted repository test command."""
    if not isinstance(command, str) or not command or len(command) > 8_000 or "\n" in command or "\r" in command:
        return None
    # Harness commands are shell strings. Do not infer a repository test run
    # when shell expansion can change the path after this classification.
    if "$" in command or "`" in command or "~" in command:
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>`$()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        shell_tokens = list(lexer)
        if any(token and all(char in ";&|<>`$()" for char in token) for token in shell_tokens):
            return None
        argv = shlex.split(command, posix=True)
    except ValueError:
        return None
    return local_repository_test_argv(argv, cwd)


def repository_test_run_evidence(
    command: str, output: object, cwd: str | Path | None = None,
) -> dict[str, object] | None:
    """Recognise a completed local repository test command and its process exit code."""
    argv = repository_test_command_argv(command, cwd)
    if argv is None or not isinstance(output, str):
        return None
    lowered = output.casefold()
    if any(marker in lowered for marker in (
        "[command timed out", "[command cancelled", "[command canceled",
        "[command could not start", "command not found",
    )):
        return None
    node_evidence = node_test_run_evidence(command, output)
    if node_evidence is not None:
        return node_evidence
    exit_match = _EXIT_CODE.search(output)
    if not exit_match:
        return None
    exit_code = int(exit_match.group(1))
    if exit_code == 127:
        return None
    # Harness exposes the shell process exit code but not a separate timeout or
    # cancellation field. Preserve the conventional shell statuses so callers
    # do not mistake timeout (GNU timeout: 124) or SIGINT (128 + SIGINT: 130)
    # for an ordinary test failure that should trigger failure-only schedules.
    return {
        "argv": argv, "exitCode": exit_code, "stdout": output, "stderr": "",
        "timedOut": exit_code == 124, "cancelled": exit_code == 130 or exit_code < 0,
    }


def background_test_run_evidence(
    argv: object, output: object, exit_code: object, cwd: str | Path | None = None,
) -> dict[str, object] | None:
    """Build event evidence for a completed Runs command, using its stored argv."""
    safe_argv = local_repository_test_argv(argv, cwd)
    if (safe_argv is None or not isinstance(exit_code, int) or isinstance(exit_code, bool)
            or not isinstance(output, str)):
        return None
    return {
        "argv": safe_argv, "exitCode": exit_code, "stdout": output, "stderr": "",
        "timedOut": exit_code == 124, "cancelled": exit_code == 130 or exit_code < 0,
    }


def node_test_run_evidence(command: str, output: object) -> dict[str, object] | None:
    """Recognise complete Node TAP test output for legacy verification history."""
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
    return {
        "argv": argv, "exitCode": exit_code, "stdout": output, "stderr": "",
        "testCount": counts["tests"], "passed": counts["pass"], "failed": counts["fail"],
        "timedOut": exit_code == 124, "cancelled": exit_code == 130 or exit_code < 0,
    }

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
        return redact_shell_command(command, limit=240)
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
