"""Agent-facing capability bundles and legacy tool-grant compatibility."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Capability:
    id: str
    name: str
    description: str
    tools: tuple[str, ...]


CAPABILITIES = (
    Capability("conversation", "Conversation", "Post updates and talk with teammates.",
               ("post_update", "message_agent", "reply_to_agent")),
    Capability("planning", "Planning", "Create, inspect and revise task plans.",
               ("create_plan_items", "create_plan_item", "list_plan_items", "revise_plan_item")),
    Capability("task_coordination", "Task coordination", "Claim tasks atomically and update their progress.",
               ("update_state",)),
    Capability("chat_lifecycle", "Chat lifecycle", "Finish a chat or explain what is waiting for the user.",
               ("update_state",)),
    Capability("repository_read", "Read project files", "Browse and search project files.",
               ("read_repository_file", "search_repository", "read_file", "list_directory",
                "search_files", "find_files", "file_info")),
    Capability("repository_write", "Change project files", "Edit files and request isolated or destructive changes.",
               ("write_repository_file", "start_isolated_work", "request_isolated_integration",
                "integrate_isolated_changes", "request_file_deletion_approval", "delete_repository_file",
                "write_file", "edit_file", "create_directory")),
    Capability("commands", "Run project commands", "Run tests and manage project commands.",
               ("run_repository_tests", "run_command", "start_command", "check_command", "stop_command")),
    Capability("workflows", "Workflows", "Find and follow optional process guidance.",
               ("list_workflows", "get_workflow", "activate_workflow",
                "get_workflow_state", "update_workflow_state")),
    Capability("skills", "Skills", "Discover and load reusable task guidance.",
               ("search_available_skills", "load_skill", "list_skill_resources", "read_skill_resource")),
    Capability("memory", "Durable memory", "Recall and propose project knowledge.",
               ("search_project_memory", "read_project_memory", "propose_project_memory")),
    Capability("artifacts", "Artifacts and shared documents", "Create, inspect and discuss outputs and documents.",
               ("list_artifacts", "get_artifact", "create_artifact", "comment_on_artifact")),
    Capability("computer_observation", "Computer observation", "Observe the explicitly selected computer surface.",
               ("computer_observe",)),
    Capability("web", "Web research", "Search the web and fetch permitted pages.",
               ("duckduckgo_search", "web_fetch")),
    Capability("connected_services", "Connected services", "Use tools from configured MCP services.", ("mcp:*",)),
)

CAPABILITY_BY_ID = {capability.id: capability for capability in CAPABILITIES}
WORKFLOW_OPERATION_NAMES = frozenset({
    "list_workflows", "search_workflows", "get_workflow", "activate_workflow",
    "get_workflow_state", "update_workflow_state",
})
LEGACY_CAPABILITY_GRANTS = {
    "list_available_workflows": "workflows",
    "select_workflow": "workflows",
    "set_workflow_stage": "workflows",
    "claim_work": "task_coordination",
    "release_work_claim": "task_coordination",
    "complete_work": "task_coordination",
    "complete_mission": "chat_lifecycle",
    "mark_mission_blocked": "chat_lifecycle",
    "create_interactive_artifact": "artifacts",
    "list_mission_artifacts": "artifacts",
    "read_mission_artifact": "artifacts",
    "read_artifact_reviews": "artifacts",
    "list_canvas_documents": "artifacts",
    "read_canvas_document": "artifacts",
    "read_canvas_version": "artifacts",
}
_TOOL_CAPABILITY_INDEX: dict[str, list[str]] = {}
for capability in CAPABILITIES:
    for tool in capability.tools:
        if tool != "mcp:*":
            _TOOL_CAPABILITY_INDEX.setdefault(tool, []).append(capability.id)
TOOL_TO_CAPABILITIES = {
    tool: tuple(capability_ids) for tool, capability_ids in _TOOL_CAPABILITY_INDEX.items()
}
TOOL_NAMES = frozenset(TOOL_TO_CAPABILITIES) | {"mcp:*"}


def capability_catalog(extra_capabilities: tuple[str, ...] | list[str] = ()) -> list[dict[str, str]]:
    """Return concise, stable metadata for profile editors."""
    catalog = [{"id": item.id, "name": item.name, "description": item.description}
               for item in CAPABILITIES]
    existing = {item["id"] for item in catalog}
    for capability in extra_capabilities:
        if capability.startswith("mcp-service:") and capability not in existing:
            server = capability.removeprefix("mcp-service:")
            catalog.append({"id": capability, "name": f"{server} service",
                            "description": f"Use the tools from the configured {server} service."})
    return catalog


def capabilities_for_grants(grants: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """Translate legacy per-tool grants to the capability bundles that contain them."""
    result = []
    for grant in grants:
        capability = grant.removeprefix("capability:")
        if capability in CAPABILITY_BY_ID:
            result.append(capability)
        elif capability.startswith("mcp-service:"):
            result.append(capability)
        elif grant == "mcp:*":
            result.append("connected_services")
        elif grant in LEGACY_CAPABILITY_GRANTS:
            result.append(LEGACY_CAPABILITY_GRANTS[grant])
        elif grant.startswith("mcp:"):
            server, separator, _tool = grant[4:].partition(".")
            if separator and server:
                result.append(f"mcp-service:{server}")
        elif grant in TOOL_TO_CAPABILITIES:
            # A direct grant to this shared operation cannot express which actions
            # are intended, so require the corresponding named capability instead.
            if grant != "update_state":
                result.extend(TOOL_TO_CAPABILITIES[grant])
    return tuple(dict.fromkeys(result))


def tools_for_capabilities(capabilities: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """Expand profile capabilities to runtime tool grants."""
    selected = set(capabilities)
    tools = [
        tool for capability in CAPABILITIES if capability.id in selected for tool in capability.tools
    ]
    if "workflows" in selected:
        tools.append("workflow:*")
    tools.extend(
        f"mcp:{capability.removeprefix('mcp-service:')}.*"
        for capability in selected if capability.startswith("mcp-service:")
    )
    return tuple(dict.fromkeys(tools))
