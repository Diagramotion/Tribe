"""Pydantic AI Harness capabilities composed for one Tribe agent run."""

from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import shlex
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from .browser_sessions import BROWSER_ACTION_TOOLS
from .credentials import redact_review_arguments, redact_secret_values, redact_shell_command
from .mcp_registry import MCPRegistry
from .skills import SkillCatalog
from .transient_media import sanitized_browser_messages
from .workspace import WorkspaceTools, is_approved_repository_test_command
from .store import tool_action_approval_capability

if TYPE_CHECKING:
    from pydantic_ai_harness.step_persistence import StepStore


_HARNESS_LOCAL_WORKSPACE_TOOLS = frozenset({
    "read_file", "write_file", "edit_file", "list_directory", "search_files", "find_files",
    "list_files", "grep", "create_directory", "file_info", "run_command", "start_command",
    "check_command", "stop_command", "shell",
})


def _automatic_review_error_reason(error: Exception) -> str:
    """Explain an auto-review failure without exposing saved environment credentials."""
    diagnostic = " ".join(redact_secret_values(str(error)).split())[:220]
    detail = f"{type(error).__name__}: {diagnostic}" if diagnostic else type(error).__name__
    return f"Automatic review failed ({detail}); a user decision is required."


_REPOSITORY_FILE_CHANGE_TOOLS = frozenset({
    "write_file", "edit_file", "create_directory", "write_repository_file",
})
_PERSISTENT_READ_TOOLS = frozenset({
    "read_repository_file", "search_repository", "read_file", "list_directory",
    "search_files", "find_files", "file_info", "list_artifacts", "get_artifact",
    "list_workflows", "get_workflow", "get_workflow_state",
    "search_available_skills", "list_skill_resources", "read_skill_resource",
    "search_project_memory", "read_project_memory",
})
_APPROVAL_PREVIEW_LIMIT = 1500
# Keep the Harness fallback (DEFAULT_CONTEXT_WINDOW) for models whose context
# window the provider registry cannot resolve.  This value is 200,000 in the
# supported Pydantic AI Harness release; a smaller guessed window needlessly
# compacts long-running work before the selected model's context is exhausted.
UNKNOWN_MODEL_CONTEXT_WINDOW = 200_000


def repository_change_approval_preview(tool_name: str, arguments: object) -> str | None:
    """Build a bounded, credential-redacted preview for user-reviewed local edits."""
    if tool_name not in _REPOSITORY_FILE_CHANGE_TOOLS or not isinstance(arguments, dict):
        return None
    safe = redact_review_arguments(arguments)

    def preview(value: object) -> str:
        if not isinstance(value, str):
            return "(not provided)"
        bounded = value[:_APPROVAL_PREVIEW_LIMIT]
        if len(value) > len(bounded):
            bounded += f"\n… preview truncated; {len(value) - len(bounded)} more characters"
        return bounded or "(empty)"

    path = preview(safe.get("path", "(not provided)")).replace("\r", " ").replace("\n", " ")
    if tool_name == "edit_file":
        return f"File: {path}\n\nBefore:\n{preview(safe.get('old_text'))}\n\nAfter:\n{preview(safe.get('new_text'))}"
    if tool_name == "create_directory":
        return f"Create directory: {path}"
    return f"File: {path}\n\nProposed contents:\n{preview(safe.get('content'))}"


def _contains_shell_path_expansion(command: str) -> bool:
    """Treat shell-derived paths as outside the project until a user reviews them."""
    return bool(re.search(
        r"(?<!\\)(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|~(?:[A-Za-z0-9._+-]+)?(?=/|\\|\s|$|[&;|<>]))",
        command,
    ))


def _references_path_outside_project(
    arguments: list[str], project_root: Path | None = None,
) -> bool:
    """Require review for absolute, parent-relative or escaping-symlink paths."""
    root = project_root.resolve() if project_root is not None else None
    for argument in arguments:
        value = argument.partition("=")[2] if "=" in argument else argument
        normalized = value.strip("'\"").replace("\\", "/")
        if normalized.startswith("/") or re.match(r"^[a-z]:/", normalized, re.IGNORECASE):
            return True
        if re.search(r"\.\.(?:/|$)", normalized):
            return True
        if re.match(r"^-[A-Za-z]+(?:/|[A-Za-z]:/)", normalized, re.IGNORECASE):
            return True
        if root is None:
            continue
        candidates = [normalized]
        # grep and ripgrep accept a pattern file as either `-f FILE` or `-fFILE`.
        if normalized.startswith("-f") and len(normalized) > 2:
            candidates.append(normalized[2:])
        for candidate in candidates:
            path = Path(candidate)
            if path.is_absolute() or not candidate or candidate.startswith("-"):
                continue
            if any(glob.has_magic(part) for part in path.parts):
                prefix_parts = []
                for part in path.parts:
                    if glob.has_magic(part):
                        break
                    prefix_parts.append(part)
                prefix = root.joinpath(*prefix_parts)
                try:
                    if not prefix.resolve(strict=False).is_relative_to(root):
                        return True
                    for match in glob.glob(str(root / path)):
                        if not Path(match).resolve(strict=False).is_relative_to(root):
                            return True
                except (OSError, RuntimeError, ValueError):
                    return True
                continue
            resolved_path = root
            for part in path.parts:
                if part in {"", "."}:
                    continue
                if part == "..":
                    break
                resolved_path = resolved_path / part
                try:
                    if resolved_path.is_symlink():
                        resolved_path = resolved_path.resolve(strict=False)
                        if not resolved_path.is_relative_to(root):
                            return True
                except (OSError, RuntimeError, ValueError):
                    # An unreadable or cyclic path cannot be classified as project-local.
                    return True
    return False


def _project_venv_executable_is_valid(executable_path: Path, project_root: Path) -> bool:
    """Accept an installed POSIX venv's Python symlink only when pyvenv.cfg backs it."""
    try:
        root = project_root.resolve(strict=True)
        resolved = (root / executable_path).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return False
    if resolved.is_relative_to(root):
        return resolved.is_file()
    if os.name != "posix" or not resolved.is_file() or not os.access(resolved, os.X_OK):
        return False
    if not executable_path.is_symlink() or not resolved.name.casefold().startswith("python"):
        return False
    for index, part in enumerate(executable_path.parts):
        if part.casefold() not in {".venv", "venv"}:
            continue
        config_path = root.joinpath(*executable_path.parts[:index + 1], "pyvenv.cfg")
        try:
            config = config_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            return False
        interpreter_home_value = None
        for line in config.splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip().casefold() == "home" and value.strip():
                interpreter_home_value = value.strip()
                break
        if interpreter_home_value is None:
            return False
        try:
            interpreter_home = Path(interpreter_home_value).expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return False
        return resolved.is_relative_to(interpreter_home)
    return False


def _has_shell_control(
    command: str, *, allow_and_chain: bool = False, allow_sequential_chain: bool = False,
    allow_pipelines: bool = False, allow_or_chain: bool = False,
    allow_stderr_to_null: bool = False,
) -> bool:
    """Recognise shell operators outside quotes without mistaking grep patterns for pipes."""
    try:
        lexer = shlex.shlex(
            command, posix=os.name != "nt", punctuation_chars=";&|<>`$()",
        )
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return True
    if allow_stderr_to_null:
        tokens = _without_safe_stderr_redirections(tokens)
    operators = {"||", ";", "|", "&", ">", "<", "`", "$(", "(", ")"}
    if not allow_and_chain:
        operators.add("&&")
    if allow_sequential_chain:
        operators.discard(";")
    if allow_pipelines:
        operators.discard("|")
    if allow_or_chain:
        operators.discard("||")
    return any(token in operators for token in tokens)


def _without_safe_stderr_redirections(tokens: list[str]) -> list[str]:
    """Strip only the inert `2>/dev/null` redirection from parsed shell tokens."""
    result: list[str] = []
    index = 0
    while index < len(tokens):
        if tokens[index:index + 3] == ["2", ">", "/dev/null"]:
            index += 3
            continue
        result.append(tokens[index])
        index += 1
    return result


def _read_only_command_paths(executable: str, arguments: list[str]) -> list[str]:
    """Return filesystem operands, excluding search patterns and inline scripts."""
    if executable == "printf":
        return []

    if executable in {"grep", "rg"}:
        paths: list[str] = []
        positional: list[str] = []
        has_pattern = False
        index = 0
        while index < len(arguments):
            token = arguments[index]
            if token == "--":
                positional.extend(arguments[index + 1:])
                break
            if token in {"-e", "--regexp"}:
                has_pattern = True
                index += 2
                continue
            if token.startswith("--regexp="):
                has_pattern = True
                index += 1
                continue
            file_options = {"-f", "--file"}
            if executable == "rg":
                file_options.update({"--files-from", "--ignore-file"})
            if token in file_options:
                if index + 1 < len(arguments):
                    paths.append(arguments[index + 1])
                index += 2
                continue
            if token.startswith(("--file=", "--files-from=", "--ignore-file=")):
                paths.append(token.partition("=")[2])
            elif token.startswith("-f") and token != "-f":
                paths.append(token[2:])
            elif token.startswith("-e") and token != "-e":
                has_pattern = True
            elif token.startswith("-"):
                # Common grep/ripgrep switches take a value; skip it so a value
                # beginning with '/' is not mistaken for an external file.
                if token in {"-A", "-B", "-C", "-m", "--after-context", "--before-context",
                             "--context", "--max-count", "--color", "--colors", "--type",
                             "--glob", "--iglob", "--max-depth"}:
                    index += 1
            else:
                positional.append(token)
            index += 1
        if not has_pattern and positional:
            positional = positional[1:]
        return paths + positional

    if executable == "sed":
        paths: list[str] = []
        positional: list[str] = []
        has_script = False
        index = 0
        while index < len(arguments):
            token = arguments[index]
            if token == "--":
                positional.extend(arguments[index + 1:])
                break
            if token in {"-e", "--expression"}:
                has_script = True
                index += 2
                continue
            if token in {"-f", "--file"}:
                if index + 1 < len(arguments):
                    paths.append(arguments[index + 1])
                has_script = True
                index += 2
                continue
            if token.startswith("--expression="):
                has_script = True
                index += 1
                continue
            if token.startswith("--file="):
                paths.append(token.partition("=")[2])
                has_script = True
                index += 1
                continue
            if token.startswith("-f") and token != "-f":
                paths.append(token[2:])
                has_script = True
            elif token.startswith("-e") and token != "-e":
                has_script = True
            elif token.startswith("-"):
                pass
            else:
                positional.append(token)
            index += 1
        if positional and not has_script:
            positional = positional[1:]  # The first positional operand is the sed program.
        return paths + positional

    if executable == "find":
        paths: list[str] = []
        index = 0
        expression_started = False
        while index < len(arguments):
            token = arguments[index]
            if token in {"-H", "-L", "-P"}:
                index += 1
                continue
            if token in {"-O", "-D"}:
                index += 2
                continue
            if token == "--":
                paths.extend(arguments[index + 1:])
                break
            if token.startswith("-") or token in {"!", "("}:
                expression_started = True
                if token in {"-files0-from", "-newer", "-anewer", "-cnewer", "-samefile"} \
                        or re.fullmatch(r"-newer[acmBt]{2}", token):
                    if index + 1 < len(arguments):
                        paths.append(arguments[index + 1])
                    index += 2
                    continue
                if token.startswith("-files0-from="):
                    paths.append(token.partition("=")[2])
                index += 1
                continue
            if not expression_started:
                # Find's leading non-option operands are search roots. After the
                # expression starts, only known file-taking predicates are paths.
                paths.append(token)
            index += 1
        return paths

    return arguments


def _sed_script_has_external_effects(script: str) -> bool:
    """Reject sed file I/O and execution commands from automatic command review."""
    script = script.strip()
    if len(script) >= 2 and script[0] in {"'", '"'} and script[-1] == script[0]:
        script = script[1:-1]
    if re.search(r"(?:^|[;{}])\s*(?:\d+(?:,\d+)?\s*)?[rRwWeE](?=\s|$)", script):
        return True
    index = 0
    while index < len(script):
        if script[index] != "s" or index + 1 >= len(script):
            index += 1
            continue
        delimiter = script[index + 1]
        if delimiter.isalnum() or delimiter.isspace() or delimiter == "\\":
            index += 1
            continue
        cursor = index + 2
        delimiters = 0
        while cursor < len(script) and delimiters < 2:
            if script[cursor] == "\\":
                cursor += 2
                continue
            if script[cursor] == delimiter:
                delimiters += 1
            cursor += 1
        if delimiters != 2:
            return True
        flags = script[cursor:].lstrip()
        if re.search(r"(?<![A-Za-z])[ewW](?=\s|$)", flags):
            return True
        index = cursor
    return False


def _sed_command_has_external_effects(arguments: list[str]) -> bool:
    """Find inline sed scripts; script files require approval because their content is opaque."""
    scripts: list[str] = []
    index = 0
    while index < len(arguments):
        token = arguments[index]
        if token in {"-e", "--expression"}:
            if index + 1 >= len(arguments):
                return True
            scripts.append(arguments[index + 1])
            index += 2
            continue
        if token in {"-f", "--file"} or token.startswith("--file=") or token.startswith("-f"):
            return True
        if token.startswith("--expression="):
            scripts.append(token.partition("=")[2])
        elif token.startswith("-e") and token != "-e":
            scripts.append(token[2:])
        elif not token.startswith("-") and not scripts:
            scripts.append(token)
        elif not token.startswith("-") and scripts:
            break
        index += 1
    return any(_sed_script_has_external_effects(script) for script in scripts)


_FIND_SIDE_EFFECT_OPTIONS = {
    "-delete", "-exec", "-execdir", "-ok", "-okdir",
    "-fls", "-fprint", "-fprint0", "-fprintf",
}


def _find_command_has_side_effect(arguments: list[str]) -> bool:
    """Require exact approval for find actions that write or launch commands."""
    return any(
        item.casefold() in _FIND_SIDE_EFFECT_OPTIONS
        or any(item.casefold().startswith(option + "=") for option in _FIND_SIDE_EFFECT_OPTIONS)
        for item in arguments
    )


def command_needs_approval(command: str, project_root: Path | None = None) -> bool:
    """Keep the existing conservative shell boundary for risky command families."""
    if not command.strip():
        return False
    try:
        parts = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        return True
    if not parts:
        return False
    executable = Path(parts[0].replace("\\", "/")).name.casefold()
    raw_arguments = parts[1:]
    arguments = [part.casefold() for part in raw_arguments]
    explicit_executable_path = "/" in parts[0].replace("\\", "/")
    if executable == "rtk" and arguments:
        if raw_arguments[0].casefold() == "proxy":
            raw_arguments = raw_arguments[1:]
            arguments = arguments[1:]
        if raw_arguments:
            explicit_executable_path = explicit_executable_path or (
                "/" in raw_arguments[0].replace("\\", "/")
            )
            executable = Path(raw_arguments[0].replace("\\", "/")).name.casefold()
            raw_arguments = raw_arguments[1:]
            arguments = [part.casefold() for part in raw_arguments]
    risky_executables = {
        "rm", "rmdir", "del", "erase", "remove-item", "format", "mkfs", "dd",
        "shutdown", "reboot", "curl", "wget", "ssh", "scp", "sftp", "ftp",
        "rsync", "npx", "uvx", "gh", "aws", "az", "gcloud", "terraform", "jupyter", "sonar-scanner",
    }
    if executable == "rg" and any(
        item == "--pre" or item.startswith("--pre=") for item in arguments
    ):
        return True
    if executable == "sed" and any(
        item in {"-i", "--in-place"}
        or item.startswith("-i")
        or item.startswith("--in-place=")
        for item in arguments
    ):
        return True
    if "nbconvert" in arguments or "jupyter" in arguments:
        return True
    if executable in risky_executables:
        return True
    if executable == "find" and _find_command_has_side_effect(raw_arguments):
        return True
    if executable == "sed" and _sed_command_has_external_effects(raw_arguments):
        return True
    if executable in {"bash", "sh", "zsh", "powershell", "pwsh", "cmd"}:
        return True
    if executable in {"python", "python3", "node", "ruby", "perl"} and any(
        item in {"-c", "-e", "--eval", "-command"} for item in arguments
    ):
        return True
    if executable == "git" and arguments and arguments[0] in {
        "push", "pull", "fetch", "clone", "clean", "reset", "submodule",
    }:
        return True
    if executable in {"npm", "pnpm", "yarn", "pip", "pip3", "uv", "cargo", "gem"} \
            and arguments and arguments[0] in {
                "install", "add", "remove", "uninstall", "publish", "link", "upgrade",
            }:
        return True
    has_shell_control = _has_shell_control(command)
    reviewable_command = command_is_reviewable(command, project_root)
    if reviewable_command:
        # A project-local virtual-environment test executable is a known test
        # command, not an arbitrary executable path outside the repository.
        explicit_executable_path = False
    if has_shell_control and reviewable_command:
        has_shell_control = False
    references_outside_project = (
        False if reviewable_command else _references_path_outside_project(raw_arguments, project_root)
    )
    return (explicit_executable_path or has_shell_control or _contains_shell_path_expansion(command)
            or references_outside_project)


def command_is_reviewable(command: str, project_root: Path | None = None) -> bool:
    """Limit automatic command review to local reads and allowlisted repository tests."""
    if _contains_shell_path_expansion(command):
        return False
    if not command or "\n" in command or "\r" in command:
        return False
    if _has_shell_control(
        command, allow_and_chain=True, allow_sequential_chain=True, allow_pipelines=True,
        allow_or_chain=True, allow_stderr_to_null=True,
    ):
        return False
    try:
        lexer = shlex.shlex(
            command, posix=os.name != "nt", punctuation_chars=";&|<>`$()",
        )
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = _without_safe_stderr_redirections(list(lexer))
    except ValueError:
        return False
    if not tokens or any(not item for item in tokens):
        return False
    test_tokens = tokens
    if tokens[0] == "rtk":
        test_tokens = tokens[2:] if len(tokens) > 1 and tokens[1] == "proxy" else tokens[1:]
    if test_tokens:
        executable = test_tokens[0].replace("\\", "/")
        executable_path = Path(executable)
        if (
            not executable_path.is_absolute()
            and ".." not in executable_path.parts
            and any(part.casefold() in {".venv", "venv"} for part in executable_path.parts)
            and executable_path.name.casefold() in {
                "pytest", "pytest.exe", "python", "python3", "python.exe", "python3.exe",
            }
        ):
            if project_root is not None:
                if not _project_venv_executable_is_valid(executable_path, project_root):
                    return False
            test_tokens = [executable_path.name, *test_tokens[1:]]
    if is_approved_repository_test_command(test_tokens):
        return not _references_path_outside_project(test_tokens[1:], project_root)
    read_only_commands = {
        "git", "rg", "grep", "ls", "pwd", "cat", "sed", "head", "tail", "find", "nl", "wc",
        "printf", "true",
    }
    read_only_git_commands = {"status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files", "blame"}
    segments: list[list[str]] = []
    segment: list[str] = []
    for token in tokens:
        if token in {"&&", "||", ";", "|"}:
            if not segment:
                return False
            segments.append(segment)
            segment = []
        else:
            segment.append(token)
    if segment:
        segments.append(segment)
    elif not tokens or tokens[-1] != ";":
        return False

    for segment in segments:
        raw_executable = segment[0].strip("'\"")
        if "/" in raw_executable.replace("\\", "/"):
            return False
        executable = Path(raw_executable.replace("\\", "/")).name.casefold()
        arguments = segment[1:]
        if executable == "rtk" and arguments:
            raw_executable = arguments[0].strip("'\"")
            if "/" in raw_executable.replace("\\", "/"):
                return False
            executable, arguments = Path(arguments[0].replace("\\", "/")).name.casefold(), arguments[1:]
        if executable not in read_only_commands:
            return False
        if executable == "git" and (not arguments or arguments[0].casefold() not in read_only_git_commands):
            return False
        if executable == "git" and any(
            item.casefold() in {"-d", "-D", "--delete", "--output", "--ext-diff", "--textconv"}
            or item.casefold().startswith("--output=") for item in arguments
        ):
            return False
        if executable == "find" and any(
            item.casefold() in {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-l"}
            for item in arguments
        ):
            return False
        if executable == "sed" and any(
            item.casefold() in {"-i", "--in-place"}
            or item.casefold().startswith("-i")
            or item.casefold().startswith("--in-place=")
            for item in arguments
        ):
            return False
        if any(
            item in {"-c", "--eval", "-command", "-exec", "-execdir", "--pre"}
            or item.casefold().startswith("--pre=")
            for item in arguments
        ):
            return False
        if executable == "find" and _find_command_has_side_effect(arguments):
            return False
        if executable == "sed" and _sed_command_has_external_effects(arguments):
            return False
        path_arguments = _read_only_command_paths(executable, arguments)
        if _references_path_outside_project(path_arguments, project_root):
            return False
    return True


def command_is_auto_review_candidate(command: str, project_root: Path | None = None) -> bool:
    """Let Auto-review assess bounded local eval commands; do not grant them by classifier alone."""
    if command_is_reviewable(command, project_root):
        return True
    if (not command or len(command) > 8_000 or "\n" in command or "\r" in command
            or _contains_shell_path_expansion(command)
            or _has_shell_control(command)):
        return False
    try:
        tokens = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        return False
    if not tokens:
        return False
    if Path(tokens[0].replace("\\", "/")).name.casefold() == "rtk":
        tokens = tokens[2:] if len(tokens) > 1 and tokens[1].casefold() == "proxy" else tokens[1:]
    if not tokens:
        return False
    executable_path = tokens[0].replace("\\", "/")
    executable = Path(executable_path).name.casefold()
    arguments = tokens[1:]
    if executable_path != executable or executable not in {"node", "nodejs", "python", "python3"}:
        return False
    if not any(item.casefold() in {"-c", "-e", "--eval"} for item in arguments):
        return False
    return not _references_path_outside_project(arguments, project_root)


def persistent_tool_approval_allowed(
    tool_name: str, arguments: object, *, requires_mcp_approval: bool = False,
    project_root: Path | None = None,
) -> bool:
    """Allow scoped grants only for named reads and bounded local actions."""
    if tool_name in {"duckduckgo_search", "web_fetch"}:
        return True
    if requires_mcp_approval:
        return False
    if tool_name in _PERSISTENT_READ_TOOLS:
        return True
    if tool_name in {
        "request_file_deletion_approval", "delete_repository_file",
        "request_isolated_integration", "integrate_isolated_changes", "generate_image",
    }:
        return False
    if tool_name in _REPOSITORY_FILE_CHANGE_TOOLS:
        return True
    if tool_name == "run_repository_tests":
        argv = arguments.get("argv") if isinstance(arguments, dict) else None
        return is_approved_repository_test_command(argv)
    if tool_name in {"run_command", "start_command"}:
        command = arguments.get("command", "") if isinstance(arguments, dict) else ""
        if not isinstance(command, str):
            return False
        return (not command_needs_approval(command, project_root)
                or command_is_reviewable(command, project_root))
    return False


def _supports_native_local_workspace() -> bool:
    """Pydantic AI's LocalWorkspaceBackend currently supports POSIX hosts only."""
    return os.name == "posix"


def _assert_harness_workspace_is_current(tool_name: str, run_root: Path, current_root: Path) -> None:
    """Stop native tools from using a stale checkout after isolation starts mid-run."""
    if tool_name in _HARNESS_LOCAL_WORKSPACE_TOOLS and run_root.resolve() != current_root.resolve():
        raise RuntimeError(
            "The repository workspace changed during this run. Use Tribe's repository tools for the rest "
            "of this run; Harness file and shell tools will use the isolated workspace on the next run."
        )


def _compaction_keep_tokens(context_window: int | None) -> int:
    """Retain a recent working set without overwhelming small model windows."""
    window = context_window if context_window else UNKNOWN_MODEL_CONTEXT_WINDOW
    return max(1_000, int(window * 0.2))


def build_capabilities(
    workspace: WorkspaceTools, skills: SkillCatalog, trigger_sequence: int = 0,
    approved_tool_call_ids: set[str] | None = None,
    step_store: StepStore | None = None,
    mcp_registry: MCPRegistry | None = None,
    project_id: str | None = None,
    web_access: dict[str, object] | None = None,
    repository_access: str = "workspace_write",
    selected_skill_ids: list[str] | None = None,
    model_context_window: int | None = None,
    model_max_output_tokens: int | None = None,
    tool_permissions: tuple[str, ...] | None = None,
    eager_shell_tools: tuple[str, ...] = (),
    approval_mode: str | None = None,
    approval_reviewer=None,
    image_generator=None,
    after_model_response=None,
    context_pruning_enabled: bool = False,
) -> list[object]:
    """Compose bounded repository tools and portable skills for a run.

    Tribe deliberately does not use the Coder composite: it enables unrestricted shell
    access and self-delegation, which conflict with Tribe's independent event consumers
    and action approval policy. The capabilities below are selected explicitly.
    """
    if repository_access not in {"read_only", "workspace_write"}:
        raise ValueError("repository_access must be read_only or workspace_write")
    try:
        from pydantic_ai import ApprovalRequired
        from pydantic_ai.capabilities import (
            HandleDeferredToolCalls,
            Hooks,
            ImageGeneration,
            LocalWorkspace,
            WebFetch,
            WebSearch,
        )
        from pydantic_ai.workspaces import LocalWorkspaceBackend
        from pydantic_ai_harness import FileSystem, Shell, Skills
        from pydantic_ai_harness.compaction import DEFAULT_CONTEXT_WINDOW, SummarizingCompaction
        from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence

        from .context_pruning import ContextPruning
    except ImportError as error:
        raise RuntimeError(
            "Install tribe-runtime[ai] to enable Pydantic AI Harness capabilities: "
            f"{error}"
        ) from error

    root = workspace.root.resolve()
    approved_calls = approved_tool_call_ids if approved_tool_call_ids is not None else set()
    approval_mode = approval_mode or workspace.store.project_approval_policy_for_mission(
        workspace.mission_id
    )
    if approval_mode not in {"standard", "review_changes", "confirm_every_call", "auto_review"}:
        approval_mode = "standard"

    change_tools = {
        "write_file", "edit_file", "create_directory", "write_repository_file",
        "run_command", "start_command", "run_repository_tests",
    }
    command_tools = {"run_command", "start_command", "run_repository_tests"}
    file_change_tools = change_tools - command_tools
    exact_approval_tools = {
        "request_file_deletion_approval", "delete_repository_file",
        "request_isolated_integration", "integrate_isolated_changes",
    }

    def mcp_action(tool_name: str) -> tuple[str, str] | None:
        if tool_name in BROWSER_ACTION_TOOLS:
            return ("browser", tool_name.removeprefix("browser_"))
        if not mcp_registry or not project_id:
            return None
        return mcp_registry.approval_for(project_id, tool_name)

    web_action_names = {"duckduckgo_search", "web_fetch"}

    def command_text(arguments: object) -> str:
        if isinstance(arguments, dict):
            command = arguments.get("command")
            if isinstance(command, str):
                return command
            argv = arguments.get("argv")
            if isinstance(argv, list) and all(isinstance(item, str) for item in argv):
                return shlex.join(argv)
        return ""

    def reviewable_command_action(tool_name: str, arguments: object) -> bool:
        if tool_name == "run_repository_tests":
            argv = arguments.get("argv") if isinstance(arguments, dict) else None
            return is_approved_repository_test_command(argv)
        return command_is_auto_review_candidate(command_text(arguments), root)

    def safe_command(command: str) -> str:
        return redact_shell_command(command)

    def redact_mcp_arguments(value: object) -> object:
        if isinstance(value, dict):
            return {
                key: "[redacted]" if re.search(
                    r"(?i)(key|token|secret|password|auth|credential|cookie|session)", str(key),
                ) or str(key).casefold() in {
                    "value", "text", "content", "body", "message", "prompt", "query",
                    "input", "script", "code", "url",
                } else safe_command(item) if str(key).casefold() == "command" and isinstance(item, str)
                else redact_mcp_arguments(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [
                f"[text omitted · {len(item)} characters]" if isinstance(item, str)
                else redact_mcp_arguments(item)
                for item in value
            ]
        if isinstance(value, str):
            return f"[text omitted · {len(value)} characters]"
        return value

    def redact_approval_arguments(tool_name: str, value: object) -> object:
        redacted = redact_mcp_arguments(value)
        action = mcp_action(tool_name)
        if action != ("browser", tool_name.removeprefix("browser_")) or not isinstance(value, dict):
            return redacted
        try:
            parsed_url = urlsplit(value.get("url", "")) if isinstance(value.get("url"), str) else None
            host = parsed_url.hostname if parsed_url else None
            port = parsed_url.port if parsed_url else None
        except ValueError:
            host = None
            port = None
            parsed_url = None
        if host:
            host_display = f"[{host}]" if ":" in host else host
            origin = f"{parsed_url.scheme}://{host_display}" if parsed_url and parsed_url.scheme else f"//{host_display}"
            if port is not None:
                origin += f":{port}"
        else:
            origin = "[website origin omitted]"
        return {
            key: (origin if key == "url" and isinstance(item, str)
                  else f"[text omitted · {len(item)} characters]"
                  if key in {"value", "text", "selector", "name"} and isinstance(item, str)
                  else item)
            for key, item in redacted.items()
        }

    async def require_action_approval(ctx, *, call, tool_def, args):
        _assert_harness_workspace_is_current(tool_def.name, root, workspace.root)
        if tool_def.name in change_tools:
            try:
                workspace._require_work_claim()
            except PermissionError as error:
                from pydantic_ai.exceptions import ModelRetry

                raise ModelRetry(
                    "There is unfinished plan work, so repository changes and commands need its live task claim. "
                    "Use update_state to claim a ready task that covers this action, then retry it. "
                    "If no ready task matches, do not bypass dependencies; explain what is blocking the request."
                ) from error
        mcp_tool = mcp_action(tool_def.name)
        is_web_action = tool_def.name in web_action_names
        if call.tool_call_id in approved_calls:
            return args
        if (project_id and tool_def.name not in exact_approval_tools
                and (mcp_tool is not None or tool_def.name in change_tools)):
            capability = tool_action_approval_capability(
                tool_def.name, args, workspace.store.data_dir, create_key=False,
            )
            has_grant = bool(capability and workspace.store.has_access_grant(
                workspace.mission_id, project_id, capability,
            ))
            reusable_command_approval = (
                tool_def.name not in {"run_command", "start_command"}
                or persistent_tool_approval_allowed(
                tool_def.name, args,
                project_root=root,
                )
            )
            if has_grant and reusable_command_approval:
                return args
        if is_web_action and project_id and workspace.store.has_access_grant(
            workspace.mission_id, project_id, "public_web_read",
        ):
            return args
        if approval_mode == "confirm_every_call" and tool_def.name not in exact_approval_tools:
            raise ApprovalRequired({"reason": "This project asks for approval before every agent tool call."})
        if approval_mode == "review_changes" and tool_def.name in change_tools:
            raise ApprovalRequired({"reason": "This project asks for approval before file changes and command runs."})
        if approval_mode == "auto_review" and tool_def.name in file_change_tools:
            raise ApprovalRequired({"reason": "The project auto-review is checking this file change."})
        if (approval_mode == "auto_review" and tool_def.name in command_tools
                and reviewable_command_action(tool_def.name, args)):
            raise ApprovalRequired({"reason": "The project auto-review is checking this local command."})
        if tool_def.name not in {"run_command", "start_command"} and mcp_tool is None and not is_web_action:
            return args
        if mcp_tool is not None:
            server_name, tool_name = mcp_tool
            raise ApprovalRequired({
                "reason": f"MCP tool {server_name}.{tool_name} requires one-time user approval."
            })
        if is_web_action:
            raise ApprovalRequired({
                "reason": "External web access requires one-time user approval for this exact request."
            })
        command = command_text(args)
        if command_needs_approval(command, root):
            raise ApprovalRequired({"reason": "The command may access external services or make destructive changes."})
        return args

    async def resolve_action_approvals(ctx, requests):
        from pydantic_ai.messages import ModelMessagesTypeAdapter
        from pydantic_ai.tools import ToolDenied

        decisions = {}

        def record_agent_approval_context(tool_call_id: str, **approval: object) -> None:
            summaries = getattr(ctx.deps, "tool_call_summaries", None)
            entry = summaries.get(tool_call_id) if isinstance(summaries, dict) else None
            if isinstance(entry, dict):
                entry["approvalReview"] = approval

        for call in requests.approvals:
            args = call.args
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            mcp_tool = mcp_action(call.tool_name)
            command = command_text(args)
            summary = (getattr(ctx.deps, "tool_call_summaries", None) or {}).get(
                call.tool_call_id, {}
            ).get("summary", "")
            automatic_review_reason = ""
            repository_preview = repository_change_approval_preview(call.tool_name, args)
            argument_summary = (
                f"Proposed repository change:\n{repository_preview}"
                if repository_preview is not None else
                f"Arguments:\n{json.dumps(redact_approval_arguments(call.tool_name, args), indent=2, ensure_ascii=False)[:6000]}"
            )
            reviewable_auto_action = (
                call.tool_name in file_change_tools
                or call.tool_name in command_tools and reviewable_command_action(call.tool_name, args)
            )
            if approval_mode == "auto_review" and approval_reviewer and reviewable_auto_action:
                try:
                    review = await approval_reviewer(
                        tool_name=call.tool_name, command=command, summary=summary,
                        arguments=redact_review_arguments(args), context_messages=ctx.messages,
                        role_access={
                            "agent_id": workspace.agent_id,
                            "repository_access": repository_access,
                            "tool_permissions": sorted(tool_permissions or ()),
                        },
                    )
                except asyncio.TimeoutError:
                    review = {"decision": "ask", "reason": "Automatic review timed out."}
                except Exception as error:
                    review = {
                        "decision": "ask",
                        "reason": _automatic_review_error_reason(error),
                    }
                if isinstance(review, dict) and review.get("decision") in {"approve", "deny"}:
                    approved = review["decision"] == "approve"
                    review_reason = str(review.get("reason") or "").strip()[:1_000]
                    workspace.store.record_automatic_tool_review(
                        workspace.mission_id, workspace.agent_id,
                        tool_call_id=call.tool_call_id, tool_name=call.tool_name,
                        decision="approved" if approved else "denied", reason=review_reason,
                        summary=summary,
                    )
                    decisions[call.tool_call_id] = (
                        True if approved else ToolDenied(
                            message=f"Automatic review denied this action: {review_reason or 'the proposal did not meet the review criteria.'} "
                            "Revise the proposal using the review feedback; do not repeat the same action unchanged."
                        )
                    )
                    if approved:
                        approved_calls.add(call.tool_call_id)
                        record_agent_approval_context(
                            call.tool_call_id, source="automatic", decision="approved",
                        )
                    continue
                automatic_review_reason = (
                    str(review.get("reason") or "") if isinstance(review, dict) else ""
                ).strip() or "Automatic review could not make a safe decision."
                workspace.store.record_automatic_tool_review(
                    workspace.mission_id, workspace.agent_id,
                    tool_call_id=call.tool_call_id, tool_name=call.tool_name,
                    decision="needs_user", reason=automatic_review_reason, summary=summary,
                )
                record_agent_approval_context(
                    call.tool_call_id, source="automatic", decision="needs_user",
                )
            if approval_mode == "confirm_every_call" and call.tool_name not in exact_approval_tools:
                title = "Confirm agent action"
                summary = (getattr(ctx.deps, "tool_call_summaries", None) or {}).get(
                    call.tool_call_id, {}
                ).get("summary")
                target = summary or "Agent tool call"
                if mcp_tool == ("browser", call.tool_name.removeprefix("browser_")):
                    target = "Browser session"
                details = (
                    "This project asks you to approve every agent tool call before it runs.\n\n"
                    f"Requested action: {call.tool_name}\n"
                    f"{argument_summary}\n\n"
                    "Approval applies once to this exact call."
                )
            elif call.tool_name in change_tools and approval_mode == "review_changes":
                is_command = call.tool_name in command_tools
                title = "Approve command" if is_command else "Review project change"
                summary = (getattr(ctx.deps, "tool_call_summaries", None) or {}).get(
                    call.tool_call_id, {}
                ).get("summary")
                target = summary or (f"Run command in {root}" if is_command else "Project files")
                details = (
                    "The project approval mode requires confirmation before this change.\n\n"
                    f"Requested action: {call.tool_name}\n"
                    f"{argument_summary}\n\n"
                    "Approval applies once to this exact call."
                )
            elif call.tool_name in file_change_tools:
                is_repository_file_change = call.tool_name in _REPOSITORY_FILE_CHANGE_TOOLS
                details = (
                    (f"Automatic review asked for your decision: {automatic_review_reason}\n\n"
                     if automatic_review_reason else "")
                    + f"Requested change: {call.tool_name}\n"
                    + f"{argument_summary}\n\n"
                    + "Approve once for this exact call."
                    + (" Chat or project approval options below cover future in-project file changes "
                       "for agents that already have repository write access. Deletions and external "
                       "actions still require separate approval."
                       if is_repository_file_change else "")
                )
                title = "Review project change"
                target = summary or "Project files"
            elif mcp_tool:
                server_name, tool_name = mcp_tool
                title = (f"Use browser · {tool_name.replace('_', ' ')}" if server_name == "browser"
                         else f"Run MCP action {server_name}.{tool_name}")
                target = ("Browser session" if server_name == "browser"
                          else f"MCP server {server_name} · {tool_name}")
                redacted_args = redact_approval_arguments(call.tool_name, args)
                exact_action = json.dumps(redacted_args, indent=2, ensure_ascii=False)[:8000]
                details = (
                    f"Exact {('browser action' if server_name == 'browser' else 'MCP tool')}: {server_name}.{tool_name}\nArguments:\n{exact_action}\n\n"
                    + ("The destination origin is shown; its path and query are hidden.\n"
                       if server_name == "browser" else "")
                    + "Approval applies once to this exact tool call."
                )
            elif call.tool_name in web_action_names:
                title = "Search the public web" if call.tool_name == "duckduckgo_search" else "Fetch a public web page"
                target = json.dumps(args if isinstance(args, dict) else {}, ensure_ascii=False)[:2000]
                details = (
                    f"Exact web request:\n{json.dumps(args if isinstance(args, dict) else {}, indent=2, ensure_ascii=False)[:4000]}\n\n"
                    "This sends a read-only request to an external service. You can approve this request once, "
                    "or allow read-only public web access for this chat, project, or workspace. "
                    "Project web settings and the selected role's web access still apply."
                )
            else:
                title = "Review command" if automatic_review_reason else "Run a command outside the safe set"
                target = f"Run command in {root}"
                details = (
                    (f"Automatic review asked for your decision: {automatic_review_reason}\n\n"
                     if automatic_review_reason else "")
                    + f"Exact command:\n{safe_command(command)}\n\n"
                    + ("Automatic review could not approve this command. " if automatic_review_reason else
                       "This command may access external services or make destructive changes. ")
                    + "Approval applies once to this exact tool call."
                )
            interaction = workspace.store.create_deferred_tool_interaction(
                mission_id=workspace.mission_id, requested_by=workspace.agent_id,
                title=title,
                details=details,
                target=target, trigger_sequence=trigger_sequence,
                run_id=ctx.run_id, conversation_id=ctx.conversation_id or "",
                tool_call_id=call.tool_call_id, tool_name=call.tool_name,
                tool_arguments=redact_approval_arguments(call.tool_name, args),
                approval_capability=(
                    tool_action_approval_capability(
                        call.tool_name, args, workspace.store.data_dir,
                    )
                    if persistent_tool_approval_allowed(
                        call.tool_name, args, requires_mcp_approval=mcp_tool is not None,
                        project_root=root,
                    ) else ""
                ),
                message_history=ModelMessagesTypeAdapter.dump_json(
                    sanitized_browser_messages(ctx.messages)
                ).decode("utf-8"),
                tool_summary=(getattr(ctx.deps, "tool_call_summaries", None) or {})
                    .get(call.tool_call_id, {}).get("summary", ""),
                activity_labels=(getattr(ctx.deps, "tool_call_summaries", None) or {})
                    .get(call.tool_call_id, {}).get("activityLabels"),
                work_item_id=getattr(ctx.deps, "active_work_item_id", None),
            )
            while True:
                mission = workspace.store.mission(workspace.mission_id)
                if not mission:
                    workspace.store.resolve_interaction(interaction["id"], "denied_mission_missing")
                    decisions[call.tool_call_id] = False
                    workspace.store.update_deferred_tool_approval(interaction["id"], "denied")
                    break
                if mission["status"] != "active":
                    await asyncio.sleep(0.25)
                    continue
                current = workspace.store.approval(interaction["id"])
                if not current or current["status"] != "pending":
                    approved = bool(current and current["resolution"] == "approved_once")
                    if approved:
                        approved = workspace.store.consume_deferred_tool_approval(
                            interaction["id"], target
                        )
                    decisions[call.tool_call_id] = approved
                    if approved:
                        approved_calls.add(call.tool_call_id)
                        previous_review = (
                            (getattr(ctx.deps, "tool_call_summaries", None) or {}).get(
                                call.tool_call_id, {},
                            ).get("approvalReview")
                        )
                        record_agent_approval_context(
                            call.tool_call_id, source="user", decision="approved_once",
                            automatic_review=(previous_review.get("decision")
                                             if isinstance(previous_review, dict) else None),
                        )
                    workspace.store.update_deferred_tool_approval(
                        interaction["id"], "consumed" if approved else "denied"
                    )
                    break
                await asyncio.sleep(0.25)
        return requests.build_results(approvals=decisions)

    context_window = (
        model_context_window
        if isinstance(model_context_window, int) and not isinstance(model_context_window, bool)
        and model_context_window > 1
        else None
    )
    # Summarize older turns before the selected model's context is exhausted, while
    # retaining a recent working set. The summary call inherits the active model and
    # is included in the run's usage accounting.
    fallback_context_window = DEFAULT_CONTEXT_WINDOW
    keep_tokens = _compaction_keep_tokens(context_window or fallback_context_window)
    summary_model_settings = (
        {"max_tokens": model_max_output_tokens}
        if isinstance(model_max_output_tokens, int) and not isinstance(model_max_output_tokens, bool)
        and model_max_output_tokens > 0
        else None
    )
    capabilities: list[object] = [SummarizingCompaction(
        model_settings=summary_model_settings,
        max_fraction=0.75,
        context_window=context_window,
        fallback_context_window=fallback_context_window,
        keep_tokens=keep_tokens,
        keep_messages=20,
        keep_user_messages=True,
        incremental=True,
        receipts=True,
    )]
    native_local_workspace = _supports_native_local_workspace()
    if native_local_workspace:
        # Pydantic AI resolves the run workspace before model execution; unlike its
        # tools, this capability must be eager.
        capabilities.insert(0, LocalWorkspace(root))
    if native_local_workspace:
        granted_tools = set(tool_permissions or ())
        filesystem_names = {
            "read_file", "write_file", "edit_file", "list_directory", "search_files",
            "find_files", "create_directory", "file_info",
        }
        shell_names = {"run_command", "start_command", "check_command", "stop_command"}
        filesystem_tools = sorted(filesystem_names & granted_tools)
        if repository_access == "read_only":
            filesystem_tools = [
                name for name in filesystem_tools
                if name not in {"write_file", "edit_file", "create_directory"}
            ]
        # Repository access controls FileSystem capabilities; Shell tools remain profile-granted.
        shell_tools = sorted(shell_names & granted_tools)
        if filesystem_tools:
            capabilities.append(FileSystem(
                root_dir=root,
                denied_patterns=[
                    ".git", "**/.git", "**/.git/**", ".tribe", "**/.tribe", "**/.tribe/**",
                    ".venv", "**/.venv", "**/.venv/**", "venv", "**/venv", "**/venv/**",
                    "**/node_modules/**", "**/dist/**", "**/build/**", "**/target/**",
                ],
                content_hashes=True,
                id="tribe_filesystem",
                tools=filesystem_tools,
                defer_loading=True,
            ))
        if shell_tools:
            # Shell access is granted by the reusable role profile. Do not maintain an
            # executable-name allowlist here; Tribe's hook applies approval policy to each
            # command, and Harness runs it in the selected project workspace.
            eager_tools = sorted(set(shell_tools) & set(eager_shell_tools))
            deferred_tools = sorted(set(shell_tools) - set(eager_tools))
            if eager_tools:
                capabilities.append(Shell(
                    denied_commands=[], id="tribe_shell_eager", tools=eager_tools,
                    defer_loading=False,
                ))
            if deferred_tools:
                capabilities.append(Shell(
                    denied_commands=[], id="tribe_shell", tools=deferred_tools,
                    defer_loading=True,
                ))
    capabilities.extend([
        StepPersistence(
            # Harness owns its run/checkpoint schema; keep it in a sibling database so
            # its generic `events` table cannot collide with Tribe's domain event log.
            store=step_store or SqliteStepStore(database=workspace.store.data_dir / "agent_steps.sqlite3"),
            agent_name=f"tribe:{workspace.mission_id}:{workspace.agent_id}",
            metadata={
                "mission_id": workspace.mission_id,
                "agent_id": workspace.agent_id,
                "trigger_sequence": str(trigger_sequence),
            },
            capture_frontier=True,
        ),
        Hooks(before_model_request=ContextPruning().before_model_request if context_pruning_enabled else None,
              before_tool_execute=require_action_approval,
              after_model_request=after_model_response),
        HandleDeferredToolCalls(resolve_action_approvals),
    ])

    native_skill_roots = skills.native_skill_roots
    native_skill_names = getattr(skills, "native_skill_names", frozenset())
    selected_ids = set(selected_skill_ids or [])
    list_skills = getattr(skills, "list", None)
    selected_names = {
        item["name"] for item in (list_skills() if callable(list_skills) else [])
        if item.get("id") in selected_ids
    }
    selected_native_names = native_skill_names.intersection(selected_names)
    if native_local_workspace and native_skill_roots and selected_native_names:
        try:
            roots = native_skill_roots
            common_root = Path(os.path.commonpath([str(path) for path in roots]))
        except ValueError:
            # On Windows, project and user skills may be on different drives. Tribe's
            # compatibility tools still expose them; the native loader needs one root.
            roots = []
        if roots:
            directories = [path.relative_to(common_root).as_posix() or "." for path in roots]
            capabilities.append(
                Skills(
                    directories,
                    include=selected_native_names,
                    missing_directories="skip",
                    duplicate_names="keep_first",
                    workspace=LocalWorkspaceBackend(common_root),
                )
            )

    granted_tools = set(tool_permissions or ())
    if web_access and web_access.get("enabled") is True and "duckduckgo_search" in granted_tools:
        capabilities.append(WebSearch(
            native=False, local="duckduckgo", id="tribe_web_search", defer_loading=True,
        ))
        allowed_domains = web_access.get("allowedDomains")
        if isinstance(allowed_domains, list) and allowed_domains and "web_fetch" in granted_tools:
            capabilities.append(WebFetch(
                native=False, local=True,
                allowed_domains=[domain for domain in allowed_domains if isinstance(domain, str)],
                id="tribe_web_fetch", defer_loading=True,
            ))

    if "image_generation" in granted_tools:
        capabilities.append(ImageGeneration(
            local=image_generator,
            defer_loading=True,
            description="Generate an image for a user request when a visual deliverable is useful. Uses the chat model's native image support or the configured image provider.",
        ))

    return capabilities
