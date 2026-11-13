from __future__ import annotations

import asyncio
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import keyring
import uvicorn
from fastmcp.client.auth.oauth import OAuth
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.lowlevel import Server
from mcp.shared.auth import OAuthToken
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool, ToolAnnotations
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from pydantic_ai_harness.step_persistence import SqliteStepStore

from tribe_runtime.harness_capabilities import build_capabilities
from tribe_runtime.mcp_registry import MCPRegistry
from tribe_runtime.oauth_store import OAuthKeyringStore
from tribe_runtime.store import MissionStore
from tribe_runtime.workspace import WorkspaceTools


class _TokenVerifier:
    def __init__(self, resource: str) -> None:
        self.resource = resource

    async def verify_token(self, token: str) -> AccessToken | None:
        if token != "tribe-runtime-test-token":
            return None
        return AccessToken(
            token=token, client_id="tribe-integration-test", scopes=[], resource=self.resource,
        )


class OAuthMcpRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_registry_builds_authenticated_pydantic_toolset_and_read_only_filter(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-mcp-oauth-runtime-") as directory:
            root = Path(directory)
            repository = root / "repository"
            repository.mkdir()
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
            store = MissionStore(root / "data" / "tribe.sqlite3")
            project, _mission = store.create_project(
                str(repository), "OAuth test", "Test MCP access", "Exercise authenticated tool discovery",
            )
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(128)
            host, port = listener.getsockname()
            endpoint = f"http://{host}:{port}/mcp"
            tool_calls = []

            async def list_tools(_ctx, _params) -> ListToolsResult:
                return ListToolsResult(tools=[
                    Tool(
                        name="read_document", description="Read a document", inputSchema={
                            "type": "object", "properties": {"path": {"type": "string"}},
                            "required": ["path"],
                        }, annotations=ToolAnnotations(readOnlyHint=True),
                    ),
                    Tool(
                        name="publish_document", description="Publish a document", inputSchema={
                            "type": "object", "properties": {"path": {"type": "string"}},
                            "required": ["path"],
                        }, annotations=ToolAnnotations(readOnlyHint=False),
                    ),
                ])

            async def call_tool(_ctx, params) -> CallToolResult:
                tool_calls.append((params.name, params.arguments))
                return CallToolResult(content=[TextContent(text=f"called {params.name}")])

            server = Server("OAuth test service", on_list_tools=list_tools, on_call_tool=call_tool)
            app = server.streamable_http_app(
                streamable_http_path="/mcp",
                auth=AuthSettings(
                    issuer_url=f"http://{host}:{port}", resource_server_url=endpoint,
                    validate_token_resource=True,
                ),
                token_verifier=_TokenVerifier(endpoint),
            )
            native_server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
            server_thread = threading.Thread(
                target=native_server.run, kwargs={"sockets": [listener]}, daemon=True,
            )
            server_thread.start()
            deadline = time.monotonic() + 5
            while not native_server.started and server_thread.is_alive() and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            self.assertTrue(native_server.started, "MCP fixture server failed to start")

            def stop_server() -> None:
                native_server.should_exit = True
                server_thread.join(timeout=5)

            self.addCleanup(stop_server)

            keyring_values: dict[tuple[str, str], str] = {}

            def get_password(service: str, account: str) -> str | None:
                return keyring_values.get((service, account))

            def set_password(service: str, account: str, value: str) -> None:
                keyring_values[(service, account)] = value

            def delete_password(service: str, account: str) -> None:
                if (service, account) not in keyring_values:
                    raise keyring.errors.PasswordDeleteError
                del keyring_values[(service, account)]

            with patch("keyring.get_password", side_effect=get_password), \
                    patch("keyring.set_password", side_effect=set_password), \
                    patch("keyring.delete_password", side_effect=delete_password):
                credentials = OAuthKeyringStore(
                    "workspace", "docs", workspace_id=str(store.data_dir.resolve()),
                )
                from mcp.shared.auth import OAuthToken

                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    auth_store = OAuth(mcp_url=endpoint, token_storage=credentials)
                await auth_store.token_storage_adapter.set_tokens(OAuthToken(
                    access_token="tribe-runtime-test-token", refresh_token="refresh-token", expires_in=3600,
                ))

                registry = MCPRegistry(store)
                registry.save_config(project["id"], {"mcpServers": {
                    "docs": {"url": endpoint, "oauth": {"scopes": []}, "readOnlyTools": ["read_document"]},
                }})
                toolsets = registry.load_toolsets(project["id"], ("mcp:*",))
                self.assertEqual(len(toolsets), 1)
                context = RunContext(deps=None, model=None, usage=RunUsage())
                async with toolsets[0]:
                    discovered = await toolsets[0].get_tools(context)
                self.assertEqual(set(discovered), {"docs_read_document", "docs_publish_document"})

                read_only = toolsets[0].filtered(
                    lambda _ctx, tool: registry.is_read_only_tool(project["id"], tool.name),
                )
                async with read_only:
                    visible = await read_only.get_tools(context)
                    result = await read_only.call_tool(
                        "docs_read_document", {"path": "README.md"}, context,
                        visible["docs_read_document"],
                    )
                self.assertEqual(set(visible), {"docs_read_document"})
                self.assertEqual(tool_calls, [("read_document", {"path": "README.md"})])
                self.assertIn("called read_document", str(result))
                self.assertIsNone(registry.approval_for(project["id"], "docs_read_document"))
                self.assertEqual(
                    registry.approval_for(project["id"], "docs_publish_document"),
                    ("docs", "publish_document"),
                )

                workspace = WorkspaceTools(store, _mission["id"], "tester")
                capabilities = build_capabilities(
                    workspace,
                    SimpleNamespace(native_skill_roots=[]),
                    trigger_sequence=1,
                    step_store=SqliteStepStore(database=store.data_dir / "oauth-approval-steps.sqlite3"),
                    mcp_registry=registry,
                    project_id=project["id"],
                )
                agent = Agent(TestModel(call_tools=["docs_publish_document"]))
                run = asyncio.create_task(agent.run(
                    "Publish the document now.",
                    deps=None,
                    capabilities=capabilities,
                    toolsets=registry.load_toolsets(project["id"], ("mcp:*",)),
                    conversation_id=f"test:{_mission['id']}:tester",
                ))
                pending = None
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    pending_requests = store.pending_interactions()
                    if pending_requests:
                        pending = pending_requests[0]
                        break
                    if run.done():
                        break
                    await asyncio.sleep(0.05)
                self.assertIsNotNone(pending, "OAuth mutating tool did not request approval")
                self.assertEqual(pending["target"], "MCP server docs · publish_document")
                self.assertEqual(tool_calls, [("read_document", {"path": "README.md"})])
                store.resolve_interaction(pending["id"], "approved_once")
                await asyncio.wait_for(run, timeout=10)
                self.assertEqual(tool_calls[-1][0], "publish_document")
                approval = store.deferred_tool_approvals(_mission["id"], "tester")[-1]
                self.assertEqual(approval["status"], "consumed")
                self.assertEqual(approval["tool_arguments"], tool_calls[-1][1])


if __name__ == "__main__":
    unittest.main()
