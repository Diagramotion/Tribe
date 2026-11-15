"""Workspace MCP configuration composed through Pydantic AI's MCP client."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from .capabilities import WORKFLOW_OPERATION_NAMES
from urllib.parse import urlparse, urlunsplit

from .network_policy import is_loopback_hostname
from .store import MissionStore

_SERVER_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_ENV_REFERENCE = re.compile(r"^\$\{[A-Z_][A-Z0-9_]*\}$")
_ENV_REFERENCE_MATCH = re.compile(r"^\$\{([A-Z_][A-Z0-9_]*)\}$")
_KEYRING_SERVICE = "Tribe MCP server"
PLAYWRIGHT_MCP_VERSION = "0.0.83"
# Keep in sync with the `playwright` dependency declared by this pinned MCP release.
PLAYWRIGHT_CLI_VERSION = "1.64.0-alpha-1790635538000"
MCP_SERVER_INIT_TIMEOUT = 60
MCP_DISCOVERY_TIMEOUT = 90
PLAYWRIGHT_READ_ONLY_TOOLS = (
    "browser_console_messages",
    "browser_find",
    "browser_snapshot",
    "browser_take_screenshot",
)


def _mcp_tool_allowed(tool_definition: Any) -> bool:
    """Exclude Playwright's RCE-equivalent arbitrary-code tool from agent toolsets."""
    return not tool_definition.name.endswith("_browser_run_code_unsafe")


MCP_TOOL_RESULT_LIMIT = 6_000
_MCP_TRUNCATION_MARKER = {
    "_tribe_truncated": "Result shortened; request a narrower result for more detail.",
}


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


def _bounded_json_value(value: Any, limit: int) -> Any:
    """Keep JSON-shaped results valid while retaining complete fields and list items."""
    if _json_size(value) <= limit:
        return value
    if limit < 24:
        return None
    if isinstance(value, str):
        suffix = "… truncated"
        low, high = 0, len(value)
        best = suffix
        while low <= high:
            middle = (low + high) // 2
            candidate = value[:middle] + suffix
            if _json_size(candidate) <= limit:
                best = candidate
                low = middle + 1
            else:
                high = middle - 1
        return best

    marker = _MCP_TRUNCATION_MARKER
    marker_size = _json_size(marker)
    if isinstance(value, list):
        result: list[Any] = []
        truncated = False
        for item in value:
            separator_size = 1 if result else 0
            remaining = limit - _json_size(result) - separator_size - marker_size - 1
            if remaining < 24:
                truncated = True
                break
            bounded = _bounded_json_value(item, remaining)
            if _json_size([*result, bounded, marker]) > limit:
                truncated = True
                break
            result.append(bounded)
            if bounded != item:
                truncated = True
                break
        if truncated and _json_size([*result, marker]) <= limit:
            result.append(marker)
        return result

    if isinstance(value, dict):
        result: dict[str, Any] = {}
        truncated = False
        for key, item in value.items():
            key_text = str(key)
            if key_text == "_tribe_truncated":
                truncated = True
                continue
            base_size = _json_size(result)
            key_size = _json_size(key_text)
            separator_size = 1 if result else 0
            remaining = limit - base_size - key_size - separator_size - 2 - marker_size - 1
            if remaining < 24:
                truncated = True
                break
            bounded = _bounded_json_value(item, remaining)
            candidate = {**result, key_text: bounded}
            if _json_size({**candidate, **marker}) > limit:
                truncated = True
                break
            result[key_text] = bounded
            if bounded != item:
                truncated = True
                break
        if truncated and _json_size({**result, **marker}) <= limit:
            result.update(marker)
        return result
    return None


def bound_mcp_tool_result(value: Any, *, limit: int = MCP_TOOL_RESULT_LIMIT) -> Any:
    """Keep a large connected-service response from exhausting the model context."""
    if not isinstance(value, (str, dict, list)):
        return value
    if _json_size(value) <= limit:
        return value
    bounded = _bounded_json_value(value, limit)
    if _json_size(bounded) <= limit:
        return bounded
    return _MCP_TRUNCATION_MARKER if _json_size(_MCP_TRUNCATION_MARKER) <= limit else None


def bounded_mcp_toolset(toolset: Any) -> Any:
    """Wrap an MCP toolset with a response-size limit while preserving its tool catalogue."""
    from pydantic_ai.toolsets.wrapper import WrapperToolset

    class BoundedResultToolset(WrapperToolset):
        async def call_tool(self, name: str, tool_args: dict[str, Any], ctx: Any, tool: Any) -> Any:
            result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
            return bound_mcp_tool_result(result)

    return BoundedResultToolset(wrapped=toolset)


def _load_mcp_toolsets(config: dict[str, Any]) -> list[object]:
    """Build Pydantic AI MCP toolsets with enough time for real servers to start."""
    from fastmcp.client.transports import StdioTransport
    from pydantic_ai.mcp import MCPToolset

    toolsets = []
    for name, server in config["mcpServers"].items():
        if "command" in server:
            transport = StdioTransport(
                command=server["command"],
                args=server.get("args", []),
                env=server.get("env"),
                cwd=server.get("cwd"),
            )
            toolset = MCPToolset(transport, id=name, init_timeout=MCP_SERVER_INIT_TIMEOUT)
        else:
            toolset = MCPToolset(
                server["url"], id=name, headers=server.get("headers"),
                init_timeout=MCP_SERVER_INIT_TIMEOUT,
            )
        toolsets.append(toolset.prefixed(name))
    return toolsets


class MCPRegistry:
    """Validates workspace MCP definitions and delegates protocol handling to Pydantic AI."""

    def __init__(self, store: MissionStore):
        self.store = store
        self.root = store.data_dir / "mcp"
        self.root.mkdir(parents=True, exist_ok=True)
        self.workspace_config_path = self.root / "workspace.json"
        self.origins_path = self.root / "legacy-origins.json"
        self.aliases_path = self.root / "legacy-server-names.json"

    def _migrate_legacy_configs(self) -> None:
        """Import old project definitions while retaining each project's prior access."""
        if self.workspace_config_path.exists():
            return
        servers: dict[str, Any] = {}
        origins: dict[str, str] = {}
        aliases: dict[str, str] = {}
        legacy_configs: dict[str, dict[str, Any]] = {}
        imported_names: dict[str, set[str]] = {}
        for project in self.store.bootstrap().get("projects", []):
            project_id = project["id"]
            path = self.root / f"{project_id}.json"
            if not path.exists():
                continue
            try:
                legacy = self.validate(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError, ValueError):
                continue
            legacy_configs[project_id] = legacy
            for name, definition in legacy["mcpServers"].items():
                target = name
                if target in servers:
                    target = f"{name[:55]}_{project_id.replace('-', '')[:8]}"
                if target not in servers:
                    servers[target] = definition
                    origins[target] = project_id
                    aliases[target] = name
                imported_names.setdefault(project_id, set()).add(target)
        checked = self.validate({"mcpServers": servers})
        self._write_json(self.workspace_config_path, checked)
        self._write_json(self.origins_path, origins)
        self._write_json(self.aliases_path, aliases)
        for project in self.store.bootstrap().get("projects", []):
            project_id = project["id"]
            allowed = imported_names.get(project_id, set())
            self.save_exclusions(project_id, set(servers) - allowed)

    @staticmethod
    def _write_json(path: Path, value: Any) -> None:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)

    def workspace_config(self) -> dict[str, Any]:
        self._migrate_legacy_configs()
        try:
            return self.validate(json.loads(self.workspace_config_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"MCP configuration could not be read: {error}") from error

    def save_workspace_config(self, config: Any) -> dict[str, Any]:
        checked = self.validate(config)
        self._migrate_legacy_configs()
        self._write_json(self.workspace_config_path, checked)
        return checked

    def exclusions_path(self, project_id: str) -> Path:
        if not self.store.bootstrap(project_id)["project"]:
            raise ValueError("project_not_found")
        return self.root / f"{project_id}.excluded.json"

    def get_exclusions(self, project_id: str) -> list[str]:
        self._migrate_legacy_configs()
        path = self.exclusions_path(project_id)
        try:
            values = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Project MCP exclusions could not be read: {error}") from error
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError("Project MCP exclusions are invalid")
        configured = set(self.workspace_config()["mcpServers"])
        return sorted(set(values) & configured)

    def save_exclusions(self, project_id: str, excluded: set[str] | list[str]) -> list[str]:
        path = self.exclusions_path(project_id)
        configured = set(self.workspace_config()["mcpServers"])
        values = set(excluded)
        if values - configured:
            raise ValueError("Project exclusions must refer to configured workspace MCP servers")
        self._write_json(path, sorted(values))
        return sorted(values)

    def config_path(self, project_id: str) -> Path:
        return self.workspace_config_path

    def get_config(self, project_id: str) -> dict[str, Any]:
        if not self.store.bootstrap(project_id)["project"]:
            raise ValueError("project_not_found")
        config = self.workspace_config()
        excluded = set(self.get_exclusions(project_id))
        config["mcpServers"] = {name: definition for name, definition in config["mcpServers"].items()
                                if name not in excluded}
        return config

    @staticmethod
    def validate(config: Any) -> dict[str, Any]:
        if not isinstance(config, dict) or set(config) != {"mcpServers"}:
            raise ValueError("configuration must contain only an mcpServers object")
        servers = config["mcpServers"]
        if not isinstance(servers, dict) or len(servers) > 50:
            raise ValueError("mcpServers must be an object with at most 50 entries")
        for name, definition in servers.items():
            if not isinstance(name, str) or not _SERVER_NAME.fullmatch(name):
                raise ValueError(f"invalid MCP server name: {name!r}")
            if not isinstance(definition, dict):
                raise ValueError(f"configuration for {name!r} must be an object")  # noqa: TRY004 - API validation uses ValueError
            is_stdio = isinstance(definition.get("command"), str) and bool(definition["command"].strip())
            is_http = isinstance(definition.get("url"), str) and bool(definition["url"].strip())
            if is_stdio == is_http:
                raise ValueError(f"{name!r} must define exactly one of command or url")
            allowed_keys = (
                {"command", "args", "env", "cwd", "oauth", "readOnlyTools", "disabledTools", "disabled"}
                if is_stdio else {"url", "headers", "oauth", "readOnlyTools", "disabledTools", "disabled"}
            )
            unknown = set(definition) - allowed_keys
            if unknown:
                raise ValueError(f"unsupported fields for {name!r}: {', '.join(sorted(unknown))}")
            args = definition.get("args", [])
            if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
                raise ValueError(f"args for {name!r} must be a list of strings")
            env = definition.get("env", {})
            if not isinstance(env, dict) or any(
                not isinstance(key, str) or not isinstance(value, str)
                or not _ENV_REFERENCE.fullmatch(value)
                for key, value in env.items()
            ):
                raise ValueError(f"env values for {name!r} must reference environment variables")
            headers = definition.get("headers", {})
            if not isinstance(headers, dict) or any(
                not isinstance(key, str) or not isinstance(value, str)
                or not _ENV_REFERENCE.fullmatch(value)
                for key, value in headers.items()
            ):
                raise ValueError(f"header values for {name!r} must reference environment variables")
            oauth = definition.get("oauth")
            if oauth is not None:
                if is_stdio or not isinstance(oauth, dict) or set(oauth) - {"scopes"}:
                    raise ValueError(f"OAuth for {name!r} is supported only for remote services with optional scopes")
                scopes = oauth.get("scopes", [])
                if (not isinstance(scopes, list) or len(scopes) > 50
                        or any(not isinstance(scope, str) or not scope.strip() or len(scope) > 200 for scope in scopes)
                        or len(scopes) != len(set(scopes))):
                    raise ValueError(f"OAuth scopes for {name!r} must be a unique list of non-empty strings")
                if headers:
                    raise ValueError(f"OAuth and header-token authentication cannot both be set for {name!r}")
            if is_http:
                parsed = urlparse(definition["url"])
                if (not parsed.hostname or parsed.username or parsed.password
                        or parsed.scheme not in {"http", "https"}
                        or (parsed.scheme == "http" and not is_loopback_hostname(parsed.hostname))):
                    raise ValueError(f"MCP URLs must use HTTPS or loopback HTTP without embedded credentials ({name!r})")
            read_only_tools = definition.get("readOnlyTools", [])
            if not isinstance(read_only_tools, list) or any(
                not isinstance(tool, str) or not tool.strip() for tool in read_only_tools
            ):
                raise ValueError(f"readOnlyTools for {name!r} must be a list of tool names")
            disabled_tools = definition.get("disabledTools", [])
            if not isinstance(disabled_tools, list) or any(
                not isinstance(tool, str) or not tool.strip() for tool in disabled_tools
            ):
                raise ValueError(f"disabledTools for {name!r} must be a list of tool names")
            if not isinstance(definition.get("disabled", False), bool):
                raise ValueError(f"disabled for {name!r} must be a boolean")
        return config

    def save_config(self, project_id: str, config: Any) -> dict[str, Any]:
        if not self.store.bootstrap(project_id)["project"]:
            raise ValueError("project_not_found")
        return self.save_workspace_config(config)

    def install_playwright_browser(self, project_id: str) -> dict[str, Any]:
        """Add Microsoft's pinned Playwright MCP server without changing other servers."""
        if not self.store.bootstrap(project_id)["project"]:
            raise ValueError("project_not_found")
        config = self.workspace_config()
        servers = config["mcpServers"]
        if "playwright" in servers:
            raise ValueError("An MCP server named 'playwright' already exists")
        if len(servers) >= 50:
            raise ValueError("mcpServers cannot contain more than 50 entries")
        servers["playwright"] = {
            "command": "npx",
            "args": [
                "--yes", f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}", "--headless", "--isolated",
            ],
            "readOnlyTools": list(PLAYWRIGHT_READ_ONLY_TOOLS),
        }
        return self.save_config(project_id, config)

    def install_playwright_browser_for_workspace(self) -> dict[str, Any]:
        """Add Microsoft's pinned Playwright MCP server to workspace connections."""
        config = self.workspace_config()
        servers = config["mcpServers"]
        if "playwright" in servers:
            raise ValueError("An MCP server named 'playwright' already exists")
        if len(servers) >= 50:
            raise ValueError("mcpServers cannot contain more than 50 entries")
        servers["playwright"] = {
            "command": "npx",
            "args": ["--yes", f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}", "--headless", "--isolated"],
            "readOnlyTools": list(PLAYWRIGHT_READ_ONLY_TOOLS),
        }
        return self.save_workspace_config(config)

    @staticmethod
    def check_browser_runtime_dependencies() -> dict[str, Any]:
        """Check local Node.js and npx availability without installing or launching anything."""
        node = shutil.which("node")
        if not node:
            return {"ready": False, "reason": "node_missing", "nodeVersion": None}
        try:
            result = subprocess.run(
                [node, "--version"], capture_output=True, text=True, timeout=4, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {"ready": False, "reason": "node_unavailable", "nodeVersion": None}
        match = re.fullmatch(r"v?(\d+)\.\d+\.\d+", result.stdout.strip())
        if result.returncode != 0 or not match:
            return {"ready": False, "reason": "node_version_unavailable", "nodeVersion": None}
        version = result.stdout.strip().removeprefix("v")
        if int(match.group(1)) < 18:
            return {"ready": False, "reason": "node_version_unsupported", "nodeVersion": version}
        if not shutil.which("npx"):
            return {"ready": False, "reason": "npx_missing", "nodeVersion": version}
        return {"ready": True, "reason": None, "nodeVersion": version}

    @staticmethod
    def install_playwright_browser_binary() -> dict[str, Any]:
        """Install the Chromium build used by the pinned Playwright MCP dependency."""
        preflight = MCPRegistry.check_browser_runtime_dependencies()
        if not preflight["ready"]:
            messages = {
                "node_missing": "Install Node.js 18 or newer, then restart Tribe.",
                "npx_missing": "The Node.js installation does not include npx. Install Node.js 18 or newer, then restart Tribe.",
                "node_version_unsupported": f"Browser tools need Node.js 18 or newer; this device has Node.js {preflight['nodeVersion']}.",
            }
            raise RuntimeError(messages.get(preflight["reason"], "Node.js is not ready on this device."))

        npx = shutil.which("npx")
        if not npx:  # The preflight can race with an environment change.
            raise RuntimeError("The Node.js installation does not include npx. Install Node.js 18 or newer, then restart Tribe.")
        command = [
            npx, "--yes", "--package", f"playwright@{PLAYWRIGHT_CLI_VERSION}",
            "playwright", "install", "chromium",
        ]
        try:
            result = subprocess.run(
                command, capture_output=True, text=True, timeout=600, check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("The browser download timed out. Check your connection and try again.") from error
        except OSError as error:
            raise RuntimeError("The browser installer could not be started. Check the Node.js installation and try again.") from error
        if result.returncode != 0:
            raise RuntimeError("Chromium could not be installed. Check your connection and available disk space, then try again.")
        return {"installed": "chromium", "nodeVersion": preflight["nodeVersion"]}

    @staticmethod
    def _secret_references(config: dict[str, Any]) -> set[str]:
        references = set()
        for definition in config["mcpServers"].values():
            for field in ("env", "headers"):
                for value in definition.get(field, {}).values():
                    match = _ENV_REFERENCE_MATCH.fullmatch(value)
                    if match:
                        references.add(match.group(1))
        return references

    @staticmethod
    def _keychain_secret(project_id: str, name: str) -> str | None:
        import keyring

        try:
            return keyring.get_password(_KEYRING_SERVICE, f"{project_id}:{name}")
        except keyring.errors.KeyringError:
            return None

    def secret_status(self, project_id: str | None = None) -> dict[str, str | None]:
        config = self.workspace_config() if project_id is None else self.get_config(project_id)
        try:
            origins = json.loads(self.origins_path.read_text(encoding="utf-8")) if project_id is None else {}
        except (OSError, json.JSONDecodeError):
            origins = {}
        statuses = {}
        for name in sorted(self._secret_references(config)):
            if os.environ.get(name):
                statuses[name] = "environment"
            elif self._keychain_secret("workspace" if project_id is None else project_id, name):
                statuses[name] = "keychain"
            elif project_id is None and any(
                self._keychain_secret(origins.get(server_name, ""), name)
                for server_name, definition in config["mcpServers"].items()
                if any(value == f"${{{name}}}"
                       for field in ("env", "headers")
                       for value in definition.get(field, {}).values())
            ):
                statuses[name] = "keychain"
            else:
                statuses[name] = None
        return statuses

    def save_secrets(self, project_id: str | None, secrets: Any) -> dict[str, bool]:
        import keyring

        if not isinstance(secrets, dict):
            raise ValueError("secrets must be an object keyed by environment variable name")  # noqa: TRY004
        allowed = self._secret_references(self.workspace_config() if project_id is None else self.get_config(project_id))
        if set(secrets) - allowed:
            raise ValueError("secrets may only be set for environment references in the MCP configuration")
        for name, value in secrets.items():
            if not isinstance(value, str):
                raise ValueError(f"secret for {name!r} must be a string")  # noqa: TRY004
            account = f"{'workspace' if project_id is None else project_id}:{name}"
            try:
                if value:
                    keyring.set_password(_KEYRING_SERVICE, account, value)
                else:
                    try:
                        keyring.delete_password(_KEYRING_SERVICE, account)
                    except keyring.errors.PasswordDeleteError:
                        pass
            except keyring.errors.KeyringError as error:
                raise RuntimeError(f"OS credential storage is unavailable: {error}") from error
        return self.secret_status(project_id)

    async def delete_project_data(self, project_id: str, config: dict[str, Any] | None) -> None:
        """Remove project-scoped MCP credentials and configuration after project deletion."""
        errors: list[Exception] = []
        if config is None:
            errors.append(ValueError("project connection configuration could not be read"))
        try:
            import keyring
        except Exception as error:
            keyring = None
            errors.append(error)
        if keyring is not None and config is not None:
            for name in self._secret_references(config):
                try:
                    keyring.delete_password(_KEYRING_SERVICE, f"{project_id}:{name}")
                except keyring.errors.PasswordDeleteError:
                    pass
                except keyring.errors.KeyringError as error:
                    errors.append(error)
        if config is not None:
            for server_name, definition in config["mcpServers"].items():
                if definition.get("oauth") is not None:
                    try:
                        auth = self._oauth_auth(project_id, server_name, definition)
                        await auth.token_storage_adapter.clear()
                    except Exception as error:
                        errors.append(error)
        try:
            self.config_path_for_deleted_project(project_id).unlink(missing_ok=True)
        except OSError as error:
            errors.append(error)
        if errors:
            raise RuntimeError("some saved project connections could not be fully cleared") from errors[0]

    def config_path_for_deleted_project(self, project_id: str) -> Path:
        return self.root / f"{project_id}.json"

    def _resolve_config_secrets(self, project_id: str, config: dict[str, Any]) -> dict[str, Any]:
        try:
            origins = json.loads(self.origins_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            origins = {}
        def resolve(value: str, server_name: str) -> str:
            match = _ENV_REFERENCE_MATCH.fullmatch(value)
            if not match:
                return value
            name = match.group(1)
            secret = (os.environ.get(name) or self._keychain_secret("workspace", name)
                      or self._keychain_secret(origins.get(server_name, project_id), name))
            if not secret:
                raise ValueError(f"MCP environment variable {name!r} is not configured")
            return secret

        for server_name, definition in config["mcpServers"].items():
            for field in ("env", "headers"):
                definition[field] = {
                    name: resolve(value, server_name) for name, value in definition.get(field, {}).items()
                }
        return config

    def _runtime_config(
        self, project_id: str, *, include_disabled: bool = False, only_server: str | None = None
    ) -> dict[str, Any]:
        config = self.get_config(project_id)
        repository = Path(self.store.repository_for_project(project_id)).resolve(strict=True)
        servers = config["mcpServers"]
        if only_server is not None:
            if only_server not in servers:
                raise ValueError("mcp_server_not_found")
            servers = {only_server: servers[only_server]}
        if not include_disabled:
            servers = {name: definition for name, definition in servers.items()
                       if not definition.get("disabled", False)}
            browser_access = self.store.project_web_access(project_id)
            allowed_domains = browser_access["allowedDomains"]
            if browser_access["enabled"] and allowed_domains:
                origins = []
                for domain in allowed_domains:
                    host = f"[{domain}]" if ":" in domain else domain
                    origins.append(urlunsplit(("https", host, "", "", "")))
                    if is_loopback_hostname(domain):
                        origins.append(urlunsplit(("http", host, "", "", "")))
                allowed_origins = ";".join(origins)
                playwright = servers.get("playwright")
                if playwright is not None:
                    args = playwright.get("args", [])
                    filtered_args = []
                    skip_value = False
                    for arg in args:
                        if skip_value:
                            skip_value = False
                            continue
                        if arg == "--allowed-origins":
                            skip_value = True
                        elif not arg.startswith("--allowed-origins="):
                            filtered_args.append(arg)
                    playwright["args"] = [*filtered_args, "--allowed-origins", allowed_origins]
            else:
                servers.pop("playwright", None)
        config["mcpServers"] = servers
        for definition in servers.values():
            definition.pop("readOnlyTools", None)
            definition.pop("disabledTools", None)
            definition.pop("disabled", None)
            if "command" not in definition:
                continue
            expanded_args = []
            for argument in definition.get("args", []):
                if argument == "~" or argument.startswith("~/") or argument.startswith("~\\"):
                    argument = str(Path(argument).expanduser())
                elif "=" in argument:
                    option, value = argument.split("=", 1)
                    if value == "~" or value.startswith("~/") or value.startswith("~\\"):
                        argument = f"{option}={Path(value).expanduser()}"
                expanded_args.append(argument)
            definition["args"] = expanded_args
            cwd = Path(definition.get("cwd") or repository)
            resolved = (repository / cwd).resolve() if not cwd.is_absolute() else cwd.resolve()
            if not resolved.is_relative_to(repository) or not resolved.is_dir():
                raise ValueError("MCP stdio working directories must be existing directories inside the project")
            definition["cwd"] = str(resolved)
        return self._resolve_config_secrets(project_id, config)

    def load_toolsets(self, project_id: str,
                      tool_permissions: tuple[str, ...] = ()) -> list[object]:
        source_config = self.get_config(project_id)
        if not source_config["mcpServers"]:
            return []
        disabled_tools = {
            name: set(definition.get("disabledTools", []))
            for name, definition in source_config["mcpServers"].items()
        }
        granted_tools = set(tool_permissions)
        config = self._runtime_config(project_id)
        if not config["mcpServers"]:
            return []
        oauth_servers = {
            name: definition for name, definition in config["mcpServers"].items()
            if definition.get("oauth") is not None
        }
        config["mcpServers"] = {
            name: definition for name, definition in config["mcpServers"].items()
            if name not in oauth_servers
        }
        toolsets_by_server = {
            name: toolset for name, toolset in zip(
                config["mcpServers"], _load_mcp_toolsets(config), strict=True,
            )
        }
        for name, definition in oauth_servers.items():
            toolsets_by_server[name] = self._oauth_toolset(project_id, name, definition)
        try:
            legacy_names = json.loads(self.aliases_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            legacy_names = {}
        return [
            toolsets_by_server[name].filtered(
                lambda _ctx, tool, server_name=name, grant_server=legacy_names.get(name, name), disabled=disabled_tools.get(name, set()):
                    _mcp_tool_allowed(tool)
                    and tool.name.removeprefix(f"{server_name}_") not in disabled
                    and ("mcp:*" in granted_tools
                         or f"mcp:{grant_server}.*" in granted_tools
                         or f"mcp:{grant_server}.{tool.name.removeprefix(f'{server_name}_')}" in granted_tools
                         or ("workflow:*" in granted_tools
                             and tool.name.removeprefix(f"{server_name}_") in WORKFLOW_OPERATION_NAMES))
                    and (server_name != "playwright" or self._browser_access_enabled(project_id))
            )
            for name in source_config["mcpServers"] if name in toolsets_by_server
        ]

    def _browser_access_enabled(self, project_id: str) -> bool:
        policy = self.store.project_web_access(project_id)
        return policy["enabled"] and bool(policy["allowedDomains"])

    async def discover_tools(
        self, project_id: str, server_name: str, *, verify_browser_launch: bool = False,
    ) -> list[dict[str, Any]]:
        """Connect to one configured MCP server and return its advertised tool catalogue."""
        source = self.get_config(project_id)
        if server_name not in source["mcpServers"]:
            raise ValueError("mcp_server_not_found")
        config = self._runtime_config(project_id, include_disabled=True, only_server=server_name)
        definition = source["mcpServers"][server_name]
        if definition.get("oauth") is not None:
            toolset = self._oauth_toolset(project_id, server_name, definition, allow_interactive=True)
            async with asyncio.timeout(330):
                async with toolset:
                    tools = await toolset.wrapped.list_tools()
            read_only = set(definition.get("readOnlyTools", []))
            disabled = set(definition.get("disabledTools", []))
            return [{
                "name": tool.name.removeprefix(f"{server_name}_"),
                "description": (tool.description or "")[:240],
                "readOnly": tool.name.removeprefix(f"{server_name}_") in read_only,
                "enabled": tool.name.removeprefix(f"{server_name}_") not in disabled,
            } for tool in tools]

        toolsets = _load_mcp_toolsets(config)
        async with asyncio.timeout(MCP_DISCOVERY_TIMEOUT):
            toolset = toolsets[0]
            async with toolset:
                tools = await toolset.wrapped.list_tools()
                if verify_browser_launch:
                    if server_name != "playwright" or not any(
                        tool.name == "browser_snapshot" for tool in tools
                    ):
                        raise RuntimeError("Playwright did not provide its read-only page snapshot tool")
                    await toolset.wrapped.direct_call_tool("browser_snapshot", {})
        read_only = set(source["mcpServers"][server_name].get("readOnlyTools", []))
        disabled = set(source["mcpServers"][server_name].get("disabledTools", []))
        return [{
            "name": tool.name,
            "description": (tool.description or "")[:240],
            "readOnly": tool.name in read_only,
            "enabled": tool.name not in disabled,
        } for tool in tools]

    def _oauth_lease(self, project_id: str, server_name: str, endpoint: str):
        from .oauth_lock import OAuthConnectionLease

        return OAuthConnectionLease(self.store.data_dir / "locks", "workspace", server_name, endpoint)

    def _oauth_auth(
        self, project_id: str, server_name: str, definition: dict[str, Any], *, allow_interactive: bool = False,
    ):
        from .oauth_auth import LeasedOAuth
        from .oauth_store import OAuthKeyringStore

        endpoint = definition["url"]
        workspace_id = str(self.store.data_dir.resolve())
        fallback_store = None
        try:
            origins = json.loads(self.origins_path.read_text(encoding="utf-8"))
            aliases = json.loads(self.aliases_path.read_text(encoding="utf-8"))
            legacy_project = origins.get(server_name)
            legacy_name = aliases.get(server_name)
            if legacy_project and legacy_name:
                fallback_store = OAuthKeyringStore(
                    legacy_project, legacy_name, workspace_id=workspace_id,
                )
        except (OSError, json.JSONDecodeError):
            pass
        return LeasedOAuth(
            mcp_url=endpoint,
            scopes=definition.get("oauth", {}).get("scopes", []),
            client_name="Tribe",
            token_storage=OAuthKeyringStore(
                "workspace", server_name, workspace_id=workspace_id, fallback=fallback_store,
            ),
            lease=self._oauth_lease(project_id, server_name, endpoint),
            allow_interactive=allow_interactive,
        )

    def _oauth_toolset(
        self, project_id: str, server_name: str, definition: dict[str, Any], *, allow_interactive: bool = False,
    ):
        from fastmcp.client import Client
        from pydantic_ai.mcp import MCPToolset

        endpoint = definition["url"]
        auth = self._oauth_auth(project_id, server_name, definition, allow_interactive=allow_interactive)
        return MCPToolset(Client(endpoint, auth=auth)).prefixed(server_name)

    def _configured_oauth(self, project_id: str, server_name: str) -> tuple[dict[str, Any], Any]:
        config = self.workspace_config() if project_id == "workspace" else self.get_config(project_id)
        definition = config["mcpServers"].get(server_name)
        if not definition or definition.get("oauth") is None:
            raise ValueError("oauth_service_not_configured")
        return definition, self._oauth_auth(project_id, server_name, definition)

    async def oauth_status(self, project_id: str, server_name: str) -> dict[str, str]:
        _, auth = self._configured_oauth(project_id, server_name)
        tokens = await auth.token_storage_adapter.get_tokens()
        expiry = await auth.token_storage_adapter.get_token_expiry()
        sign_in_needed = (
            tokens is None
            or not tokens.access_token and not tokens.refresh_token
            or expiry is not None and expiry <= time.time() and not tokens.refresh_token
        )
        return {"state": "needs_sign_in" if sign_in_needed else "connected"}

    async def forget_oauth(self, project_id: str, server_name: str) -> dict[str, str]:
        definition, auth = self._configured_oauth(project_id, server_name)
        async with self._oauth_lease(project_id, server_name, definition["url"]).hold():
            await auth.token_storage_adapter.clear()
        return {"state": "needs_sign_in"}

    def approval_for(self, project_id: str, tool_name: str) -> tuple[str, str] | None:
        """Return the configured server and unprefixed tool when approval is required."""
        match = self.server_for_tool(project_id, tool_name)
        if match is None:
            return None
        server_name, tool = match
        definition = self.get_config(project_id)["mcpServers"][server_name]
        if tool in definition.get("readOnlyTools", []):
            return None
        return server_name, tool

    def is_read_only_tool(self, project_id: str, tool_name: str) -> bool:
        """Fail closed unless the configured server marks this exact tool read-only."""
        match = self.server_for_tool(project_id, tool_name)
        if match is None:
            return False
        server_name, tool = match
        definition = self.get_config(project_id)["mcpServers"][server_name]
        return tool in definition.get("readOnlyTools", [])

    def server_for_tool(self, project_id: str, tool_name: str) -> tuple[str, str] | None:
        config = self.get_config(project_id)
        for server_name in config["mcpServers"]:
            prefix = f"{server_name}_"
            if tool_name.startswith(prefix):
                return server_name, tool_name.removeprefix(prefix)
        return None
