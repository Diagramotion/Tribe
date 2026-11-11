"""Agent discovery and self-claim worker contracts."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from .credentials import provider_for_model
from .capabilities import (
    CAPABILITY_BY_ID, LEGACY_CAPABILITY_GRANTS, TOOL_NAMES,
    capabilities_for_grants, tools_for_capabilities,
)
from .store import MissionStore


TOOL_PERMISSION_NAMES = (
    (TOOL_NAMES - {"update_state"}) | frozenset(f"capability:{name}" for name in CAPABILITY_BY_ID)
    | frozenset(LEGACY_CAPABILITY_GRANTS)
)
RETIRED_TOOL_GRANTS = frozenset({"complete_discovery", "finalize_plan", "record_review_checkpoint"})


@dataclass(frozen=True, init=False)
class AgentDefinition:
    id: str
    name: str
    role: str
    instructions: str
    source: str
    model: str = ""
    repository_access: str = "workspace_write"
    effort: str = ""
    capabilities: tuple[str, ...] = ()

    def __init__(self, id: str, name: str, role: str, instructions: str, source: str,
                 model: str = "", repository_access: str = "workspace_write",
                 effort: str = "", capabilities: tuple[str, ...] = (), *,
                 tool_permissions: tuple[str, ...] | None = None):
        # Read legacy profile integrations during migration; persist and expose only bundles.
        grants = tuple(capabilities) + tuple(tool_permissions or ())
        object.__setattr__(self, "id", id)
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "role", role)
        object.__setattr__(self, "instructions", instructions)
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "model", model)
        object.__setattr__(self, "repository_access", repository_access)
        object.__setattr__(self, "effort", effort)
        object.__setattr__(self, "capabilities", grants)
        self.__post_init__()

    @property
    def tool_permissions(self) -> tuple[str, ...]:
        """Resolved grants retained for runtime integrations and legacy API clients."""
        return tools_for_capabilities(self.capabilities)

    def __post_init__(self) -> None:
        if self.repository_access not in {"read_only", "workspace_write"}:
            raise ValueError("repository_access must be read_only or workspace_write")
        object.__setattr__(self, "capabilities", capabilities_for_grants(self.capabilities))


@dataclass(frozen=True)
class AgentRunResult:
    text: str
    work_item_id: str | None = None
    usage: dict[str, int | str | None] | None = None
    model: str | None = None
    interactive_artifact_ids: tuple[str, ...] = ()
    image_artifact_ids: tuple[str, ...] = ()


def discover_agents(directory: Path) -> list[AgentDefinition]:
    """Load Markdown role definitions, failing clearly on an invalid registry entry."""
    agents = []
    identifiers: set[str] = set()
    for candidate in sorted(directory.glob("*.md")):
        path = _contained_agent_path(directory, candidate.name)
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as error:
            raise ValueError(f"{path}: could not read agent definition: {error}") from error
        if not lines or lines[0].strip() != "---":
            raise ValueError(f"{path}: agent definition must start with YAML front matter")
        try:
            closing = next(
                index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"
            )
        except StopIteration as error:
            raise ValueError(f"{path}: YAML front matter is not closed") from error
        fields = {}
        for line in lines[1:closing]:
            if not line.strip():
                continue
            key, separator, value = line.partition(":")
            if not separator or not key.strip():
                raise ValueError(f"{path}: malformed front matter field {line!r}")
            key = key.strip()
            if key in fields:
                raise ValueError(f"{path}: duplicate front matter field {key!r}")
            scalar = value.strip()
            if scalar.startswith("["):
                try:
                    scalar = json.loads(scalar)
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path}: invalid JSON list for {key!r}") from error
                if not isinstance(scalar, list) or any(not isinstance(value, str) for value in scalar):
                    raise ValueError(f"{path}: {key!r} must be a list of strings")
            elif scalar.startswith('"'):
                try:
                    scalar = json.loads(scalar)
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path}: invalid quoted value for {key!r}") from error
                if not isinstance(scalar, str):
                    raise ValueError(f"{path}: {key!r} must be a string")
            else:
                scalar = scalar.strip("'")
            fields[key] = scalar
        missing = [key for key in ("id", "name", "role") if not fields.get(key)]
        if missing:
            missing_fields = ", ".join(missing)
            raise ValueError(f"{path}: missing required front matter field(s): {missing_fields}")
        identifier = fields["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", identifier):
            raise ValueError(
                f"{path}: id must start with a lowercase letter and contain only lowercase letters, "
                "numbers, _ or -"
            )
        if identifier in identifiers:
            raise ValueError(f"{path}: duplicate agent id {identifier!r}")
        instructions = "\n".join(lines[closing + 1:]).strip()
        if not instructions:
            raise ValueError(f"{path}: agent instructions must not be empty")
        model = fields.get("model", "").strip()
        if model:
            _, separator, model_name = model.partition(":")
            try:
                provider_for_model(model)
            except ValueError as error:
                raise ValueError(f"{path}: {error}") from error
            if not separator or not model_name.strip() or len(model) > 200:
                raise ValueError(f"{path}: model must be a provider:model identifier up to 200 characters")
        effort = fields.get("effort", "").strip().lower()
        if effort and effort not in {"minimal", "low", "medium", "high", "xhigh", "max"}:
            raise ValueError(f"{path}: effort must be minimal, low, medium, high, xhigh or max")
        repository_access = fields.get("repository_access", "workspace_write").strip()
        if repository_access not in {"read_only", "workspace_write"}:
            raise ValueError(f"{path}: repository_access must be read_only or workspace_write")
        capabilities = fields.get("capabilities")
        if capabilities is None:
            capabilities = fields.get("tool_permissions", [])
        if capabilities is not None:
            unknown_tools = {
                tool for tool in capabilities
                if tool not in TOOL_PERMISSION_NAMES and tool not in CAPABILITY_BY_ID
                and tool not in RETIRED_TOOL_GRANTS and not re.fullmatch(
                    r"(?:mcp:[a-z0-9_-]+\.[a-zA-Z0-9_.-]+|mcp-service:[a-z0-9_-]+)", tool,
                )
            }
            if unknown_tools:
                raise ValueError(f"{path}: unknown capability or legacy tool grant(s): {', '.join(sorted(unknown_tools))}")
            capabilities = capabilities_for_grants(tuple(capabilities))
        identifiers.add(identifier)
        agents.append(
            AgentDefinition(identifier, fields["name"], fields["role"], instructions, path.name,
                            model, repository_access, effort, capabilities)
        )
    return agents


def load_agent_definitions(*directories: Path) -> list[AgentDefinition]:
    """Merge role libraries while rejecting ambiguous IDs across sources."""
    agents: list[AgentDefinition] = []
    identifiers: set[str] = set()
    for source_index, directory in enumerate(directories):
        for agent in discover_agents(directory):
            if agent.id in identifiers:
                source_path = directory / f"{agent.id}.md"
                raise ValueError(f"{source_path}: duplicate agent id {agent.id!r}")
            identifiers.add(agent.id)
            agents.append(replace(agent, source="user") if source_index else agent)
    return agents


def _render_agent_definition(agent_id: str, name: str, role: str,
                             instructions: str, model: str = "",
                             repository_access: str = "workspace_write",
                             effort: str = "",
                             tool_permissions: list[str] | tuple[str, ...] | None = None
                             ) -> tuple[str, str, str, str, str, str, str, tuple[str, ...] | None]:
    values = {"id": agent_id.strip(), "name": name.strip(), "role": role.strip()}
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", values["id"]):
        raise ValueError(
            "id must start with a lowercase letter and contain only lowercase letters, numbers, _ or -"
        )
    if any(not values[key] for key in ("name", "role")):
        raise ValueError("name and role are required")
    if any(len(values[key]) > 200 for key in ("name", "role")):
        raise ValueError("name and role must be no longer than 200 characters")
    if any("\n" in values[key] or "\r" in values[key] for key in ("name", "role")):
        raise ValueError("name and role must each be one line")
    instructions = instructions.strip()
    if not instructions or len(instructions) > 20_000:
        raise ValueError("instructions must be 1 to 20000 characters")
    model = model.strip()
    if model:
        _, separator, model_name = model.partition(":")
        provider_for_model(model)
        if not separator or not model_name.strip() or len(model) > 200:
            raise ValueError("model must be a provider:model identifier up to 200 characters")
    repository_access = repository_access.strip()
    if repository_access not in {"read_only", "workspace_write"}:
        raise ValueError("repository_access must be read_only or workspace_write")
    effort = effort.strip().lower()
    if effort and effort not in {"minimal", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError("effort must be minimal, low, medium, high, xhigh or max")
    if tool_permissions is None:
        tool_permissions = ()
    if not isinstance(tool_permissions, (list, tuple)) or any(
        not isinstance(item, str) for item in tool_permissions
    ):
        raise ValueError("tool_permissions must be a list of tool names")
    unknown_tools = {
        tool for tool in tool_permissions
        if tool not in TOOL_PERMISSION_NAMES and tool not in CAPABILITY_BY_ID
        and tool not in RETIRED_TOOL_GRANTS and not re.fullmatch(
            r"(?:mcp:[a-z0-9_-]+\.[a-zA-Z0-9_.-]+|mcp-service:[a-z0-9_-]+)", tool,
        )
    }
    if unknown_tools:
        raise ValueError(f"unknown capability or legacy tool grant(s): {', '.join(sorted(unknown_tools))}")
    capabilities = capabilities_for_grants(tuple(tool_permissions))
    content = (
        "---\n"
        f"id: {values['id']}\n"
        f"name: {json.dumps(values['name'], ensure_ascii=False)}\n"
        f"role: {json.dumps(values['role'], ensure_ascii=False)}\n"
        f"repository_access: {repository_access}\n"
    )
    if model:
        content += f"model: {json.dumps(model, ensure_ascii=False)}\n"
    if effort:
        content += f"effort: {effort}\n"
    if capabilities is not None:
        content += f"capabilities: {json.dumps(list(capabilities), ensure_ascii=False)}\n"
    content += f"---\n\n{instructions}\n"
    return (values["id"], values["name"], values["role"], model, repository_access,
            effort, content, capabilities)


def _contained_agent_path(directory: Path, name: str) -> Path:
    """Resolve an agent file and reject paths or symlinks escaping its library."""
    root = directory.resolve()
    candidate = (root / name).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("agent_definition_path_invalid")
    return candidate


def write_agent_definition(directory: Path, agent_id: str, name: str, role: str,
                           instructions: str, model: str = "",
                           repository_access: str = "workspace_write",
                           effort: str = "",
                           tool_permissions: list[str] | tuple[str, ...] | None = None) -> AgentDefinition:
    """Persist one user-owned role as a Markdown file without overwriting existing roles."""
    identifier, name, role, model, repository_access, effort, content, capabilities = _render_agent_definition(
        agent_id, name, role, instructions, model, repository_access, effort, tool_permissions
    )
    directory.mkdir(parents=True, exist_ok=True)
    path = _contained_agent_path(directory, f"{identifier}.md")
    try:
        with path.open("x", encoding="utf-8", newline="\n") as definition_file:
            definition_file.write(content)
    except FileExistsError as error:
        raise ValueError(f"agent id {identifier!r} already exists in the user library") from error
    try:
        definition = next(agent for agent in discover_agents(directory) if agent.id == identifier)
        return replace(definition, source="user")
    except Exception:
        path.unlink(missing_ok=True)
        raise


def update_agent_definition(directory: Path, agent_id: str, name: str, role: str,
                            instructions: str, model: str = "",
                            repository_access: str = "workspace_write",
                            effort: str = "",
                            tool_permissions: list[str] | tuple[str, ...] | None = None) -> AgentDefinition:
    """Atomically replace the Markdown file for an existing user-owned role."""
    identifier, name, role, model, repository_access, effort, content, capabilities = _render_agent_definition(
        agent_id, name, role, instructions, model, repository_access, effort, tool_permissions
    )
    if identifier != agent_id:
        raise ValueError("agent id cannot be changed")
    path = _contained_agent_path(directory, f"{identifier}.md")
    if not path.is_file():
        raise ValueError("user_agent_not_found")
    temporary = _contained_agent_path(directory, f".agent-{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as definition_file:
            definition_file.write(content)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return AgentDefinition(identifier, name, role, instructions.strip(), "user", model, repository_access,
                           effort, capabilities)


def archive_agent_definition(directory: Path, agent_id: str) -> Path:
    """Move a user role out of the active library without destroying its Markdown source."""
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", agent_id):
        raise ValueError("invalid_agent_id")
    source = _contained_agent_path(directory, f"{agent_id}.md")
    if not source.is_file():
        raise ValueError("user_agent_not_found")
    archive_directory = _contained_agent_path(directory, "archive")
    archive_directory.mkdir(parents=True, exist_ok=True)
    destination = _contained_agent_path(
        archive_directory, f"{agent_id}-{uuid.uuid4().hex[:8]}.md",
    )
    source.replace(destination)
    return destination


class AgentProvider(Protocol):
    """LLM adapter boundary; providers receive one durable event and bounded context."""

    async def run(self, store: MissionStore, mission_id: str, event: dict) -> str | AgentRunResult: ...


class SelfClaimingAgent:
    """Claims work atomically; a provider adapter can be supplied without changing the store."""

    def __init__(self, definition: AgentDefinition, store: MissionStore):
        self.definition = definition
        self.store = store

    def claim_next(self, mission_id: str, work_item_id: str | None = None) -> dict | None:
        return self.store.claim_work(
            mission_id, self.definition.id, work_item_id=work_item_id,
        )
