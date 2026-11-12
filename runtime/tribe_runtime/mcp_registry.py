"""Project-scoped MCP configuration composed through Pydantic AI's MCP client."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
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
PLAYWRIGHT_READ_ONLY_TOOLS = (
    "browser_console_messages",
    "browser_find",
    "browser_snapshot",
    "browser_take_screenshot",
)


def _mcp_tool_allowed(tool_definition: Any) -> bool:
    """Exclude Playwright's RCE-equivalent arbitrary-code tool from agent toolsets."""
    return not tool_definition.name.endswith("_browser_run_code_unsafe")


class MCPRegistry:
    """Validates project MCP definitions and delegates protocol handling to Pydantic AI."""

    def __init__(self, store: MissionStore):
        self.store = store
        self.root = store.data_dir / "mcp"
        self.root.mkdir(parents=True, exist_ok=True)

    def config_path(self, project_id: str) -> Path:
        if not self.store.bootstrap(project_id)["project"]:
            raise ValueError("project_not_found")
        return self.root / f"{project_id}.json"

    def get_config(self, project_id: str) -> dict[str, Any]:
        path = self.config_path(project_id)
        if not path.exists():
            return {"mcpServers": {}}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"MCP configuration could not be read: {error}") from error

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
        checked = self.validate(config)
        path = self.config_path(project_id)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(checked, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
        return checked

    def install_playwright_browser(self, project_id: str) -> dict[str, Any]:
        """Add Microsoft's pinned Playwright MCP server without changing other servers."""
        config = self.get_config(project_id)
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

    def secret_status(self, project_id: str) -> dict[str, str | None]:
        config = self.get_config(project_id)
        statuses = {}
        for name in sorted(self._secret_references(config)):
            if os.environ.get(name):
                statuses[name] = "environment"
            elif self._keychain_secret(project_id, name):
                statuses[name] = "keychain"
            else:
                statuses[name] = None
        return statuses

    def save_secrets(self, project_id: str, secrets: Any) -> dict[str, bool]:
        import keyring

        if not isinstance(secrets, dict):
            raise ValueError("secrets must be an object keyed by environment variable name")  # noqa: TRY004
        allowed = self._secret_references(self.get_config(project_id))
        if set(secrets) - allowed:
            raise ValueError("secrets may only be set for environment references in this project's MCP configuration")
        for name, value in secrets.items():
            if not isinstance(value, str):
                raise ValueError(f"secret for {name!r} must be a string")  # noqa: TRY004
            account = f"{project_id}:{name}"
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
        def resolve(value: str) -> str:
            match = _ENV_REFERENCE_MATCH.fullmatch(value)
            if not match:
                return value
            name = match.group(1)
            secret = os.environ.get(name) or self._keychain_secret(project_id, name)
            if not secret:
                raise ValueError(f"MCP environment variable {name!r} is not configured")
            return secret

        for definition in config["mcpServers"].values():
            for field in ("env", "headers"):
                definition[field] = {
                    name: resolve(value) for name, value in definition.get(field, {}).items()
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
        from pydantic_ai.mcp import load_mcp_toolsets

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
        temporary_path = None
        try:
            standard_toolsets = []
            if config["mcpServers"]:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=self.root, prefix="runtime-", suffix=".json", delete=False
                ) as temporary:
                    temporary_path = Path(temporary.name)
                    os.chmod(temporary_path, 0o600)
                    json.dump(config, temporary)
                standard_toolsets = load_mcp_toolsets(temporary_path)

            toolsets_by_server = dict(zip(config["mcpServers"], standard_toolsets, strict=True))
            for name, definition in oauth_servers.items():
                toolsets_by_server[name] = self._oauth_toolset(project_id, name, definition)
            return [
                toolsets_by_server[name].filtered(
                    lambda _ctx, tool, server_name=name, disabled=disabled_tools.get(name, set()):
                        _mcp_tool_allowed(tool)
                        and tool.name.removeprefix(f"{server_name}_") not in disabled
                        and ("mcp:*" in granted_tools
                             or f"mcp:{server_name}.*" in granted_tools
                             or f"mcp:{server_name}.{tool.name.removeprefix(f'{server_name}_')}" in granted_tools
                             or ("workflow:*" in granted_tools
                                 and tool.name.removeprefix(f"{server_name}_") in WORKFLOW_OPERATION_NAMES))
                        and (server_name != "playwright" or self._browser_access_enabled(project_id))
                )
                for name in source_config["mcpServers"] if name in toolsets_by_server
            ]
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

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
        from pydantic_ai.mcp import load_mcp_toolsets

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

        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.root, prefix="check-", suffix=".json", delete=False
            ) as temporary:
                temporary_path = Path(temporary.name)
                os.chmod(temporary_path, 0o600)
                json.dump(config, temporary)
            toolsets = load_mcp_toolsets(temporary_path)
            async with asyncio.timeout(45 if verify_browser_launch else 20):
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
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def _oauth_lease(self, project_id: str, server_name: str, endpoint: str):
        from .oauth_lock import OAuthConnectionLease

        return OAuthConnectionLease(self.store.data_dir / "locks", project_id, server_name, endpoint)

    def _oauth_auth(
        self, project_id: str, server_name: str, definition: dict[str, Any], *, allow_interactive: bool = False,
    ):
        from .oauth_auth import LeasedOAuth
        from .oauth_store import OAuthKeyringStore

        endpoint = definition["url"]
        return LeasedOAuth(
            mcp_url=endpoint,
            scopes=definition.get("oauth", {}).get("scopes", []),
            client_name="Tribe",
            token_storage=OAuthKeyringStore(
                project_id, server_name, workspace_id=str(self.store.data_dir.resolve()),
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
        config = self.get_config(project_id)
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
