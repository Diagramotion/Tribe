"""Pydantic AI Harness capabilities composed for one Tribe agent run."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from .browser_sessions import BROWSER_ACTION_TOOLS
from .mcp_registry import MCPRegistry
from .skills import SkillCatalog
from .transient_media import sanitized_browser_messages
from .workspace import WorkspaceTools

if TYPE_CHECKING:
    from pydantic_ai_harness.step_persistence import StepStore


_HARNESS_LOCAL_WORKSPACE_TOOLS = frozenset({
    "read_file", "write_file", "edit_file", "list_directory", "search_files", "find_files",
    "list_files", "grep", "create_directory", "file_info", "run_command", "start_command",
    "check_command", "stop_command", "shell",
})


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
    return max(1_000, int(context_window * 0.2)) if context_window else 32_000


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
    approval_mode: str | None = None,
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
        from pydantic_ai_harness.compaction import SummarizingCompaction
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
    if approval_mode not in {"standard", "review_changes", "confirm_every_call"}:
        approval_mode = "standard"

    change_tools = {
        "write_file", "edit_file", "create_directory", "write_repository_file",
        "run_command", "start_command", "run_repository_tests",
    }
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
            return command if isinstance(command, str) else ""
        return ""

    def command_needs_approval(command: str) -> bool:
        if not command.strip():
            return False
        try:
            parts = shlex.split(command, posix=os.name != "nt")
        except ValueError:
            return True
        if not parts:
            return False
        executable = Path(parts[0].replace("\\", "/")).name.casefold()
        arguments = [part.casefold() for part in parts[1:]]
        if executable == "gh":
            read_only_operations = {
                ("auth", "status"), ("repo", "view"),
                ("pr", "view"), ("pr", "list"), ("pr", "status"), ("pr", "checks"),
                ("issue", "view"), ("issue", "list"), ("issue", "status"),
                ("run", "view"), ("run", "list"),
                ("release", "view"), ("release", "list"),
                ("workflow", "view"), ("workflow", "list"),
                ("search", "repos"), ("search", "issues"),
            }
            if tuple(arguments[:2]) in read_only_operations:
                return False
        risky_executables = {
            "rm", "rmdir", "del", "erase", "remove-item", "format", "mkfs", "dd",
            "shutdown", "reboot", "curl", "wget", "ssh", "scp", "sftp", "ftp",
            "rsync", "npx", "uvx", "gh", "aws", "az", "gcloud", "terraform", "jupyter",
        }
        if "nbconvert" in arguments or "jupyter" in arguments:
            return True
        if executable in risky_executables:
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
        return bool(re.search(r"(?:&&|\|\||[;|<>`]|\$\()", command))

    def safe_command(command: str) -> str:
        return re.sub(
            r"(?i)(api[_-]?key|token|password|secret)(\s*[=:]\s*)([^\s]+)",
            r"\1\2[redacted]", command,
        )[:2000]

    def redact_mcp_arguments(value: object) -> object:
        if isinstance(value, dict):
            return {
                key: "[redacted]" if re.search(r"(?i)(key|token|secret|password|auth)", str(key))
                else redact_mcp_arguments(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [redact_mcp_arguments(item) for item in value]
        return value

    def redact_approval_arguments(tool_name: str, value: object) -> object:
        redacted = redact_mcp_arguments(value)
        action = mcp_action(tool_name)
        if action != ("browser", tool_name.removeprefix("browser_")) or not isinstance(value, dict):
            return redacted
        try:
            host = urlsplit(value.get("url", "")).hostname if isinstance(value.get("url"), str) else None
        except ValueError:
            host = None
        return {
            key: (host or "[website host omitted]" if key == "url" and isinstance(item, str)
                  else f"[text omitted · {len(item)} characters]"
                  if key in {"value", "text", "selector", "name"} and isinstance(item, str)
                  else item)
            for key, item in redacted.items()
        }

    async def require_action_approval(ctx, *, call, tool_def, args):
        _assert_harness_workspace_is_current(tool_def.name, root, workspace.root)
        if tool_def.name in {"run_command", "start_command"}:
            workspace._require_work_claim()
        mcp_tool = mcp_action(tool_def.name)
        is_web_action = tool_def.name in web_action_names
        if call.tool_call_id in approved_calls:
            return args
        if approval_mode == "confirm_every_call" and tool_def.name not in exact_approval_tools:
            raise ApprovalRequired({"reason": "This project asks for approval before every agent tool call."})
        if approval_mode == "review_changes" and tool_def.name in change_tools:
            raise ApprovalRequired({"reason": "This project asks for approval before file changes and command runs."})
        if tool_def.name not in {"run_command", "start_command"} and mcp_tool is None and not is_web_action:
            return args
        if is_web_action and project_id and workspace.store.has_access_grant(
            workspace.mission_id, project_id, "public_web_read",
        ):
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
        if command_needs_approval(command):
            raise ApprovalRequired({"reason": "The command may access external services or make destructive changes."})
        return args

    async def resolve_action_approvals(ctx, requests):
        from pydantic_ai.messages import ModelMessagesTypeAdapter

        decisions = {}
        for call in requests.approvals:
            args = call.args
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            mcp_tool = mcp_action(call.tool_name)
            command = command_text(args)
            if approval_mode == "confirm_every_call" and call.tool_name not in exact_approval_tools:
                title = "Confirm agent action"
                summary = (getattr(ctx.deps, "tool_call_summaries", None) or {}).get(
                    call.tool_call_id, {}
                ).get("summary")
                target = summary or "Agent tool call"
                if mcp_tool == ("browser", call.tool_name.removeprefix("browser_")):
                    target = "Browser session"
                safe_args = redact_approval_arguments(call.tool_name, args)
                details = (
                    "This project asks you to approve every agent tool call before it runs.\n\n"
                    f"Requested action: {call.tool_name}\n"
                    f"Arguments:\n{json.dumps(safe_args, indent=2, ensure_ascii=False)[:6000]}\n\n"
                    "Approval applies once to this exact call."
                )
            elif call.tool_name in change_tools and approval_mode == "review_changes":
                command_tools = {"run_command", "start_command", "run_repository_tests"}
                is_command = call.tool_name in command_tools
                title = "Approve command" if is_command else "Review project change"
                summary = (getattr(ctx.deps, "tool_call_summaries", None) or {}).get(
                    call.tool_call_id, {}
                ).get("summary")
                target = summary or (f"Run command in {root}" if is_command else "Project files")
                safe_args = redact_mcp_arguments(args)
                details = (
                    "The project approval mode requires confirmation before this change.\n\n"
                    f"Requested action: {call.tool_name}\n"
                    f"Arguments:\n{json.dumps(safe_args, indent=2, ensure_ascii=False)[:6000]}\n\n"
                    "Approval applies once to this exact call."
                )
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
                    "Approval applies once to this exact tool call."
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
                title = "Run a command outside the safe set"
                target = f"Run command in {root}"
                details = (
                    f"Exact command:\n{safe_command(command)}\n\n"
                    "This command may access external services or make destructive changes. "
                    "Approval applies once to this exact tool call."
                )
            interaction = workspace.store.create_deferred_tool_interaction(
                mission_id=workspace.mission_id, requested_by=workspace.agent_id,
                title=title,
                details=details,
                target=target, trigger_sequence=trigger_sequence,
                run_id=ctx.run_id, conversation_id=ctx.conversation_id or "",
                tool_call_id=call.tool_call_id, tool_name=call.tool_name,
                tool_arguments=({key: ("[redacted]" if key in {"url", "value", "text", "selector", "name"}
                                       else value) for key, value in args.items()}
                                if mcp_tool and mcp_tool[0] == "browser" and isinstance(args, dict)
                                else args if isinstance(args, dict) else {}),
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
    keep_tokens = _compaction_keep_tokens(context_window)
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
        fallback_context_window=200_000,
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
    if repository_access != "read_only" and native_local_workspace:
        granted_tools = set(tool_permissions or ())
        filesystem_names = {
            "read_file", "write_file", "edit_file", "list_directory", "search_files",
            "find_files", "create_directory", "file_info",
        }
        shell_names = {"run_command", "start_command", "check_command", "stop_command"}
        filesystem_tools = sorted(filesystem_names & granted_tools)
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
            capabilities.append(Shell(
                denied_commands=[],
                id="tribe_shell", tools=shell_tools, defer_loading=True,
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
