from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
import zipfile
from contextlib import closing, contextmanager, nullcontext
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import patch
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from pydantic_ai import RunContext

from tribe_runtime import project_memory
from tribe_runtime.design_systems import export_design_system_package
from tribe_runtime.agent_runtime import (
    _design_system_context,
    AgentDependencies,
    AgentSupervisor,
    AgentWorker,
    PydanticAIProvider,
    _agent_can_read_context_event,
    _agent_conversation_id,
    _agent_failure_kind,
    _browser_api_request_timeout,
    _build_agent,
    _continuable_prior_runs,
    _count_compaction_receipts,
    _durable_tool_output,
    _has_unresolved_harness_tool_effects,
    _next_agent_reply_metadata,
    _project_team_context,
    _provider_retry_delay,
    _reject_text_encoded_tool_call,
    _scheduled_provider_retry_delay,
    _tools_for_agent,
    _user_facing_agent_text,
)
from tribe_runtime.agents import (
    AgentDefinition,
    AgentRunResult,
    archive_agent_definition,
    discover_agents,
    load_agent_definitions,
    write_agent_definition,
)
from tribe_runtime.general_chats import GeneralChatService
from tribe_runtime.harness_capabilities import _compaction_keep_tokens, build_capabilities
from tribe_runtime.mcp_registry import MCPRegistry
from tribe_runtime.recipes import get_recipe, list_recipes, save_recipe
from tribe_runtime.skills import SkillCatalog
from tribe_runtime.store import SCHEMA_VERSION, MissionStore
from tribe_runtime.workspace import (
    WorkspaceTools,
    browse_repository,
    project_git_diff,
    project_git_status,
)
from tribe_runtime.workspace_restore import WorkspaceRestore

ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def _database_connection(path: Path):
    connection = sqlite3.connect(path)
    try:
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


class RuntimeCase(unittest.TestCase):
    def test_browser_actions_allow_time_for_native_user_confirmation(self) -> None:
        for action in ("click", "fill", "type", "press", "upload"):
            with self.subTest(action=action):
                self.assertEqual(_browser_api_request_timeout(action), 300)
        self.assertEqual(_browser_api_request_timeout("navigate"), 25)
        self.assertEqual(_browser_api_request_timeout("snapshot"), 10)

    def test_rejects_plain_text_browser_tool_call(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "no browser action was performed"):
            _reject_text_encoded_tool_call(
                '{"name":"browser_navigate","arguments":{"url":"https://example.com"}}'
            )

    def test_rejects_plain_text_deferred_tool_search(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "native tool-calling support"):
            _reject_text_encoded_tool_call(
                '{"name":"search_tools","arguments":{"queries":["browser"]}}'
            )

    def test_keeps_ordinary_json_response(self) -> None:
        _reject_text_encoded_tool_call('{"name":"example","arguments":{}}')

    def test_compaction_retained_context_scales_below_eight_thousand_tokens(self) -> None:
        self.assertEqual(_compaction_keep_tokens(16_000), 3_200)
        self.assertEqual(_compaction_keep_tokens(1_000_000), 200_000)
        self.assertEqual(_compaction_keep_tokens(None), 32_000)

    def test_agent_channel_copy_removes_internal_identifiers(self) -> None:
        text = (
            "Tests passed (run 7a8d9474-e130-42fe-afdd-9914ee3789a4) "
            "after tool call_abcdefghijklmnop."
        )
        cleaned = _user_facing_agent_text(text)
        self.assertNotIn("7a8d9474-e130-42fe-afdd-9914ee3789a4", cleaned)
        self.assertNotIn("call_abcdefghijklmnop", cleaned)
        self.assertIn("Tests passed", cleaned)

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="tribe-runtime-test-")
        self.root = Path(self.temp.name)
        self._smriti_environment = patch.dict(
            os.environ, {"SMRITI_MEMORY_ROOT": str(self.root / "smriti")}
        )
        self._smriti_environment.start()
        with project_memory._LOCK:
            project_memory._STORES.clear()
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "tribe-tests@example.invalid")
        self.git("config", "user.name", "Tribe tests")
        (self.repository / "README.md").write_text("base\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-qm", "base")
        self.store = MissionStore(self.root / "data" / "tribe.sqlite3")
        self.project, self.mission = self.store.create_project(
            str(self.repository), "Test project", "Test mission", "Exercise runtime invariants"
        )

    def tearDown(self) -> None:
        with project_memory._LOCK:
            project_memory._STORES.clear()
        self._smriti_environment.stop()
        self.temp.cleanup()

    def git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", *args], cwd=self.repository, check=True, capture_output=True, text=True
        )
        return result.stdout.strip()

    def insert_legacy_memory(self, title: str, content: str, actor_id: str = "user") -> dict[str, Any]:
        entry_id = str(uuid.uuid4())
        timestamp = datetime.now(UTC).isoformat()
        event = self.store.append("knowledge.entry.saved", actor_id, self.mission["id"], {
            "entry": {"id": entry_id, "project_id": self.project["id"], "title": title,
                      "content": content, "created_by": actor_id, "updated_by": actor_id},
        })
        with self.store._connect() as db:
            db.execute(
                """INSERT INTO project_knowledge(
                       id,project_id,title,content,created_by,updated_at,source_mission_id,
                       source_event_sequence,created_at,updated_by,status
                   ) VALUES (?,?,?,?,?,?,?,?,?,?, 'active')""",
                (entry_id, self.project["id"], title, content, actor_id, timestamp,
                 self.mission["id"], event["sequence"], timestamp, actor_id),
            )
        return {"id": entry_id, "project_id": self.project["id"], "title": title,
                "content": content, "created_by": actor_id, "updated_by": actor_id,
                "source_mission_id": self.mission["id"],
                "source_event_sequence": event["sequence"], "created_at": timestamp,
                "updated_at": timestamp, "status": "active"}

    def test_non_git_folder_can_be_registered_as_project(self) -> None:
        workspace = self.root / "greenfield-register"
        workspace.mkdir()

        project = self.store.register_project(str(workspace), "Greenfield")

        self.assertEqual(Path(project["repository"]), workspace.resolve())
        self.assertEqual(self.store.project(project["id"])["repository"], str(workspace.resolve()))

    def test_git_project_paths_still_normalize_to_repository_root(self) -> None:
        repository_root = self.root / "independent-git-project"
        repository_root.mkdir()
        subprocess.run(["git", "init", "-q", str(repository_root)], check=True)
        nested = repository_root / "nested-project-folder"
        nested.mkdir()

        project = self.store.register_project(str(nested), "Git project")

        self.assertEqual(Path(project["repository"]), repository_root.resolve())

    def test_non_git_empty_folder_can_start_project_chat(self) -> None:
        workspace = self.root / "greenfield-chat"
        workspace.mkdir()

        project, mission = self.store.create_project(
            str(workspace), "Greenfield", "Start here", "Build a small app"
        )

        self.assertEqual(Path(project["repository"]), workspace.resolve())
        self.assertEqual(self.store.project(mission["project_id"])["id"], project["id"])
        self.assertEqual(project_git_status(workspace)["isGit"], False)

    def test_non_git_greenfield_workspace_supports_agent_files_and_harness_tools(self) -> None:
        workspace_root = self.root / "greenfield-agent-work"
        workspace_root.mkdir()
        project, mission = self.store.create_project(
            str(workspace_root), "Greenfield", "Start here", "Create the initial app"
        )
        item = self.store.create_work_item(mission["id"], "Create the app scaffold")
        claim = self.store.claim_work(mission["id"], "builder", work_item_id=item["id"])
        self.assertEqual(claim["id"], item["id"])

        tools = WorkspaceTools(self.store, mission["id"], "builder", item["id"])
        capabilities = build_capabilities(
            tools, SkillCatalog(workspace_root),
            tool_permissions=("read_file", "write_file", "list_directory", "run_command"),
        )
        capability_names = {type(capability).__name__ for capability in capabilities}
        self.assertTrue(tools.root.samefile(workspace_root))
        if os.name == "posix":
            self.assertTrue({"LocalWorkspace", "FileSystem", "Shell"}.issubset(capability_names))
        else:
            self.assertTrue({"LocalWorkspace", "FileSystem", "Shell"}.isdisjoint(capability_names))

        tools.write_file("src/main.py", "print('greenfield')")
        self.assertEqual((workspace_root / "src/main.py").read_text(), "print('greenfield')")
        self.assertEqual(browse_repository(workspace_root, "src/main.py")["content"],
                         "print('greenfield')")
        self.assertFalse(project_git_status(workspace_root)["isGit"])
        with self.assertRaisesRegex(ValueError, "project_is_not_git_enabled"):
            project_git_diff(workspace_root, "src/main.py")
        with self.assertRaisesRegex(RuntimeError, "requires a Git-enabled project"):
            tools.start_isolated_work()
        self.assertEqual(self.store.project(project["id"])["repository"], str(workspace_root.resolve()))

    def test_non_git_empty_project_api_registers_and_browses_the_folder(self) -> None:
        from tribe_runtime import server as runtime_server

        workspace = self.root / "empty-folder-api"
        workspace.mkdir()
        with (
            patch.object(runtime_server, "STORE", self.store),
            patch.object(runtime_server, "SUPERVISOR") as supervisor,
        ):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                create_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/projects",
                    data=json.dumps({"repository": str(workspace), "name": "Empty project"}).encode(),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(create_request, timeout=3) as response:
                    created = json.loads(response.read())
                    self.assertEqual(response.status, 201)

                project_id = created["project"]["id"]
                self.assertIsNone(created["mission"])
                self.assertEqual(Path(created["project"]["repository"]), workspace.resolve())
                supervisor.start_mission.assert_not_called()

                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{project_id}/files", timeout=3,
                ) as response:
                    files = json.loads(response.read())
                self.assertEqual(files["entry"], {
                    "kind": "directory", "path": "", "entries": [], "truncated": False,
                })

                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{project_id}/git", timeout=3,
                ) as response:
                    git = json.loads(response.read())
                self.assertEqual(git, {"isGit": False, "branch": None, "files": []})
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

    def test_general_chat_is_durable_and_has_no_project_link(self) -> None:
        chat = self.store.create_general_chat()
        self.store.append_general_chat_message(chat["id"], "user", "What is a queue?")
        self.store.append_general_chat_message(
            chat["id"], "assistant", "A queue is first in, first out.",
            "openai:test", duration_ms=321, input_tokens=12, output_tokens=8,
            sources=[{"title": "Queue (abstract data type)", "url": "https://example.com/queue", "domain": "example.com"}],
        )

        saved = self.store.general_chat(chat["id"])

        self.assertEqual(saved["title"], "What is a queue?")
        self.assertEqual([message["role"] for message in saved["messages"]], ["user", "assistant"])
        self.assertEqual(saved["messages"][1]["input_tokens"], 12)
        self.assertEqual(saved["messages"][1]["sources"][0]["domain"], "example.com")
        self.assertNotIn("project_id", saved)
        self.assertTrue(self.store.delete_general_chat(chat["id"]))
        self.assertIsNone(self.store.general_chat(chat["id"]))

    def test_general_chat_model_preference_is_validated_and_used_for_replies(self) -> None:
        self.store.set_setting("model", "openai:workspace-default")
        chat = self.store.create_general_chat()
        catalog = [
            {"id": "openai:workspace-default", "allowed": True, "toolCalling": True},
            {"id": "openai:chat-choice", "allowed": True, "toolCalling": True},
        ]
        with patch.object(self.store, "model_catalog", return_value=catalog):
            saved = self.store.set_general_chat_model_preference(chat["id"], "openai:chat-choice")
            self.assertEqual(saved["model_preference"], "openai:chat-choice")
            with self.assertRaisesRegex(ValueError, "model_not_allowed"):
                self.store.set_general_chat_model_preference(chat["id"], "openai:disabled")

        service = GeneralChatService(self.store)
        result = SimpleNamespace(output="Answer", usage=SimpleNamespace(input_tokens=1, output_tokens=1))
        with patch.object(service, "_run", return_value=(result, 12)) as run:
            reply = service.send(chat["id"], "Question")

        run.assert_called_once_with("openai:chat-choice", "Question", [])
        self.assertEqual(reply["chat"]["messages"][-1]["model"], "openai:chat-choice")

    def test_general_chat_model_preference_route_persists_and_rejects_unavailable_models(self) -> None:
        from tribe_runtime import server as runtime_server

        chat = self.store.create_general_chat()
        with patch.object(self.store, "model_catalog", return_value=[{
            "id": "openai:chat-choice", "allowed": True, "toolCalling": True,
        }]), patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{http.server_port}/api/general-chats/{chat['id']}/preferences"
                request = urllib.request.Request(
                    url, data=json.dumps({"modelPreference": "openai:chat-choice"}).encode(),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    payload = json.loads(response.read())
                self.assertEqual(payload["chat"]["model_preference"], "openai:chat-choice")

                invalid = urllib.request.Request(
                    url, data=json.dumps({"modelPreference": "openai:not-allowed"}).encode(),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(invalid, timeout=3)
                with failure.exception as response:
                    self.assertEqual(response.code, 422)
                    self.assertEqual(json.loads(response.read())["error"], "model_not_allowed")
                self.assertEqual(
                    self.store.general_chat(chat["id"])["model_preference"], "openai:chat-choice",
                )
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

    def test_general_chat_agent_exposes_only_workspace_safe_web_search(self) -> None:
        from pydantic_ai.models.test import TestModel

        with patch("tribe_runtime.agent_runtime._model_for_identifier", return_value=TestModel()), \
             patch("tribe_runtime.agent_runtime._resolved_provider_base_url", return_value=""), \
             patch("tribe_runtime.general_chats.get_api_key", return_value=None):
            agent = GeneralChatService(self.store)._build_agent("openai:test")

        self.assertLessEqual(set(agent._function_toolset.tools), {"duckduckgo_search"})

    def test_general_chat_web_search_preference_off_removes_search(self) -> None:
        from pydantic_ai.models.test import TestModel

        self.store.set_setting("web_search_preference", "off")
        with patch("tribe_runtime.agent_runtime._model_for_identifier", return_value=TestModel()), \
             patch("tribe_runtime.agent_runtime._resolved_provider_base_url", return_value=""), \
             patch("tribe_runtime.general_chats.get_api_key", return_value=None):
            agent = GeneralChatService(self.store)._build_agent("openai:test")

        self.assertEqual(set(agent._function_toolset.tools), set())

    def test_general_chat_preserves_web_citations_as_safe_links(self) -> None:
        from types import SimpleNamespace

        result = SimpleNamespace(
            output="The answer.",
            response=SimpleNamespace(parts=[SimpleNamespace(citations=[
                SimpleNamespace(sources=[
                    SimpleNamespace(url="https://example.com/source", title="Example source"),
                    SimpleNamespace(url="file:///private/data", title="Local file"),
                ]),
            ])]),
        )

        sources = GeneralChatService._sources_from_result(result)

        self.assertEqual(sources, [{
            "title": "Example source", "url": "https://example.com/source", "domain": "example.com",
        }])

    def test_workspace_skill_catalog_excludes_project_skill_roots(self) -> None:
        project_skill = self.repository / ".agents" / "skills" / "project-only"
        project_skill.mkdir(parents=True)
        (project_skill / "SKILL.md").write_text(
            "---\nname: Project only\ndescription: Project-specific instructions.\n---\nDo this.\n",
            encoding="utf-8",
        )

        scoped = SkillCatalog(self.repository, include_project_skills=False)
        project_scoped = SkillCatalog(self.repository)

        self.assertFalse(any(item["name"] == "Project only" for item in scoped.list()))
        self.assertTrue(any(item["name"] == "Project only" for item in project_scoped.list()))

    def test_general_chat_service_persists_provider_reply(self) -> None:
        from pydantic_ai.models.test import TestModel

        chat = self.store.create_general_chat()
        self.store.set_setting("model", "openai:test")
        self.store.set_setting("web_search_preference", "off")
        with patch("tribe_runtime.agent_runtime._model_for_identifier", return_value=TestModel()), \
             patch("tribe_runtime.agent_runtime._resolved_provider_base_url", return_value=""), \
             patch("tribe_runtime.general_chats.get_api_key", return_value=None):
            result = GeneralChatService(self.store).send(chat["id"], "Explain queues in one sentence")

        self.assertIsNone(result["responseError"])
        self.assertEqual([item["role"] for item in result["chat"]["messages"]], ["user", "assistant"])
        self.assertGreaterEqual(result["chat"]["messages"][1]["duration_ms"], 0)

    def test_general_chat_deep_research_persists_mode_and_citations(self) -> None:
        chat = self.store.create_general_chat()
        self.store.set_setting("model", "openai:test")
        result = SimpleNamespace(
            output="A sourced finding ([Official report](https://example.org/report)).",
            usage=SimpleNamespace(input_tokens=3, output_tokens=7),
            response=SimpleNamespace(parts=[SimpleNamespace(citations=[SimpleNamespace(sources=[
                SimpleNamespace(url="https://example.org/report", title="Official report"),
            ])])]),
        )
        service = GeneralChatService(self.store)
        with patch.object(service, "_run", return_value=(result, 42)) as run:
            reply = service.send(chat["id"], "Research this", mode="deep_research")

        run.assert_called_once_with("openai:test", "Research this", [], deep_research=True)
        self.assertIsNone(reply["responseError"])
        user, assistant = reply["chat"]["messages"]
        self.assertEqual(user["mode"], "deep_research")
        self.assertEqual(assistant["mode"], "deep_research")
        self.assertEqual(assistant["sources"][0]["domain"], "example.org")

    def test_general_chat_deep_research_runs_in_the_workspace_safe_agent(self) -> None:
        from pydantic_ai.models.test import TestModel

        chat = self.store.create_general_chat()
        self.store.set_setting("model", "openai:test")
        self.store.set_setting("web_search_preference", "duckduckgo")
        with patch("tribe_runtime.agent_runtime._model_for_identifier", return_value=TestModel(
                 call_tools=[],
                 custom_output_text="## Findings\n\nA supported result ([Primary source](https://example.org/source)).",
             )), patch("tribe_runtime.agent_runtime._resolved_provider_base_url", return_value=""), \
             patch("tribe_runtime.general_chats.get_api_key", return_value=None):
            result = GeneralChatService(self.store).send(chat["id"], "Research this", mode="deep_research")

        self.assertIsNone(result["responseError"])
        self.assertEqual(result["chat"]["messages"][-1]["mode"], "deep_research")
        self.assertIn("Primary source", result["chat"]["messages"][-1]["body"])

    def test_general_chat_deep_research_requires_workspace_search(self) -> None:
        chat = self.store.create_general_chat()
        self.store.set_setting("web_search_preference", "off")

        result = GeneralChatService(self.store).send(chat["id"], "Research this", mode="deep_research")

        self.assertEqual(result["responseError"], "web_search_disabled")
        self.assertEqual(result["chat"]["messages"], [])

    @staticmethod
    def reveal_deferred_test_tools(agent: Any, capabilities: list[Any] | None = None) -> None:
        """Let TestModel call named tools directly without simulating ToolSearch."""
        for tool in getattr(agent._function_toolset, "tools", {}).values():
            if getattr(tool, "defer_loading", False):
                tool.defer_loading = False
        for capability in capabilities or []:
            if getattr(capability, "defer_loading", False):
                capability.defer_loading = False

    def test_mcp_registry_validates_scope_and_marks_only_read_only_tools_approval_free(self) -> None:
        registry = MCPRegistry(self.store)
        config = {
            "mcpServers": {
                "docs": {
                    "command": "python",
                    "args": ["-m", "example_mcp"],
                    "cwd": ".",
                    "env": {"DOCS_TOKEN": "${TRIBE_TEST_DOCS_TOKEN}"},
                    "readOnlyTools": ["search"],
                },
            },
        }

        saved = registry.save_config(self.project["id"], config)

        self.assertEqual(saved, config)
        self.assertIsNone(registry.approval_for(self.project["id"], "docs_search"))
        self.assertEqual(registry.approval_for(self.project["id"], "docs_publish"), ("docs", "publish"))
        self.assertTrue(registry.is_read_only_tool(self.project["id"], "docs_search"))
        self.assertFalse(registry.is_read_only_tool(self.project["id"], "docs_publish"))
        self.assertFalse(registry.is_read_only_tool(self.project["id"], "unknown_tool"))
        self.assertEqual(registry.server_for_tool(self.project["id"], "docs_publish"), ("docs", "publish"))
        with patch.dict(os.environ, {"TRIBE_TEST_DOCS_TOKEN": "test-token"}):
            runtime_config = registry._runtime_config(self.project["id"])
            self.assertEqual(len(registry.load_toolsets(self.project["id"], ("mcp:*",))), 1)
        self.assertNotIn("readOnlyTools", runtime_config["mcpServers"]["docs"])
        self.assertEqual(runtime_config["mcpServers"]["docs"]["env"]["DOCS_TOKEN"], "test-token")
        self.assertEqual(runtime_config["mcpServers"]["docs"]["cwd"], str(self.repository.resolve()))
        self.assertFalse(list(registry.root.glob("runtime-*.json")))

    def test_browser_preflight_checks_node_version_and_npx_without_running_npx(self) -> None:
        with patch("tribe_runtime.mcp_registry.shutil.which", side_effect=lambda name: f"/bin/{name}"), \
             patch("tribe_runtime.mcp_registry.subprocess.run", return_value=subprocess.CompletedProcess(
                 ["node", "--version"], 0, "v16.20.0\n", "")) as run:
            unsupported = MCPRegistry.check_browser_runtime_dependencies()
        self.assertEqual(unsupported, {
            "ready": False, "reason": "node_version_unsupported", "nodeVersion": "16.20.0",
        })
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ["/bin/node", "--version"])

        with patch("tribe_runtime.mcp_registry.shutil.which", side_effect=lambda name: f"/bin/{name}"), \
             patch("tribe_runtime.mcp_registry.subprocess.run", return_value=subprocess.CompletedProcess(
                 ["node", "--version"], 0, "v22.11.0\n", "")):
            ready = MCPRegistry.check_browser_runtime_dependencies()
        self.assertEqual(ready, {"ready": True, "reason": None, "nodeVersion": "22.11.0"})

        with patch("tribe_runtime.mcp_registry.shutil.which", return_value=None), \
             patch("tribe_runtime.mcp_registry.subprocess.run") as run:
            missing = MCPRegistry.check_browser_runtime_dependencies()
        self.assertEqual(missing["reason"], "node_missing")
        run.assert_not_called()

    def test_playwright_chromium_install_uses_the_pinned_mcp_dependency(self) -> None:
        from tribe_runtime.mcp_registry import PLAYWRIGHT_CLI_VERSION

        with patch("tribe_runtime.mcp_registry.shutil.which", side_effect=lambda name: f"/bin/{name}"), \
             patch("tribe_runtime.mcp_registry.subprocess.run", side_effect=[
                 subprocess.CompletedProcess(["node", "--version"], 0, "v22.11.0\n", ""),
                 subprocess.CompletedProcess(["npx"], 0, "browser ready", ""),
             ]) as run:
            result = MCPRegistry.install_playwright_browser_binary()

        self.assertEqual(result, {"installed": "chromium", "nodeVersion": "22.11.0"})
        command = run.call_args_list[1].args[0]
        self.assertEqual(command, [
            "/bin/npx", "--yes", "--package", f"playwright@{PLAYWRIGHT_CLI_VERSION}",
            "playwright", "install", "chromium",
        ])
        self.assertEqual(run.call_args_list[1].kwargs["timeout"], 600)

    def test_playwright_chromium_install_does_not_expose_installer_output(self) -> None:
        with (
            patch("tribe_runtime.mcp_registry.shutil.which", side_effect=lambda name: f"/bin/{name}"),
            patch("tribe_runtime.mcp_registry.subprocess.run", side_effect=[
                subprocess.CompletedProcess(["node", "--version"], 0, "v22.11.0\n", ""),
                subprocess.CompletedProcess(["npx"], 1, "", "secret-bearing diagnostic"),
            ]),
            self.assertRaisesRegex(
                RuntimeError, "Check your connection and available disk space"
            ) as failure,
        ):
            MCPRegistry.install_playwright_browser_binary()

        self.assertNotIn("secret-bearing diagnostic", str(failure.exception))

    def test_playwright_connection_check_launches_browser_with_read_only_snapshot(self) -> None:
        from types import SimpleNamespace

        registry = MCPRegistry(self.store)
        registry.install_playwright_browser(self.project["id"])

        class BrowserServer:
            calls: ClassVar[list[tuple[str, dict]]] = []

            async def list_tools(self):
                return [SimpleNamespace(name="browser_snapshot", description="Page snapshot")]

            async def direct_call_tool(self, name, arguments):
                self.calls.append((name, arguments))
                return {"content": []}

        class Toolset:
            def __init__(self):
                self.wrapped = BrowserServer()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

        toolset = Toolset()
        with patch("pydantic_ai.mcp.load_mcp_toolsets", return_value=[toolset]):
            tools = asyncio.run(registry.discover_tools(
                self.project["id"], "playwright", verify_browser_launch=True,
            ))

        self.assertEqual([tool["name"] for tool in tools], ["browser_snapshot"])
        self.assertEqual(toolset.wrapped.calls, [("browser_snapshot", {})])

    def test_browser_mcp_check_stops_before_starting_server_when_node_is_missing(self) -> None:
        from tribe_runtime import server as runtime_server

        MCPRegistry(self.store).install_playwright_browser(self.project["id"])

        async def unexpected_discovery(*_args):
            raise AssertionError("browser server must not start without Node.js")

        with patch.object(runtime_server, "STORE", self.store), \
             patch.object(runtime_server.MCPRegistry, "check_browser_runtime_dependencies",
                          return_value={"ready": False, "reason": "node_missing", "nodeVersion": None}), \
             patch.object(runtime_server.MCPRegistry, "discover_tools", new=unexpected_discovery):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/mcp/check",
                    data=json.dumps({"serverName": "playwright"}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(failure.exception.code, 424)
                with failure.exception as response:
                    payload = json.loads(response.read())
                self.assertEqual(payload["error"], "Install Node.js 18 or newer, then restart Tribe.")
            finally:
                http.shutdown()
                http.server_close()

    def test_playwright_browser_install_route_requires_project_browser_tools(self) -> None:
        from tribe_runtime import server as runtime_server

        registry = MCPRegistry(self.store)
        registry.install_playwright_browser(self.project["id"])
        with patch.object(runtime_server, "STORE", self.store), \
             patch.object(runtime_server.MCPRegistry, "install_playwright_browser_binary",
                          return_value={"installed": "chromium", "nodeVersion": "22.11.0"}) as install:
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/mcp/playwright/install",
                    data=b"{}", headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    payload = json.loads(response.read())
                self.assertEqual(payload, {"installed": "chromium", "nodeVersion": "22.11.0"})
                install.assert_called_once_with()
                registry.save_config(self.project["id"], {"mcpServers": {}})
                try:
                    urllib.request.urlopen(request, timeout=3)
                except urllib.error.HTTPError as failure:
                    with failure:
                        self.assertEqual(failure.code, 409)
                else:
                    self.fail("Chromium installation should require the pinned browser tools")
                install.assert_called_once_with()
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=2)

    def test_mcp_oauth_config_uses_direct_client_and_exposes_secret_free_sign_in_state(self) -> None:
        import keyring

        registry = MCPRegistry(self.store)
        config = {"mcpServers": {
            "docs": {"url": "https://tools.example.com/mcp", "oauth": {"scopes": ["docs:read"]},
                     "readOnlyTools": ["search"]},
            "local": {"command": sys.executable, "args": ["-c", "pass"]},
        }}
        registry.save_config(self.project["id"], config)
        self.assertIsNone(registry.approval_for(self.project["id"], "docs_search"))
        self.assertEqual(registry.approval_for(self.project["id"], "docs_publish"), ("docs", "publish"))
        loaded_configurations = []

        class FilterableToolset:
            def filtered(self, predicate):
                self.predicate = predicate
                return self

        local_toolset = FilterableToolset()

        def load_standard_toolsets(path):
            loaded_configurations.append(json.loads(Path(path).read_text(encoding="utf-8")))
            return [local_toolset]

        with patch("pydantic_ai.mcp.load_mcp_toolsets", side_effect=load_standard_toolsets):
            toolsets = registry.load_toolsets(self.project["id"], ("mcp:*",))

        self.assertEqual(len(toolsets), 2)
        self.assertNotIn("docs", loaded_configurations[0]["mcpServers"])
        self.assertEqual(loaded_configurations[0]["mcpServers"]["local"]["command"], sys.executable)
        self.assertFalse(list(registry.root.glob("runtime-*.json")))
        with patch("keyring.get_password", return_value=None), patch(
            "keyring.delete_password", side_effect=keyring.errors.PasswordDeleteError,
        ):
            self.assertEqual(
                asyncio.run(registry.oauth_status(self.project["id"], "docs")),
                {"state": "needs_sign_in"},
            )
            self.assertEqual(
                asyncio.run(registry.forget_oauth(self.project["id"], "docs")),
                {"state": "needs_sign_in"},
            )
        with self.assertRaisesRegex(ValueError, "cannot both"):
            registry.validate({"mcpServers": {"bad": {
                "url": "https://tools.example.com/mcp", "oauth": {}, "headers": {"Authorization": "${TOKEN}"},
            }}})
        with self.assertRaisesRegex(ValueError, "remote services"):
            registry.validate({"mcpServers": {"bad": {
                "command": sys.executable, "oauth": {},
            }}})
        with self.assertRaisesRegex(ValueError, "unique list"):
            registry.validate({"mcpServers": {"bad": {
                "url": "https://tools.example.com/mcp", "oauth": {"scopes": ["read", "read"]},
            }}})

    def test_mcp_server_and_tool_disablement_is_enforced_when_loading_toolsets(self) -> None:
        from types import SimpleNamespace

        registry = MCPRegistry(self.store)
        registry.save_config(self.project["id"], {"mcpServers": {
            "active": {"command": sys.executable, "args": ["-c", "pass"], "disabledTools": ["publish"]},
            "paused": {"command": sys.executable, "args": ["-c", "pass"], "disabled": True},
        }})

        class FilterableToolset:
            predicate = None

            def filtered(self, predicate):
                self.predicate = predicate
                return self

        toolset = FilterableToolset()
        with patch("pydantic_ai.mcp.load_mcp_toolsets", return_value=[toolset]) as load:
            loaded = registry.load_toolsets(self.project["id"], ("mcp:*",))
        load.assert_called_once()
        self.assertEqual(loaded, [toolset])
        self.assertTrue(toolset.predicate(None, SimpleNamespace(name="active_search")))
        self.assertFalse(toolset.predicate(None, SimpleNamespace(name="active_publish")))
        runtime_config = registry._runtime_config(self.project["id"])
        self.assertEqual(set(runtime_config["mcpServers"]), {"active"})
        self.assertNotIn("disabledTools", runtime_config["mcpServers"]["active"])

    def test_mcp_server_check_discovers_tools_without_exposing_server_secrets(self) -> None:
        server_script = self.repository / "mcp_check_server.py"
        server_script.write_text(
            """import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if not method or 'id' not in request:
        continue
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'],
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'check', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'search', 'description': 'Search project docs',
                             'inputSchema': {'type': 'object', 'properties': {}}}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}) + '\\n')
    sys.stdout.flush()
""",
            encoding="utf-8",
        )
        registry = MCPRegistry(self.store)
        registry.save_config(self.project["id"], {"mcpServers": {
            "docs": {
                "command": sys.executable,
                "args": [str(server_script)],
                "cwd": ".",
                "readOnlyTools": ["search"],
                "disabledTools": ["search"],
            },
            "unconfigured": {"command": sys.executable, "env": {"TOKEN": "${MISSING_TOKEN}"}},
        }})

        tools = asyncio.run(registry.discover_tools(self.project["id"], "docs"))

        self.assertEqual(tools, [{
            "name": "search",
            "description": "Search project docs",
            "readOnly": True,
            "enabled": False,
        }])
        self.assertFalse(list(registry.root.glob("check-*.json")))

    def test_playwright_preset_is_pinned_isolated_and_gates_browser_actions(self) -> None:
        from types import SimpleNamespace

        from tribe_runtime.mcp_registry import PLAYWRIGHT_MCP_VERSION, _mcp_tool_allowed

        registry = MCPRegistry(self.store)
        original = registry.save_config(self.project["id"], {"mcpServers": {
            "docs": {"command": "python", "args": ["-m", "docs_mcp"]},
        }})
        saved = registry.install_playwright_browser(self.project["id"])
        self.assertIn("docs", saved["mcpServers"])
        browser = saved["mcpServers"]["playwright"]
        self.assertEqual(browser["command"], "npx")
        self.assertIn(f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}", browser["args"])
        self.assertIn("--isolated", browser["args"])
        self.assertIn("browser_snapshot", browser["readOnlyTools"])
        self.assertNotIn("playwright", registry._runtime_config(self.project["id"])["mcpServers"])
        registry.save_config(self.project["id"], {"mcpServers": {
            "docs": saved["mcpServers"]["docs"],
            "playwright": browser | {"args": [*browser["args"], "--allowed-origins=https://unapproved.example"]},
        }})
        self.store.set_project_web_access(self.project["id"], True, ["docs.python.org", "react.dev"])
        runtime_browser = registry._runtime_config(self.project["id"])["mcpServers"]["playwright"]
        self.assertEqual(runtime_browser["args"][-2:], [
            "--allowed-origins",
            "https://docs.python.org;http://docs.python.org;https://react.dev;http://react.dev",
        ])
        self.assertNotIn("https://unapproved.example", runtime_browser["args"][-1])
        self.assertIsNone(registry.approval_for(self.project["id"], "playwright_browser_snapshot"))
        self.assertEqual(
            registry.approval_for(self.project["id"], "playwright_browser_navigate"),
            ("playwright", "browser_navigate"),
        )
        self.assertFalse(_mcp_tool_allowed(SimpleNamespace(name="playwright_browser_run_code_unsafe")))
        self.assertTrue(_mcp_tool_allowed(SimpleNamespace(name="playwright_browser_snapshot")))
        class FilterableToolset:
            predicate = None

            def filtered(self, predicate):
                self.predicate = predicate
                return self

        docs_toolset = FilterableToolset()
        browser_toolset = FilterableToolset()
        with patch("pydantic_ai.mcp.load_mcp_toolsets", return_value=[docs_toolset, browser_toolset]):
            registry.load_toolsets(self.project["id"], ("mcp:*",))
        self.assertTrue(browser_toolset.predicate(None, SimpleNamespace(name="playwright_browser_navigate")))
        self.store.set_project_web_access(self.project["id"], False, ["docs.python.org"])
        self.assertFalse(browser_toolset.predicate(None, SimpleNamespace(name="playwright_browser_navigate")))
        with self.assertRaisesRegex(ValueError, "already exists"):
            registry.install_playwright_browser(self.project["id"])
        self.assertEqual(original["mcpServers"].keys(), {"docs"})

    def test_workflow_recipe_versions_and_mission_snapshot_are_durable(self) -> None:
        builtin_dir = ROOT / "recipes"
        user_dir = self.root / "data" / "recipes"
        builtin = get_recipe(builtin_dir, user_dir, "goal-driven-sdlc")
        self.assertIsNotNone(builtin)
        self.assertEqual(builtin.version, 9)
        self.assertEqual([stage["id"] for stage in builtin.stages], [
            "discovery", "planning", "building", "verification", "review", "finish",
        ])

        saved = save_recipe(user_dir, "goal-driven-sdlc", "My SDLC", "A custom delivery flow.",
                            "Discover, implement, verify, and review.", builtin_dir,
                            [{"id": "research", "title": "Research"}, {"id": "synthesis", "title": "Synthesis"}])
        self.assertEqual(saved.version, builtin.version + 1)
        self.assertEqual([stage["title"] for stage in saved.stages], ["Research", "Synthesis"])
        self.assertEqual(get_recipe(builtin_dir, user_dir, saved.id).source, "user")
        self.assertEqual(len(list_recipes(builtin_dir, user_dir)), 3)

        mission = self.store.create_mission(self.project["id"], "Recipe mission", "Deliver the feature",
                                            saved.snapshot())
        restored = self.store.mission(mission["id"])
        self.assertEqual(restored["recipe_id"], saved.id)
        self.assertEqual(restored["recipe_version"], saved.version)
        self.assertEqual(json.loads(restored["recipe_snapshot"])["instructions"], saved.instructions)
        event = self.store.events_after(mission["id"], 0)[0]
        self.assertEqual(event["payload"]["workflow"]["version"], saved.version)

    def test_design_system_versions_apply_to_project_and_survive_reload(self) -> None:
        system = {
            "name": "Field kit", "description": "Research components", "source": "user",
            "tokens": {
                "canvas": "#111827", "surface": "#182234", "raised": "#202d42",
                "text": "#e8edf5", "muted": "#a0aec2", "accent": "#6b9df7",
                "line": "#42516a", "focus": "#83c5ff", "success": "#59d5a2",
                "warning": "#ffb34d", "danger": "#f07d7d", "radius": "8px",
                "spacing": "12px", "fontSize": "14px", "font": "'Inter', 'SF Pro', sans-serif",
            },
            "components": {"button": "Clear actions", "card": "Open groups", "input": "Visible focus"},
            "guidance": "Keep data labels readable.", "references": [],
            "category": "Research", "license": "Apache-2.0", "tags": ["data", "research"],
            "manifest": {"schemaVersion": "od-design-system-project/v1", "id": "field-kit"},
            "packageFiles": [
                {"path": "DESIGN.md", "content": "# Design rules"},
                {"path": "tokens.css", "content": ":root { --bg: #111827; }"},
                {"path": "source/evidence report.md", "content": "Source notes"},
                {"path": "source/evidence.json", "content": '{"schema":"tribe-design-system-evidence/v1"}'},
                {"path": "tokens/field-kit.tokens", "content": '{"color":{"primary":{"$type":"color","$value":"#6b9df7"}}}'},
            ],
        }
        palette_steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
        system["palettes"] = {
            role: [{"step": step, "color": "#6b9df7"} for step in palette_steps]
            for role in ("brand", "neutral", "success", "warning", "danger")
        }
        invalid_palette = {**system, "palettes": {**system["palettes"], "brand": system["palettes"]["brand"][:-1]}}
        with self.assertRaisesRegex(ValueError, "design_system_palette_brand_invalid"):
            self.store.save_design_system(invalid_palette)
        saved = self.store.save_design_system(system)
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["palettes"]["brand"][5], {"step": 500, "color": "#6b9df7"})
        self.assertEqual(saved["packageFiles"][0]["path"], "DESIGN.md")
        self.assertEqual(saved["packageFiles"][2]["path"], "source/evidence report.md")
        self.assertEqual(saved["packageFiles"][3]["path"], "source/evidence.json")
        self.assertEqual(saved["license"], "Apache-2.0")
        package = zipfile.ZipFile(io.BytesIO(export_design_system_package(saved)))
        self.assertIn("manifest.json", package.namelist())
        self.assertIn("DESIGN.md", package.namelist())
        self.assertIn("tokens.css", package.namelist())
        self.assertIn("components.html", package.namelist())
        self.assertIn("source/evidence.json", package.namelist())
        self.assertIn("tokens/field-kit.tokens", package.namelist())
        manifest = json.loads(package.read("manifest.json"))
        self.assertEqual(manifest["files"]["designTokens"], "tokens/field-kit.tokens")
        self.assertNotIn("design-tokens.json", package.namelist())
        self.assertIn("tribe-system.json", package.namelist())
        self.assertEqual(package.read("DESIGN.md").decode(), "# Design rules")
        http_reference = self.store.save_design_system({
            **system,
            "name": "HTTP visual reference",
            "sourceUrl": "http://design.example/reference",
            "references": [{"url": "http://design.example/reference", "label": "Captured visual reference"}],
        })
        self.assertEqual(http_reference["sourceUrl"], "http://design.example/reference")
        self.assertEqual(http_reference["references"][0]["url"], "http://design.example/reference")
        generated_package = zipfile.ZipFile(io.BytesIO(export_design_system_package({**system, "packageFiles": []})))
        self.assertIn(b"--tribe-font-size", generated_package.read("tokens.css"))
        revised = {**saved, "description": "Updated research components"}
        saved_v2 = self.store.save_design_system(revised, expected_version=1)
        self.assertEqual(saved_v2["version"], 2)
        unchanged = self.store.save_design_system(saved_v2, expected_version=2)
        self.assertEqual(unchanged["version"], 2)
        self.assertEqual(
            [item["version"] for item in self.store.design_system_versions(saved["id"])], [2, 1],
        )
        with self.assertRaisesRegex(ValueError, "design_system_version_conflict"):
            self.store.save_design_system(revised, expected_version=1)

        applied = self.store.apply_project_design_system(self.project["id"], saved_v2)
        self.assertEqual(applied["version"], 2)
        project = self.store.project_for_mission(self.mission["id"])
        self.assertEqual(project["designSystem"]["guidance"], "Keep data labels readable.")
        self.assertEqual(project["designSystem"]["version"], 2)
        restarted = MissionStore(self.store.path)
        self.assertEqual(restarted.design_systems()[0]["id"], saved["id"])
        self.assertEqual(restarted.design_system_version(saved["id"], 1)["description"], "Research components")
        official = {**saved_v2, "id": "field-notes", "name": "Field Notes", "source": "official"}
        applied_official = restarted.apply_project_design_system(self.project["id"], official)
        self.assertEqual(applied_official["source"], "official")
        self.assertEqual(applied_official["id"], "field-notes")
        self.assertTrue(restarted.remove_project_design_system(self.project["id"]))
        self.assertIsNone(restarted.project_for_mission(self.mission["id"])["designSystem"])

        imported_snapshot = {**saved_v2, "source": "user", "version": 1}
        imported_snapshot.pop("id")
        imported = restarted.save_design_system(imported_snapshot)
        self.assertNotEqual(imported["id"], saved_v2["id"])
        self.assertEqual(imported["version"], 1)
        self.assertEqual(imported["tokens"], saved_v2["tokens"])
        self.assertEqual(imported["components"], saved_v2["components"])
        self.assertEqual(imported["palettes"], saved_v2["palettes"])
        self.assertEqual(imported["packageFiles"], saved_v2["packageFiles"])
        invalid_package = {**system, "packageFiles": [{"path": "../outside.md", "content": "not safe"}]}
        with self.assertRaisesRegex(ValueError, "design_system_package_path_invalid"):
            self.store.save_design_system(invalid_package)

    def test_project_design_system_endpoint_loads_the_exact_applied_package_snapshot(self) -> None:
        with patch.dict(os.environ, {"TRIBE_DATA_DIR": str(self.root / "runtime-data")}):
            from tribe_runtime import server as runtime_server

        system = {
            "name": "Endpoint fixture", "description": "Snapshot comparison fixture", "source": "user",
            "tokens": {
                "canvas": "#111827", "surface": "#182234", "raised": "#202d42",
                "text": "#e8edf5", "muted": "#a0aec2", "accent": "#6b9df7",
                "line": "#42516a", "focus": "#83c5ff", "success": "#59d5a2",
                "warning": "#ffb34d", "danger": "#f07d7d",
            },
            "packageFiles": [
                {"path": "components.html", "content": "<main>Applied snapshot</main>"},
                {"path": "preview/dashboard.html", "content": "<main>Current project</main>"},
            ],
        }
        saved = self.store.save_design_system(system)
        self.store.apply_project_design_system(self.project["id"], saved)

        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/design-system",
                    timeout=3,
                ) as response:
                    payload = json.loads(response.read())
                self.assertEqual(payload["designSystem"]["version"], saved["version"])
                self.assertEqual(payload["designSystem"]["packageFiles"], system["packageFiles"])
                self.assertEqual(payload["designSystem"]["appliedAt"], self.store.project(self.project["id"])["designSystem"]["appliedAt"])

                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/projects", timeout=3,
                ) as response:
                    projects = json.loads(response.read())["projects"]
                listed = next(item for item in projects if item["id"] == self.project["id"])
                self.assertNotIn("packageFiles", listed["designSystem"])
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=2)

    def test_agent_design_system_context_includes_patterns_and_selected_previews(self) -> None:
        context = _design_system_context({
            "name": "Field kit", "version": 2,
            "manifest": {"componentsManifest": "indexes/component-index.json", "files": {"patterns": ["patterns/empty-state.md"]}, "preview": {"pages": [
                {"path": "preview/desktop.html"}, {"path": "preview/mobile.html"}, {"path": "preview/unselected.html"},
            ]}},
            "packageFiles": [
                {"path": "USAGE.md", "content": "Read the package guide first."},
                {"path": "DESIGN.md", "content": "# Principles"},
                {"path": "tokens.css", "content": ":root { --surface: #fff; }"},
                {"path": "source/evidence.md", "content": "Selected reference; not official brand assets."},
                {"path": "indexes/component-index.json", "content": '{"components":[{"name":"Button"}]}'},
                {"path": "patterns/empty-state.md", "content": "Keep recovery actions near the empty state."},
                {"path": "guidance/interactions.md", "content": "Use visible focus and concise validation."},
                {"path": "components.html", "content": "<button>Save</button>"},
                {"path": "preview/desktop.html", "content": "<main>large preview</main>"},
                {"path": "preview/mobile.html", "content": "<main>small preview</main>"},
                {"path": "preview/unselected.html", "content": "<main>extra preview</main>"},
                {"path": "assets/brand.png", "content": "binary"},
            ],
        })
        paths = [file["path"] for file in context["packageFiles"]]
        self.assertEqual(paths, [
            "USAGE.md", "DESIGN.md", "tokens.css", "indexes/component-index.json", "components.html", "source/evidence.md",
            "patterns/empty-state.md", "guidance/interactions.md", "preview/desktop.html", "preview/mobile.html",
        ])
        self.assertNotIn("preview/unselected.html", paths)
        self.assertNotIn("assets/brand.png", paths)
        self.assertEqual(context["name"], "Field kit")

    def test_workflow_progress_stage_is_durable_and_bound_to_the_mission_snapshot(self) -> None:
        workflow = {
            "id": "research-flow", "version": 1, "title": "Research flow",
            "description": "Research then synthesise.", "instructions": "Follow the stages.",
            "stages": [{"id": "research", "title": "Research"},
                       {"id": "synthesis", "title": "Synthesis"}],
        }
        mission = self.store.create_mission(
            self.project["id"], "Workflow stage", "Run a research workflow", workflow,
        )
        first = self.store.set_mission_workflow_stage(mission["id"], "planner", "research", "Inspect sources")
        self.assertTrue(first["changed"])
        self.assertEqual(self.store.mission(mission["id"])["workflow_context"]["stage"]["title"], "Research")
        repeated = self.store.set_mission_workflow_stage(mission["id"], "planner", "research")
        self.assertFalse(repeated["changed"])
        with self.assertRaisesRegex(ValueError, "workflow_stage_not_in_selected_workflow"):
            self.store.set_mission_workflow_stage(mission["id"], "planner", "not-a-stage")

    def test_workflow_stage_tool_is_exposed_only_by_profile_permission(self) -> None:
        permitted = AgentDefinition(
            "planner", "Planner", "Planning", "", "planner.md",
            tool_permissions=("set_workflow_stage",),
        )
        agent = _build_agent(permitted, "openai:test-model")
        allowed = _tools_for_agent(agent, "read_only", permitted.tool_permissions)
        denied = _tools_for_agent(agent, "read_only", ())
        self.assertIn("update_workflow_state", {tool.name for tool in allowed})
        self.assertNotIn("update_workflow_state", {tool.name for tool in denied})
        self.assertTrue(all(
            tool.defer_loading for tool in agent._function_toolset.tools.values()
            if tool.name in {
                "list_workflows", "get_workflow", "activate_workflow",
                "get_workflow_state", "update_workflow_state",
            }
        ))

    def test_scheduler_tools_are_exposed_only_by_profile_permission(self) -> None:
        permitted = AgentDefinition(
            "planner", "Planner", "Planning", "", "planner.md",
            capabilities=("scheduling",),
        )
        agent = _build_agent(permitted, "openai:test-model")
        allowed = {tool.name for tool in _tools_for_agent(
            agent, "read_only", permitted.tool_permissions,
        )}
        denied = {tool.name for tool in _tools_for_agent(agent, "read_only", ())}
        expected = {
            "list_project_schedules", "create_project_schedule",
            "edit_project_schedule", "manage_project_schedule",
        }

        self.assertTrue(expected <= allowed)
        self.assertTrue(expected.isdisjoint(denied))
        self.assertTrue(all(agent._function_toolset.tools[name].defer_loading for name in expected))

    def test_agent_schedules_default_to_device_timezone_and_keep_timezone_on_edit(self) -> None:
        definition = AgentDefinition(
            "planner", "Planner", "Planning", "", "planner.md", capabilities=("scheduling",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        tools = _build_agent(definition, "openai:test-model")._function_toolset.tools
        create_tool = tools["create_project_schedule"]
        edit_tool = tools["edit_project_schedule"]
        self.assertNotIn("timezone", create_tool.function_schema.json_schema.get("required", []))

        with patch.object(self.store, "local_timezone_name", return_value="Pacific/Auckland"):
            created = create_tool.function(
                SimpleNamespace(deps=dependencies), "Daily check", "Check project progress", "daily",
            )
        self.assertTrue(created["ok"])
        self.assertEqual(created["schedule"]["timezone"], "Pacific/Auckland")

        created_cron = create_tool.function(
            SimpleNamespace(deps=dependencies), "Weekday check", "Check project progress", "cron",
            cron_expression="0 9 * * MON-FRI",
        )
        self.assertTrue(created_cron["ok"])
        self.assertEqual(created_cron["schedule"]["cron_expression"], "0 9 * * MON-FRI")

        existing = self.store.create_schedule(
            self.project["id"], "Sydney check", "Check delivery", "daily", "Australia/Sydney",
        )
        edited = edit_tool.function(
            SimpleNamespace(deps=dependencies), existing["id"], "Updated check", "Check delivery",
            "weekly",
        )
        self.assertTrue(edited["ok"])
        self.assertEqual(edited["schedule"]["timezone"], "Australia/Sydney")

    def test_new_mission_records_selected_skills_and_initial_message_routing(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Explain the project", "Explain the project",
            initial_message="Explain the project", selected_skills=["product-docs", "product-docs"],
        )
        events = self.store.events_after(mission["id"], 0)
        self.assertEqual(events[0]["payload"]["selectedSkills"], ["product-docs"])
        self.assertTrue(events[0]["payload"]["hasInitialMessage"])
        self.assertEqual(events[1]["type"], "message.created")

    def test_null_recipe_id_starts_a_plain_chat_without_recipe_lookup(self) -> None:
        from tribe_runtime import server as runtime_server

        with patch.object(runtime_server, "STORE", self.store), \
             patch.object(runtime_server, "SUPERVISOR") as supervisor:
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/missions",
                    data=json.dumps({
                        "projectId": self.project["id"], "title": "Explain the project",
                        "goal": "Explain the project", "initialMessage": "Explain the project",
                        "recipeId": None, "selectedSkills": [], "deepResearch": True,
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    payload = json.loads(response.read())
                self.assertEqual(response.status, 201)
                self.assertIsNone(payload["mission"]["recipe_id"])
                events = self.store.events_after(payload["mission"]["id"], 0)
                self.assertEqual(events[1]["payload"]["researchMode"], "deep_research")
                supervisor.start_mission.assert_called_once_with(
                    payload["mission"]["id"], initial_launch=True,
                )
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

    def test_workflow_choice_does_not_gate_profile_granted_repository_actions(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Guided delivery", "Implement a change",
            {"id": "goal-driven-sdlc", "version": 7, "title": "Goal-driven SDLC"},
        )
        workspace = WorkspaceTools(self.store, mission["id"], "builder")
        workspace.write_file("without-plan.txt", "profile access is the repository boundary")
        self.assertTrue((self.repository / "without-plan.txt").is_file())

        first = self.store.create_work_item(mission["id"], "Implement change")
        claim = self.store.claim_work(mission["id"], "builder", work_item_id=first["id"])
        self.assertEqual(claim["id"], first["id"])
        second = self.store.create_work_item(mission["id"], "Verify the change")
        self.assertEqual(self.store.work_items(mission["id"])[0]["status"], "claimed")
        self.store.complete_work(first["id"], "builder", "Implemented the requested change")
        next_claim = self.store.claim_work(mission["id"], "reviewer", work_item_id=second["id"])
        self.assertEqual(next_claim["id"], second["id"])

    def test_finalized_plan_is_optional_and_replanning_does_not_revoke_claims(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Optional plan", "Deliver a change",
            {"id": "goal-driven-sdlc", "version": 7, "title": "Goal-driven SDLC"},
        )
        item = self.store.create_work_item(mission["id"], "Implement change")
        self.store.finalize_plan(mission["id"], "planner", [{
            "criterion": "The change is delivered", "work_item_ids": [item["id"]],
        }])
        claim = self.store.claim_work(mission["id"], "builder", work_item_id=item["id"])
        self.store.create_work_item(mission["id"], "Cover an additional edge case")
        self.assertEqual(self.store.work_items(mission["id"])[0]["owner"], "builder")
        self.assertFalse(self.store.has_current_plan_checkpoint(mission["id"]))
        self.store.complete_work(claim["id"], "builder", "Finished the claimed implementation")
        self.assertEqual(self.store.work_items(mission["id"])[0]["status"], "done")

    def test_repeating_unchanged_plan_finalization_reuses_the_existing_checkpoint(self) -> None:
        mission = self.store.create_mission(self.project["id"], "Plan retry", "Deliver a change")
        item = self.store.create_work_item(mission["id"], "Implement change")
        criteria = [{
            "criterion": "The change is implemented", "work_item_ids": [item["id"]],
        }]

        first = self.store.finalize_plan(mission["id"], "planner", criteria)
        repeated = self.store.finalize_plan(mission["id"], "planner", criteria)

        self.assertEqual(repeated["id"], first["id"])
        finalizations = [event for event in self.store.events_after(mission["id"], 0)
                         if event["type"] == "plan.finalized"]
        self.assertEqual(len(finalizations), 1)

        next_item = self.store.create_work_item(mission["id"], "Verify the change")
        revised = self.store.finalize_plan(mission["id"], "planner", [{
            "criterion": "The change is implemented", "work_item_ids": [item["id"]],
        }, {
            "criterion": "The change is verified", "work_item_ids": [next_item["id"]],
        }])
        self.assertNotEqual(revised["id"], first["id"])

    def test_discovery_and_plan_finalization_remain_optional_guidance(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Optional discovery", "Deliver a verified change",
            {"id": "bug-fix", "version": 1, "title": "Bug fix", "instructions": "Fix and verify."},
        )
        item = self.store.create_work_item(mission["id"], "Implement change")
        finalized = self.store.finalize_plan(mission["id"], "planner", [{
            "criterion": "The change is implemented", "work_item_ids": [item["id"]],
        }])
        self.assertEqual(finalized["type"], "plan.finalized")
        self.assertFalse(any(
            event["type"] == "sdlc.discovery.completed"
            for event in self.store.events_after(mission["id"], 0)
        ))
        self.assertEqual(self.store.claim_work(mission["id"], "builder")["id"], item["id"])

    def test_workflow_recipe_rejects_invalid_identity_and_empty_guidance(self) -> None:
        recipes_dir = self.root / "recipes"
        with self.assertRaisesRegex(ValueError, "recipe_id"):
            save_recipe(recipes_dir, "../oops", "Bad", "A summary.", "Instructions", ROOT / "recipes")
        with self.assertRaisesRegex(ValueError, "guidance"):
            save_recipe(recipes_dir, "valid-id", "Valid", "A summary.", "", ROOT / "recipes")

    def test_agent_memory_proposal_review_updates_canonical_project_memory(self) -> None:
        existing = project_memory.save_project_memory(
            self.store, self.project["id"], self.mission["id"], "user",
            "Build command", "Run npm test.",
        )
        self.assertEqual(existing["status"], "active")
        self.assertEqual(existing["source_mission_id"], self.mission["id"])

        proposal = self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Build command", "Run npm run test."
        )
        self.assertEqual(proposal["status"], "pending")
        self.assertEqual(proposal["source_mission_title"], self.mission["title"])
        self.assertEqual(project_memory.read_project_memory(
            self.project["id"], existing["id"],
        )["content"], "Run npm test.")
        self.assertEqual(self.store.knowledge_proposals(self.project["id"])[0]["id"], proposal["id"])
        snapshot = self.store.bootstrap(self.project["id"])
        self.assertEqual(snapshot["knowledgeProposals"][0]["source_mission_title"], self.mission["title"])
        self.assertEqual(self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Build command", "Run npm run test."
        )["id"], proposal["id"])
        with self.assertRaisesRegex(ValueError, "already_pending"):
            self.store.propose_knowledge(
                self.project["id"], self.mission["id"], "reviewer", "Build command", "Use another command."
            )

        reviewed = project_memory.review_project_memory_proposal(
            self.store, proposal["id"], "user", "accept",
        )
        self.assertEqual(reviewed["proposal"]["status"], "accepted")
        self.assertEqual(reviewed["proposal"]["reviewed_by"], "user")
        self.assertEqual(reviewed["entry"]["content"], "Run npm run test.")
        self.assertEqual(reviewed["entry"]["created_by"], "builder")
        self.assertEqual(reviewed["entry"]["updated_by"], "user")
        self.assertEqual(reviewed["entry"]["id"], existing["id"])
        self.assertEqual(project_memory.read_project_memory(
            self.project["id"], existing["id"],
        )["content"], "Run npm run test.")

        archived = project_memory.set_project_memory_status(
            self.store, self.project["id"], existing["id"], "archived", self.mission["id"],
        )
        self.assertEqual(archived["status"], "archived")
        self.assertEqual(project_memory.list_project_memory(self.store, self.project["id"]), [])
        self.assertEqual(project_memory.list_project_memory(
            self.store, self.project["id"], include_archived=True,
        )[0]["status"], "archived")
        restored = project_memory.set_project_memory_status(
            self.store, self.project["id"], existing["id"], "active", self.mission["id"],
        )
        self.assertEqual(restored["status"], "active")
        self.assertEqual(project_memory.list_project_memory(
            self.store, self.project["id"],
        )[0]["content"], "Run npm run test.")
        event_types = [event["type"] for event in self.store.events_after(self.mission["id"], 0)]
        self.assertIn("knowledge.proposed", event_types)
        self.assertIn("knowledge.proposal.reviewed", event_types)
        self.assertIn("knowledge.entry.archived", event_types)
        self.assertIn("knowledge.entry.restored", event_types)

    def test_startup_memory_migration_imports_accepted_entries_and_enforces_project_scope(self) -> None:
        legacy = self.insert_legacy_memory("Build command", "Run npm test.")
        proposal = self.store.propose_knowledge(
            self.project["id"], self.mission["id"], "builder", "Release rule", "Tag after tests pass."
        )
        self.store.review_knowledge_proposal(proposal["id"], "user", "accept")
        other_workspace = self.root / "other-project"
        other_workspace.mkdir()
        other_project = self.store.register_project(str(other_workspace), "Other project")

        self.assertEqual(project_memory.migrate_all_project_memory(self.store), 2)
        self.assertEqual(project_memory.migrate_all_project_memory(self.store), 2)
        migration = project_memory.audit_project_memory_migration(self.store)
        self.assertEqual(migration["expected"], 2)
        self.assertEqual(migration["verified"], 2)
        self.assertEqual(migration["missing"], [])
        self.assertEqual(migration["conflicts"], [])

        project_memory._write(self.project["id"], {
            **legacy, "content": "Conflicting migrated content",
        })
        migration = project_memory.audit_project_memory_migration(self.store)
        self.assertEqual(migration["verified"], 1)
        self.assertEqual(migration["conflicts"][0]["entry_id"], legacy["id"])
        self.assertIn("content", migration["conflicts"][0]["fields"])
        project_memory._write(self.project["id"], legacy)

        entries = project_memory.list_project_memory(self.store, self.project["id"])
        self.assertEqual({entry["title"] for entry in entries}, {"Build command", "Release rule"})
        self.assertEqual(project_memory.read_project_memory(other_project["id"], legacy["id"]), None)
        self.assertEqual(
            project_memory.search_project_memory(self.store, self.project["id"], "release tag")[0]["title"],
            "Release rule",
        )

    def test_project_web_access_policy_is_opt_in_validated_and_audited(self) -> None:
        self.assertEqual(self.store.project_web_access(self.project["id"]), {
            "enabled": False, "allowedDomains": [],
        })
        saved = self.store.set_project_web_access(
            self.project["id"], True, ["docs.python.org", "React.dev", "docs.python.org."]
        )
        self.assertEqual(saved, {
            "enabled": True, "allowedDomains": ["docs.python.org", "react.dev"],
        })
        self.assertEqual(self.store.project_web_access(self.project["id"]), saved)
        event = self.store.events_after(self.mission["id"], 0)[-1]
        self.assertEqual(event["type"], "project.web_access.updated")
        self.assertEqual(event["payload"]["allowedDomains"], saved["allowedDomains"])
        with self.assertRaisesRegex(ValueError, "exact_hostnames"):
            self.store.set_project_web_access(self.project["id"], True, ["*.example.com"])
        with self.assertRaisesRegex(TypeError, "boolean"):
            self.store.set_project_web_access(self.project["id"], "yes", [])

    def test_project_computer_access_is_opt_in_and_audited(self) -> None:
        self.assertEqual(self.store.project_computer_access(self.project["id"]), {"enabled": False})
        self.assertEqual(
            self.store.set_project_computer_access(self.project["id"], True), {"enabled": True}
        )
        event = self.store.events_after(self.mission["id"], 0)[-1]
        self.assertEqual(event["type"], "project.computer_access.updated")
        self.assertEqual(event["payload"], {"enabled": True})
        with self.assertRaisesRegex(TypeError, "boolean"):
            self.store.set_project_computer_access(self.project["id"], "yes")

    def test_project_command_tools_are_scoped_validated_and_audited(self) -> None:
        self.assertEqual(self.store.project_command_tools(self.project["id"]), [])
        saved = self.store.set_project_command_tools(
            self.project["id"], ["terraform", "gh", "terraform"]
        )
        self.assertEqual(saved, ["gh", "terraform"])
        self.assertEqual(self.store.project_command_tools(self.project["id"]), saved)
        event = self.store.events_after(self.mission["id"], 0)[-1]
        self.assertEqual(event["type"], "project.command_tools.updated")
        self.assertEqual(event["payload"]["executables"], saved)
        other_repository = self.root / "other-repository"
        other_repository.mkdir()
        subprocess.run(["git", "init", "--quiet", str(other_repository)], check=True)
        other_project, _ = self.store.create_project(
            str(other_repository), "Other project", "Independent tools", "Keep policies separate"
        )
        self.assertEqual(self.store.project_command_tools(other_project["id"]), [])
        with self.assertRaisesRegex(ValueError, "without_a_path"):
            self.store.set_project_command_tools(self.project["id"], ["../terraform"])
        with self.assertRaisesRegex(ValueError, "at_most_100"):
            self.store.set_project_command_tools(self.project["id"], ["tool"] * 101)

    def test_project_reference_files_are_validated_persisted_and_audited(self) -> None:
        updated = self.store.update_project_goal(
            self.project["id"], self.mission["id"], "Build a dependable local tool.", ["README.md"]
        )
        self.assertEqual(updated["referenceFiles"], ["README.md"])
        self.assertEqual(self.store.project_for_mission(self.mission["id"])["referenceFiles"], ["README.md"])
        self.assertEqual(self.store.bootstrap(self.project["id"])["project"]["referenceFiles"], ["README.md"])
        event = self.store.events_after(self.mission["id"], 0)[-1]
        self.assertEqual(event["type"], "project.references.updated")
        self.assertEqual(event["payload"]["referenceFiles"], ["README.md"])
        with self.assertRaisesRegex(ValueError, "project_reference_path_invalid"):
            self.store.update_project_goal(
                self.project["id"], self.mission["id"], "Build a dependable local tool.", ["../private.md"]
            )

    def test_mission_archive_preserves_history_and_restores_prior_status(self) -> None:
        with self.assertRaisesRegex(ValueError, "pause_mission_before_archiving"):
            self.store.archive_mission(self.mission["id"])

        self.store.pause_mission(self.mission["id"])
        archived = self.store.archive_mission(self.mission["id"])
        self.assertIsNotNone(archived["archived_at"])
        self.assertEqual(archived["status"], "paused")
        self.assertIsNone(self.store.activate_mission(self.mission["id"]))
        self.assertIsNone(self.store.bootstrap(self.project["id"])["mission"])
        self.assertEqual(self.store.active_missions(), [])
        self.assertEqual(self.store.events_after(self.mission["id"], 0)[-1]["type"], "mission.archived")
        with self.assertRaisesRegex(ValueError, "mission_archived"):
            self.store.append("user.message", "user", self.mission["id"], {"text": "blocked"})

        restored = self.store.restore_mission(self.mission["id"])
        self.assertIsNone(restored["archived_at"])
        self.assertEqual(restored["status"], "paused")
        self.assertEqual(self.store.events_after(self.mission["id"], 0)[-1]["type"], "mission.restored")

    def test_mission_archive_and_restore_endpoints(self) -> None:
        from tribe_runtime import server as runtime_server

        self.store.pause_mission(self.mission["id"])
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                for action in ("archive", "restore"):
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{http.server_port}/api/missions/{self.mission['id']}/{action}",
                        data=b"{}",
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(request, timeout=3) as response:
                        result = json.loads(response.read())
                    self.assertEqual(response.status, 200)
                    self.assertEqual(bool(result["mission"]["archived_at"]), action == "archive")
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=2)

    def test_computer_observation_routes_keep_capture_payload_out_of_mission_events(self) -> None:
        import base64

        from tribe_runtime import server as runtime_server
        from tribe_runtime.computer_use import ComputerObservationBroker

        broker = ComputerObservationBroker()
        self.store.set_project_computer_access(self.project["id"], True)
        with patch.object(runtime_server, "STORE", self.store), patch.object(runtime_server, "COMPUTER", broker):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                origin = {"Origin": "http://localhost:5173"}

                def post(path: str, payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{http.server_port}{path}",
                        data=json.dumps(payload).encode(),
                        headers={**origin, "Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        response = urllib.request.urlopen(request, timeout=3)
                    except urllib.error.HTTPError as error:
                        with closing(error):
                            return error.code, json.loads(error.read())
                    with response:
                        return response.status, json.loads(response.read())

                def put(path: str, payload: dict) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{http.server_port}{path}",
                        data=json.dumps(payload).encode(),
                        headers={**origin, "Content-Type": "application/json"},
                        method="PUT",
                    )
                    try:
                        response = urllib.request.urlopen(request, timeout=3)
                    except urllib.error.HTTPError as error:
                        with closing(error):
                            return error.code, json.loads(error.read())
                    with response:
                        return response.status, json.loads(response.read())

                request = broker.create(self.mission["id"], "reviewer")
                token = broker.pending()[0]["completionToken"]
                status, claimed = post(
                    f"/api/computer/requests/{request['id']}/claim", {"completionToken": token},
                )
                self.assertEqual(status, 200)
                self.assertEqual(claimed["request"]["id"], request["id"])

                status, _ = post(f"/api/computer/requests/{request['id']}/complete", {
                    "completionToken": token,
                    "application": "Private editor",
                    "windowTitle": "Confidential draft",
                    "accessibilityText": "Private document contents",
                    "imageBase64": base64.b64encode(b"png-bytes").decode(),
                })
                self.assertEqual(status, 200)
                event = self.store.events_after(self.mission["id"], 0)[-1]
                self.assertEqual(event["type"], "computer.observation.completed")
                self.assertEqual(event["payload"], {"requestId": request["id"]})
                self.assertNotIn("Private editor", json.dumps(event))
                self.assertNotIn("Confidential draft", json.dumps(event))
                self.assertNotIn("Private document contents", json.dumps(event))

                status, result = post(
                    f"/api/computer/requests/{request['id']}/cancel",
                    {"completionToken": token},
                )
                self.assertEqual((status, result["status"]), (200, "cancelled"))
                self.assertIsNone(broker.wait(request["id"], timeout=0))

                cancelled = broker.create(self.mission["id"], "reviewer")
                cancel_token = broker.pending()[0]["completionToken"]
                status, result = post(
                    f"/api/computer/requests/{cancelled['id']}/cancel",
                    {"completionToken": cancel_token},
                )
                self.assertEqual((status, result["status"]), (200, "cancelled"))

                disabled_request = broker.create(self.mission["id"], "reviewer")
                status, result = put(
                    f"/api/projects/{self.project['id']}/computer-access", {"enabled": False},
                )
                self.assertEqual((status, result["computerAccess"]["enabled"]), (200, False))
                self.assertFalse(broker.is_live(disabled_request["id"]))
                self.store.set_project_computer_access(self.project["id"], True)

                waiting = broker.create(self.mission["id"], "reviewer")
                waiting_token = broker.pending()[0]["completionToken"]
                status, _ = post(f"/api/missions/{self.mission['id']}/pause", {})
                self.assertEqual(status, 200)
                self.assertEqual(broker.pending(), [])
                self.assertIsNone(broker.wait(waiting["id"], timeout=0))
                status, result = post(
                    f"/api/computer/requests/{waiting['id']}/claim",
                    {"completionToken": waiting_token},
                )
                self.assertEqual((status, result["error"]), (409, "observation_request_not_pending"))
            finally:
                broker.close()
                http.shutdown()
                http.server_close()
                thread.join(timeout=2)

    def test_project_approval_policy_is_persisted_validated_and_does_not_grant_tools(self) -> None:
        self.assertEqual(self.store.project_approval_policy(self.project["id"]), {"mode": "standard"})
        for mode in ("review_changes", "confirm_every_call"):
            self.assertEqual(self.store.set_project_approval_policy(self.project["id"], mode), {"mode": mode})
            self.assertEqual(
                self.store.project_approval_policy_for_mission(self.mission["id"]), mode,
            )
        with self.assertRaisesRegex(ValueError, "approval_mode_invalid"):
            self.store.set_project_approval_policy(self.project["id"], "allow_all")
        self.assertEqual(
            self.store.project_approval_policy_for_mission(self.mission["id"]),
            "confirm_every_call",
        )

        definition = AgentDefinition(
            "restricted", "Restricted", "Read only", "Inspect work", "restricted.md",
            tool_permissions=("read_repository_file",),
        )
        agent = _build_agent(definition, "openai:test-model")
        capabilities = build_capabilities(
            WorkspaceTools(self.store, self.mission["id"], definition.id),
            SkillCatalog(self.repository), tool_permissions=definition.tool_permissions,
            approval_mode="confirm_every_call",
        )
        granted_tools = {tool.name for tool in _tools_for_agent(
            agent, definition.repository_access, definition.tool_permissions,
        )}
        self.assertIn("read_repository_file", granted_tools)
        self.assertNotIn("write_repository_file", granted_tools)
        filesystem = next(
            (item for item in capabilities if type(item).__name__ == "FileSystem"), None,
        )
        self.assertNotIn("write_file", set(getattr(filesystem, "tools", ()) or ()))

    def test_approval_modes_pause_only_the_configured_harness_actions(self) -> None:
        if os.name != "posix":
            self.skipTest("Pydantic AI's native workspace Harness is supported on POSIX hosts only")
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build work", "builder.md",
            tool_permissions=("read_repository_file", "write_file"),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        skills = SkillCatalog(self.repository)
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Write and inspect a file"}
        )
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, skills,
            file_locks={}, pending_file_changes={}, trigger_sequence=trigger["sequence"],
        )
        agent = _build_agent(definition, "openai:test-model")
        expected_gates = {
            "standard": ("write_file", False),
            "review_changes": ("write_file", True),
            "confirm_every_call": ("read_repository_file", True),
        }

        for index, (mode, (tool_name, gated)) in enumerate(expected_gates.items()):
            with self.subTest(mode=mode):
                self.store.set_project_approval_policy(self.project["id"], mode)
                capabilities = build_capabilities(
                    workspace, skills, trigger_sequence=trigger["sequence"],
                    tool_permissions=definition.tool_permissions,
                )
                self.reveal_deferred_test_tools(agent, capabilities)
                failures: list[BaseException] = []

                class ApprovalModeModel(TestModel):
                    def gen_tool_args(self, tool_def):
                        if tool_def.name == "write_file":
                            return {"path": f"approval-{mode}.txt", "content": mode}
                        if tool_def.name == "read_repository_file":
                            return {"path": "README.md"}
                        return super().gen_tool_args(tool_def)

                test_model = ApprovalModeModel(call_tools=[tool_name], custom_output_text="action complete")

                def run_agent() -> None:
                    try:
                        with agent.override(model=test_model):
                            asyncio.run(agent.run(
                                f"Perform the action for approval mode test {index}.",
                                deps=dependencies,
                                capabilities=capabilities,
                                conversation_id=f"tribe:{self.mission['id']}:{definition.id}:approval-{mode}",
                            ))
                    except Exception as error:  # noqa: BLE001 - surfaced below
                        failures.append(error)

                worker = threading.Thread(target=run_agent)
                worker.start()
                interaction = None
                try:
                    if gated:
                        deadline = time.monotonic() + 10
                        while time.monotonic() < deadline:
                            pending = [item for item in self.store.pending_interactions()
                                       if item["mission_id"] == self.mission["id"]]
                            if pending:
                                interaction = pending[0]
                                break
                            time.sleep(0.05)
                        self.assertIsNotNone(interaction, f"{mode} did not ask before writing: {failures}")
                        self.assertIn(tool_name, interaction["details"])
                        approval = next(
                            row for row in self.store.deferred_tool_approvals(
                                self.mission["id"], definition.id,
                            ) if row["interaction_id"] == interaction["id"]
                        )
                        self.assertEqual(approval["status"], "pending")
                        if tool_name == "write_file":
                            self.assertFalse((self.repository / f"approval-{mode}.txt").exists())
                        self.store.resolve_interaction(interaction["id"], "approved_once")
                    worker.join(timeout=10)
                    self.assertFalse(worker.is_alive(), f"{mode} run did not finish")
                    self.assertFalse(failures, str(failures))
                    if gated:
                        approval = next(
                            row for row in self.store.deferred_tool_approvals(
                                self.mission["id"], definition.id,
                            ) if row["interaction_id"] == interaction["id"]
                        )
                        self.assertEqual(approval["status"], "consumed")
                    else:
                        self.assertEqual(self.store.pending_interactions(), [])
                finally:
                    worker.join(timeout=1)
                    if dependencies.file_locks is not None:
                        for lock in dependencies.file_locks.values():
                            lock.close()
                        dependencies.file_locks.clear()

    def test_web_search_requires_exact_approval_then_resumes_once(self) -> None:
        from ddgs.ddgs import DDGS
        from pydantic_ai import Agent
        from pydantic_ai.capabilities import WebFetch, WebSearch
        from pydantic_ai.models.test import TestModel
        from pydantic_ai_harness.step_persistence import SqliteStepStore

        workspace = WorkspaceTools(self.store, self.mission["id"], "researcher")
        skills = SkillCatalog(self.repository)
        capabilities = build_capabilities(
            workspace, skills, trigger_sequence=1,
            step_store=SqliteStepStore(database=self.store.data_dir / "web-approval-steps.sqlite3"),
            web_access={"enabled": True, "allowedDomains": ["docs.python.org"]},
            tool_permissions=("duckduckgo_search", "web_fetch"),
        )
        self.assertTrue(any(isinstance(capability, WebSearch) for capability in capabilities))
        fetch = next(capability for capability in capabilities if isinstance(capability, WebFetch))
        self.assertEqual(fetch.allowed_domains, ["docs.python.org"])
        agent = Agent(TestModel(call_tools=["duckduckgo_search"]))
        self.reveal_deferred_test_tools(agent, capabilities)
        failures: list[BaseException] = []

        def run_agent() -> None:
            try:
                asyncio.run(agent.run(
                    "Search the web for Python documentation.", capabilities=capabilities,
                    conversation_id=f"test:{self.mission['id']}:researcher",
                ))
            except Exception as error:  # noqa: BLE001 - capture worker failure for assertion
                failures.append(error)

        worker = threading.Thread(target=run_agent)
        with patch.object(DDGS, "text", return_value=[{
            "title": "Python documentation", "href": "https://docs.python.org/",
            "body": "The Python documentation.",
        }]) as search:
            worker.start()
            try:
                deadline = time.monotonic() + 10
                interaction = None
                while time.monotonic() < deadline:
                    pending = self.store.pending_interactions()
                    if pending:
                        interaction = pending[0]
                        break
                    time.sleep(0.05)
                self.assertIsNotNone(interaction, f"web search must pause before network access: {failures}")
                self.assertEqual(interaction["title"], "Search the public web")
                self.assertIn("Exact web request", interaction["details"])
                row = self.store.deferred_tool_approvals(self.mission["id"], "researcher")[0]
                self.assertEqual(row["tool_name"], "duckduckgo_search")
                self.assertFalse(search.called, "web search ran before the approval decision")
                self.store.resolve_interaction(interaction["id"], "approved_once")
                worker.join(timeout=10)
                self.assertFalse(worker.is_alive(), "approved web search did not resume")
                self.assertFalse(failures, str(failures))
                self.assertTrue(search.called)
                row = self.store.deferred_tool_approvals(self.mission["id"], "researcher")[0]
                self.assertEqual(row["status"], "consumed")
            finally:
                worker.join(timeout=1)

    def test_browser_action_requires_exact_approval_and_redacts_form_values(self) -> None:
        from pydantic_ai import Agent
        from pydantic_ai.models.test import TestModel
        from pydantic_ai_harness.step_persistence import SqliteStepStore

        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        capabilities = build_capabilities(
            workspace, SkillCatalog(self.repository), trigger_sequence=1,
            step_store=SqliteStepStore(database=self.store.data_dir / "browser-approval-steps.sqlite3"),
            tool_permissions=("browser_control",),
            approval_mode="confirm_every_call",
        )
        called: list[tuple[str, str]] = []
        agent = Agent(TestModel(call_tools=["browser_fill"]))

        @agent.tool_plain
        def browser_fill(selector: str, value: str) -> str:
            called.append((selector, value))
            return "filled"

        self.reveal_deferred_test_tools(agent, capabilities)
        failures: list[BaseException] = []

        def run_agent() -> None:
            try:
                asyncio.run(agent.run(
                    "Enter the supplied value in the page.",
                    capabilities=capabilities,
                    conversation_id=f"test:{self.mission['id']}:builder",
                ))
            except Exception as error:  # noqa: BLE001 - capture provider-thread failures for assertions
                failures.append(RuntimeError("".join(__import__("traceback").format_exception(error))))

        worker = threading.Thread(target=run_agent)
        worker.start()
        try:
            deadline = time.monotonic() + 10
            interaction = None
            while time.monotonic() < deadline:
                pending = self.store.pending_interactions()
                if pending:
                    interaction = pending[0]
                    break
                time.sleep(0.05)
            self.assertIsNotNone(interaction, f"browser action must pause; failures={failures}")
            self.assertEqual(interaction["title"], "Confirm agent action")
            self.assertEqual(interaction["target"], "Browser session")
            self.assertIn("text omitted", interaction["details"])
            row = self.store.deferred_tool_approvals(self.mission["id"], "builder")[0]
            self.assertEqual(row["tool_arguments"]["value"], "[redacted]")
            self.assertEqual(row["tool_arguments"]["selector"], "[redacted]")
            self.assertNotIn('"value":"a"', row["message_history"])
            self.assertEqual(called, [])
            self.store.resolve_interaction(interaction["id"], "approved_once")
            worker.join(timeout=10)
            self.assertFalse(worker.is_alive(), "approved browser action did not resume")
            self.assertFalse(failures, str(failures))
            self.assertEqual(called, [("a", "a")])
        finally:
            worker.join(timeout=1)

    def test_browser_click_schemas_use_each_browser_adapter_contract(self) -> None:
        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "builder.md",
            tool_permissions=("browser_control",),
        )
        agent = _build_agent(definition, "openai:test-model")

        click_schema = agent._function_toolset.tools["browser_click"].function_schema.json_schema
        self.assertEqual(click_schema["required"], ["ref"])
        self.assertNotIn("role", click_schema["properties"])

        hover_schema = agent._function_toolset.tools["browser_hover"].function_schema.json_schema
        self.assertEqual(hover_schema["required"], ["name"])
        self.assertEqual(hover_schema["properties"]["role"]["default"], "button")
        self.assertIn("button", hover_schema["properties"]["role"]["enum"])
        self.assertNotIn("selector", hover_schema["properties"])

        coordinate_schema = agent._function_toolset.tools["browser_click_at"].function_schema.json_schema
        self.assertEqual(coordinate_schema["required"], ["x", "y"])
        self.assertIn("browser_type", agent._function_toolset.tools)

    def test_mcp_secret_values_are_project_scoped_and_stored_in_the_os_keyring(self) -> None:
        registry = MCPRegistry(self.store)
        registry.save_config(self.project["id"], {
            "mcpServers": {"docs": {"command": "python", "env": {"DOCS_TOKEN": "${DOCS_TOKEN}"}}},
        })
        keyring_values = {}

        def save_secret(service, account, secret):
            keyring_values[(service, account)] = secret

        def get_secret(service, account):
            return keyring_values.get((service, account))

        with patch("keyring.set_password", side_effect=save_secret), patch(
            "keyring.get_password", side_effect=get_secret
        ), patch("keyring.delete_password"):
            self.assertEqual(registry.secret_status(self.project["id"]), {"DOCS_TOKEN": None})
            statuses = registry.save_secrets(self.project["id"], {"DOCS_TOKEN": "secret-value"})
            self.assertEqual(statuses, {"DOCS_TOKEN": "keychain"})
            config_path = registry.config_path(self.project["id"])
            self.assertNotIn(b"secret-value", config_path.read_bytes())
            runtime_config = registry._runtime_config(self.project["id"])
            self.assertEqual(runtime_config["mcpServers"]["docs"]["env"]["DOCS_TOKEN"], "secret-value")
            with self.assertRaisesRegex(ValueError, "only be set for environment references"):
                registry.save_secrets(self.project["id"], {"OTHER_SECRET": "no"})

    def test_mcp_registry_rejects_credentials_and_out_of_repository_working_directory(self) -> None:
        registry = MCPRegistry(self.store)
        with self.assertRaisesRegex(ValueError, "MCP URLs"):
            registry.validate({"mcpServers": {"remote": {"url": "http://example.com/mcp"}}})
        with self.assertRaisesRegex(ValueError, "MCP URLs"):
            registry.validate({"mcpServers": {"remote": {"url": "https://user:pass@example.com/mcp"}}})
        registry.save_config(self.project["id"], {
            "mcpServers": {"local": {"command": "python", "cwd": ".."}},
        })
        with self.assertRaisesRegex(ValueError, "inside the project"):
            registry.load_toolsets(self.project["id"])

    def test_pydantic_ai_invokes_a_project_configured_mcp_stdio_tool(self) -> None:
        from pydantic_ai import Agent
        from pydantic_ai.messages import ToolReturnPart

        server_script = self.repository / "mcp_server.py"
        server_script.write_text(
            """import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if not method or 'id' not in request:
        continue
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'],
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'test', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'ping', 'description': 'Return pong',
                             'inputSchema': {'type': 'object', 'properties': {}}}]}
    elif method == 'tools/call':
        result = {'content': [{'type': 'text', 'text': 'pong'}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}) + '\\n')
    sys.stdout.flush()
""",
            encoding="utf-8",
        )
        registry = MCPRegistry(self.store)
        registry.save_config(self.project["id"], {
            "mcpServers": {"fixture": {
                "command": sys.executable,
                "args": [str(server_script)],
                "cwd": ".",
                "readOnlyTools": ["ping"],
            }},
        })

        discovered = asyncio.run(registry.discover_tools(self.project["id"], "fixture"))
        self.assertEqual(discovered, [{
            "name": "ping", "description": "Return pong", "readOnly": True, "enabled": True,
        }])

        async def invoke():
            agent = Agent("test")
            return await agent.run("Call the ping tool.", toolsets=registry.load_toolsets(self.project["id"], ("mcp:*",)))

        result = asyncio.run(invoke())
        tool_results = [
            part.content
            for message in result.all_messages()
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        self.assertIn("pong", tool_results)

    def test_mutating_mcp_tool_waits_for_approval_and_resumes_the_saved_call(self) -> None:
        from pydantic_ai import Agent
        from pydantic_ai.models.test import TestModel
        from pydantic_ai_harness.step_persistence import SqliteStepStore

        marker = self.root / "mcp-action-ran.txt"
        server_script = self.repository / "mcp_mutation_server.py"
        server_script.write_text(
            """import json, pathlib, sys
marker = pathlib.Path(sys.argv[1])
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if not method or 'id' not in request:
        continue
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'],
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'test', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'write', 'description': 'Perform a mutation',
                             'inputSchema': {'type': 'object', 'properties': {}}}]}
    elif method == 'tools/call':
        with marker.open('a', encoding='utf-8') as output:
            output.write('called\\n')
        result = {'content': [{'type': 'text', 'text': 'mutation complete'}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}) + '\\n')
    sys.stdout.flush()
""",
            encoding="utf-8",
        )
        registry = MCPRegistry(self.store)
        registry.save_config(self.project["id"], {
            "mcpServers": {"fixture": {
                "command": sys.executable,
                "args": [str(server_script), str(marker)],
                "cwd": ".",
            }},
        })
        workspace = WorkspaceTools(self.store, self.mission["id"], "tester")
        skills = SkillCatalog(self.repository)
        step_store = SqliteStepStore(database=self.store.data_dir / "test-agent-steps.sqlite3")
        capabilities = build_capabilities(
            workspace, skills, trigger_sequence=1, step_store=step_store,
            mcp_registry=registry, project_id=self.project["id"],
        )
        agent = Agent(TestModel(call_tools=["fixture_write"]))
        outcome: list[object] = []
        failures: list[BaseException] = []

        def run_agent() -> None:
            try:
                outcome.append(asyncio.run(agent.run(
                    "Call fixture.write now.",
                    deps=None,
                    capabilities=capabilities,
                    toolsets=registry.load_toolsets(self.project["id"], ("mcp:*",)),
                    conversation_id=f"test:{self.mission['id']}:tester",
                )))
            except Exception as error:  # noqa: BLE001 - capture provider-thread failures for assertions
                failures.append(error)

        worker = threading.Thread(target=run_agent)
        worker.start()
        try:
            deadline = time.monotonic() + 10
            interaction = None
            while time.monotonic() < deadline:
                pending = self.store.pending_interactions()
                if pending:
                    interaction = pending[0]
                    break
                time.sleep(0.05)
            self.assertIsNotNone(
                interaction,
                f"mutating MCP calls must request approval; failures={failures}; "
                f"events={[event['type'] for event in self.store.events_after(self.mission['id'], 0)]}",
            )
            self.assertFalse(marker.exists(), "MCP side effects must wait for approval")
            self.assertEqual(interaction["target"], "MCP server fixture · write")
            self.assertIn("fixture.write", interaction["details"])
            waiting_event = next(
                event for event in self.store.events_after(self.mission["id"], 0)
                if event["type"] == "agent.tool.waiting_for_user"
            )
            self.assertEqual(waiting_event["payload"]["triggerSequence"], 1)
            self.assertEqual(waiting_event["payload"]["outcome"], "approval_pending")
            self.store.resolve_interaction(interaction["id"], "approved_once")
            worker.join(timeout=10)
            self.assertFalse(worker.is_alive(), "approved deferred MCP call did not resume")
            self.assertFalse(
                failures,
                f"{failures}; events={[event['type'] for event in self.store.events_after(self.mission['id'], 0)]}; "
                f"approvals={self.store.deferred_tool_approvals(self.mission['id'], 'tester')}",
            )
            self.assertTrue(outcome)
            self.assertEqual(marker.read_text(encoding="utf-8"), "called\n")
        finally:
            worker.join(timeout=1)

    def test_claim_is_exclusive_per_agent_and_shared_across_agents(self) -> None:
        first = self.store.create_work_item(self.mission["id"], "First")
        second = self.store.create_work_item(self.mission["id"], "Second")
        builder_claim = self.store.claim_work(self.mission["id"], "builder")
        builder_repeat = self.store.claim_work(self.mission["id"], "builder")
        reviewer_claim = self.store.claim_work(self.mission["id"], "reviewer")

        self.assertEqual(builder_claim["id"], first["id"])
        self.assertEqual(builder_repeat["id"], first["id"])
        self.assertEqual(reviewer_claim["id"], second["id"])
        self.assertEqual(self.store.renew_work_claims(self.mission["id"], "builder"), 1)
        self.assertIsNone(self.store.complete_work(first["id"], "reviewer", "wrong owner"))

    def test_agent_can_release_only_its_own_claim_for_another_role(self) -> None:
        item = self.store.create_work_item(self.mission["id"], "Independent review")
        claimed = self.store.claim_work(self.mission["id"], "builder", work_item_id=item["id"])

        self.assertIsNone(self.store.release_work_claim(
            self.mission["id"], "reviewer", item["id"], "wrong owner",
        ))
        released = self.store.release_work_claim(
            self.mission["id"], "builder", item["id"], "This task is assigned to the reviewer",
        )

        self.assertEqual(claimed["owner"], "builder")
        self.assertEqual(released["status"], "ready")
        self.assertIsNone(released["owner"])
        event = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "plan.item.released"
        )
        self.assertEqual(event["actorId"], "builder")
        self.assertEqual(event["payload"]["reason"], "This task is assigned to the reviewer")
        self.assertEqual(
            self.store.claim_work(self.mission["id"], "reviewer", work_item_id=item["id"])["owner"],
            "reviewer",
        )

    def test_harness_node_test_results_become_idempotent_durable_verification_events(self) -> None:
        output = """[stdout]
TAP version 13
1..2
# tests 2
# pass 2
# fail 0
"""
        first = self.store.record_harness_node_test_result(
            self.mission["id"], "builder", 17, "shell-call-1",
            "node --test habit-tracker/test/habits.test.js", output, "task-1", "tool-event-1",
        )
        duplicate = self.store.record_harness_node_test_result(
            self.mission["id"], "builder", 17, "shell-call-1",
            "node --test habit-tracker/test/habits.test.js", output, "task-1",
        )

        self.assertEqual(first["id"], duplicate["id"])
        self.assertEqual(first["type"], "repo.test_run.completed")
        self.assertEqual(first["payload"]["exitCode"], 0)
        self.assertEqual(first["payload"]["testCount"], 2)
        self.assertEqual(first["payload"]["sourceToolCallId"], "shell-call-1")
        self.assertEqual(first["payload"]["sourceToolEventId"], "tool-event-1")

    def test_harness_test_evidence_rejects_incomplete_or_non_test_output(self) -> None:
        self.assertIsNone(self.store.record_harness_node_test_result(
            self.mission["id"], "builder", 18, "shell-call-2",
            "node --test habit-tracker/test/habits.test.js", "[Command timed out after 30s]", "task-1",
        ))
        self.assertIsNone(self.store.record_harness_node_test_result(
            self.mission["id"], "builder", 18, "shell-call-3",
            "node -e console.log('tests passed')", "tests passed", "task-1",
        ))

    def test_agent_can_self_claim_a_selected_eligible_item(self) -> None:
        first = self.store.create_work_item(self.mission["id"], "Review the design")
        second = self.store.create_work_item(self.mission["id"], "Implement the fix")

        claim = self.store.claim_work(
            self.mission["id"], "builder", work_item_id=second["id"],
        )

        self.assertEqual(claim["id"], second["id"])
        self.assertEqual(claim["owner"], "builder")
        self.assertIsNone(self.store.claim_work(
            self.mission["id"], "reviewer", work_item_id=second["id"],
        ))
        self.assertIsNone(self.store.claim_work(
            self.mission["id"], "builder", work_item_id=first["id"],
        ), "one agent must not accumulate parallel active claims")
        self.assertEqual(
            self.store.claim_work(self.mission["id"], "reviewer")["id"], first["id"],
        )

    def test_selected_claim_rejects_blocked_or_foreign_work_item(self) -> None:
        prerequisite = self.store.create_work_item(self.mission["id"], "Inspect")
        blocked = self.store.create_work_item(
            self.mission["id"], "Implement", depends_on=[prerequisite["id"]],
        )
        other_mission = self.store.create_mission(
            self.project["id"], "Other mission", "Keep this task scoped to another mission.",
        )
        foreign = self.store.create_work_item(other_mission["id"], "Foreign task")

        self.assertIsNone(self.store.claim_work(
            self.mission["id"], "builder", work_item_id=blocked["id"],
        ))
        self.assertIsNone(self.store.claim_work(
            self.mission["id"], "builder", work_item_id=foreign["id"],
        ))
        self.assertEqual(
            self.store.claim_work(self.mission["id"], "builder")["id"], prerequisite["id"],
        )

    def test_concurrent_selected_claims_grant_one_owner(self) -> None:
        item = self.store.create_work_item(self.mission["id"], "Shared implementation task")
        gate = threading.Barrier(3)
        results: dict[str, dict | None] = {}

        def claim(agent_id: str) -> None:
            gate.wait()
            results[agent_id] = self.store.claim_work(
                self.mission["id"], agent_id, work_item_id=item["id"],
            )

        workers = [threading.Thread(target=claim, args=(agent,)) for agent in ("builder", "reviewer")]
        for worker in workers:
            worker.start()
        gate.wait()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        winners = [agent for agent, claimed in results.items() if claimed is not None]
        self.assertEqual(len(winners), 1)
        self.assertEqual(self.store.work_items(self.mission["id"])[0]["owner"], winners[0])

    def test_expired_claim_cannot_be_renewed_or_completed_by_its_previous_owner(self) -> None:
        item = self.store.create_work_item(self.mission["id"], "Expiring task")
        previous_claim = self.store.claim_work(self.mission["id"], "builder")
        with self.store._connect() as db:
            db.execute(
                "UPDATE work_items SET lease_until = ? WHERE id = ?",
                ("2000-01-01T00:00:00+00:00", item["id"]),
            )

        self.assertIsNone(self.store.active_work_item_id(self.mission["id"], "builder"))
        self.assertEqual(self.store.renew_work_claims(self.mission["id"], "builder"), 0)
        self.assertIsNone(self.store.complete_work(item["id"], "builder", "stale result"))
        with self.assertRaisesRegex(PermissionError, "current claim owner"):
            self.store.revise_work_item(
                self.mission["id"], item["id"], "builder", "Stale edit", "Must be rejected",
            )

        current_claim = self.store.claim_work(self.mission["id"], "reviewer")
        self.assertEqual(current_claim["id"], item["id"])
        self.assertNotEqual(previous_claim["owner"], current_claim["owner"])
        self.assertIsNone(self.store.complete_work(item["id"], "builder", "stale result"))
        self.assertIsNotNone(self.store.complete_work(item["id"], "reviewer", "current result"))

    def test_prerequisites_gate_atomic_agent_claims_and_show_blockers(self) -> None:
        discovery = self.store.create_work_item(self.mission["id"], "Inspect the repository")
        implementation = self.store.create_work_item(
            self.mission["id"], "Implement the change", "Acceptance: feature works", "planner",
            depends_on=[discovery["id"]],
        )

        self.assertEqual(implementation["status"], "blocked")
        self.assertEqual(implementation["blocked_by"], [discovery["id"]])
        self.assertEqual(self.store.claim_work(self.mission["id"], "builder")["id"], discovery["id"])
        self.assertIsNone(self.store.claim_work(self.mission["id"], "reviewer"))
        self.assertIsNotNone(self.store.complete_work(discovery["id"], "builder", "Repository inspected"))
        claimed = self.store.claim_work(self.mission["id"], "reviewer")

        self.assertEqual(claimed["id"], implementation["id"])
        self.assertEqual(claimed["status"], "claimed")
        listed = {item["id"]: item for item in self.store.work_items(self.mission["id"])}
        self.assertEqual(listed[implementation["id"]]["blocked_by"], [])

    def test_database_backup_is_consistent_and_restorable(self) -> None:
        self.store.append("message.created", "user", self.mission["id"], {"text": "Keep this event"})
        backup = self.root / "backups" / "tribe.sqlite3"

        self.store.backup_to(backup)
        restored = MissionStore(backup)

        self.assertEqual(restored.project(self.project["id"])["name"], self.project["name"])
        self.assertEqual(
            [event["payload"].get("text") for event in restored.events_after(self.mission["id"], 0)
             if event["type"] == "message.created"],
            ["Keep this event"],
        )

    def test_workspace_backup_restores_shared_artifact_content_portably(self) -> None:
        self.store.append("message.created", "user", self.mission["id"], {"text": "Keep this event"})
        artifact, _ = self.store.add_artifact(
            self.mission["id"], "diagram.mmd", "text/markdown", "user", b"graph TD; A-->B"
        )
        with closing(sqlite3.connect(self.store.data_dir / "agent_steps.sqlite3")) as step_db:
            step_db.execute("CREATE TABLE retained_context (value TEXT NOT NULL)")
            step_db.execute("INSERT INTO retained_context VALUES ('kept')")
            step_db.commit()
        backup = self.root / "backups" / "workspace.tribe-backup"
        restored_directory = self.root / "restored-workspace"
        backup.parent.mkdir(parents=True)

        from tribe_runtime import server as runtime_server

        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{http.server_port}/api/backup", timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    backup.write_bytes(response.read())
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=2)
        with zipfile.ZipFile(io.BytesIO(backup.read_bytes())) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["format"], "tribe-workspace-backup")
            self.assertEqual(len(manifest["artifacts"]), 1)
            self.assertEqual(manifest["agentState"]["path"], "agent_steps.sqlite3")
        restored = MissionStore.restore_workspace_backup(backup, restored_directory)

        self.assertEqual(restored.project(self.project["id"])["name"], self.project["name"])
        restored_artifact, content = restored.artifact_content(artifact["id"], self.mission["id"])
        self.assertEqual(restored_artifact["name"], "diagram.mmd")
        self.assertEqual(content, b"graph TD; A-->B")
        with closing(sqlite3.connect(restored_directory / "agent_steps.sqlite3")) as step_db:
            self.assertEqual(step_db.execute("SELECT value FROM retained_context").fetchone()[0], "kept")
        self.assertEqual(
            [event["payload"].get("text") for event in restored.events_after(self.mission["id"], 0)
             if event["type"] == "message.created"],
            ["Keep this event"],
        )

    def test_workspace_restore_is_staged_then_activated_without_losing_local_configuration(self) -> None:
        self.store.append("message.created", "user", self.mission["id"], {"text": "Backed up"})
        artifact, _ = self.store.add_artifact(
            self.mission["id"], "diagram.mmd", "text/markdown", "user", b"graph TD; A-->B"
        )
        backup = self.root / "backups" / "workspace.tribe-backup"
        backup.parent.mkdir(parents=True)
        self.store.write_workspace_backup(backup)
        config_root = self.store.data_dir
        for directory, filename in (("agents", "custom.md"), ("recipes", "custom.md"), ("mcp", "config.json")):
            target = config_root / directory
            target.mkdir(exist_ok=True)
            (target / filename).write_text("local config", encoding="utf-8")

        restore = WorkspaceRestore(config_root)
        summary = restore.stage(backup)
        self.store.append("message.created", "user", self.mission["id"], {"text": "After backup"})

        self.assertEqual(summary, {"projects": 1, "missions": 1, "artifacts": 1, "preservedSettings": ["agents", "recipes", "mcp"]})
        self.assertEqual(
            [event["payload"].get("text") for event in self.store.events_after(self.mission["id"], 0)
             if event["type"] == "message.created"],
            ["Backed up", "After backup"],
        )
        self.assertIsNone(restore.activate_pending())

        restored = MissionStore(config_root / "tribe.sqlite3")
        restored_events = [
            event["payload"].get("text") for event in restored.events_after(self.mission["id"], 0)
            if event["type"] == "message.created"
        ]
        self.assertEqual(restored_events, ["Backed up"])
        for directory, filename in (("agents", "custom.md"), ("recipes", "custom.md"), ("mcp", "config.json")):
            self.assertEqual((config_root / directory / filename).read_text(encoding="utf-8"), "local config")
        restored_artifact, content = restored.artifact_content(artifact["id"], self.mission["id"])
        self.assertEqual(restored_artifact["name"], "diagram.mmd")
        self.assertEqual(content, b"graph TD; A-->B")

    def test_workspace_restore_refuses_live_work(self) -> None:
        self.assertIn("active_missions", self.store.workspace_restore_blockers())

    def test_failed_workspace_restore_rolls_back_to_current_data(self) -> None:
        self.store.append("message.created", "user", self.mission["id"], {"text": "Keep current data"})
        backup = self.root / "workspace.tribe-backup"
        self.store.write_workspace_backup(backup)
        restore = WorkspaceRestore(self.store.data_dir)
        restore.stage(backup)
        marker = json.loads(restore.marker.read_text(encoding="utf-8"))
        stage = restore.parent / marker["stage"]
        (stage / "tribe.sqlite3").write_bytes(b"not a database")

        error = restore.activate_pending()

        self.assertIn("could not be activated", error)
        self.assertEqual(self.store.project(self.project["id"])["name"], self.project["name"])
        messages = [event["payload"].get("text") for event in self.store.events_after(self.mission["id"], 0)
                    if event["type"] == "message.created"]
        self.assertEqual(messages, ["Keep current data"])

    def test_restore_endpoint_stages_backup_and_blocks_writes_until_shutdown(self) -> None:
        from tribe_runtime import server as runtime_server

        self.store.pause_mission(self.mission["id"])
        backup = self.root / "workspace.tribe-backup"
        self.store.write_workspace_backup(backup)
        runtime_server.RESTORE_PENDING.clear()

        class ShutdownStub:
            @staticmethod
            def close() -> None:
                return None

        with (patch.object(runtime_server, "STORE", self.store),
              patch.object(runtime_server, "COMMANDS", ShutdownStub()),
              patch.object(runtime_server, "SUPERVISOR", ShutdownStub())):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/backup/restore",
                    data=backup.read_bytes(),
                    headers={"Content-Type": "application/octet-stream", "Origin": "http://127.0.0.1:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 202)
                    self.assertEqual(json.loads(response.read())["status"], "staged")
                followup = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/settings",
                    data=b"{}", headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:5173"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(followup, timeout=5)
                self.assertEqual(error.exception.code, 503)
                error.exception.close()
            finally:
                thread.join(timeout=3)
                if thread.is_alive():
                    http.shutdown()
                    thread.join(timeout=2)
                http.server_close()
                runtime_server.RESTORE_PENDING.clear()

        restored = WorkspaceRestore(self.store.data_dir)
        self.assertTrue(restored.marker.exists())
        self.assertIsNone(restored.activate_pending())
        self.assertEqual(MissionStore(self.store.path).project(self.project["id"])["name"], self.project["name"])

    def test_image_generation_settings_accept_current_models_and_preserve_legacy_choice(self) -> None:
        from tribe_runtime import server as runtime_server

        with (patch.object(runtime_server, "STORE", self.store),
              patch.object(runtime_server, "get_api_key", return_value="test-key")):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                for model in (
                    "google:gemini-3.1-flash-lite-image",
                    "google:gemini-3-pro-image",
                    "xai:grok-imagine-image-2.0",
                    "xai:grok-imagine-image",
                ):
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{http.server_port}/api/settings/image-generation",
                        data=json.dumps({"model": model}).encode(),
                        headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:5173"},
                        method="PUT",
                    )
                    with urllib.request.urlopen(request, timeout=5) as response:
                        self.assertEqual(json.loads(response.read()), {"model": model})
                    self.assertEqual(self.store.get_setting("image_generation_model"), model)
            finally:
                http.shutdown()
                thread.join(timeout=3)
                http.server_close()

    def test_project_audit_export_contains_mission_events_and_artifact_metadata(self) -> None:
        self.store.append("message.created", "user", self.mission["id"], {"text": "Audit this"})
        artifact, _ = self.store.add_artifact(
            self.mission["id"], "review.md", "text/markdown", "reviewer", b"Reviewed output"
        )
        archive = self.root / "exports" / "project-audit.json"

        self.store.write_project_audit_export(self.project["id"], archive)

        exported = json.loads(archive.read_text(encoding="utf-8"))
        self.assertEqual(exported["format"], "tribe.project-audit")
        self.assertEqual(exported["schemaVersion"], 1)
        self.assertNotIn("repository", exported["project"])
        mission = exported["missions"][0]
        self.assertTrue(any(
            event["type"] == "message.created" and event["payload"].get("text") == "Audit this"
            for event in mission["events"]
        ))
        artifact_event = next(event for event in mission["events"] if event["type"] == "artifact.created")
        self.assertNotIn("path", artifact_event["payload"]["artifact"])
        self.assertEqual(mission["artifacts"][0]["id"], artifact["id"])
        self.assertNotIn(str(artifact["path"]), archive.read_text(encoding="utf-8"))

    def test_artifact_review_threads_are_version_anchored_and_publish_mission_events(self) -> None:
        artifact, _ = self.store.add_artifact(
            self.mission["id"], "design.svg", "image/svg+xml", "planner", b"<svg><path d='M0 0'/></svg>"
        )
        first, created_event = self.store.add_artifact_review_comment(
            artifact["id"], "Please label this transition", "user",
            {"type": "image_point", "x": 0.25, "y": 0.5},
        )
        _, reply_event = self.store.add_artifact_review_comment(
            artifact["id"], "I will update the diagram", "designer", thread_id=first["threadId"]
        )
        reviews = self.store.artifact_reviews(artifact["id"])

        self.assertEqual(len(reviews), 1)
        self.assertEqual(reviews[0]["anchor"], {"type": "image_point", "x": 0.25, "y": 0.5})
        self.assertEqual(reviews[0]["version_hash"], hashlib.sha256(b"<svg><path d='M0 0'/></svg>").hexdigest())
        self.assertEqual([comment["author_id"] for comment in reviews[0]["comments"]], ["user", "designer"])
        self.assertEqual(created_event["type"], "artifact.review.comment.created")
        self.assertEqual(created_event["payload"]["anchor"], {"type": "image_point", "x": 0.25, "y": 0.5})
        self.assertEqual(reply_event["payload"]["threadId"], first["threadId"])
        self.assertIsNone(self.store.artifact_content(artifact["id"], mission_id="another-mission"))
        with self.assertRaisesRegex(ValueError, "artifact_not_found"):
            self.store.artifact_reviews(artifact["id"], mission_id="another-mission")

        resolved, event = self.store.resolve_artifact_review_thread(first["threadId"])
        self.assertEqual(resolved["status"], "resolved")
        self.assertEqual(event["type"], "artifact.review.thread.resolved")
        with self.assertRaisesRegex(ValueError, "artifact_review_thread_resolved"):
            self.store.add_artifact_review_comment(
                artifact["id"], "Late reply", "user", thread_id=first["threadId"]
            )
        reopened, reopened_event = self.store.reopen_artifact_review_thread(first["threadId"])
        self.assertEqual(reopened["status"], "open")
        self.assertIsNone(reopened["resolved_at"])
        self.assertEqual(reopened_event["type"], "artifact.review.thread.reopened")
        self.assertEqual(reopened_event["payload"]["versionHash"], reviews[0]["version_hash"])
        _, continued_event = self.store.add_artifact_review_comment(
            artifact["id"], "The diagram now includes that label", "planner",
            thread_id=first["threadId"],
        )
        self.assertEqual(continued_event["payload"]["threadId"], first["threadId"])

    def test_artifact_review_thread_reopen_api_returns_updated_thread_and_event(self) -> None:
        from tribe_runtime import server as runtime_server

        artifact, _ = self.store.add_artifact(
            self.mission["id"], "notes.md", "text/markdown", "planner", b"Review notes"
        )
        thread, _ = self.store.add_artifact_review_comment(
            artifact["id"], "Please clarify this section", "user"
        )
        self.store.resolve_artifact_review_thread(thread["threadId"])
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            server_thread = threading.Thread(target=http.serve_forever, daemon=True)
            server_thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/artifact-review-threads/"
                    f"{thread['threadId']}/reopen",
                    data=json.dumps({"actorId": "user"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    result = json.loads(response.read())
            finally:
                http.shutdown()
                http.server_close()
                server_thread.join(timeout=2)

        self.assertEqual(result["thread"]["status"], "open")
        self.assertIsNone(result["thread"]["resolved_at"])
        self.assertEqual(result["event"]["type"], "artifact.review.thread.reopened")
        self.assertEqual(result["event"]["payload"]["artifactId"], artifact["id"])

    def test_canvas_document_proposals_comments_and_revisions_are_durable(self) -> None:
        user_document, user_event = self.store.create_canvas_document(
            self.mission["id"], "Review notes", "markdown", "", "# Notes",
        )
        self.assertEqual((user_document["revision"], user_document["author"]), (1, "user"))
        self.assertEqual(user_event["type"], "canvas.document.created")

        publication = (
            "I drafted the architecture note.\n```canvas:v1\n"
            '{"title":"Architecture","kind":"markdown","body":"# Current\\nOriginal"}'
            "\n```"
        )
        source = self.store.append_agent_update(self.mission["id"], "planner", publication)
        self.assertEqual(source["payload"]["channelAudience"], "activity")
        direct = self.store.append_agent_update(self.mission["id"], "planner", "Please review this.", "reviewer")
        self.assertEqual(direct["payload"]["channelAudience"], "conversation")
        documents = self.store.canvas_documents(self.mission["id"])
        document = documents[0]
        document_id = document["id"]
        self.assertEqual(document["revision"], 1)
        self.assertEqual(self.store.canvas_document(self.mission["id"], document_id)["current"]["body"], "# Current\nOriginal")
        self.assertEqual(source["payload"]["text"], "I drafted the architecture note.")

        proposal_text = (
            f'```canvas:v1\n{{"artifact_id":"{document_id}","base_revision":1,'
            '"title":"Architecture","kind":"markdown","body":"# Current\\nRevised"}\n```'
        )
        proposal_source = self.store.append_agent_update(self.mission["id"], "builder", proposal_text)
        proposal = self.store.canvas_document(self.mission["id"], document_id)["proposals"][0]
        self.assertEqual(proposal["status"], "pending")
        self.assertEqual(proposal["source_event_sequence"], proposal_source["sequence"])

        comment, comment_event = self.store.create_canvas_comment(
            self.mission["id"], document_id, "Please explain this change", "user",
            base_revision=1, quote="Original", start_offset=10, end_offset=18, assignee="reviewer",
        )
        self.assertEqual(comment_event["type"], "canvas.comment.created")
        reply_text = (
            f'```canvas-comment:v1\n{{"artifact_id":"{document_id}",'
            f'"thread_id":"{comment["threadId"]}","body":"I will clarify it."}}\n```'
        )
        self.store.append_agent_update(self.mission["id"], "reviewer", reply_text)
        detail = self.store.canvas_document(self.mission["id"], document_id)
        self.assertEqual([item["author"] for item in detail["threads"][0]["comments"]], ["user", "reviewer"])

        accepted, accepted_event = self.store.review_canvas_proposal(
            self.mission["id"], proposal["id"], "accept",
        )
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(accepted_event["type"], "canvas.proposal.accepted")
        self.assertEqual(self.store.canvas_document(self.mission["id"], document_id)["revision"], 2)
        with self.assertRaisesRegex(ValueError, "canvas_revision_conflict"):
            self.store.save_canvas_document(
                self.mission["id"], document_id, 1, "Architecture", "markdown", "", "stale edit",
            )
        with self.assertRaisesRegex(ValueError, "canvas_comment_selection_invalid"):
            self.store.create_canvas_comment(
                self.mission["id"], document_id, "Invalid anchor", "user",
                base_revision=2, start_offset="1", end_offset=2,
            )

    def test_canvas_document_links_share_one_revision_history_and_isolate_mission_collaboration(self) -> None:
        target = self.store.create_mission(self.project["id"], "Follow-up", "Continue the design")
        document, _ = self.store.create_canvas_document(
            self.mission["id"], "Shared design", "markdown", "", "Initial design",
        )
        source_comment, _ = self.store.create_canvas_comment(
            self.mission["id"], document["id"], "Source mission note", "user", base_revision=1,
        )

        self.assertIsNone(self.store.canvas_document(target["id"], document["id"]))
        linked, link_event = self.store.link_canvas_document(target["id"], document["id"])
        self.assertEqual(linked["id"], document["id"])
        self.assertEqual(link_event["type"], "canvas.document.linked")
        self.assertEqual(self.store.canvas_documents(target["id"])[0]["is_linked"], 1)
        self.assertEqual(self.store.canvas_document(target["id"], document["id"])["threads"], [])

        target_comment, _ = self.store.create_canvas_comment(
            target["id"], document["id"], "Follow-up mission note", "user", base_revision=1,
        )
        proposal_source = self.store.append_agent_update(
            target["id"], "builder",
            f'```canvas:v1\n{{"artifact_id":"{document["id"]}","base_revision":1,'
            '"title":"Shared design","kind":"markdown","body":"Revised design"}\n```',
        )
        target_detail = self.store.canvas_document(target["id"], document["id"])
        self.assertEqual([thread["id"] for thread in target_detail["threads"]], [target_comment["threadId"]])
        self.assertEqual(target_detail["proposals"][0]["source_event_sequence"], proposal_source["sequence"])
        self.assertEqual(
            [thread["id"] for thread in self.store.canvas_document(self.mission["id"], document["id"])["threads"]],
            [source_comment["threadId"]],
        )

        accepted, _ = self.store.review_canvas_proposal(target["id"], target_detail["proposals"][0]["id"], "accept")
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(self.store.canvas_document(self.mission["id"], document["id"])["current"]["body"], "Revised design")
        removed = self.store.unlink_canvas_document(target["id"], document["id"])
        self.assertEqual(removed["event"]["type"], "canvas.document.unlinked")
        self.assertIsNone(self.store.canvas_document(target["id"], document["id"]))
        self.assertIsNotNone(self.store.canvas_document(self.mission["id"], document["id"]))

        other_repository = self.root / "other-repository"
        other_repository.mkdir()
        subprocess.run(["git", "init", "-q", str(other_repository)], check=True)
        _, foreign_mission = self.store.create_project(
            str(other_repository), "Other project", "Different mission", "Project boundary check",
        )
        with self.assertRaisesRegex(ValueError, "canvas_document_project_mismatch"):
            self.store.link_canvas_document(foreign_mission["id"], document["id"])

    def test_canvas_stale_proposal_is_rejected_and_marked_stale(self) -> None:
        document, _ = self.store.create_canvas_document(
            self.mission["id"], "Plan", "markdown", "", "Initial",
        )
        proposal_post = self.store.append_agent_update(
            self.mission["id"], "builder",
            f'```canvas:v1\n{{"artifact_id":"{document["id"]}","base_revision":1,'
            '"title":"Plan","kind":"markdown","body":"Proposed"}\n```',
        )
        proposal = self.store.canvas_document(self.mission["id"], document["id"])["proposals"][0]
        self.assertEqual(proposal["source_event_sequence"], proposal_post["sequence"])
        self.store.save_canvas_document(
            self.mission["id"], document["id"], 1, "Plan", "markdown", "", "User edit",
        )

        with self.assertRaisesRegex(ValueError, "canvas_proposal_stale"):
            self.store.review_canvas_proposal(self.mission["id"], proposal["id"], "accept")

        updated = self.store.canvas_document(self.mission["id"], document["id"])
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["current"]["body"], "User edit")
        self.assertEqual(updated["proposals"][0]["status"], "stale")
        self.assertTrue(any(
            event["type"] == "canvas.proposal.stale"
            for event in self.store.events_after(self.mission["id"], proposal_post["sequence"])
        ))

    def test_canvas_proposal_acceptance_can_publish_a_selected_revision(self) -> None:
        document, _ = self.store.create_canvas_document(
            self.mission["id"], "Plan", "markdown", "", "Current text",
        )
        self.store.append_agent_update(
            self.mission["id"], "builder",
            f'```canvas:v1\n{{"artifact_id":"{document["id"]}","base_revision":1,'
            '"title":"Plan","kind":"markdown","body":"Agent text"}\n```',
        )
        proposal = self.store.canvas_document(self.mission["id"], document["id"])["proposals"][0]
        accepted, event = self.store.review_canvas_proposal(
            self.mission["id"], proposal["id"], "accept", accepted_content={
                "title": "Plan", "kind": "markdown", "language": "", "body": "Selected text",
            },
        )
        detail = self.store.canvas_document(self.mission["id"], document["id"])
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(detail["current"]["body"], "Selected text")
        self.assertEqual(detail["current"]["author"], "user")
        self.assertTrue(event["payload"]["selectedContent"])
        with self.assertRaisesRegex(ValueError, "canvas_proposal_content_invalid"):
            self.store.review_canvas_proposal(
                self.mission["id"], proposal["id"], "accept", accepted_content={"body": "bad"},
            )

    def test_project_audit_export_requires_an_existing_project(self) -> None:
        with self.assertRaisesRegex(ValueError, "project_not_found"):
            self.store.write_project_audit_export("missing-project", self.root / "missing.json")

    def test_mission_completion_waits_for_live_claims_without_gating_ready_plan_items(self) -> None:
        active_item = self.store.create_work_item(self.mission["id"], "Finish the active fix")
        claim = self.store.claim_work(
            self.mission["id"], "builder", work_item_id=active_item["id"],
        )
        self.assertIsNotNone(claim)

        with self.assertRaisesRegex(ValueError, "mission_has_work_in_progress"):
            self.store.complete_mission(self.mission["id"], "reviewer", "Everything is complete")
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "active")

        self.store.complete_work(active_item["id"], "builder", "Fix completed")
        completed = self.store.complete_mission(
            self.mission["id"], "planner", "The requested work is complete.",
        )
        self.assertEqual(completed["mission"]["status"], "completed")

    def test_completion_does_not_require_plan_work_but_resolves_user_requests_and_validates_supplied_evidence(self) -> None:
        with self.assertRaisesRegex(ValueError, "mission_must_be_completed"):
            self.store.review_mission_outcome(self.mission["id"], "accepted")
        implementation = self.store.create_work_item(self.mission["id"], "Implement acceptance conditions")
        self.store.create_work_item(
            self.mission["id"], "Review implementation and verification", "Independent reviewer",
            "planner", depends_on=[implementation["id"]],
        )
        builder_task = self.store.claim_work(self.mission["id"], "builder")
        self.store.complete_work(builder_task["id"], "builder", "Implemented and verified")
        reviewer_task = self.store.claim_work(self.mission["id"], "reviewer")
        self.store.complete_work(reviewer_task["id"], "reviewer", "Review passed")
        request = self.store.create_interaction(
            self.mission["id"], "question", "Confirm migration policy", "Need user decision", None, "planner"
        )
        with self.assertRaisesRegex(ValueError, "resolve_pending_user_requests"):
            self.store.complete_mission(self.mission["id"], "reviewer", "Complete", ["All acceptance checks passed"])
        self.store.resolve_interaction(request["id"], "Use the documented policy")

        failed_run = self.store.append(
            "repo.test_run.completed", "reviewer", self.mission["id"],
            {"runId": "failed-run", "argv": ["pytest"], "exitCode": 1},
        )
        with self.assertRaisesRegex(ValueError, "verification_evidence_must_reference"):
            self.store.complete_mission(
                self.mission["id"], "reviewer", "Complete", ["Tests passed"], [failed_run["id"]]
            )
        passed_run = self.store.append(
            "repo.test_run.completed", "reviewer", self.mission["id"],
            {"runId": "passed-run", "argv": ["pytest"], "exitCode": 0},
        )

        result = self.store.complete_mission(
            self.mission["id"], "reviewer", "Implemented, verified and independently reviewed.",
            ["Feature behavior matches the mission acceptance criteria", "Automated verification passed"],
            [passed_run["id"]],
        )

        self.assertEqual(result["mission"]["status"], "completed")
        self.assertEqual(result["event"]["type"], "mission.completed")
        self.assertEqual(len(result["event"]["payload"]["acceptanceEvidence"]), 2)
        self.assertEqual(result["event"]["payload"]["evidenceRefs"][0]["id"], passed_run["id"])
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "completed")
        self.assertIsNone(self.store.activate_mission(self.mission["id"]))
        review = self.store.review_mission_outcome(self.mission["id"], "follow_up", "One edge case needs a follow-up.")
        self.assertEqual(review["type"], "mission.outcome.reviewed")
        self.assertEqual(review["actorId"], "user")
        self.assertEqual(review["payload"], {"outcome": "follow_up", "notes": "One edge case needs a follow-up."})
        archive = self.root / "exports" / "outcome-audit.json"
        self.store.write_project_audit_export(self.project["id"], archive)
        exported = json.loads(archive.read_text(encoding="utf-8"))
        self.assertTrue(any(
            event["id"] == review["id"]
            for mission in exported["missions"]
            for event in mission["events"]
        ))
        optional_mission = self.store.create_mission(
            self.project["id"], "Optional plan work", "Complete without workflow gates",
        )
        self.store.create_work_item(optional_mission["id"], "Optional follow-up")
        self.assertEqual(
            self.store.complete_mission(optional_mission["id"], "reviewer", "Complete")["mission"]["status"],
            "completed",
        )

    def test_mission_completion_maps_each_acceptance_check_to_its_sources(self) -> None:
        implementation = self.store.create_work_item(self.mission["id"], "Implement output")
        review = self.store.create_work_item(
            self.mission["id"], "Review output", "Independent reviewer",
            "planner", depends_on=[implementation["id"]],
        )
        builder_task = self.store.claim_work(self.mission["id"], "builder")
        self.store.complete_work(builder_task["id"], "builder", "Output is implemented")
        reviewer_task = self.store.claim_work(self.mission["id"], "reviewer")
        self.assertEqual(reviewer_task["id"], review["id"])
        self.store.complete_work(reviewer_task["id"], "reviewer", "Output independently reviewed")

        artifact, _ = self.store.add_artifact(
            self.mission["id"], "release-notes.md", "text/markdown", "reviewer", b"Verified release notes"
        )
        test_run = self.store.append(
            "repo.test_run.completed", "reviewer", self.mission["id"],
            {"runId": "verification", "argv": ["pytest", "tests"], "exitCode": 0},
        )
        result = self.store.complete_mission(
            self.mission["id"], "reviewer", "Ready for review",
            acceptance_checks=[
                {"criterion": "Release notes are available", "evidence_refs": [artifact["id"]]},
                {"criterion": "Automated checks pass", "evidence_refs": [test_run["id"]]},
            ],
        )

        checks = result["event"]["payload"]["acceptanceChecks"]
        self.assertEqual([check["criterion"] for check in checks], [
            "Release notes are available", "Automated checks pass",
        ])
        self.assertEqual(checks[0]["evidence"][0]["id"], artifact["id"])
        self.assertEqual(checks[1]["evidence"][0]["id"], test_run["id"])
        self.assertEqual(checks[1]["evidence"][0]["label"], "pytest tests")
        self.assertEqual(len(result["event"]["payload"]["evidenceRefs"]), 2)
        with self.assertRaisesRegex(ValueError, "outcome_must_be"):
            self.store.review_mission_outcome(self.mission["id"], "maybe")

    def test_selected_workflow_does_not_gate_completion_on_plan_review_test_or_evidence(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Flexible workflow", "Deliver a useful change",
            {"id": "goal-driven-sdlc", "version": 7, "title": "Goal-driven SDLC"},
        )
        self.store.create_work_item(mission["id"], "Optional follow-up task")

        result = self.store.complete_mission(
            mission["id"], "reviewer", "The requested change is complete.", acceptance_checks=[],
        )

        self.assertEqual(result["mission"]["status"], "completed")
        self.assertEqual(result["event"]["payload"]["acceptanceChecks"], [])
        self.assertEqual(result["event"]["payload"]["evidenceRefs"], [])

    def test_review_checkpoint_is_optional_for_any_workflow_and_does_not_create_tasks(self) -> None:
        finding = {"severity": "medium", "file": "src/example.py", "issue": "Consider a follow-up."}
        result = self.store.record_review_checkpoint(
            self.mission["id"], "reviewer", "changes_requested", "One optional improvement remains.",
            findings=[finding],
        )
        self.assertEqual(result["event"]["payload"]["verificationEventId"], None)
        self.assertEqual(result["event"]["payload"]["findings"], [finding])
        self.assertEqual(result["workItems"], [])
        self.assertEqual(self.store.work_items(self.mission["id"]), [])

    def test_completion_validates_evidence_only_when_the_agent_supplies_references(self) -> None:
        failed_run = self.store.append(
            "repo.test_run.completed", "reviewer", self.mission["id"],
            {"runId": "failed-run", "argv": ["pytest"], "exitCode": 1},
        )
        with self.assertRaisesRegex(ValueError, "verification_evidence_must_reference"):
            self.store.complete_mission(
                self.mission["id"], "reviewer", "The work is complete.", evidence_refs=[failed_run["id"]],
            )
        passed_run = self.store.append(
            "repo.test_run.completed", "reviewer", self.mission["id"],
            {"runId": "passed-run", "argv": ["pytest"], "exitCode": 0},
        )
        result = self.store.complete_mission(
            self.mission["id"], "reviewer", "The work is complete.", evidence_refs=[passed_run["id"]],
        )
        self.assertEqual(result["mission"]["status"], "completed")
        self.assertEqual(result["event"]["payload"]["evidenceRefs"][0]["id"], passed_run["id"])

    def test_agent_event_claim_is_single_owner_and_commits_result_with_offset_once(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Run the task"}
        )
        started = self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual((started["status"], started["attempts"]), ("running", 1))
        self.assertTrue(started["claimed"])

        duplicate = self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual((duplicate["status"], duplicate["attempts"]), ("running", 1))
        self.assertFalse(duplicate["claimed"])
        self.assertIsNone(self.store.agent_offset("builder", self.mission["id"]))

        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"], "Implemented the change.", "work-1"
        )
        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"], "Duplicate result", "work-1"
        )

        result_events = [
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.message.created"
            and event["payload"].get("triggerSequence") == trigger["sequence"]
        ]
        self.assertEqual(len(result_events), 1)
        self.assertEqual(result_events[0]["payload"]["text"], "Implemented the change.")
        self.assertEqual(result_events[0]["payload"]["channelAudience"], "conversation")
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), trigger["sequence"])
        run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual((run["status"], run["attempts"], run["work_item_id"]), ("completed", 1, "work-1"))

    def test_completed_work_item_result_is_published_as_a_chat_message(self) -> None:
        item = self.store.create_work_item(self.mission["id"], "Implement the feature")
        claim = self.store.claim_work(self.mission["id"], "builder", work_item_id=item["id"])
        self.store.complete_work(claim["id"], "builder", "Implementation is ready.")
        trigger = self.store.events_after(self.mission["id"], 0)[-1]
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])

        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"],
            "Implementation is ready.", item["id"],
            publish_output=True,
        )

        run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual(run["output_text"], "Implementation is ready.")
        messages = [event for event in self.store.events_after(self.mission["id"], 0)
                    if event["type"] == "agent.message.created"
                    and event["payload"].get("triggerSequence") == trigger["sequence"]]
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["payload"]["channelAudience"], "conversation")

    def test_bootstrap_restores_completed_agent_turns_hidden_by_older_runtime(self) -> None:
        trigger = self.store.append("message.created", "user", self.mission["id"], {"text": "Inspect this."})
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"],
            "The inspection is complete.", None, publish_output=False,
        )
        self.store.append("agent.activity", "builder", self.mission["id"], {
            "status": "Ready", "triggerSequence": trigger["sequence"],
        })
        self.store.append("mission.completed", "planner", self.mission["id"], {"summary": "Done."})

        result = self.store.bootstrap(self.project["id"], self.mission["id"])
        replies = [event for event in result["events"] if event["payload"].get("historyProjection")]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["payload"]["channelAudience"], "conversation")
        self.assertEqual(replies[0]["payload"]["text"], "The inspection is complete.")
        completion_sequence = next(event["sequence"] for event in result["events"]
                                  if event["type"] == "mission.completed")
        self.assertLess(replies[0]["sequence"], completion_sequence)

    def test_plan_items_can_be_created_atomically_with_key_dependencies(self) -> None:
        created = self.store.create_work_items(self.mission["id"], [
            {"key": "build", "title": "Build the feature", "detail": "Implement it"},
            {"key": "verify", "title": "Verify the feature", "detail": "Run checks", "depends_on": ["build"]},
            {"key": "review", "title": "Review the result", "detail": "Inspect the change", "depends_on": ["verify"]},
        ], "planner")

        self.assertEqual([item["key"] for item in created], ["build", "verify", "review"])
        self.assertEqual(created[1]["depends_on"], [created[0]["id"]])
        self.assertEqual(created[2]["depends_on"], [created[1]["id"]])
        created_events = [event for event in self.store.events_after(self.mission["id"], 0)
                          if event["type"] == "plan.item.created"]
        self.assertEqual(len(created_events), 3)

    def test_invalid_plan_batch_is_atomic(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot contain a cycle"):
            self.store.create_work_items(self.mission["id"], [
                {"key": "first", "title": "First", "depends_on": ["second"]},
                {"key": "second", "title": "Second", "depends_on": ["first"]},
            ], "planner")
        self.assertEqual(self.store.work_items(self.mission["id"]), [])
        self.assertFalse(any(event["type"] == "plan.item.created"
                             for event in self.store.events_after(self.mission["id"], 0)))

    def test_agent_event_claim_is_atomic_across_store_connections(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Run once"}
        )
        second_store = MissionStore(self.store.path)
        barrier = threading.Barrier(3)
        results: list[dict[str, Any]] = []
        errors: list[BaseException] = []

        def claim(store: MissionStore) -> None:
            try:
                barrier.wait(timeout=5)
                results.append(store.begin_agent_event("builder", self.mission["id"], trigger["sequence"]))
            except BaseException as error:  # Preserve worker-thread assertion failures for the test.
                errors.append(error)

        workers = [
            threading.Thread(target=claim, args=(store,))
            for store in (self.store, second_store)
        ]
        for worker in workers:
            worker.start()
        barrier.wait(timeout=5)
        for worker in workers:
            worker.join(timeout=5)

        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        self.assertEqual(sum(result["claimed"] for result in results), 1)
        self.assertEqual({result["attempts"] for result in results}, {1})

    def test_agent_consumer_offset_cannot_regress_from_a_delayed_cursor_write(self) -> None:
        older = self.store.append("agent.activity", "runtime", self.mission["id"], {"status": "Ready"})
        newer = self.store.append("agent.activity", "runtime", self.mission["id"], {"status": "Ready"})

        self.store.save_agent_offset("builder", self.mission["id"], newer["sequence"])
        self.store.save_agent_offset("builder", self.mission["id"], older["sequence"])

        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), newer["sequence"])

    def test_agent_event_failure_and_offset_commit_together(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Unavailable operation"}
        )
        self.store.begin_agent_event("reviewer", self.mission["id"], trigger["sequence"])
        self.store.fail_agent_event(
            "reviewer", self.mission["id"], trigger["sequence"], 3, "provider unavailable"
        )
        self.store.fail_agent_event(
            "reviewer", self.mission["id"], trigger["sequence"], 3, "duplicate failure"
        )

        failures = [
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.run.failed"
            and event["payload"].get("triggerSequence") == trigger["sequence"]
        ]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["payload"]["error"], "provider unavailable")
        self.assertEqual(failures[0]["payload"]["failureKind"], "unknown")
        self.assertEqual(self.store.agent_offset("reviewer", self.mission["id"]), trigger["sequence"])
        self.assertEqual(
            self.store.agent_event_run("reviewer", self.mission["id"], trigger["sequence"])["status"],
            "failed",
        )

    def test_worker_skips_a_completed_event_if_its_cursor_is_replayed(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Already completed"}
        )
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"], "Committed result", None
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE agent_offsets SET sequence = ? WHERE agent_id = ? AND mission_id = ?",
                (trigger["sequence"] - 1, "builder", self.mission["id"]),
            )
        calls = 0
        stop = threading.Event()

        class Provider:
            async def run(inner_self, store, mission_id, event):
                nonlocal calls
                calls += 1
                return "Duplicate result"

        worker = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("builder", "Builder", "Build", "", "builder.md"),
            Provider(), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.store.agent_offset("builder", self.mission["id"]) == trigger["sequence"] + 2:
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 0)
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), trigger["sequence"] + 2)
        messages = [
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.message.created"
            and event["payload"].get("triggerSequence") == trigger["sequence"]
        ]
        self.assertEqual(len(messages), 1)

    def test_worker_reads_a_large_event_backlog_in_bounded_pages(self) -> None:
        cursor = self.store.latest_sequence(self.mission["id"])
        self.store.save_agent_offset("builder", self.mission["id"], cursor)
        for index in range(405):
            self.store.append("agent.activity", "runtime", self.mission["id"], {
                "status": "Ready", "index": index,
            })
        final_sequence = self.store.latest_sequence(self.mission["id"])
        page_calls = []
        events_after_page = self.store.events_after_page

        def track_pages(mission_id, sequence, limit=200):
            page_calls.append((sequence, limit))
            return events_after_page(mission_id, sequence, limit)

        self.store.events_after_page = track_pages
        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Build", "", "builder.md"),
            object(), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.store.agent_offset("builder", self.mission["id"]) == final_sequence:
                break
            time.sleep(0.01)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), final_sequence)
        self.assertGreaterEqual(len(page_calls), 3)
        self.assertTrue(all(limit == 200 for _, limit in page_calls))

    def test_worker_does_not_retry_after_the_attempt_published_agent_activity(self) -> None:
        from pydantic_ai.exceptions import ModelConnectionError

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Perform a change", "recipient": "builder"},
        )
        calls = 0

        class PartiallyAppliedProvider:
            async def run(inner_self, store, mission_id, event):
                nonlocal calls
                calls += 1
                store.append("agent.tool.started", "builder", mission_id, {
                    "toolName": "write_file", "toolCallId": "write-once",
                })
                raise ModelConnectionError(
                    "test-model", "provider disconnected after tool call", phase="read"
                )

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            PartiallyAppliedProvider(), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
            if run and run["status"] == "failed":
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 1)
        run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual(run["status"], "failed")
        failure = next(
            item for item in self.store.events_after(self.mission["id"], trigger["sequence"])
            if item["type"] == "agent.run.failed"
        )
        self.assertIn("automatic retry stopped", failure["payload"]["error"])
        self.assertEqual(failure["payload"]["failureKind"], "unknown_side_effect")

    def test_worker_does_not_retry_when_harness_ledger_has_an_unresolved_tool_effect(self) -> None:
        from pydantic_ai.exceptions import ModelConnectionError
        from pydantic_ai_harness.step_persistence import (
            RunRecord,
            SqliteStepStore,
            ToolEffectRecord,
        )

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Recover an interrupted native tool", "recipient": "builder"},
        )
        step_store = SqliteStepStore(database=self.store.data_dir / "agent_steps.sqlite3")
        asyncio.run(step_store.register_run(RunRecord(
            run_id="harness-unresolved", conversation_id=f"tribe:{self.mission['id']}:builder",
            agent_name=f"tribe:{self.mission['id']}:builder",
            metadata={"trigger_sequence": str(trigger["sequence"])},
        )))
        asyncio.run(step_store.record_tool_effect(ToolEffectRecord(
            run_id="harness-unresolved", tool_call_id="native-write", tool_name="write_file",
            status="started",
        )))
        calls = 0

        class FailingPydanticProvider(PydanticAIProvider):
            async def run(inner_self, store, mission_id, event, cancellation_token=None):
                nonlocal calls
                calls += 1
                raise ModelConnectionError(
                    "test-model", "provider disconnected after a native tool", phase="read"
                )

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            FailingPydanticProvider.__new__(FailingPydanticProvider), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
            if run and run["status"] == "failed":
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 1)
        failure = next(
            item for item in self.store.events_after(self.mission["id"], trigger["sequence"])
            if item["type"] == "agent.run.failed"
        )
        self.assertIn("may have started a tool side effect", failure["payload"]["error"])
        self.assertEqual(failure["payload"]["failureKind"], "unknown_side_effect")

    def test_worker_redacts_provider_environment_secrets_from_durable_failures(self) -> None:
        self.store.set_setting("model", "zai:glm-4.5")
        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Check provider error handling", "recipient": "builder"},
        )

        class FailingProvider:
            async def run(inner_self, store, mission_id, event):
                raise RuntimeError("Authentication failed for provider-native-secret")

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            FailingProvider(), stop,
        )
        with patch.dict(os.environ, {"ZAI_API_KEY": "provider-native-secret"}, clear=True):
            thread = threading.Thread(target=worker.run)
            thread.start()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
                if run and run["status"] == "failed":
                    break
                time.sleep(0.02)
            stop.set()
            thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        failure = next(
            event for event in self.store.events_after(self.mission["id"], trigger["sequence"])
            if event["type"] == "agent.run.failed"
        )
        self.assertNotIn("provider-native-secret", failure["payload"]["error"])
        self.assertIn("[redacted]", failure["payload"]["error"])

    def test_worker_retries_a_provider_failure_before_any_agent_activity(self) -> None:
        from pydantic_ai.exceptions import ModelUnavailableError

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Try again safely", "recipient": "builder"},
        )
        calls = 0

        class TransientProvider:
            async def run(inner_self, store, mission_id, event):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise ModelUnavailableError("test-model", "provider temporarily unavailable")
                return "Completed safely after retry"

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            TransientProvider(), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
            if run and run["status"] == "completed":
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 2)
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])["status"],
            "completed",
        )
        retry_event = next(
            item for item in self.store.events_after(self.mission["id"], trigger["sequence"])
            if item["type"] == "agent.run.retrying"
        )
        self.assertEqual(retry_event["actorId"], "builder")
        self.assertEqual(retry_event["payload"]["attempt"], 2)
        self.assertEqual(retry_event["payload"]["maxAttempts"], 24)
        self.assertEqual(retry_event["payload"]["failureKind"], "transient_provider")

    def test_worker_resumes_harness_checkpoint_on_safe_inline_retry(self) -> None:
        from pydantic_ai.exceptions import ModelUnavailableError

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Continue from the last safe checkpoint", "recipient": "builder"},
        )
        calls = 0
        resumed_checkpoint = False

        class RecoveringPydanticProvider(PydanticAIProvider):
            async def run(inner_self, store, mission_id, event, cancellation_token=None):
                nonlocal calls, resumed_checkpoint
                calls += 1
                if calls == 1:
                    raise ModelUnavailableError("test-model", "provider temporarily unavailable")
                resumed_checkpoint = event.get("resumeCheckpoint") is True
                return "Completed from the saved checkpoint"

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            RecoveringPydanticProvider.__new__(RecoveringPydanticProvider), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
            if run and run["status"] == "completed":
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 2)
        self.assertTrue(resumed_checkpoint)

    def test_worker_retries_after_a_settled_post_update_without_duplicate_message(self) -> None:
        from pydantic_ai.exceptions import ModelUnavailableError

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Continue from the completed update", "recipient": "planner"},
        )
        calls = 0
        resumed_checkpoint = False
        tool_call_id = "post-update-once"

        class UpdateThenRecoverProvider(PydanticAIProvider):
            async def run(inner_self, store, mission_id, event, cancellation_token=None):
                nonlocal calls, resumed_checkpoint
                calls += 1
                if calls == 1:
                    store.append("agent.tool.started", "planner", mission_id, {
                        "toolName": "post_update", "toolCallId": tool_call_id,
                        "triggerSequence": trigger["sequence"],
                    })
                    store.append_agent_update(
                        mission_id, "planner", "Discovery is complete; I am preparing the plan.",
                        metadata={
                            "triggerSequence": trigger["sequence"], "toolCallId": tool_call_id,
                        },
                    )
                    store.append("agent.tool.completed", "planner", mission_id, {
                        "toolName": "post_update", "toolCallId": tool_call_id,
                        "triggerSequence": trigger["sequence"], "outcome": "success",
                    })
                    raise ModelUnavailableError("test-model", "provider disconnected after update")
                resumed_checkpoint = event.get("resumeCheckpoint") is True
                return "Completed from the saved checkpoint"

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("planner", "Planner", "Planning", "", "planner.md"),
            UpdateThenRecoverProvider.__new__(UpdateThenRecoverProvider), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            run = self.store.agent_event_run("planner", self.mission["id"], trigger["sequence"])
            if run and run["status"] == "completed":
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 2)
        self.assertTrue(resumed_checkpoint)
        updates = [
            item for item in self.store.events_after(self.mission["id"], trigger["sequence"])
            if item["type"] == "agent.message.created"
            and item["payload"].get("toolCallId") == tool_call_id
        ]
        self.assertEqual(len(updates), 1)
        self.assertEqual(
            self.store.agent_event_run("planner", self.mission["id"], trigger["sequence"])["status"],
            "completed",
        )

    def test_worker_continues_after_a_completed_failing_test_command(self) -> None:
        from pydantic_ai.exceptions import ModelUnavailableError

        item = self.store.create_work_item(self.mission["id"], "Implement and verify the change")
        self.store.claim_work(self.mission["id"], "builder", work_item_id=item["id"])
        workspace = WorkspaceTools(
            self.store, self.mission["id"], "builder", item["id"],
        )
        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Run tests and fix any failures", "recipient": "builder"},
        )
        calls = 0
        resumed_checkpoint = False

        class CommandThenRecoverProvider(PydanticAIProvider):
            async def run(inner_self, store, mission_id, event, cancellation_token=None):
                nonlocal calls, resumed_checkpoint
                calls += 1
                if calls == 1:
                    workspace.run_tests(["pytest", "tests"])
                    raise ModelUnavailableError("test-model", "provider disconnected after test output")
                resumed_checkpoint = event.get("resumeCheckpoint") is True
                return "The test failed; I used its output to choose the next step."

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            CommandThenRecoverProvider.__new__(CommandThenRecoverProvider), stop,
        )
        failure = {
            "exit_code": 1, "stdout": "1 failed", "stderr": "assertion mismatch",
            "timed_out": False, "cancelled": False,
        }
        with patch("tribe_runtime.commands.run_foreground_process", return_value=failure):
            thread = threading.Thread(target=worker.run)
            thread.start()
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
                if run and run["status"] == "completed":
                    break
                time.sleep(0.02)
            stop.set()
            thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 2)
        self.assertTrue(resumed_checkpoint)
        result = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "repo.test_run.completed"
        )
        self.assertEqual(result["payload"]["exitCode"], 1)
        self.assertEqual(result["payload"]["stderr"], "assertion mismatch")
        completed = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual(completed["status"], "completed")

    def test_worker_persists_safe_provider_retry_across_restart(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Continue after a provider outage", "recipient": "builder"},
        )
        source = f'''\
import os
import threading
import time
from pathlib import Path
from tribe_runtime.agent_runtime import AgentWorker
from tribe_runtime.agents import AgentDefinition
from tribe_runtime.store import MissionStore
from pydantic_ai.exceptions import ModelUnavailableError

store = MissionStore(Path({str(self.store.path)!r}))
class FailingProvider:
    def __init__(self):
        self.calls = 0
    async def run(self, store, mission_id, event):
        self.calls += 1
        raise ModelUnavailableError("test-model", "provider temporarily unavailable")

provider = FailingProvider()
definition = AgentDefinition("builder", "Builder", "Implementation", "", "builder.md")
worker = AgentWorker(store, {self.mission["id"]!r}, definition, provider, threading.Event())
thread = threading.Thread(target=worker.run)
thread.start()
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    run = store.agent_event_run("builder", {self.mission["id"]!r}, {trigger["sequence"]})
    if run and run["status"] == "retrying":
        assert provider.calls == 3
        os._exit(26)
    time.sleep(0.01)
os._exit(27)
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 26, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        run = restarted_store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual(run["status"], "retrying")
        self.assertTrue(run["retry_at"])
        self.assertEqual(
            restarted_store.agent_offset("builder", self.mission["id"]), trigger["sequence"] - 1,
        )
        not_due = restarted_store.begin_agent_event(
            "builder", self.mission["id"], trigger["sequence"],
        )
        self.assertFalse(not_due["claimed"])

        with restarted_store._connect() as db:
            db.execute(
                "UPDATE agent_event_runs SET retry_at=? WHERE agent_id=? AND mission_id=? AND trigger_sequence=?",
                ("1970-01-01T00:00:00+00:00", "builder", self.mission["id"], trigger["sequence"]),
            )

        class RecoveringProvider:
            async def run(self, store, mission_id, event):
                return "Completed after the persisted retry"

        second_stop = threading.Event()
        second_worker = AgentWorker(
            restarted_store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            RecoveringProvider(), second_stop,
        )
        second_thread = threading.Thread(target=second_worker.run)
        second_thread.start()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            run = restarted_store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
            if run and run["status"] == "completed":
                break
            time.sleep(0.02)
        second_stop.set()
        second_thread.join(timeout=3)

        self.assertFalse(second_thread.is_alive())
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["attempts"], 4)

    def test_scheduled_provider_retry_can_be_cancelled_without_a_live_worker_call(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Cancel the scheduled retry", "recipient": "builder"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.schedule_agent_event_retry(
            "builder", self.mission["id"], trigger["sequence"],
            3, 24, "provider temporarily unavailable", 60,
        )
        supervisor = AgentSupervisor(
            self.store,
            [AgentDefinition("builder", "Builder", "Implementation", "", "builder.md")],
        )

        self.assertTrue(supervisor.stop_agent_run(self.mission["id"], "builder"))
        run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        interrupted = next(
            item for item in self.store.events_after(self.mission["id"], trigger["sequence"])
            if item["type"] == "agent.run.interrupted"
        )
        self.assertEqual(run["status"], "interrupted")
        self.assertIsNone(run["retry_at"])
        self.assertTrue(interrupted["payload"]["cancelledByUser"])
        self.assertEqual(
            self.store.agent_offset("builder", self.mission["id"]), trigger["sequence"],
        )

    def test_scheduled_provider_retry_expires_after_its_persisted_deadline(self) -> None:
        from datetime import UTC, datetime, timedelta

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Expire a stale provider retry", "recipient": "builder"},
        )
        run = self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.schedule_agent_event_retry(
            "builder", self.mission["id"], trigger["sequence"], run["attempts"], 24,
            "provider unavailable", 30,
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE agent_event_runs SET created_at=?,retry_deadline_at=NULL,retry_at=? "
                "WHERE agent_id='builder' AND mission_id=? AND trigger_sequence=?",
                ((datetime.now(UTC) - timedelta(hours=25)).isoformat(),
                 (datetime.now(UTC) - timedelta(seconds=2)).isoformat(),
                 self.mission["id"], trigger["sequence"]),
            )

        reclaimed = self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])

        self.assertFalse(reclaimed["claimed"])
        self.assertEqual(reclaimed["status"], "failed")
        self.assertIsNone(reclaimed["retry_at"])
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), trigger["sequence"])
        self.assertTrue(any(
            item["type"] == "agent.run.failed" and "retry window expired" in item["payload"]["error"]
            for item in self.store.events_after(self.mission["id"], trigger["sequence"])
        ))

    def test_due_provider_retry_claims_the_saved_checkpoint_frontier(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Resume the saved provider frontier", "recipient": "builder"},
        )
        first = self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.schedule_agent_event_retry(
            "builder", self.mission["id"], trigger["sequence"], first["attempts"], 24,
            "provider temporarily unavailable", 30,
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE agent_event_runs SET retry_at='1970-01-01T00:00:00+00:00' "
                "WHERE agent_id='builder' AND mission_id=? AND trigger_sequence=?",
                (self.mission["id"], trigger["sequence"]),
            )

        reclaimed = self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])

        self.assertTrue(reclaimed["claimed"])
        self.assertTrue(reclaimed["resume_checkpoint"])
        self.assertEqual(reclaimed["status"], "running")

    def test_user_cancellation_wins_over_worker_stop_during_provider_backoff(self) -> None:
        from pydantic_ai.exceptions import ModelUnavailableError

        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Cancel the retry", "recipient": "builder"},
        )
        calls = 0
        cancellation: list[threading.Event] = []

        class TransientProvider:
            async def run(inner_self, store, mission_id, event):
                nonlocal calls
                calls += 1
                raise ModelUnavailableError("test-model", "provider temporarily unavailable")

        def capture_cancel_event(_mission_id, _agent_id, _sequence, cancel_event, _token):
            cancellation.append(cancel_event)

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            TransientProvider(), stop, on_run_start=capture_cancel_event,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if any(item["type"] == "agent.run.retrying" for item in self.store.events_after(
                self.mission["id"], trigger["sequence"]
            )):
                break
            time.sleep(0.02)
        self.assertTrue(cancellation, "worker did not start the agent run")
        self.assertTrue(any(item["type"] == "agent.run.retrying" for item in self.store.events_after(
            self.mission["id"], trigger["sequence"]
        )), "provider did not enter retry backoff")

        self.assertTrue(self.store.request_agent_run_cancel(
            "builder", self.mission["id"], trigger["sequence"]
        ))
        cancellation[0].set()
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 1, "a cancelled run must not retry when the mission resumes")
        run = self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), trigger["sequence"])

    def test_user_cancellation_wins_over_worker_stop_while_waiting_for_budget(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Cancel the budget wait", "recipient": "builder"},
        )
        cancellation: list[threading.Event] = []

        class UnusedProvider:
            async def run(inner_self, store, mission_id, event):
                self.fail("provider must not run while the usage budget is unavailable")

        def capture_cancel_event(_mission_id, _agent_id, _sequence, cancel_event, _token):
            cancellation.append(cancel_event)

        stop = threading.Event()
        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            UnusedProvider(), stop, on_run_start=capture_cancel_event,
        )
        thread = threading.Thread(target=worker.run)
        with patch.object(self.store, "reserve_agent_usage", return_value=None):
            thread.start()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if any(item["type"] == "agent.activity"
                       and item["payload"].get("status") == "Waiting for budget"
                       for item in self.store.events_after(self.mission["id"], trigger["sequence"])):
                    break
                time.sleep(0.02)
            self.assertTrue(cancellation, "worker did not start the agent run")
            self.assertTrue(any(item["type"] == "agent.activity"
                                and item["payload"].get("status") == "Waiting for budget"
                                for item in self.store.events_after(self.mission["id"], trigger["sequence"])),
                            "worker did not enter budget wait")

            self.assertTrue(self.store.request_agent_run_cancel(
                "builder", self.mission["id"], trigger["sequence"]
            ))
            cancellation[0].set()
            stop.set()
            thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])["status"],
            "interrupted",
        )

    def test_provider_retries_only_transient_pydantic_ai_errors(self) -> None:
        from pydantic_ai.exceptions import (
            ModelQuotaExceededError,
            ModelRateLimitError,
            ModelUnavailableError,
        )

        self.assertEqual(
            _provider_retry_delay(ModelUnavailableError("test-model", "temporarily unavailable"), 1),
            1.0,
        )
        self.assertEqual(
            _provider_retry_delay(
                ModelRateLimitError("test-model", "rate limited", retry_after=3), 2
            ),
            3.0,
        )
        self.assertIsNone(
            _provider_retry_delay(
                ModelRateLimitError("test-model", "wait longer", retry_after=21_601), 1
            )
        )
        self.assertEqual(
            _scheduled_provider_retry_delay(
                ModelUnavailableError("test-model", "still unavailable"), 3
            ),
            30.0,
        )
        self.assertIsNone(
            _provider_retry_delay(ModelQuotaExceededError("test-model", "quota exhausted"), 1)
        )
        self.assertIsNone(_provider_retry_delay(RuntimeError("invalid request"), 1))

    def test_agent_failure_categories_distinguish_recovery_paths(self) -> None:
        from pydantic_ai.exceptions import ModelUnavailableError, UsageLimitExceeded

        class ToolExecutionError(RuntimeError):
            tool_name = "run_command"

        class InvalidRequestError(RuntimeError):
            status_code = 400

        self.assertEqual(_agent_failure_kind(ModelUnavailableError("test-model", "offline")), "transient_provider")
        self.assertEqual(_agent_failure_kind(UsageLimitExceeded("request limit")), "usage_limit")
        self.assertEqual(_agent_failure_kind(InvalidRequestError("bad payload")), "invalid_request")
        self.assertEqual(_agent_failure_kind(ToolExecutionError("command failed")), "tool_failure")
        self.assertEqual(_agent_failure_kind(PermissionError("permission denied")), "policy_denial")
        self.assertEqual(
            _agent_failure_kind(RuntimeError("prompt flagged as potentially violating our usage policy")),
            "policy_denial",
        )
        self.assertEqual(_agent_failure_kind(RuntimeError("unknown"), unknown_side_effect=True), "unknown_side_effect")
        self.assertEqual(_agent_failure_kind(RuntimeError("unexpected")), "unknown")

    def test_worker_does_not_resume_a_deferred_approval_after_inline_run_completed(self) -> None:
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Use the connected service"}
        )
        target = "MCP server service · update"
        interaction = self.store.create_deferred_tool_interaction(
            mission_id=self.mission["id"], requested_by="builder", title="Run service.update",
            details="Exact action", target=target, trigger_sequence=trigger["sequence"],
            run_id="run-1", conversation_id="conversation-1", tool_call_id="call-1",
            tool_name="service_update", tool_arguments={}, message_history="[]",
        )
        self.store.resolve_interaction(interaction["id"], "approved_once")
        self.assertTrue(self.store.consume_deferred_tool_approval(interaction["id"], target))
        self.store.update_deferred_tool_approval(interaction["id"], "consumed")
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.complete_agent_event("builder", self.mission["id"], trigger["sequence"], "", None)
        resolution_event = next(
            event for event in self.store.events_after(self.mission["id"], trigger["sequence"])
            if event["type"] == "interaction.approval.resolved"
        )
        final_sequence = self.store.latest_sequence(self.mission["id"])
        calls = 0
        stop = threading.Event()

        class Provider:
            async def run(inner_self, store, mission_id, event):
                nonlocal calls
                calls += 1
                return "Must not replay"

        worker = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("builder", "Builder", "Build", "", "builder.md"),
            Provider(), stop,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.store.agent_offset("builder", self.mission["id"]) == final_sequence:
                break
            time.sleep(0.02)
        stop.set()
        thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(calls, 0)
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])["status"],
            "completed",
        )
        self.assertFalse(any(
            event["type"] == "agent.run.failed"
            and event["payload"].get("triggerSequence") == resolution_event["sequence"]
            for event in self.store.events_after(self.mission["id"], 0)
        ))

    def test_mission_bootstrap_and_history_pages_bound_initial_event_load(self) -> None:
        for index in range(205):
            self.store.append("message.created", "user", self.mission["id"], {"text": f"Update {index}"})

        bootstrap = self.store.bootstrap(self.project["id"], self.mission["id"])
        self.assertEqual(len(bootstrap["events"]), 200)
        self.assertTrue(bootstrap["hasMoreEvents"])
        self.assertEqual(bootstrap["cursor"], bootstrap["events"][-1]["sequence"])

        older, has_more = self.store.events_before(
            self.mission["id"], bootstrap["events"][0]["sequence"], limit=100
        )
        self.assertFalse(has_more)
        self.assertEqual(len(older), 6)
        self.assertLess(older[-1]["sequence"], bootstrap["events"][0]["sequence"])

    def test_events_after_page_is_bounded_and_advances_with_global_sequence_gaps(self) -> None:
        cursor = self.store.latest_sequence(self.mission["id"])
        expected = []
        for index in range(5):
            event = self.store.append(
                "message.created", "user", self.mission["id"], {"text": f"Recovery {index}"}
            )
            expected.append(event)

        first, has_more = self.store.events_after_page(self.mission["id"], cursor, limit=2)
        second, has_more_second = self.store.events_after_page(
            self.mission["id"], first[-1]["sequence"], limit=2
        )
        third, has_more_third = self.store.events_after_page(
            self.mission["id"], second[-1]["sequence"], limit=2
        )

        self.assertTrue(has_more)
        self.assertTrue(has_more_second)
        self.assertFalse(has_more_third)
        self.assertEqual([item["id"] for item in first + second + third], [item["id"] for item in expected])
        self.assertTrue(self.store.has_event_from_actor_after(
            self.mission["id"], cursor, "user",
        ))
        self.assertFalse(self.store.has_event_from_actor_after(
            self.mission["id"], cursor, "builder",
        ))

    def test_bootstrap_restores_durable_background_command_runs(self) -> None:
        run = self.store.create_background_run(
            self.mission["id"], ["pytest", "-q"], str(self.repository), 4567
        )
        self.store.update_background_output(run["id"], "2 passed\n")
        finished = self.store.finish_background_run(run["id"], "completed", 0)

        bootstrap = self.store.bootstrap(self.project["id"], self.mission["id"])

        self.assertEqual(len(bootstrap["commandRuns"]), 1)
        restored = bootstrap["commandRuns"][0]
        self.assertEqual(restored["id"], run["id"])
        self.assertEqual(restored["argv"], ["pytest", "-q"])
        self.assertEqual(restored["status"], "completed")
        self.assertEqual(restored["exit_code"], 0)
        self.assertEqual(restored["output"], "2 passed\n")
        self.assertEqual(finished["id"], restored["id"])

    def test_startup_marks_unmonitored_background_commands_interrupted(self) -> None:
        run = self.store.create_background_run(
            self.mission["id"], ["pytest", "-q"], str(self.repository), 4567
        )

        self.store.recover_background_runs()

        recovered = self.store.background_run(run["id"])
        self.assertEqual(recovered["status"], "interrupted")
        self.assertIsNone(recovered["exit_code"])
        events = self.store.events_after(self.mission["id"], 0)
        recovery_events = [event for event in events if event["type"] == "repo.command.completed"]
        self.assertEqual(len(recovery_events), 1)
        self.assertEqual(recovery_events[0]["payload"], {
            "runId": run["id"], "status": "interrupted", "exitCode": None,
        })

        self.store.recover_background_runs()
        self.assertEqual(len([
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "repo.command.completed"
        ]), 1)

    def test_pausing_a_mission_is_idempotent_and_audited(self) -> None:
        paused = self.store.pause_mission(self.mission["id"])
        repeated = self.store.pause_mission(self.mission["id"])

        self.assertEqual(paused["status"], "paused")
        self.assertEqual(repeated["status"], "paused")
        events = self.store.events_after(self.mission["id"], 0)
        pause_events = [event for event in events if event["type"] == "mission.paused"]
        self.assertEqual(len(pause_events), 1)
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "paused")

    def test_mission_blocked_state_tracks_and_clears_pending_user_requests(self) -> None:
        first = self.store.create_interaction(
            self.mission["id"], "question", "Choose a migration strategy", "Need a decision", None, "planner"
        )
        second = self.store.create_interaction(
            self.mission["id"], "approval", "Run database migration", "Exact command", "alembic upgrade head", "builder"
        )
        blocked = first["blocked_event"]
        self.assertEqual(self.store.mission(self.mission["id"])["blocked_reason"],
                         "Waiting for your response: Choose a migration strategy")
        self.assertEqual(blocked["type"], "mission.blocked")
        self.assertTrue(blocked["payload"]["inferred"])
        self.assertIsNone(second["blocked_event"])

        self.store.resolve_interaction(first["id"], "Use expand-contract")
        self.assertEqual(self.store.mission(self.mission["id"])["blocked_reason"],
                         "Waiting for your response: Choose a migration strategy")
        resolved = self.store.resolve_interaction(second["id"], "approved_once")
        self.assertEqual(resolved["unblocked_event"]["type"], "mission.unblocked")
        self.assertIsNone(self.store.mission(self.mission["id"])["blocked_reason"])
        event_types = [event["type"] for event in self.store.events_after(self.mission["id"], 0)]
        self.assertEqual(event_types.count("mission.blocked"), 1)
        self.assertEqual(event_types.count("mission.unblocked"), 1)

    def test_mission_cannot_be_marked_blocked_without_a_pending_user_request(self) -> None:
        with self.assertRaisesRegex(ValueError, "mission_block_requires_a_pending_user_request"):
            self.store.mark_mission_blocked(self.mission["id"], "planner", "Waiting")

    def test_pending_request_does_not_block_mission_while_runnable_work_remains(self) -> None:
        task = self.store.create_work_item(self.mission["id"], "Continue implementation")
        request = self.store.create_interaction(
            self.mission["id"], "question", "Clarify one detail", "Can continue other work", None, "planner"
        )
        self.assertIsNone(request["blocked_event"])
        self.assertIsNone(self.store.mission(self.mission["id"])["blocked_reason"])
        self.assertEqual(self.store.claim_work(self.mission["id"], "builder")["id"], task["id"])

    def test_provider_continuation_skips_interrupted_run_checkpoint(self) -> None:
        from types import SimpleNamespace

        statuses = {10: "interrupted", 20: "completed"}

        class RunStore:
            def agent_event_run(self, agent_id, mission_id, trigger_sequence):
                status = statuses.get(trigger_sequence)
                return {"status": status} if status else None

        runs = [
            SimpleNamespace(run_id="interrupted", metadata={"trigger_sequence": "10"}),
            SimpleNamespace(run_id="completed", metadata={"trigger_sequence": "20"}),
            SimpleNamespace(run_id="current", metadata={"trigger_sequence": "30"}),
            SimpleNamespace(run_id="legacy", metadata={}),
        ]

        result = _continuable_prior_runs(RunStore(), "builder", "mission", runs, 30)

        self.assertEqual([run.run_id for run in result], ["completed", "legacy"])
        resumed = _continuable_prior_runs(
            RunStore(), "builder", "mission", runs, 30, include_current_trigger=True,
        )
        self.assertEqual(
            [run.run_id for run in resumed], ["completed", "current", "legacy"],
        )

    def test_harness_tool_effect_ledger_blocks_unsafe_provider_retry(self) -> None:
        from pydantic_ai_harness.step_persistence import (
            RunRecord,
            SqliteStepStore,
            ToolEffectRecord,
        )

        step_store = SqliteStepStore(database=self.store.data_dir / "agent_steps.sqlite3")
        conversation_id = f"tribe:{self.mission['id']}:builder"

        async def record_run_and_tool_start() -> None:
            await step_store.register_run(RunRecord(
                run_id="harness-run-1", conversation_id=conversation_id,
                agent_name=f"tribe:{self.mission['id']}:builder",
                metadata={"trigger_sequence": "9"},
            ))
            await step_store.record_tool_effect(ToolEffectRecord(
                run_id="harness-run-1", tool_call_id="call-1", tool_name="write_file",
                status="started",
            ))

        asyncio.run(record_run_and_tool_start())
        self.assertTrue(_has_unresolved_harness_tool_effects(
            self.store.data_dir, self.mission["id"], "builder", 9,
        ))
        asyncio.run(step_store.record_tool_effect(ToolEffectRecord(
            run_id="harness-run-1", tool_call_id="call-1", tool_name="write_file",
            status="completed",
        )))
        self.assertFalse(_has_unresolved_harness_tool_effects(
            self.store.data_dir, self.mission["id"], "builder", 9,
        ))

    def test_mission_blocks_after_last_active_task_finishes_and_unblocks_when_plan_grows(self) -> None:
        self.store.create_work_item(self.mission["id"], "Finish current task")
        claimed = self.store.claim_work(self.mission["id"], "builder")
        request = self.store.create_interaction(
            self.mission["id"], "question", "Need a product decision", "Choose option A or B", None, "planner"
        )
        self.assertIsNone(request["blocked_event"])
        self.store.complete_work(claimed["id"], "builder", "Finished current task")
        self.assertEqual(self.store.mission(self.mission["id"])["blocked_reason"],
                         "Waiting for your response: Need a product decision")

        self.store.create_work_item(self.mission["id"], "Continue independent work")
        self.assertIsNone(self.store.mission(self.mission["id"])["blocked_reason"])
        event_types = [event["type"] for event in self.store.events_after(self.mission["id"], 0)]
        self.assertIn("mission.blocked", event_types)
        self.assertIn("mission.unblocked", event_types)

    def test_pending_interactions_include_project_and_mission_context_across_projects(self) -> None:
        other_repository = self.root / "other-repository"
        other_repository.mkdir()
        subprocess.run(["git", "init", "-q", str(other_repository)], check=True)
        subprocess.run(["git", "-C", str(other_repository), "config", "user.email", "tribe-tests@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(other_repository), "config", "user.name", "Tribe tests"], check=True)
        (other_repository / "README.md").write_text("other\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(other_repository), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(other_repository), "commit", "-qm", "base"], check=True)
        other_project, other_mission = self.store.create_project(
            str(other_repository), "Other project", "Other mission", "Another objective"
        )
        self.store.pause_mission(self.mission["id"])
        first = self.store.create_interaction(
            self.mission["id"], "approval", "Remove file", "Delete generated file", "src/generated.py", "builder"
        )
        second = self.store.create_interaction(
            other_mission["id"], "question", "Choose API shape", "Need a compatibility decision", None, "planner"
        )

        pending = self.store.pending_interactions()

        self.assertEqual({item["id"] for item in pending}, {first["id"], second["id"]})
        contexts = {item["id"]: item for item in pending}
        self.assertEqual(contexts[first["id"]]["project_name"], "Test project")
        self.assertEqual(contexts[first["id"]]["mission_title"], "Test mission")
        self.assertEqual(contexts[first["id"]]["mission_status"], "paused")
        self.assertEqual(contexts[second["id"]]["project_id"], other_project["id"])
        self.assertEqual(contexts[second["id"]]["mission_title"], "Other mission")
        self.assertEqual(contexts[second["id"]]["mission_status"], "active")

        self.store.resolve_interaction(first["id"], "denied")
        self.assertEqual([item["id"] for item in self.store.pending_interactions()], [second["id"]])

    def test_deferred_approval_and_resume_frontier_are_persisted_atomically(self) -> None:
        trigger = self.store.append("message.created", "user", self.mission["id"], {"text": "Run tests"})
        interaction = self.store.create_deferred_tool_interaction(
            mission_id=self.mission["id"], requested_by="builder",
            title="Run command outside safe set", details="Exact command: rm temp.txt",
            target=f"Run command in {self.repository}",
            trigger_sequence=trigger["sequence"], run_id="run-123",
            conversation_id=f"tribe:{self.mission['id']}:builder",
            tool_call_id="tool-456", tool_name="run_command",
            tool_arguments={"command": "rm temp.txt"}, message_history='[]',
        )

        row = self.store.deferred_tool_approvals(self.mission["id"], "builder")[0]
        self.assertEqual(row["interaction_id"], interaction["id"])
        self.assertEqual(row["interaction_status"], "pending")
        self.assertEqual(row["trigger_sequence"], trigger["sequence"])
        self.assertEqual(row["run_id"], "run-123")
        self.assertEqual(row["tool_arguments"], {"command": "rm temp.txt"})
        self.assertEqual(row["message_history"], "[]")

        self.store.resolve_interaction(interaction["id"], "approved_once")
        resolved = self.store.deferred_tool_approvals(self.mission["id"], "builder")[0]
        self.assertEqual(resolved["interaction_status"], "resolved")
        self.assertEqual(resolved["resolution"], "approved_once")
        self.assertTrue(self.store.consume_deferred_tool_approval(
            interaction["id"], f"Run command in {self.repository}"
        ))
        self.assertFalse(self.store.consume_deferred_tool_approval(
            interaction["id"], f"Run command in {self.repository}"
        ))
        self.assertEqual(
            self.store.deferred_tool_approvals(self.mission["id"], "builder")[0]["status"],
            "consumed",
        )

    def test_provider_resumes_the_saved_tool_call_after_approval(self) -> None:
        from types import SimpleNamespace

        from pydantic_ai.messages import (
            ModelMessagesTypeAdapter,
            ModelRequest,
            ModelResponse,
            ToolCallPart,
            UserPromptPart,
        )

        target = f"Run command in {self.repository}"
        history = ModelMessagesTypeAdapter.dump_json([
            ModelRequest(parts=[UserPromptPart("Run the requested check")]),
            ModelResponse(parts=[ToolCallPart(
                tool_name="run_command", args={"command": "npm install"},
                tool_call_id="tool-call-789",
            )]),
        ]).decode("utf-8")
        interaction = self.store.create_deferred_tool_interaction(
            mission_id=self.mission["id"], requested_by="builder",
            title="Run command outside safe set", details="Exact command: npm install",
            target=target, trigger_sequence=1, run_id="prior-run",
            conversation_id=f"tribe:{self.mission['id']}:builder",
            tool_call_id="tool-call-789", tool_name="run_command",
            tool_arguments={"command": "npm install"}, message_history=history,
        )
        resolution = self.store.resolve_interaction(interaction["id"], "approved_once")
        json.dumps(resolution)
        captured: dict[str, object] = {}

        class ResumingAgent:
            async def run(self, prompt, **kwargs):
                captured.update(prompt=prompt, **kwargs)
                return SimpleNamespace(output="The approved command completed.")

        provider = PydanticAIProvider(
            AgentDefinition("builder", "Builder", "Implementation", "Build work", "builder.md"),
            "openai:test-model",
        )
        provider.agent = ResumingAgent()
        result = asyncio.run(provider.run(self.store, self.mission["id"], resolution["event"]))

        self.assertEqual(result.text, "The approved command completed.")
        self.assertIsNone(captured["prompt"])
        self.assertEqual(len(captured["message_history"]), 2)
        self.assertTrue(captured["deferred_tool_results"].approvals["tool-call-789"])
        row = self.store.deferred_tool_approvals(self.mission["id"], "builder")[0]
        self.assertEqual(row["status"], "consumed")

    def test_provider_returns_declined_approval_as_feedback_on_the_saved_tool_call(self) -> None:
        from types import SimpleNamespace

        from pydantic_ai.messages import (
            ModelMessagesTypeAdapter,
            ModelRequest,
            ModelResponse,
            ToolCallPart,
            UserPromptPart,
        )

        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Run the focused test"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        history = ModelMessagesTypeAdapter.dump_json([
            ModelRequest(parts=[UserPromptPart("Run the focused test")]),
            ModelResponse(parts=[ToolCallPart(
                tool_name="run_command", args={"command": "node --test test/habits.test.js"},
                tool_call_id="declined-tool-call",
            )]),
        ]).decode("utf-8")
        interaction = self.store.create_deferred_tool_interaction(
            mission_id=self.mission["id"], requested_by="builder",
            title="Run command outside safe set", details="Exact command: node --test test/habits.test.js",
            target=f"Run command in {self.repository}", trigger_sequence=trigger["sequence"],
            run_id="provider-run", conversation_id=f"tribe:{self.mission['id']}:builder",
            tool_call_id="declined-tool-call", tool_name="run_command",
            tool_arguments={"command": "node --test test/habits.test.js"}, message_history=history,
        )
        resolution = self.store.resolve_interaction(interaction["id"], "denied")
        captured: dict[str, object] = {}

        class ResumingAgent:
            async def run(inner_self, prompt, **kwargs):
                captured.update(prompt=prompt, **kwargs)
                return SimpleNamespace(output="I will use the repository test tool instead.")

        provider = PydanticAIProvider(
            AgentDefinition("builder", "Builder", "Implementation", "Build work", "builder.md"),
            "openai:test-model",
        )
        provider.agent = ResumingAgent()
        result = asyncio.run(provider.run(self.store, self.mission["id"], resolution["event"]))

        self.assertEqual(result.text, "I will use the repository test tool instead.")
        self.assertIsNone(captured["prompt"])
        self.assertEqual(len(captured["message_history"]), 2)
        self.assertFalse(captured["deferred_tool_results"].approvals["declined-tool-call"])
        row = self.store.deferred_tool_approvals(self.mission["id"], "builder")[0]
        self.assertEqual(row["status"], "denied")

    def test_unsupported_provider_does_not_persist_partial_configuration(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        with (
            patch("tribe_runtime.agent_runtime.save_api_key") as save_api_key,
            self.assertRaisesRegex(ValueError, "Unsupported provider"),
        ):
            supervisor.configure("not-a-pydantic-provider:model-name", "test-secret")
        save_api_key.assert_not_called()
        self.assertIsNone(self.store.get_setting("model"))
        self.assertIsNone(supervisor._api_key)

    def test_provider_credential_lookup_uses_the_provider_environment_convention(self) -> None:
        from tribe_runtime.credentials import get_api_key, provider_for_model

        self.assertEqual(provider_for_model("mistral:mistral-large-latest"), "mistral")
        with patch.dict(os.environ, {"MISTRAL_API_KEY": "test-secret"}, clear=True):
            self.assertEqual(get_api_key("mistral:mistral-large-latest"), "test-secret")

    def test_unlisted_pydantic_provider_uses_its_native_environment_credentials(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        definition = AgentDefinition("builder", "Builder", "Build", "Build safely.", "builder.md")
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("tribe_runtime.agent_runtime.get_api_key", return_value=None),
            self.assertRaisesRegex(ValueError, "documented environment variables"),
        ):
            supervisor.configure("zai:glm-4.5", "")

        with patch.dict(os.environ, {"ZAI_API_KEY": "provider-native-secret"}, clear=True), \
             patch("tribe_runtime.agent_runtime.get_api_key", return_value=None):
            status = supervisor.configure("zai:glm-4.5", "")
            self.assertTrue(status["enabled"])
            self.assertTrue(status["configured"])
            provider = PydanticAIProvider(definition, "zai:glm-4.5")
            self.assertEqual(
                provider.agent.model.provider.client.api_key, "provider-native-secret",
            )

    def test_unlisted_provider_environment_secret_is_redacted_from_connection_errors(self) -> None:
        supervisor = AgentSupervisor(self.store, [])

        class FailingAgent:
            def __init__(self, model, **kwargs):
                self.model = model

            def tool_plain(self, function):
                return function

            async def run(self, prompt, **kwargs):
                raise RuntimeError("Provider rejected provider-native-secret")

        with patch.dict(os.environ, {"ZAI_API_KEY": "provider-native-secret"}, clear=True), \
             patch("tribe_runtime.agent_runtime.get_api_key", return_value=None):
            supervisor.configure("zai:glm-4.5", "")
            with patch("pydantic_ai.Agent", FailingAgent):
                result = supervisor.check_connection()

        self.assertFalse(result["ok"])
        self.assertNotIn("provider-native-secret", result["error"])
        self.assertIn("[redacted]", result["error"])

    def test_azure_provider_uses_native_multi_part_environment_configuration(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        definition = AgentDefinition("builder", "Builder", "Build", "Build safely.", "builder.md")
        environment = {
            "AZURE_OPENAI_ENDPOINT": "https://tribe-test.openai.azure.com",
            "AZURE_OPENAI_API_KEY": "azure-test-secret",
            "OPENAI_API_VERSION": "2024-10-21",
        }
        with patch.dict(os.environ, environment, clear=True), \
             patch("tribe_runtime.agent_runtime.get_api_key", return_value=None):
            status = supervisor.configure("azure:deployment-name", "")
            provider = PydanticAIProvider(definition, "azure:deployment-name")

        self.assertTrue(status["enabled"])
        self.assertTrue(status["configured"])
        self.assertEqual(provider.agent.model.model_name, "deployment-name")
        self.assertTrue(str(provider.agent.model.provider.client.base_url).startswith(
            "https://tribe-test.openai.azure.com/openai/"
        ))

    def test_ollama_can_be_configured_without_a_provider_secret(self) -> None:
        from tribe_runtime.credentials import get_api_key

        supervisor = AgentSupervisor(self.store, [])
        with patch.dict(os.environ, {"TRIBE_OLLAMA_BASE_URL": "http://127.0.0.1:11435/v1"}, clear=True):
            with patch("tribe_runtime.agent_runtime.save_api_key") as save_api_key:
                status = supervisor.configure("ollama:qwen3", "")
            self.assertTrue(status["enabled"])
            self.assertTrue(status["configured"])
            self.assertNotIn("OLLAMA_BASE_URL", os.environ)
            self.assertEqual(get_api_key("ollama:qwen3"), "api-key-not-set")
            provider = PydanticAIProvider(
                AgentDefinition("local", "Local agent", "Build", "Build safely.", "test"),
                "ollama:qwen3",
            )
            self.assertEqual(provider.agent.model.model_name, "qwen3")
            self.assertEqual(str(provider.agent.model.provider.client.base_url), "http://127.0.0.1:11435/v1/")
            save_api_key.assert_not_called()

    def test_packaged_provider_smoke_constructs_ollama_without_environment(self) -> None:
        from tribe_runtime.diagnostics import check_provider_construction

        with patch.dict(os.environ, {}, clear=True):
            constructed = check_provider_construction()
        self.assertIn("ollama", constructed)
        self.assertIn("azure", constructed)

    def test_openai_compatible_local_endpoint_can_be_configured_without_a_key(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        with patch.dict(os.environ, {}, clear=True):
            with patch("tribe_runtime.agent_runtime.save_api_key") as save_api_key:
                status = supervisor.configure("openai:qwen3", "", "http://127.0.0.1:1234/v1")
            self.assertTrue(status["enabled"])
            self.assertTrue(status["configured"])
            self.assertEqual(status["baseUrl"], "http://127.0.0.1:1234/v1")
            self.assertNotIn("OPENAI_BASE_URL", os.environ)
            self.assertEqual(self.store.get_setting("model_base_url"), "http://127.0.0.1:1234/v1")
            save_api_key.assert_not_called()

    def test_native_provider_with_custom_endpoint_can_omit_api_key(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("tribe_runtime.agent_runtime.get_api_key", return_value=None),
        ):
            status = supervisor.configure(
                "alibaba:qwen-max", "", "http://localhost:8000/v1",
            )
        self.assertTrue(status["enabled"])
        self.assertTrue(status["configured"])
        self.assertEqual(status["baseUrl"], "http://localhost:8000/v1")
        provider = PydanticAIProvider(
            AgentDefinition("local", "Local agent", "Build", "Build safely.", "test"),
            "alibaba:qwen-max", "http://localhost:8000/v1",
        )
        self.assertEqual(provider.agent.model.provider.name, "alibaba")
        self.assertEqual(str(provider.agent.model.provider.client.base_url), "http://localhost:8000/v1/")

    def test_pydantic_ai_native_provider_ids_and_litellm_gateway_use_run_scoped_credentials(self) -> None:
        from tribe_runtime.agent_runtime import _model_for_identifier

        model = _model_for_identifier("alibaba:qwen-max", "dashscope-secret")
        self.assertEqual(model.provider.name, "alibaba")
        self.assertEqual(model.provider.client.api_key, "dashscope-secret")

        gateway = _model_for_identifier("litellm:openai/gpt-test", "proxy-secret",
                                        "http://localhost:4000/v1")
        self.assertEqual(gateway.provider.name, "litellm")
        self.assertEqual(gateway.provider.client.api_key, "proxy-secret")
        self.assertEqual(str(gateway.provider.client.base_url), "http://localhost:4000/v1/")

    def test_provider_sdk_retries_are_disabled_when_sdk_exposes_retry_count(self) -> None:
        from tribe_runtime.agent_runtime import _model_for_identifier

        model = _model_for_identifier("openai:gpt-test", "openai-secret")

        self.assertEqual(model.provider.client.max_retries, 0)

    def test_google_cohere_mistral_and_google_gateway_retries_are_disabled(self) -> None:
        from tribe_runtime.agent_runtime import _model_for_identifier

        google = _model_for_identifier("google:gemini-2.5-flash", "google-secret")
        self.assertEqual(
            google.provider.client._api_client._http_options.retry_options.attempts, 1,
        )

        google_gateway = _model_for_identifier(
            "gateway/google:gemini-2.5-flash", "gateway-secret", "http://localhost:4000/v1",
        )
        self.assertEqual(
            google_gateway.provider.client._api_client._http_options.retry_options.attempts, 1,
        )

        cohere = _model_for_identifier("cohere:command-a-03-2025", "cohere-secret")
        self.assertEqual(cohere.provider.client._client_wrapper.get_max_retries(), 0)

        mistral = _model_for_identifier("mistral:mistral-large-latest", "mistral-secret")
        self.assertEqual(mistral.provider.client.sdk_configuration.retry_config.strategy, "none")

    def test_openai_endpoint_url_validation_rejects_insecure_remote_and_embedded_secrets(self) -> None:
        from tribe_runtime.credentials import validate_openai_base_url

        self.assertEqual(validate_openai_base_url("https://gateway.example/v1/"), "https://gateway.example/v1")
        self.assertEqual(validate_openai_base_url("http://localhost:1234/v1"), "http://localhost:1234/v1")
        for value in (
            "http://gateway.example/v1",
            "https://user:secret@gateway.example/v1",
            "https://gateway.example/v1?token=secret",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_openai_base_url(value)

    def test_coding_agent_subscription_is_not_a_model_provider(self) -> None:
        from tribe_runtime.credentials import provider_for_model

        with self.assertRaisesRegex(ValueError, "harness subscriptions are not supported"):
            provider_for_model("openai-codex:gpt-5.6-luna")

        supervisor = AgentSupervisor(self.store, [])
        with self.assertRaisesRegex(ValueError, "harness subscriptions are not supported"):
            supervisor.configure("openai-codex:gpt-5.6-luna")
        self.assertIsNone(self.store.get_setting("model"))

    def test_provider_connection_check_verifies_tool_calls_and_redacts_credentials(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        supervisor.model = "openai:test-model"
        supervisor._api_key = "connection-secret"
        supervisor._errors.clear()
        captured: dict[str, object] = {}

        class TestAgent:
            def __init__(self, model, **kwargs):
                captured["model"] = model
                captured["agent_options"] = kwargs

            def tool_plain(self, function):
                captured["probe_tool"] = function
                return function

            async def run(self, prompt, **kwargs):
                captured["prompt"] = prompt
                captured["run_options"] = kwargs
                captured["probe_tool"]()
                return "OK"

        with patch("pydantic_ai.Agent", TestAgent):
            result = supervisor.check_connection()
        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "openai:test-model")
        self.assertEqual(captured["model"].provider.name, "openai")
        self.assertEqual(captured["model"].provider.client.api_key, "connection-secret")
        self.assertIn("Call tribe_connection_probe exactly once", captured["prompt"])
        self.assertEqual(captured["run_options"]["usage_limits"].request_limit, 2)
        self.assertEqual(captured["run_options"]["usage_limits"].output_tokens_limit, 48)
        self.assertTrue(result["connected"])
        self.assertTrue(result["toolCalling"])

        class TextOnlyAgent(TestAgent):
            async def run(self, prompt, **kwargs):
                return "OK"

        with patch("pydantic_ai.Agent", TextOnlyAgent):
            text_only = supervisor.check_connection()
        self.assertTrue(text_only["connected"])
        self.assertFalse(text_only["toolCalling"])

        class FailingAgent(TestAgent):
            async def run(self, prompt, **kwargs):
                raise RuntimeError("provider rejected connection-secret")

        with patch("pydantic_ai.Agent", FailingAgent):
            failed = supervisor.check_connection()
        self.assertFalse(failed["ok"])
        self.assertNotIn("connection-secret", failed["error"])
        self.assertIn("[redacted]", failed["error"])

    def test_ollama_connection_check_uses_the_agent_run_endpoint(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        supervisor.model = "ollama:qwen2.5-coder:7b"
        supervisor._api_key = "api-key-not-set"
        supervisor._errors.clear()
        captured: dict[str, object] = {}

        class ProbeAgent:
            def __init__(self, model, **kwargs):
                captured["model"] = model

            def tool_plain(self, function):
                captured["probe_tool"] = function
                return function

            async def run(self, prompt, **kwargs):
                captured["probe_tool"]()
                return "OK"

        with patch.dict("os.environ", {"TRIBE_OLLAMA_BASE_URL": "http://ollama.test/v1"}), \
                patch("pydantic_ai.Agent", ProbeAgent), \
                patch("tribe_runtime.agent_runtime._model_for_identifier", side_effect=lambda model, key, base_url: (
                    captured.update({"model_id": model, "base_url": base_url}) or object()
                )):
            result = supervisor.check_connection()

        self.assertTrue(result["toolCalling"])
        self.assertEqual(captured["base_url"], "http://ollama.test/v1")

    def test_provider_connection_check_requires_a_configured_runtime(self) -> None:
        supervisor = AgentSupervisor(self.store, [])
        result = supervisor.check_connection()
        self.assertFalse(result["ok"])
        self.assertIsNone(result["model"])

    def test_unversioned_store_is_upgraded_without_losing_missions(self) -> None:
        with _database_connection(self.store.path) as db:
            db.execute("PRAGMA user_version = 0")

        upgraded = MissionStore(self.store.path)
        data = upgraded.bootstrap(self.project["id"], self.mission["id"])
        self.assertEqual(data["project"]["name"], self.project["name"])
        self.assertEqual(data["mission"]["goal"], self.mission["goal"])
        with _database_connection(self.store.path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_store_refuses_a_schema_version_newer_than_runtime(self) -> None:
        future_store = self.root / "future.sqlite3"
        with _database_connection(future_store) as db:
            db.execute("PRAGMA user_version = 999")
        with self.assertRaisesRegex(RuntimeError, "newer than this runtime supports"):
            MissionStore(future_store)
        with _database_connection(future_store) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")

    def test_schema_v1_migrates_project_goal_from_first_mission(self) -> None:
        legacy_store = self.root / "legacy-v1.sqlite3"
        with _database_connection(legacy_store) as db:
            db.executescript("""
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    repository TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                    title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
                INSERT INTO projects VALUES ('project-1', 'Legacy', '/repo', '2025-01-01');
                INSERT INTO missions VALUES ('mission-1', 'project-1', 'Initial', 'Keep this objective', 'paused', '2025-01-02');
                PRAGMA user_version = 1;
            """)

        MissionStore(legacy_store)
        with _database_connection(legacy_store) as db:
            self.assertEqual(db.execute("SELECT goal FROM projects WHERE id = 'project-1'").fetchone()[0],
                             "Keep this objective")
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_schema_v3_adds_deferred_approval_run_identity(self) -> None:
        legacy_store = self.root / "legacy-v3.sqlite3"
        with _database_connection(legacy_store) as db:
            db.execute("""CREATE TABLE deferred_tool_approvals (
                interaction_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL,
                agent_id TEXT NOT NULL, trigger_sequence INTEGER NOT NULL,
                conversation_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
                tool_name TEXT NOT NULL, tool_arguments TEXT NOT NULL,
                message_history TEXT NOT NULL, target TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )""")
            db.execute("PRAGMA user_version = 3")

        MissionStore(legacy_store)
        with _database_connection(legacy_store) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(deferred_tool_approvals)")}
            self.assertIn("run_id", columns)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_schema_v4_adds_agent_event_runs_without_losing_events(self) -> None:
        legacy_store = self.root / "legacy-v4.sqlite3"
        with _database_connection(legacy_store) as db:
            db.executescript("""
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    repository TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                    title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                    project_id TEXT NOT NULL, mission_id TEXT NOT NULL, event_type TEXT NOT NULL,
                    actor_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
                INSERT INTO projects VALUES ('project-v4', 'Legacy', '/repo', '2025-01-01');
                INSERT INTO missions VALUES ('mission-v4', 'project-v4', 'Mission', 'Goal', 'paused', '2025-01-02');
                INSERT INTO events VALUES (1, 'event-v4', 'project-v4', 'mission-v4',
                    'message.created', 'user', '{"text":"Preserve this event"}', '2025-01-03');
                PRAGMA user_version = 4;
            """)

        upgraded = MissionStore(legacy_store)

        self.assertEqual(upgraded.events_after("mission-v4", 0)[0]["id"], "event-v4")
        self.assertIsNone(upgraded.agent_event_run("builder", "mission-v4", 1))
        with _database_connection(legacy_store) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(agent_event_runs)")}
            self.assertIn("status", columns)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_schema_v13_adds_mission_blocked_state_without_losing_mission(self) -> None:
        legacy_store = self.root / "legacy-v13.sqlite3"
        with _database_connection(legacy_store) as db:
            db.executescript("""
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    repository TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
                CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                    title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, background INTEGER NOT NULL DEFAULT 0,
                    recipe_id TEXT, recipe_version INTEGER, recipe_snapshot TEXT);
                INSERT INTO projects VALUES ('project-v13', 'Legacy', '/repo', 'Goal', '2025-01-01');
                INSERT INTO missions VALUES ('mission-v13', 'project-v13', 'Mission', 'Preserve this mission', 'active', '2025-01-02', 0, NULL, NULL, NULL);
                PRAGMA user_version = 13;
            """)

        upgraded = MissionStore(legacy_store)
        self.assertEqual(upgraded.mission("mission-v13")["goal"], "Preserve this mission")
        with _database_connection(legacy_store) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(missions)")}
            self.assertIn("blocked_reason", columns)
            self.assertIn("blocked_at", columns)
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_unversioned_legacy_store_adds_and_backfills_project_goal(self) -> None:
        legacy_store = self.root / "legacy-unversioned.sqlite3"
        with _database_connection(legacy_store) as db:
            db.executescript("""
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    repository TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                    title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
                INSERT INTO projects VALUES ('project-legacy', 'Legacy', '/repo', '2025-01-01');
                INSERT INTO missions VALUES ('mission-legacy', 'project-legacy', 'Initial', 'Backfill this goal', 'paused', '2025-01-02');
            """)

        MissionStore(legacy_store)
        with _database_connection(legacy_store) as db:
            self.assertEqual(db.execute("SELECT goal FROM projects WHERE id = 'project-legacy'").fetchone()[0],
                             "Backfill this goal")
            self.assertIn("blocked_reason", {row[1] for row in db.execute("PRAGMA table_info(missions)")})
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_project_goal_is_user_owned_and_audited_in_the_mission_channel(self) -> None:
        updated = self.store.update_project_goal(
            self.project["id"], self.mission["id"], "Maintain a stable multi-agent harness"
        )
        self.assertEqual(updated["goal"], "Maintain a stable multi-agent harness")
        events = self.store.events_after(self.mission["id"], 0)
        changes = [event for event in events if event["type"] == "project.goal.updated"]
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["actorId"], "user")
        self.assertEqual(changes[0]["payload"]["projectGoal"], updated["goal"])
        self.store.update_project_goal(self.project["id"], self.mission["id"], updated["goal"])
        self.assertEqual(len([event for event in self.store.events_after(self.mission["id"], 0)
                              if event["type"] == "project.goal.updated"]), 1)

    def test_agents_can_revise_ready_or_owned_work_but_not_other_claims_or_completed_work(self) -> None:
        ready = self.store.create_work_item(self.mission["id"], "Initial", "Initial detail")
        revised = self.store.revise_work_item(
            self.mission["id"], ready["id"], "planner", "Improved task", "Clear acceptance condition"
        )
        self.assertEqual(revised["title"], "Improved task")
        self.assertEqual(self.store.work_items(self.mission["id"])[0]["detail"], "Clear acceptance condition")

        claimed = self.store.claim_work(self.mission["id"], "builder")
        with self.assertRaises(PermissionError):
            self.store.revise_work_item(self.mission["id"], claimed["id"], "planner", "Override", "")
        self.store.revise_work_item(self.mission["id"], claimed["id"], "builder", "Builder update", "In progress")
        self.store.complete_work(claimed["id"], "builder", "Done")
        with self.assertRaisesRegex(ValueError, "completed work items"):
            self.store.revise_work_item(self.mission["id"], claimed["id"], "builder", "Reopen", "")

    def test_path_lock_serializes_independent_runtime_processes(self) -> None:
        log = self.root / "lock.log"
        script = """
import sys, time
from pathlib import Path
from tribe_runtime.store import MissionStore
from tribe_runtime.workspace import WorkspaceTools
database, mission_id, repository, label, output = sys.argv[1:]
store = MissionStore(Path(database))
workspace = WorkspaceTools(store, mission_id, label)
with workspace._path_lock(Path(repository) / 'README.md'):
    with open(output, 'a', encoding='utf-8') as stream:
        stream.write(label + ' start\\n')
    time.sleep(0.2)
    with open(output, 'a', encoding='utf-8') as stream:
        stream.write(label + ' end\\n')
"""
        environment = {**os.environ, "PYTHONPATH": str(ROOT / "runtime")}
        arguments = [
            sys.executable, "-c", script, str(self.store.path), self.mission["id"],
            str(self.repository), "agent-a", str(log),
        ]
        first = subprocess.Popen(arguments, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        second = subprocess.Popen(arguments[:6] + ["agent-b", str(log)], env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        first_output, first_error = first.communicate(timeout=10)
        second_output, second_error = second.communicate(timeout=10)
        self.assertEqual(first.returncode, 0, first_output + first_error)
        self.assertEqual(second.returncode, 0, second_output + second_error)
        lines = log.read_text(encoding="utf-8").splitlines()
        self.assertIn(lines, [
            ["agent-a start", "agent-a end", "agent-b start", "agent-b end"],
            ["agent-b start", "agent-b end", "agent-a start", "agent-a end"],
        ])

    def test_repository_deletion_needs_exact_one_use_approval(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        target = workspace.resolve("README.md")
        fingerprint = workspace.file_fingerprint("README.md")
        wrong = self.store.create_repository_file_deletion_approval(
            self.mission["id"], "Delete file", "Wrong target", str(target) + ".other",
            "builder", fingerprint,
        )
        self.store.resolve_interaction(wrong["id"], "approved_once")
        with self.assertRaises(PermissionError):
            workspace.delete_file("README.md", wrong["id"])

        stale = self.store.create_repository_file_deletion_approval(
            self.mission["id"], "Delete file", "Exact target", str(target),
            "builder", fingerprint,
        )
        self.store.resolve_interaction(stale["id"], "approved_once")
        (self.repository / "README.md").write_text("changed after approval\n", encoding="utf-8")
        with self.assertRaisesRegex(PermissionError, "unchanged file"):
            workspace.delete_file("README.md", stale["id"])
        self.assertEqual((self.repository / "README.md").read_text(encoding="utf-8"), "changed after approval\n")
        with self.store._connect() as db:
            self.assertIsNone(db.execute(
                "SELECT 1 FROM approval_consumptions WHERE interaction_id = ?", (stale["id"],),
            ).fetchone())

        fresh = self.store.create_repository_file_deletion_approval(
            self.mission["id"], "Delete file", "Updated file", str(target),
            "builder", workspace.file_fingerprint("README.md"),
        )
        self.store.resolve_interaction(fresh["id"], "approved_once")
        self.assertEqual(workspace.delete_file("README.md", fresh["id"]), "README.md")
        artifact = next(item for item in self.store.mission_artifacts(self.mission["id"])
                        if item["name"] == "README.md.deletion.diff")
        content = self.store.artifact_content(artifact["id"], self.mission["id"])[1]
        self.assertIn(b"-changed after approval", content)
        event_types = [event["type"] for event in self.store.events_after(self.mission["id"], 0)]
        self.assertLess(event_types.index("interaction.approval.consumed"), event_types.index("repo.file.delete.started"))
        self.assertLess(event_types.index("repo.file.delete.started"), event_types.index("repo.file.deleted"))
        with self.assertRaises(FileNotFoundError):
            workspace.delete_file("README.md", fresh["id"])

    def test_startup_reconciles_interrupted_repository_deletions_without_replaying(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")

        def begin_delete(path: str) -> tuple[dict[str, str], Path, str]:
            target = workspace.resolve(path)
            fingerprint = workspace.file_fingerprint(path)
            approval = self.store.create_repository_file_deletion_approval(
                self.mission["id"], f"Delete {path}", "Approved test deletion",
                str(target), "builder", fingerprint,
            )
            self.store.resolve_interaction(approval["id"], "approved_once")
            self.assertTrue(self.store.consume_repository_file_deletion_approval(
                approval["id"], str(target), fingerprint, self.mission["id"], "builder", path,
                f"--- a/{path}\n+++ b/{path}\n@@ -1 +0,0 @@\n-approved content\n".encode(),
                f"{Path(path).name}.deletion.diff", "text/x-diff",
            ))
            return approval, target, fingerprint

        still_present, still_present_path, _ = begin_delete("README.md")
        # Simulate a v24 process stopping after the durable start event but before the op row existed.
        with self.store._connect() as db:
            db.execute(
                "DELETE FROM repository_file_deletions WHERE approval_id = ?",
                (still_present["id"],),
            )
        self.assertEqual(self.store.reconcile_repository_file_deletions(), 1)
        self.assertTrue(still_present_path.exists())
        with self.store._connect() as db:
            status = db.execute(
                "SELECT status FROM repository_file_deletions WHERE approval_id = ?",
                (still_present["id"],),
            ).fetchone()[0]
        self.assertEqual(status, "recovered_not_deleted")
        self.assertEqual(self.store.reconcile_repository_file_deletions(), 0)

        removed, removed_path, _ = begin_delete("README.md")
        removed_path.unlink()
        self.assertEqual(self.store.reconcile_repository_file_deletions(), 1)
        with self.store._connect() as db:
            status = db.execute(
                "SELECT status FROM repository_file_deletions WHERE approval_id = ?",
                (removed["id"],),
            ).fetchone()[0]
        self.assertEqual(status, "recovered_deleted")
        recovered_artifact = next(
            item for item in self.store.mission_artifacts(self.mission["id"])
            if item["name"] == "README.md.deletion.diff"
        )
        recovered_diff = self.store.artifact_content(
            recovered_artifact["id"], self.mission["id"],
        )[1]
        self.assertIn(b"approved content", recovered_diff)
        self.assertEqual(self.store.reconcile_repository_file_deletions(), 0)
        self.assertEqual(sum(
            item["name"] == "README.md.deletion.diff"
            for item in self.store.mission_artifacts(self.mission["id"])
        ), 1)

        (self.repository / "changed.txt").write_text("approved version\n", encoding="utf-8")
        changed, changed_path, _ = begin_delete("changed.txt")
        changed_path.write_text("different version\n", encoding="utf-8")
        self.assertEqual(self.store.reconcile_repository_file_deletions(), 1)
        self.assertEqual(changed_path.read_text(encoding="utf-8"), "different version\n")
        with self.store._connect() as db:
            status = db.execute(
                "SELECT status FROM repository_file_deletions WHERE approval_id = ?",
                (changed["id"],),
            ).fetchone()[0]
        self.assertEqual(status, "needs_attention")

    def test_repository_browser_lists_safe_paths_and_bounds_file_previews(self) -> None:
        source = self.repository / "src" / "main.py"
        source.parent.mkdir()
        source.write_bytes(b"print('hello')\n")
        (self.repository / ".tribe").mkdir()
        (self.repository / ".tribe" / "private.txt").write_text("hidden", encoding="utf-8")

        root = browse_repository(self.repository)
        source_preview = browse_repository(self.repository, "src/main.py")

        self.assertNotIn(".git", {entry["name"] for entry in root["entries"]})
        self.assertNotIn(".tribe", {entry["name"] for entry in root["entries"]})
        self.assertEqual(source_preview["content"], "print('hello')\n")
        with self.assertRaisesRegex(ValueError, "canonical"):
            browse_repository(self.repository, "../outside")

        outside = self.root / "outside.txt"
        outside.write_text("private", encoding="utf-8")
        link = self.repository / "outside-link.txt"
        try:
            link.symlink_to(outside)
        except OSError:
            return  # Windows hosts without symlink privileges still exercise traversal checks.
        with self.assertRaisesRegex(ValueError, "outside_project"):
            browse_repository(self.repository, "outside-link.txt")

    def test_notebook_git_diff_includes_bounded_before_and_after_versions(self) -> None:
        notebook_path = self.repository / "analysis.ipynb"
        original = {"nbformat": 4, "cells": [{"id": "cell-a", "cell_type": "code", "source": ["x = 1"], "outputs": []}]}
        updated = {"nbformat": 4, "cells": [{"id": "cell-a", "cell_type": "code", "source": ["x = 2"], "outputs": []}]}
        notebook_path.write_text(json.dumps(original), encoding="utf-8")
        self.git("add", "analysis.ipynb")
        self.git("commit", "-qm", "add notebook")
        notebook_path.write_text(json.dumps(updated), encoding="utf-8")

        changed = project_git_diff(self.repository, "analysis.ipynb")
        versions = changed["notebookVersions"]
        self.assertEqual(json.loads(versions["before"]), original)
        self.assertEqual(json.loads(versions["after"]), updated)
        self.assertIn("-", changed["diff"])

        new_notebook = self.repository / "new-analysis.ipynb"
        new_notebook.write_text(json.dumps(updated), encoding="utf-8")
        added = project_git_diff(self.repository, "new-analysis.ipynb")
        self.assertEqual(added["notebookVersions"]["before"], "")
        self.assertEqual(json.loads(added["notebookVersions"]["after"]), updated)

    def test_test_commands_do_not_inherit_credentials_from_the_agent_process(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        completed = {
            "exit_code": 0, "stdout": "pytest 8", "stderr": "",
            "timed_out": False, "cancelled": False,
        }
        with (
            patch.dict(os.environ, {
                "OPENAI_API_KEY": "provider-secret",
                "GITHUB_TOKEN": "source-control-secret",
                "AWS_ACCESS_KEY_ID": "cloud-secret",
                "PATH": os.environ.get("PATH", ""),
                "GIT_AUTHOR_NAME": "Tribe Agent",
            }),
            patch("tribe_runtime.commands.run_foreground_process", return_value=completed) as run,
        ):
            workspace.run_tests(["pytest", "--version"])
            node_result = workspace.run_tests(["node", "--test", "tests/focus-timer.test.mjs"])

        environment = run.call_args.kwargs["env"]
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("GITHUB_TOKEN", environment)
        self.assertNotIn("AWS_ACCESS_KEY_ID", environment)
        self.assertIn("PATH", environment)
        self.assertEqual(environment["GIT_AUTHOR_NAME"], "Tribe Agent")
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args[0], ["node", "--test", "tests/focus-timer.test.mjs"])
        self.assertEqual(node_result["argv"], ["node", "--test", "tests/focus-timer.test.mjs"])
        self.assertTrue(node_result["verificationEventId"])
        completion_event = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "repo.test_run.completed"
            and event["payload"]["runId"] == node_result["runId"]
        )
        self.assertEqual(node_result["verificationEventId"], completion_event["id"])
        self.assertIsNone(run.call_args.kwargs["is_cancelled"])

    def test_expected_agent_tool_validation_errors_return_recovery_feedback(self) -> None:
        builder = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "builder.md",
            tool_permissions=("post_update", "message_agent", "reply_to_agent"),
        )
        builder_workspace = WorkspaceTools(self.store, self.mission["id"], builder.id)
        builder_deps = AgentDependencies(
            self.store, self.mission["id"], builder, builder_workspace, SkillCatalog(self.repository),
        )
        agent = _build_agent(builder, "openai:test-model")
        message = agent._function_toolset.tools["message_agent"]
        reply = agent._function_toolset.tools["reply_to_agent"]
        context = SimpleNamespace(deps=builder_deps)
        for text in ("First coordination note", "Second coordination note"):
            result = message.function(context, "reviewer", text)
            self.assertEqual(result, "Direct message sent.")
        builder_deps.reply_to_agent_id = "planner"
        self.assertEqual(
            reply.function(context, "Here is the requested clarification."),
            "Direct message sent.",
        )
        direct_messages = [
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.message.created" and event["actorId"] == builder.id
        ]
        self.assertEqual([event["payload"]["recipient"] for event in direct_messages],
                         ["reviewer", "reviewer", "planner"])
        thread_id = direct_messages[0]["payload"]["replyChainId"]
        dm_event = {"id": direct_messages[0]["id"], "type": "agent.message.created",
                    "payload": direct_messages[0]["payload"]}
        self.assertEqual(_agent_conversation_id(self.mission["id"], "reviewer", dm_event),
                         f"tribe:{self.mission['id']}:reviewer:dm:{thread_id}")
        self.assertEqual(_agent_conversation_id(self.mission["id"], "reviewer", {
            "id": "broadcast", "type": "agent.message.created", "payload": {"recipient": None},
        }), f"tribe:{self.mission['id']}:reviewer")

        reviewer = AgentDefinition("reviewer", "Reviewer", "Review", "Review", "reviewer.md")
        review_mission = self.store.create_mission(
            self.project["id"], "Review tool recovery", "Verify review-tool error recovery",
            {"id": "goal-driven-sdlc", "version": 1, "title": "Goal-driven SDLC"},
        )
        work = self.store.create_work_item(review_mission["id"], "Review the result")
        criteria = [{"criterion": "The result is verified", "work_item_ids": [work["id"]]}]
        self.store.finalize_plan(review_mission["id"], "planner", criteria)
        test_event = self.store.append(
            "repo.test_run.completed", "builder", review_mission["id"],
            {"runId": "passing", "argv": ["pytest"], "exitCode": 0},
        )
        review_work = self.store.claim_work(review_mission["id"], reviewer.id)
        self.store.complete_work(review_work["id"], reviewer.id, "Review completed")
        reviewer_workspace = WorkspaceTools(self.store, review_mission["id"], reviewer.id)
        reviewer_deps = AgentDependencies(
            self.store, review_mission["id"], reviewer, reviewer_workspace, SkillCatalog(self.repository),
        )
        reviewer_agent = _build_agent(reviewer, "openai:test-model")
        self.assertNotIn("record_review_checkpoint", reviewer_agent._function_toolset.tools)
        self.assertTrue(test_event["id"])

        planner = next(item for item in discover_agents(ROOT / "agents") if item.id == "planner")
        planner_workspace = WorkspaceTools(self.store, review_mission["id"], planner.id)
        planner_deps = AgentDependencies(
            self.store, review_mission["id"], planner, planner_workspace,
            SkillCatalog(self.repository),
        )
        planner_agent = _build_agent(planner, "openai:test-model")
        complete_tool = planner_agent._function_toolset.tools["update_state"]
        completion = complete_tool.function(
            SimpleNamespace(deps=planner_deps), "chat", "finish", summary="Complete",
        )
        self.assertEqual(completion["event"]["type"], "mission.completed")

    def test_repository_test_tool_forwards_agent_cancellation_token(self) -> None:
        from pydantic_ai import CancellationToken

        definition = AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md")
        item = self.store.create_work_item(self.mission["id"], "Run repository tests")
        claimed = self.store.claim_work(self.mission["id"], definition.id)
        self.assertEqual(claimed["id"], item["id"])
        token = CancellationToken()
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id, item["id"])
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace,
            SkillCatalog(self.repository), active_work_item_id=item["id"], cancellation_token=token,
        )
        tool = _build_agent(definition, "openai:test-model")._function_toolset.tools[
            "run_repository_tests"
        ]
        captured: dict[str, object] = {}

        def run_process(argv, **kwargs):
            captured.update(argv=argv, **kwargs)
            return {
                "exit_code": 0, "stdout": "passed", "stderr": "",
                "cancelled": False, "timed_out": False,
            }

        with patch("tribe_runtime.commands.run_foreground_process", side_effect=run_process):
            result = tool.function(SimpleNamespace(deps=dependencies), ["pytest", "--version"])

        is_cancelled = captured["is_cancelled"]
        self.assertFalse(is_cancelled())
        token.cancel()
        self.assertTrue(is_cancelled())
        self.assertFalse(result["cancelled"])
        completion = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "repo.test_run.completed"
        )
        self.assertEqual(completion["payload"]["exitCode"], 0)

    def test_repository_test_tool_returns_nonzero_exit_as_actionable_result(self) -> None:
        definition = AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md")
        item = self.store.create_work_item(self.mission["id"], "Run a failing test command")
        claimed = self.store.claim_work(self.mission["id"], definition.id)
        self.assertEqual(claimed["id"], item["id"])
        attempt_cursor = self.store.latest_sequence(self.mission["id"])
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id, item["id"])
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace,
            SkillCatalog(self.repository), active_work_item_id=item["id"],
        )
        self.store.append("agent.tool.started", definition.id, self.mission["id"], {
            "toolName": "run_repository_tests", "toolCallId": "test-call-1",
        })
        tool = _build_agent(definition, "openai:test-model")._function_toolset.tools[
            "run_repository_tests"
        ]
        failure = {
            "exit_code": 1, "stdout": "1 failed", "stderr": "assertion mismatch",
            "cancelled": False, "timed_out": False,
        }

        with patch("tribe_runtime.commands.run_foreground_process", return_value=failure):
            result = tool.function(
                SimpleNamespace(deps=dependencies, tool_call_id="test-call-1"), ["pytest", "tests"],
            )

        self.assertEqual(result["exitCode"], 1)
        self.assertEqual(result["stdout"], "1 failed")
        self.assertEqual(result["stderr"], "assertion mismatch")
        completion = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "repo.test_run.completed"
        )
        self.assertEqual(completion["payload"]["exitCode"], 1)
        self.assertEqual(completion["payload"]["toolCallId"], "test-call-1")
        self.store.append("agent.tool.completed", definition.id, self.mission["id"], {
            "toolName": "run_repository_tests", "toolCallId": "test-call-1", "outcome": "success",
        })
        self.assertFalse(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], attempt_cursor, definition.id,
        ))
        incomplete_cursor = self.store.latest_sequence(self.mission["id"])
        self.store.append("agent.tool.started", definition.id, self.mission["id"], {
            "toolName": "run_repository_tests", "toolCallId": "test-call-2",
        })
        self.store.append("repo.test_run.started", definition.id, self.mission["id"], {
            "runId": "interrupted-command", "argv": ["pytest", "tests"],
            "toolCallId": "test-call-2",
        })
        self.assertTrue(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], incomplete_cursor, definition.id,
        ))

    def test_command_output_is_durable_activity_data_not_an_artifact(self) -> None:
        output = "test output"
        self.assertEqual(_durable_tool_output("run_command", output), output)
        self.assertIsNone(_durable_tool_output("read_repository_file", output))
        self.assertIsNone(_durable_tool_output("run_command", "   "))
        self.assertEqual(len(_durable_tool_output("check_command", "x" * 200_010)), 200_000)

    def test_file_recovery_hashes_complete_unified_edits_and_rejects_uncertain_diffs(self) -> None:
        from difflib import unified_diff

        from tribe_runtime.file_recovery import expected_file_hash

        path = self.root / "edit.txt"
        before = "keep this\nreplace this\nlast line\n"
        after = "keep this\nreplacement\nlast line\nnew line\n"
        path.write_text(before, encoding="utf-8")
        diff = "".join(unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile="a/edit.txt", tofile="b/edit.txt",
        ))
        self.assertEqual(
            expected_file_hash(path, diff, truncated=False),
            hashlib.sha256(after.encode("utf-8")).hexdigest(),
        )
        self.assertIsNone(expected_file_hash(path, diff, truncated=True))
        self.assertIsNone(expected_file_hash(path, "--- a/edit.txt\n+++ b/edit.txt\n", truncated=False))
        path.unlink()
        create_diff = "".join(unified_diff(
            [], after.splitlines(keepends=True), fromfile="/dev/null", tofile="b/edit.txt",
        ))
        self.assertEqual(
            expected_file_hash(path, create_diff, truncated=False),
            hashlib.sha256(after.encode("utf-8")).hexdigest(),
        )

    def test_agent_claim_tool_accepts_the_selected_work_item_id(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "builder.md",
            capabilities=("task_coordination",),
        )
        self.store.create_work_item(self.mission["id"], "Review the design")
        selected = self.store.create_work_item(self.mission["id"], "Implement the fix")
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        tool = _build_agent(definition, "openai:test-model")._function_toolset.tools["update_state"]
        self.assertEqual(
            tool.function_schema.json_schema["required"], ["target", "action"],
        )

        claimed = tool.function(SimpleNamespace(deps=dependencies), "task", "claim", selected["id"])

        self.assertEqual(claimed["id"], selected["id"])
        self.assertEqual(dependencies.active_work_item_id, selected["id"])
        self.assertEqual(workspace.work_item_id, selected["id"])

        reviewer = AgentDefinition(
            "reviewer", "Reviewer", "Review", "Review", "reviewer.md",
            capabilities=("task_coordination", "conversation"),
        )
        model_selected = self.store.create_work_item(self.mission["id"], "Verify the implementation")
        reviewer_workspace = WorkspaceTools(self.store, self.mission["id"], reviewer.id)
        reviewer_dependencies = AgentDependencies(
            self.store, self.mission["id"], reviewer, reviewer_workspace,
            SkillCatalog(self.repository),
        )

        async def run_agent_choice() -> None:
            agent = _build_agent(reviewer, "openai:test-model")
            self.reveal_deferred_test_tools(agent)

            class BoardChoiceModel(TestModel):
                def gen_tool_args(self, tool_def):
                    if tool_def.name == "list_plan_items":
                        return {}
                    if tool_def.name == "update_state":
                        return {"target": "task", "action": "claim", "target_id": model_selected["id"]}
                    if tool_def.name == "post_update":
                        return {"text": "I claimed the implementation task."}
                    return super().gen_tool_args(tool_def)

            with agent.override(model=BoardChoiceModel(
                call_tools=["list_plan_items", "update_state", "post_update"],
            )):
                await agent.run("Choose and claim the verification task from the board.", deps=reviewer_dependencies)

        asyncio.run(run_agent_choice())
        events = self.store.events_after(self.mission["id"], 0)
        claim_event = next(event for event in events if (
            event["type"] == "plan.item.claimed"
            and event["actorId"] == reviewer.id
            and event["payload"]["workItem"]["id"] == model_selected["id"]
        ))
        message_event = next(event for event in events if (
            event["type"] == "agent.message.created"
            and event["actorId"] == reviewer.id
            and event["payload"].get("workItemId") == model_selected["id"]
        ))
        self.assertLess(claim_event["sequence"], message_event["sequence"])

    def test_isolated_patch_requires_approval_and_integrates(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        workspace.start_isolated_work()
        workspace.write_file("README.md", "isolated edit\n")
        request = workspace.request_isolated_integration("Reviewed change")
        with self.assertRaises(PermissionError):
            workspace.integrate_isolated_changes(request["interactionId"])

        self.store.resolve_interaction(request["interactionId"], "approved_once")
        result = workspace.integrate_isolated_changes(request["interactionId"])
        self.assertTrue(result["workspaceRemoved"])
        self.assertEqual((self.repository / "README.md").read_text(encoding="utf-8"), "isolated edit\n")
        self.assertEqual(self.store.integration_request(request["interactionId"])["status"], "applied")

    def test_discard_cancels_pending_integration(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        workspace.start_isolated_work()
        workspace.write_file("README.md", "discard me\n")
        request = workspace.request_isolated_integration("Discard this proposal")
        result = workspace.discard_isolated_work()

        self.assertTrue(result["discarded"])
        self.assertEqual(self.store.integration_request(request["interactionId"])["status"], "cancelled")
        self.assertEqual(self.store.approval(request["interactionId"])["resolution"], "cancelled_by_user")
        self.assertEqual((self.repository / "README.md").read_text(encoding="utf-8"), "base\n")

    def test_skill_catalog_discovers_and_reads_project_skills(self) -> None:
        skill_file = self.repository / ".agents" / "skills" / "review" / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(
            "---\nname: Review changes\ndescription: Inspect a patch\n---\nCheck behaviour first.\n",
            encoding="utf-8",
        )
        reference_file = skill_file.parent / "references" / "checklist.md"
        reference_file.parent.mkdir()
        reference_file.write_text("Check regressions and failure paths.\n", encoding="utf-8")
        home = self.root / "home"
        home.mkdir()
        with (
            patch("tribe_runtime.skills.Path.home", return_value=home),
            patch.dict(os.environ, {"AGENT_SKILLS_PATHS": ""}),
        ):
            catalog = SkillCatalog(self.repository)
        skills = catalog.list("patch")
        self.assertEqual(len(skills), 1)
        self.assertIn("Check behaviour first", catalog.read(skills[0]["id"]))
        self.assertEqual(catalog.list_resources(skills[0]["id"]), ["references/checklist.md"])
        self.assertEqual(catalog.read_resource(skills[0]["id"], "references/checklist.md"),
                         "Check regressions and failure paths.\n")
        with self.assertRaisesRegex(ValueError, "invalid_skill_resource_path"):
            catalog.read_resource(skills[0]["id"], "../outside.md")
        with self.assertRaisesRegex(ValueError, "invalid_skill_resource_path"):
            catalog.read_resource(skills[0]["id"], ".hidden")
        outside_file = self.root / "outside.md"
        outside_file.write_text("Do not expose this file.", encoding="utf-8")
        symlink = skill_file.parent / "outside-link.md"
        try:
            symlink.symlink_to(outside_file)
        except OSError:
            pass  # Windows hosts without symlink privileges still exercise traversal checks above.
        else:
            self.assertNotIn("outside-link.md", catalog.list_resources(skills[0]["id"]))
            with self.assertRaisesRegex(ValueError, "skill_resource_outside_skill_directory"):
                catalog.read_resource(skills[0]["id"], "outside-link.md")

    def test_native_skill_loader_receives_only_canonical_skill_names(self) -> None:
        skill_root = self.repository / ".agents" / "skills"
        for directory, name in (
            ("review", "review"),
            ("presentations", "Presentations"),
            ("release", "Release guide"),
        ):
            skill_file = skill_root / directory / "SKILL.md"
            skill_file.parent.mkdir(parents=True)
            skill_file.write_text(
                f"---\nname: {name}\ndescription: Instructions for {directory}\n---\nUse this skill.\n",
                encoding="utf-8",
            )
        home = self.root / "home"
        home.mkdir()
        with (
            patch("tribe_runtime.skills.Path.home", return_value=home),
            patch.dict(os.environ, {
                "AGENT_SKILLS_PATHS": "",
                "COPILOT_SKILLS_DIRS": "",
                "CODEX_HOME": str(home / ".codex"),
                "CLAUDE_CONFIG_DIR": str(home / ".claude"),
                "XDG_CONFIG_HOME": str(home / ".config"),
            }),
        ):
            catalog = SkillCatalog(self.repository)

        self.assertEqual(len(catalog.list()), 6)
        self.assertEqual(catalog.native_skill_names, frozenset({
            "interactive-app-authoring", "workflow-authoring", "review", "data-visualisation",
        }))
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        capabilities = build_capabilities(workspace, catalog)
        self.assertNotIn("Skills", {type(item).__name__ for item in capabilities})
        if os.name != "posix":
            self.skipTest("Pydantic AI's native skill loader requires its POSIX workspace backend")
        selected_skill_id = next(item["id"] for item in catalog.list() if item["name"] == "review")
        capabilities = build_capabilities(workspace, catalog, selected_skill_ids=[selected_skill_id])
        native_skills = next(item for item in capabilities if type(item).__name__ == "Skills")
        self.assertEqual(native_skills.include, frozenset({"review"}))

    def test_non_posix_hosts_use_tribe_repository_and_skill_tools(self) -> None:
        with patch("tribe_runtime.harness_capabilities._supports_native_local_workspace", return_value=False):
            capabilities = build_capabilities(
                WorkspaceTools(self.store, self.mission["id"], "builder"),
                SkillCatalog(self.repository),
            )

        capability_names = {type(item).__name__ for item in capabilities}
        self.assertNotIn("LocalWorkspace", capability_names)
        self.assertNotIn("FileSystem", capability_names)
        self.assertNotIn("Shell", capability_names)
        self.assertNotIn("Skills", capability_names)
        self.assertIn("StepPersistence", capability_names)
        self.assertIn("Hooks", capability_names)

    def test_tribe_repository_tools_run_without_a_harness_workspace(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build work", "builder.md",
            tool_permissions=("read_repository_file",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        skills = SkillCatalog(self.repository)
        dependencies = AgentDependencies(self.store, self.mission["id"], definition, workspace, skills)
        agent = _build_agent(definition, "openai:test-model")

        class RepositoryReadModel(TestModel):
            def gen_tool_args(self, tool_def):
                if tool_def.name == "read_repository_file":
                    return {"path": "README.md"}
                return super().gen_tool_args(tool_def)

        platform_boundary = (
            patch("tribe_runtime.harness_capabilities._supports_native_local_workspace", return_value=False)
            if os.name == "posix" else nullcontext()
        )
        with platform_boundary:
            capabilities = build_capabilities(
                workspace, skills, tool_permissions=definition.tool_permissions,
            )
        capability_names = {type(item).__name__ for item in capabilities}
        if os.name != "posix":
            self.assertNotIn("LocalWorkspace", capability_names)
            self.assertNotIn("FileSystem", capability_names)
            self.assertNotIn("Shell", capability_names)

        async def run() -> str:
            with agent.override(model=RepositoryReadModel(
                call_tools=["read_repository_file"], custom_output_text="repository tool worked"
            )):
                result = await agent.run(
                    "Read README.md with the Tribe repository tool.", deps=dependencies,
                    capabilities=capabilities,
                    conversation_id=f"tribe:{self.mission['id']}:{definition.id}",
                )
            return result.output

        self.assertEqual(asyncio.run(run()), "repository tool worked")
        tool_event = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.tool.completed"
        )
        self.assertEqual(tool_event["payload"]["toolName"], "read_repository_file")

    def test_missing_repository_file_returns_recoverable_tool_result(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build work", "builder.md",
            tool_permissions=("read_repository_file",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        skills = SkillCatalog(self.repository)
        dependencies = AgentDependencies(self.store, self.mission["id"], definition, workspace, skills)
        agent = _build_agent(definition, "openai:test-model")

        class MissingFileModel(TestModel):
            def gen_tool_args(self, tool_def):
                if tool_def.name == "read_repository_file":
                    return {"path": "package.json"}
                return super().gen_tool_args(tool_def)

        async def run() -> str:
            with agent.override(model=MissingFileModel(
                call_tools=["read_repository_file"], custom_output_text="I will use the repository search results."
            )):
                result = await agent.run(
                    "Check whether this repository has a package manifest.", deps=dependencies,
                    conversation_id=f"tribe:{self.mission['id']}:{definition.id}",
                )
            return result.output

        self.assertEqual(asyncio.run(run()), "I will use the repository search results.")
        completed = [
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.tool.completed"
            and event["payload"].get("toolName") == "read_repository_file"
        ]
        self.assertEqual(len(completed), 1)

    def test_harness_tools_are_blocked_after_workspace_switch_mid_run(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "builder")
        capabilities = build_capabilities(workspace, SkillCatalog(self.repository))
        hooks = next(item for item in capabilities if type(item).__name__ == "Hooks")
        before_tool_execute = hooks._registry["before_tool_execute"][0].func
        isolated_root = self.root / "isolated-worktree"
        isolated_root.mkdir()
        workspace.root = isolated_root

        for tool_name in ("write_file", "read_file", "run_command"):
            with self.subTest(tool=tool_name), self.assertRaisesRegex(RuntimeError, "workspace changed"):
                asyncio.run(before_tool_execute(
                    None, call=None, tool_def=SimpleNamespace(name=tool_name), args={}
                ))

    def test_skill_catalog_supports_opencode_directory_and_flat_markdown(self) -> None:
        skill_file = self.repository / ".opencode" / "skills" / "release.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(
            "---\nname: Release workflow\ndescription: Prepare a release\n---\nCheck the version.\n",
            encoding="utf-8",
        )
        home = self.root / "home"
        home.mkdir()
        with (
            patch("tribe_runtime.skills.Path.home", return_value=home),
            patch.dict(os.environ, {"AGENT_SKILLS_PATHS": ""}),
        ):
            catalog = SkillCatalog(self.repository)
        skills = catalog.list("release")
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["source"], "Project · OpenCode")
        self.assertIn("Check the version", catalog.read(skills[0]["id"]))

    def test_skill_catalog_discovers_cross_agent_locations_and_nested_project_skills(self) -> None:
        def write_skill(path: Path, name: str) -> None:
            path.parent.mkdir(parents=True)
            description = (
                "description: >-\n  Instructions for release.\n  Use for preparing deployments."
                if name == "release" else f"description: Instructions for {name}"
            )
            path.write_text(
                f"---\nname: {name}\n{description}\n---\nUse this skill.\n",
                encoding="utf-8",
            )

        cursor_skill = self.repository / ".cursor" / "skills" / "release" / "SKILL.md"
        nested_skill = self.repository / "packages" / "api" / ".agents" / "skills" / "schema" / "SKILL.md"
        home = self.root / "home"
        copilot_skill = home / ".copilot" / "skills" / "review" / "SKILL.md"
        duplicate_user_skill = home / ".cursor" / "skills" / "release" / "SKILL.md"
        configured_root = self.root / "shared-skills"
        configured_skill = configured_root / "accessibility" / "SKILL.md"
        for path, name in (
            (cursor_skill, "release"),
            (nested_skill, "schema"),
            (copilot_skill, "review"),
            (duplicate_user_skill, "release"),
            (configured_skill, "accessibility"),
        ):
            write_skill(path, name)

        with (
            patch("tribe_runtime.skills.Path.home", return_value=home),
            patch.dict(os.environ, {
                "AGENT_SKILLS_PATHS": "",
                "COPILOT_SKILLS_DIRS": str(configured_root),
                "CODEX_HOME": str(home / ".codex"),
                "CLAUDE_CONFIG_DIR": str(home / ".claude"),
                "XDG_CONFIG_HOME": str(home / ".config"),
            }),
        ):
            catalog = SkillCatalog(self.repository)

        skills = catalog.list()
        by_name = {skill["name"]: skill for skill in skills}
        self.assertEqual(set(by_name), {
            "interactive-app-authoring", "workflow-authoring", "release", "schema", "review",
            "accessibility", "data-visualisation",
        })
        self.assertEqual(by_name["interactive-app-authoring"]["source"], "Tribe · Built-in")
        self.assertEqual(by_name["release"]["description"], "Instructions for release. Use for preparing deployments.")
        self.assertEqual(by_name["release"]["source"], "Project · Cursor")
        self.assertEqual(by_name["review"]["source"], "User · GitHub Copilot")
        self.assertIn("Project · Agent Skills · packages/api", by_name["schema"]["source"])
        self.assertIn(cursor_skill.parents[1].resolve(), catalog.native_skill_roots)
        self.assertIn(nested_skill.parents[1].resolve(), catalog.native_skill_roots)
        self.assertIn(copilot_skill.parents[1].resolve(), catalog.native_skill_roots)

    def test_skill_catalog_honours_agent_home_overrides_and_plugin_skill_roots(self) -> None:
        codex_home = self.root / "custom-codex"
        codex_skill = codex_home / "plugins" / "cache" / "marketplace" / "reviewer" / "1.0" / "skills" / "security-audit" / "SKILL.md"
        codex_skill.parent.mkdir(parents=True)
        codex_skill.write_text(
            "---\nname: Security audit\ndescription: Inspect changes\n---\nReview trust boundaries.\n",
            encoding="utf-8",
        )
        claude_home = self.root / "custom-claude"
        claude_skill = claude_home / "skills" / "release" / "SKILL.md"
        claude_skill.parent.mkdir(parents=True)
        claude_skill.write_text(
            "---\nname: Release checklist\ndescription: Check releases\n---\nVerify release notes.\n",
            encoding="utf-8",
        )
        home = self.root / "home"
        home.mkdir()
        with (
            patch("tribe_runtime.skills.Path.home", return_value=home),
            patch.dict(os.environ, {
                "AGENT_SKILLS_PATHS": "",
                "CODEX_HOME": str(codex_home),
                "CLAUDE_CONFIG_DIR": str(claude_home),
                "XDG_CONFIG_HOME": str(self.root / "xdg"),
            }),
        ):
            catalog = SkillCatalog(self.repository)

        skills = catalog.list()
        self.assertEqual({skill["name"] for skill in skills}, {
            "Security audit", "Release checklist", "interactive-app-authoring", "workflow-authoring",
            "data-visualisation",
        })
        sources = {skill["name"]: skill["source"] for skill in skills}
        self.assertEqual(sources["Security audit"], "User · Codex plugin")
        self.assertEqual(sources["Release checklist"], "User · Claude")

    def test_agent_registry_rejects_incomplete_definition(self) -> None:
        directory = self.root / "agents"
        directory.mkdir()
        (directory / "missing-role.md").write_text(
            "---\nid: analyst\nname: Analyst\n---\nReview evidence.\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(ValueError, "missing required front matter field.*role"):
            discover_agents(directory)

    def test_builtin_agent_definitions_are_valid(self) -> None:
        agents = discover_agents(ROOT / "agents")
        self.assertEqual({agent.id for agent in agents}, {"planner", "builder", "reviewer"})
        self.assertTrue(all(agent.instructions for agent in agents))
        self.assertTrue(all(agent.tool_permissions is not None for agent in agents))

    def test_agent_registry_rejects_duplicate_ids(self) -> None:
        directory = self.root / "agents"
        directory.mkdir()
        definition = "---\nid: analyst\nname: Analyst\nrole: Review\n---\nReview evidence.\n"
        (directory / "first.md").write_text(definition, encoding="utf-8")
        (directory / "second.md").write_text(definition, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate agent id 'analyst'"):
            discover_agents(directory)

    def test_repository_access_is_persisted_and_builtin_roles_are_least_privilege(self) -> None:
        builtins = {agent.id: agent for agent in discover_agents(ROOT / "agents")}
        self.assertEqual(builtins["planner"].repository_access, "read_only")
        self.assertEqual(builtins["reviewer"].repository_access, "read_only")
        self.assertEqual(builtins["builder"].repository_access, "workspace_write")

        directory = self.root / "restricted-agents"
        agent = write_agent_definition(
            directory, "auditor", "Auditor", "Review changes", "Inspect and verify only.",
            repository_access="read_only",
            tool_permissions=("read_repository_file",),
        )
        loaded = discover_agents(directory)[0]
        self.assertEqual(agent.repository_access, "read_only")
        self.assertEqual(loaded.repository_access, "read_only")
        self.assertEqual(loaded.capabilities, ("repository_read",))
        self.assertIn("repository_access: read_only", (directory / "auditor.md").read_text())
        self.assertIn('capabilities: ["repository_read"]',
                      (directory / "auditor.md").read_text())
        with self.assertRaisesRegex(ValueError, "unknown capability"):
            write_agent_definition(
                directory, "unknown_tool", "Bad role", "Test", "Invalid permissions.",
                tool_permissions=("unregistered_tool",),
            )

    def test_read_only_role_function_toolset_hides_repository_mutations(self) -> None:
        reviewer = next(agent for agent in discover_agents(ROOT / "agents") if agent.id == "reviewer")
        agent = _build_agent(reviewer, "openai:gpt-4o-mini")

        allowed = {tool.name for tool in _tools_for_agent(
            agent, "read_only", reviewer.tool_permissions,
        )}

        self.assertIn("read_repository_file", allowed)
        self.assertNotIn("run_repository_tests", allowed)
        self.assertIn("update_state", allowed)
        self.assertNotIn("complete_mission", allowed)
        self.assertNotIn("complete_discovery", allowed)
        self.assertNotIn("finalize_plan", allowed)
        self.assertNotIn("create_plan_item", allowed)
        self.assertNotIn("revise_plan_item", allowed)
        self.assertNotIn("write_repository_file", allowed)
        self.assertNotIn("delete_repository_file", allowed)
        self.assertNotIn("integrate_isolated_changes", allowed)
        self.assertNotIn("complete_discovery", {
            tool.name for tool in _tools_for_agent(
                agent, "workspace_write",
                next(item for item in discover_agents(ROOT / "agents") if item.id == "builder").tool_permissions,
            )
        })
        self.assertFalse(agent._function_toolset.tools["post_update"].defer_loading)
        self.assertFalse(agent._function_toolset.tools["read_repository_file"].defer_loading)
        self.assertFalse(agent._function_toolset.tools["search_repository"].defer_loading)
        self.assertTrue(agent._function_toolset.tools["create_plan_item"].defer_loading)
        self.assertTrue(agent._function_toolset.tools["create_plan_items"].defer_loading)
        self.assertTrue(agent._function_toolset.tools["write_repository_file"].defer_loading)

    def test_registered_artifact_and_document_tools_are_grantable_from_profiles(self) -> None:
        permissions = ("list_artifacts", "get_artifact", "create_artifact", "comment_on_artifact")
        directory = self.root / "artifact-agents"
        write_agent_definition(
            directory, "publisher", "Publisher", "Review deliverables", "Inspect mission outputs.",
            tool_permissions=permissions,
        )
        definition = discover_agents(directory)[0]
        agent = _build_agent(definition, "openai:test-model")

        available = {tool.name for tool in _tools_for_agent(
            agent, definition.repository_access, definition.tool_permissions,
        )}

        self.assertEqual(available, set(permissions))
        self.assertTrue(all(agent._function_toolset.tools[name].defer_loading for name in permissions))

    def test_agent_instructions_route_tests_through_the_restricted_test_tool(self) -> None:
        builder = next(agent for agent in discover_agents(ROOT / "agents") if agent.id == "builder")
        agent = _build_agent(builder, "openai:gpt-4o-mini")
        instructions = agent._instructions[0].instruction

        self.assertFalse(agent._function_toolset.tools["run_repository_tests"].defer_loading)
        self.assertIn("Use the granted project command capability to run appropriate checks.", instructions)
        self.assertIn("A failed command is feedback", instructions)
        self.assertIn("check the task's stated intended role", instructions)
        self.assertIn("Specialized capabilities may be deferred and discovered with load_capability", instructions)
        state_tool = agent._function_toolset.tools["update_state"]
        self.assertEqual(state_tool.function_schema.json_schema["required"], ["target", "action"])
        self.assertNotIn("complete_discovery", agent._function_toolset.tools)
        self.assertNotIn("finalize_plan", agent._function_toolset.tools)
        self.assertNotIn("record_review_checkpoint", agent._function_toolset.tools)

    def test_profile_grants_control_planning_and_review_tools_independent_of_role_id(self) -> None:
        from tribe_runtime.agents import TOOL_PERMISSION_NAMES

        planner_definition = next(item for item in discover_agents(ROOT / "agents") if item.id == "planner")
        reviewer_definition = next(item for item in discover_agents(ROOT / "agents") if item.id == "reviewer")
        planner = _build_agent(
            planner_definition,
            "openai:test-model",
        )
        reviewer = _build_agent(
            reviewer_definition,
            "openai:test-model",
        )
        planner_tools = {tool.name for tool in _tools_for_agent(
            planner, planner_definition.repository_access, planner_definition.tool_permissions,
        )}
        reviewer_tools = {tool.name for tool in _tools_for_agent(
            reviewer, reviewer_definition.repository_access, reviewer_definition.tool_permissions,
        )}

        self.assertTrue({"create_plan_item", "create_plan_items", "revise_plan_item"}.issubset(planner_tools))
        self.assertTrue({"create_plan_item", "create_plan_items", "revise_plan_item"}.isdisjoint(reviewer_tools))
        self.assertIn("update_state", planner_tools)
        self.assertIn("update_state", reviewer_tools)
        self.assertNotIn("complete_mission", reviewer_tools)
        self.assertNotIn("record_review_checkpoint", planner_tools)
        custom_definition = AgentDefinition(
            "delivery-lead", "Delivery lead", "Plan delivery", "Plan work", "delivery-lead.md",
            repository_access="read_only", tool_permissions=("finalize_plan",),
        )
        self.assertNotIn("finalize_plan", {
            tool.name for tool in _tools_for_agent(
                planner, custom_definition.repository_access,
                custom_definition.tool_permissions,
            )
        })
        custom_finisher = AgentDefinition(
            "delivery-finisher", "Delivery finisher", "Mission closure", "Close completed work",
            "delivery-finisher.md", repository_access="read_only",
            tool_permissions=("complete_mission",),
        )
        self.assertIn("update_state", {
            tool.name for tool in _tools_for_agent(
                planner, custom_finisher.repository_access, custom_finisher.tool_permissions,
            )
        })
        ungranted_definition = AgentDefinition(
            "ungranted", "Unassigned", "No access", "No tools granted", "ungranted.md",
        )
        self.assertEqual([], _tools_for_agent(
            planner, ungranted_definition.repository_access, ungranted_definition.tool_permissions,
        ))
        self.assertTrue(TOOL_PERMISSION_NAMES)
        for name in ("create_plan_item", "revise_plan_item", "update_state"):
            self.assertFalse(planner._function_toolset.tools[name].defer_loading)
        self.assertNotIn("finalize_plan", planner._function_toolset.tools)
        self.assertNotIn("complete_discovery", planner._function_toolset.tools)
        self.assertIn("update_state", reviewer._function_toolset.tools)

    def test_planner_eager_board_tool_is_in_the_model_callable_schema(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "planner", "Planner", "Planning", "Plan work", "planner.md",
            tool_permissions=("list_plan_items",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        agent = _build_agent(definition, "openai:test-model")
        model = TestModel(call_tools=["list_plan_items"], custom_output_text="Board checked.")
        capabilities = build_capabilities(
            workspace, dependencies.skills, repository_access="read_only",
            tool_permissions=definition.tool_permissions,
        )

        async def run() -> str:
            with agent.override(model=model, tools=_tools_for_agent(
                agent, definition.repository_access, definition.tool_permissions,
            )):
                result = await agent.run(
                    "Inspect the current plan board.", deps=dependencies, capabilities=capabilities,
                )
            return result.output

        self.assertEqual(asyncio.run(run()), "Board checked.")
        self.assertIn(
            "list_plan_items",
            {tool.name for tool in model.last_model_request_parameters.function_tools},
        )

    def test_finalize_plan_validation_errors_return_recovery_feedback(self) -> None:
        definition = AgentDefinition("planner", "Planner", "Planning", "Plan", "planner.md")
        tools = _build_agent(definition, "openai:test-model")._function_toolset.tools
        self.assertNotIn("finalize_plan", tools)
        self.assertIn("create_plan_item", tools)

    def test_discovery_checkpoint_rejection_returns_recoverable_tool_feedback(self) -> None:
        definition = AgentDefinition("planner", "Planner", "Planning", "Plan", "planner.md")
        tools = _build_agent(definition, "openai:test-model")._function_toolset.tools
        self.assertNotIn("complete_discovery", tools)

    def test_mark_mission_blocked_without_a_pending_request_returns_recovery_feedback(self) -> None:
        definition = AgentDefinition(
            "planner", "Planner", "Planning", "Plan", "planner.md",
            tool_permissions=("mark_mission_blocked",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        tool = _build_agent(definition, "openai:test-model")._function_toolset.tools["update_state"]

        result = tool.function(
            SimpleNamespace(deps=dependencies), "chat", "waiting", summary="Waiting for a user request",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "mission_block_requires_a_pending_user_request")
        self.assertEqual(result["action"], "continue_work_or_explain_blocker")

    def test_claim_and_complete_work_policy_denials_return_recovery_feedback(self) -> None:
        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "builder.md",
            tool_permissions=("claim_work", "complete_work"),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        tools = _build_agent(definition, "openai:test-model")._function_toolset.tools
        with patch.object(self.store, "claim_work", side_effect=ValueError("plan_checkpoint_stale")):
            claim = tools["update_state"].function(
                SimpleNamespace(deps=dependencies), "task", "claim", "task-id",
            )
        with patch.object(self.store, "complete_work", side_effect=ValueError("plan_checkpoint_stale")):
            completion = tools["update_state"].function(
                SimpleNamespace(deps=dependencies), "task", "complete", "task-id", "Done and verified",
            )

        self.assertEqual(claim, {
            "ok": False, "error": "plan_checkpoint_stale", "action": "wait_for_current_plan",
        })
        self.assertEqual(completion, {
            "ok": False, "error": "plan_checkpoint_stale", "action": "refresh_plan_and_retry",
        })

    def test_complete_work_retries_owned_claim_once_and_reports_observed_state(self) -> None:
        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "builder.md",
            tool_permissions=("complete_work",),
        )
        ready = self.store.create_work_item(self.mission["id"], "A task not yet claimed")
        claimed = self.store.create_work_item(self.mission["id"], "A task to complete")
        self.store.claim_work(self.mission["id"], definition.id, work_item_id=claimed["id"])
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition,
            WorkspaceTools(self.store, self.mission["id"], definition.id),
            SkillCatalog(self.repository),
        )
        tool = _build_agent(definition, "openai:test-model")._function_toolset.tools[
            "update_state"
        ]
        original_complete = self.store.complete_work
        complete_attempts = 0

        def transient_completion_miss(*args):
            nonlocal complete_attempts
            complete_attempts += 1
            return None if complete_attempts == 1 else original_complete(*args)

        with patch.object(
            self.store, "complete_work", side_effect=transient_completion_miss,
        ) as complete:
            result = tool.function(
                SimpleNamespace(deps=dependencies), "task", "complete", claimed["id"],
                "Implemented and verified",
            )
        self.assertEqual(result["status"], "done")
        self.assertEqual(complete.call_count, 2)

        unclaimed_result = tool.function(
            SimpleNamespace(deps=dependencies), "task", "complete", ready["id"],
            "Not actually claimed",
        )
        self.assertEqual(unclaimed_result["observedStatus"], "ready")
        self.assertIsNone(unclaimed_result["observedOwner"])

    def test_auto_chat_can_select_workflow_but_explicit_choice_cannot_be_replaced(self) -> None:
        planner = next(item for item in discover_agents(ROOT / "agents") if item.id == "planner")
        workspace = WorkspaceTools(self.store, self.mission["id"], planner.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], planner, workspace, SkillCatalog(self.repository),
        )
        tools = _build_agent(planner, "openai:test-model")._function_toolset.tools

        available = tools["list_workflows"].function(SimpleNamespace(deps=dependencies))
        self.assertIn("goal-driven-sdlc", {workflow["id"] for workflow in available})
        selected = tools["activate_workflow"].function(
            SimpleNamespace(deps=dependencies), "goal-driven-sdlc",
        )
        self.assertTrue(selected["ok"])
        self.assertEqual(self.store.mission(self.mission["id"])["recipe_id"], "goal-driven-sdlc")
        self.assertTrue(any(
            event["type"] == "mission.workflow.selected"
            for event in self.store.events_after(self.mission["id"], 0)
        ))

        explicit = self.store.create_mission(
            self.project["id"], "Explicit workflow", "Fix a defect",
            {"id": "bug-fix", "version": 1, "title": "Bug fix", "instructions": "Fix and verify."},
        )
        explicit_workspace = WorkspaceTools(self.store, explicit["id"], planner.id)
        explicit_dependencies = AgentDependencies(
            self.store, explicit["id"], planner, explicit_workspace, SkillCatalog(self.repository),
        )
        rejected = tools["activate_workflow"].function(
            SimpleNamespace(deps=explicit_dependencies), "goal-driven-sdlc",
        )
        self.assertFalse(rejected["ok"])
        self.assertEqual(self.store.mission(explicit["id"])["recipe_id"], "bug-fix")

    def test_reviewer_agent_can_record_a_checkpoint_through_its_native_tool(self) -> None:
        definition = next(item for item in discover_agents(ROOT / "agents") if item.id == "reviewer")
        tools = _build_agent(definition, "openai:test-model")._function_toolset.tools
        self.assertIn("message_agent", tools)
        self.assertNotIn("record_review_checkpoint", tools)

    def test_read_only_role_does_not_receive_harness_filesystem_or_shell(self) -> None:
        workspace = WorkspaceTools(self.store, self.mission["id"], "reviewer")
        skills = SkillCatalog(self.repository)

        read_only = build_capabilities(
            workspace, skills, repository_access="read_only",
            tool_permissions=("read_file", "write_file", "run_command"),
        )
        writer = build_capabilities(
            workspace, skills, repository_access="workspace_write",
            tool_permissions=("read_file", "write_file", "run_command"),
        )
        read_only_names = {type(capability).__name__ for capability in read_only}
        writer_names = {type(capability).__name__ for capability in writer}

        if os.name != "posix":
            self.assertTrue({"FileSystem", "Shell"}.isdisjoint(writer_names))
            self.assertTrue({"LocalWorkspace", "FileSystem", "Shell"}.isdisjoint(read_only_names))
            return

        self.assertNotIn("FileSystem", read_only_names)
        self.assertNotIn("Shell", read_only_names)
        self.assertIn("FileSystem", writer_names)
        self.assertIn("Shell", writer_names)
        capability_by_name = {type(capability).__name__: capability for capability in writer}
        self.assertFalse(capability_by_name["LocalWorkspace"].defer_loading)
        self.assertTrue(capability_by_name["FileSystem"].defer_loading)
        self.assertTrue(capability_by_name["Shell"].defer_loading)

    def test_harness_workspace_is_resolved_before_tool_search(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md")
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        agent = _build_agent(definition, "openai:test-model")

        async def run() -> None:
            await agent.run(
                "Answer directly.", deps=dependencies,
                capabilities=build_capabilities(workspace, dependencies.skills),
                model=TestModel(call_tools=[], custom_output_text="Ready."),
            )

        asyncio.run(run())

    def test_user_agent_is_saved_as_markdown_and_merged_with_builtins(self) -> None:
        directory = self.root / "user-agents"
        agent = write_agent_definition(
            directory, "security_auditor", 'Security: "Audit"', "Review security risks",
            "Inspect trust boundaries and report concrete findings.", "anthropic:claude-sonnet-4-5",
        )
        definitions = load_agent_definitions(ROOT / "agents", directory)
        self.assertEqual(agent.id, "security_auditor")
        self.assertEqual(agent.name, 'Security: "Audit"')
        self.assertIn("Inspect trust boundaries", agent.instructions)
        self.assertEqual(agent.model, "anthropic:claude-sonnet-4-5")
        self.assertIn('model: "anthropic:claude-sonnet-4-5"', (directory / f"{agent.id}.md").read_text())
        self.assertEqual({item.id for item in definitions},
                         {"planner", "builder", "reviewer", "security_auditor"})
        with self.assertRaisesRegex(ValueError, "already exists"):
            write_agent_definition(directory, agent.id, agent.name, agent.role, agent.instructions)

    def test_agent_model_override_selects_provider_and_missing_credential_isolated_per_role(self) -> None:
        self.store.set_setting("model", "openai:gpt-test")
        definitions = [
            AgentDefinition("planner", "Planner", "Plan work", "Plan.", "planner.md", "anthropic:claude-test"),
            AgentDefinition("builder", "Builder", "Build work", "Build.", "builder.md"),
        ]

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        class IdleProvider:
            async def run(self, store: MissionStore, mission_id: str, event: dict) -> str:
                return ""

        def provider_factory(definition: AgentDefinition, model: str):
            if definition.id == "planner":
                raise RuntimeError(f"No saved credentials are available for {model}")
            self.assertEqual(model, "openai:gpt-test")
            return IdleProvider()

        supervisor = EnabledSupervisor(self.store, definitions, provider_factory=provider_factory)
        try:
            supervisor.start_mission(self.mission["id"])
            self.assertEqual(supervisor.status["agentErrors"]["planner"],
                             "No saved credentials are available for anthropic:claude-test")
            events = self.store.events_after(self.mission["id"], 0)
            failed = next(item for item in events if item["type"] == "agent.provider.failed")
            started = next(item for item in events if item["type"] == "agent.runtime.started")
            self.assertEqual(failed["payload"]["agentId"], "planner")
            self.assertEqual(started["payload"]["models"], {"builder": "openai:gpt-test"})
        finally:
            supervisor.close()

    def test_agent_model_override_loads_its_provider_credential_before_agent_creation(self) -> None:
        definition = AgentDefinition("security", "Security", "Review", "Review changes.", "security.md")
        with patch("tribe_runtime.agent_runtime.get_api_key", return_value="anthropic-test-key"), \
             patch("tribe_runtime.agent_runtime._build_agent", return_value=object()) as build:
            provider = PydanticAIProvider(definition, "anthropic:claude-test")

        self.assertEqual(provider.model, "anthropic:claude-test")
        build.assert_called_once_with(definition, "anthropic:claude-test", "anthropic-test-key", "")

    def test_archiving_user_agent_keeps_markdown_out_of_active_library(self) -> None:
        directory = self.root / "user-agents"
        agent = write_agent_definition(directory, "security_auditor", "Security auditor", "Review risks", "Inspect changes.")

        archived_path = archive_agent_definition(directory, agent.id)

        self.assertTrue(archived_path.is_file())
        self.assertIn("Inspect changes", archived_path.read_text(encoding="utf-8"))
        self.assertEqual(discover_agents(directory), [])
        self.assertFalse((directory / "security_auditor.md").exists())

    def test_supervisor_unregisters_archived_role(self) -> None:
        supervisor = AgentSupervisor(self.store, [AgentDefinition("custom", "Custom", "Do work", "Instructions", "user")])

        supervisor.unregister_agent("custom")

        self.assertEqual(supervisor.definitions, [])

    def test_agent_libraries_reject_cross_source_duplicate_ids(self) -> None:
        user_directory = self.root / "user-agents"
        user_directory.mkdir()
        write_agent_definition(user_directory, "planner", "Custom planner", "Planning", "Plan tasks.")
        with self.assertRaisesRegex(ValueError, "duplicate agent id 'planner'"):
            load_agent_definitions(ROOT / "agents", user_directory)

    def test_worker_retries_and_links_its_channel_update_to_task(self) -> None:
        stop = threading.Event()

        class FlakyProvider:
            calls = 0

            async def run(self, store: MissionStore, mission_id: str, event: dict) -> AgentRunResult:
                self.calls += 1
                if self.calls == 1:
                    from pydantic_ai.exceptions import ModelServerError
                    raise ModelServerError("test-model", "temporary provider failure")
                stop.set()
                return AgentRunResult("Task update", "work-item-123")

        self.store.save_agent_offset("builder", self.mission["id"], self.store.latest_sequence(self.mission["id"]))
        self.store.append("message.created", "user", self.mission["id"], {
            "text": "Start", "recipient": "builder",
        })
        provider = FlakyProvider()
        definition = AgentDefinition("builder", "Builder", "Implement", "", "builder.md")
        AgentWorker(self.store, self.mission["id"], definition, provider, stop).run()

        updates = [event for event in self.store.events_after(self.mission["id"], 0)
                   if event["type"] == "agent.message.created"]
        self.assertEqual(provider.calls, 2)
        self.assertEqual(updates[-1]["payload"]["workItemId"], "work-item-123")

    def test_provider_prompt_contains_current_plan_and_claim(self) -> None:
        self.store.update_project_goal(self.project["id"], self.mission["id"], "Long-term project goal")
        item = self.store.create_work_item(self.mission["id"], "Implement durable jobs", "Persist and resume jobs")
        claimed = self.store.claim_work(self.mission["id"], "builder")
        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["prompt"] = json.loads(prompt)
                return type("Result", (), {"output": "no-op"})()

        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Review the plan"})
        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("builder", "Builder", "Implementation", "Build features", "builder.md"),
                "openai:test-model",
            )
            asyncio.run(provider.run(self.store, self.mission["id"], event))
        self.assertEqual(captured["prompt"]["plan"]["items"][0]["title"], item["title"])
        self.assertEqual(captured["prompt"]["agent_claimed_work_item"], claimed["id"])
        self.assertEqual(captured["prompt"]["project"]["goal"], "Long-term project goal")

    def test_deep_research_prompt_reuses_selected_team_and_workflow_context(self) -> None:
        workflow = {
            "id": "source-led-research", "title": "Source-led research", "version": 2,
            "instructions": "Compare primary sources and record uncertainty.", "stages": [],
        }
        self.store.select_mission_workflow(self.mission["id"], "user", workflow)
        team = [
            {"id": "planner", "name": "Planner", "role": "Planner", "ready": True,
             "capabilities": ["task_coordination", "web", "artifacts"], "canClaimWork": True},
            {"id": "reviewer", "name": "Reviewer", "role": "Quality", "ready": True,
             "capabilities": ["task_coordination"], "canClaimWork": True},
        ]
        trigger = self.store.append("message.created", "user", self.mission["id"], {
            "text": "Compare two approaches", "recipient": None, "researchMode": "deep_research",
        })
        planner = AgentDefinition(
            "planner", "Planner", "Planner", "Coordinate work", "planner.md",
            tool_permissions=("task_coordination", "web", "workflows"),
        )
        worker = AgentWorker(self.store, self.mission["id"], planner, object(), threading.Event(), project_team=team)
        enriched_trigger = worker._provider_event(trigger)
        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["prompt"] = json.loads(prompt)
                return type("Result", (), {"output": "Report ([Primary source](https://example.org/source))."})()

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(planner, "openai:test-model")
            response = asyncio.run(provider.run(self.store, self.mission["id"], enriched_trigger))

        prompt = captured["prompt"]
        self.assertTrue(prompt["deep_research"])
        self.assertEqual(prompt["research_protocol"]["role"], "lead")
        self.assertEqual(prompt["project_team"], team)
        self.assertEqual(prompt["workflow"], workflow)
        self.assertIn("inline Markdown links", prompt["instructions"])
        self.assertIn("refine the question map and search terms", prompt["instructions"])
        self.assertIn("dependent Planner analysis task with `Intended role: Planner`", prompt["instructions"])
        self.assertIn("it is not the final report task", prompt["instructions"])
        self.assertIn("shared Research brief", prompt["instructions"])
        self.assertIn("Intended role: <exact selected role id or name>", prompt["instructions"])
        self.assertIn("optional guidance", prompt["instructions"])
        self.assertIn("https://example.org/source", response.text)

    def test_deep_research_context_is_carried_into_durable_plan_tasks(self) -> None:
        from tribe_runtime.agent_runtime import (
            _is_research_task_detail, _research_task_detail,
        )

        ordinary_detail = (
            "Intended role: researcher\nInvestigate the pricing question and compare primary sources."
        )
        research_detail = _research_task_detail(ordinary_detail, True)
        self.assertIn("Research context: Deep Research investigation.", research_detail)
        self.assertTrue(_is_research_task_detail(research_detail))
        self.assertEqual(_research_task_detail(research_detail, True), research_detail)
        self.assertEqual(_research_task_detail(ordinary_detail, False), ordinary_detail)

        planner = AgentDefinition(
            "planner", "Planner", "Planner", "Lead research", "planner.md",
            capabilities=("planning", "task_coordination"),
        )
        dependencies = AgentDependencies(
            self.store, self.mission["id"], planner,
            WorkspaceTools(self.store, self.mission["id"], planner.id),
            SkillCatalog(self.repository), deep_research=True,
        )
        tool = _build_agent(planner, "openai:test-model")._function_toolset.tools["create_plan_items"]
        tool.function(SimpleNamespace(deps=dependencies), [{
            "key": "pricing-research", "title": "Investigate pricing", "detail": ordinary_detail,
        }])
        work_item = self.store.work_items(self.mission["id"])[0]
        self.assertTrue(_is_research_task_detail(work_item["detail"]))

        researcher = AgentDefinition(
            "researcher", "Researcher", "Research", "Investigate the assigned question", "researcher.md",
            capabilities=("conversation", "task_coordination", "artifacts", "web"),
        )
        self.store.claim_work(self.mission["id"], researcher.id, work_item_id=work_item["id"])
        created_event = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "plan.item.created" and event["payload"]["workItem"]["id"] == work_item["id"]
        )
        team = _project_team_context([planner, researcher], {planner.id, researcher.id})
        worker = AgentWorker(
            self.store, self.mission["id"], researcher, object(), threading.Event(), project_team=team,
        )
        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["prompt"] = json.loads(prompt)
                return type("Result", (), {"output": "Two primary sources support the conclusion."})()

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(researcher, "openai:test-model")
            asyncio.run(provider.run(
                self.store, self.mission["id"], worker._provider_event(created_event),
            ))
        self.assertTrue(captured["prompt"]["deep_research"])
        self.assertEqual(captured["prompt"]["research_protocol"]["role"], "team_member")
        self.assertIn("refine search terms", captured["prompt"]["instructions"].lower())

    def test_deep_research_lead_context_includes_durable_handoffs_and_document_comments(self) -> None:
        from tribe_runtime.agent_runtime import _deep_research_documents, _deep_research_handoffs

        planner = AgentDefinition(
            "planner", "Planner", "Planner", "Lead research", "planner.md",
            capabilities=("planning", "task_coordination", "artifacts"),
        )
        self.store.append("message.created", "user", self.mission["id"], {
            "text": "Compare the official guidance", "researchMode": "deep_research",
        })
        for index in range(15):
            self.store.append("agent.activity", "reviewer", self.mission["id"], {
                "status": f"Research step {index}",
            })
        handoff_text = "Verified NCSC finding and exact official source URL."
        self.store.append("agent.message.created", "reviewer", self.mission["id"], {
            "text": handoff_text, "recipient": "planner",
        })
        handoffs = _deep_research_handoffs(
            self.store, self.mission["id"], planner, self.store.latest_sequence(self.mission["id"]),
        )
        self.assertTrue(any(item["text"] == handoff_text for item in handoffs))

        document, _ = self.store.create_canvas_document(
            self.mission["id"], "Research brief", "markdown", "",
            "# Evidence ledger\\n\\nInitial notes.", "planner",
        )
        comment_text = "CISA source note: the SMB page prioritises admins and sensitive data."
        self.store.create_canvas_comment(
            self.mission["id"], document["id"], comment_text, "builder", base_revision=1,
        )
        resources = _deep_research_documents(self.store, self.mission["id"])
        brief = next(item for item in resources if item["id"] == document["id"])
        self.assertIn("Initial notes", brief["body"])
        self.assertTrue(any(comment["body"] == comment_text for comment in brief["comments"]))

    def test_deep_research_plan_reactivates_planner_after_shared_research_work(self) -> None:
        planner = AgentDefinition(
            "planner", "Planner", "Planner", "Lead the investigation", "planner.md",
            capabilities=("conversation", "planning", "task_coordination", "chat_lifecycle", "artifacts", "web"),
        )
        researcher = AgentDefinition(
            "researcher", "Researcher", "Research", "Investigate an assigned question", "researcher.md",
            capabilities=("conversation", "task_coordination", "artifacts", "web"),
        )
        reviewer = AgentDefinition(
            "evidence-checker", "Evidence checker", "Verify cited claims", "Check source support", "reviewer.md",
            capabilities=("conversation", "task_coordination", "artifacts", "web"),
        )
        team = _project_team_context(
            [planner, researcher, reviewer], {planner.id, researcher.id, reviewer.id},
        )
        planner_deps = AgentDependencies(
            self.store, self.mission["id"], planner,
            WorkspaceTools(self.store, self.mission["id"], planner.id),
            SkillCatalog(self.repository), project_team=team, deep_research=True,
        )
        planner_agent = _build_agent(planner, "openai:test-model")
        tools = planner_agent._function_toolset.tools
        brief = tools["create_artifact"].function(
            SimpleNamespace(deps=planner_deps), "document", "Research brief",
            "# Question\n\nCompare the evidence and identify unresolved questions.", "markdown",
        )
        created_items = tools["create_plan_items"].function(SimpleNamespace(deps=planner_deps), [
            {
                "key": "independent-research", "title": "Investigate the first angle",
                "detail": "Intended role: researcher\nFind primary sources and report evidence, gaps, and disagreements.",
            },
            {
                "key": "synthesis-round-one", "title": "Review findings and refine questions",
                "detail": "Intended role: Planner\nRead the research notes, identify unanswered questions, and plan focused follow-up work.",
                "depends_on": ["independent-research"],
            },
        ])
        researcher_item, synthesis_item = created_items
        self.assertIn("Research context: Deep Research investigation.", researcher_item["detail"])
        self.assertIn("Research context: Deep Research investigation.", synthesis_item["detail"])
        self.assertEqual(brief["artifactType"], "document")

        research_event = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "plan.item.created"
            and event["payload"]["workItem"]["id"] == researcher_item["id"]
        )
        researcher_worker = AgentWorker(
            self.store, self.mission["id"], researcher, object(), threading.Event(), project_team=team,
        )
        planner_worker = AgentWorker(
            self.store, self.mission["id"], planner, object(), threading.Event(), project_team=team,
        )
        self.assertTrue(researcher_worker._should_run(research_event))
        self.assertFalse(planner_worker._should_run(research_event))

        claimed = self.store.claim_work(
            self.mission["id"], researcher.id, work_item_id=researcher_item["id"],
        )
        self.assertIsNotNone(claimed)
        self.store.complete_work(researcher_item["id"], researcher.id, "Sources reviewed and gaps recorded.")
        completion_event = next(
            event for event in reversed(self.store.events_after(self.mission["id"], 0))
            if event["type"] == "plan.item.completed"
            and event["payload"]["workItem"]["id"] == researcher_item["id"]
        )
        self.assertEqual(next(
            item for item in self.store.work_items(self.mission["id"])
            if item["id"] == synthesis_item["id"]
        )["status"], "ready")
        self.assertTrue(planner_worker._should_run(completion_event))
        self.assertIsNotNone(self.store.claim_work(
            self.mission["id"], planner.id, work_item_id=synthesis_item["id"],
        ))

        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["prompt"] = json.loads(prompt)
                return type("Result", (), {"output": "The evidence leaves one follow-up question."})()

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(planner, "openai:test-model")
            asyncio.run(provider.run(
                self.store, self.mission["id"], planner_worker._provider_event(completion_event),
            ))

        prompt = captured["prompt"]
        self.assertTrue(prompt["deep_research"])
        self.assertEqual(prompt["research_protocol"]["role"], "lead")
        self.assertEqual(
            prompt["research_protocol"]["iteration"],
            "review findings, verify consequential claims, refine questions, and assign focused follow-up work",
        )
        self.assertIn("Research brief", [item["title"] for item in prompt["research_protocol"]["working_documents"]])
        self.assertIn("Sources reviewed and gaps recorded.", json.dumps(prompt))
        self.assertIn("dependent Planner analysis task", prompt["instructions"])
        self.assertIn("final-report task must depend on every research and source-audit task", prompt["instructions"])
        self.assertIn("verify its consequential claims", prompt["instructions"])
        self.assertIn("ready selected role whose profile grants task coordination, web, and artifact capabilities", prompt["instructions"])
        self.assertIn("Only write the final report artifact after the final-report task is ready", prompt["instructions"])
        self.assertIn("versioned document proposal", prompt["instructions"])
        self.assertIn("Agent activity update", prompt["instructions"])

        followup_item, followup_analysis = tools["create_plan_items"].function(
            SimpleNamespace(deps=planner_deps), [
                {
                    "key": "follow-up-research", "title": "Check the missing comparison",
                    "detail": "Intended role: researcher\nSearch for the missing primary-source comparison.",
                },
                {
                    "key": "analysis-round-two", "title": "Review the follow-up evidence",
                    "detail": "Intended role: Planner\nRead the follow-up result and decide whether source checks are needed.",
                    "depends_on": ["follow-up-research"],
                },
            ],
        )
        followup_created_event = next(
            event for event in reversed(self.store.events_after(self.mission["id"], 0))
            if event["type"] == "plan.item.created"
            and event["payload"]["workItem"]["id"] == followup_item["id"]
        )
        self.assertTrue(researcher_worker._should_run(followup_created_event))
        self.store.complete_work(
            synthesis_item["id"], planner.id, "One comparison remains open; a focused follow-up is assigned.",
        )
        self.assertIsNotNone(self.store.claim_work(
            self.mission["id"], researcher.id, work_item_id=followup_item["id"],
        ))
        researcher_deps = AgentDependencies(
            self.store, self.mission["id"], researcher,
            WorkspaceTools(self.store, self.mission["id"], researcher.id),
            SkillCatalog(self.repository), project_team=team, deep_research=True,
        )
        researcher_tools = _build_agent(researcher, "openai:test-model")._function_toolset.tools
        shared_brief = researcher_tools["get_artifact"].function(
            SimpleNamespace(deps=researcher_deps), brief["id"],
        )
        self.assertEqual(shared_brief["current"]["body"],
                         "# Question\n\nCompare the evidence and identify unresolved questions.")
        source_note = researcher_tools["create_artifact"].function(
            SimpleNamespace(deps=researcher_deps), "document", "Follow-up source note",
            "## Finding\n\nThe primary source fills the comparison gap. [Study](https://example.org/study)",
            "markdown",
        )
        self.assertEqual(source_note["artifactType"], "document")
        self.store.complete_work(
            followup_item["id"], researcher.id,
            "The primary source fills the comparison gap; source and publication date recorded.",
        )
        followup_completion = next(
            event for event in reversed(self.store.events_after(self.mission["id"], 0))
            if event["type"] == "plan.item.completed"
            and event["payload"]["workItem"]["id"] == followup_item["id"]
        )
        self.assertTrue(planner_worker._should_run(followup_completion))
        self.assertEqual(next(
            item for item in self.store.work_items(self.mission["id"])
            if item["id"] == followup_analysis["id"]
        )["status"], "ready")
        self.assertIsNotNone(self.store.claim_work(
            self.mission["id"], planner.id, work_item_id=followup_analysis["id"],
        ))

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            asyncio.run(provider.run(
                self.store, self.mission["id"], planner_worker._provider_event(followup_completion),
            ))
        followup_prompt = captured["prompt"]
        self.assertTrue(followup_prompt["deep_research"])
        self.assertIn("The primary source fills the comparison gap", json.dumps(followup_prompt))
        self.assertIn("Follow-up source note", [
            item["title"] for item in followup_prompt["research_protocol"]["working_documents"]
        ])

        proposal_body = {
            "artifact_id": brief["id"], "base_revision": 1, "title": "Research brief",
            "kind": "markdown",
            "body": "# Question\n\nCompare the evidence, including the newly found primary source.",
        }
        proposal_sequence = self.store.latest_sequence(self.mission["id"])
        tools["post_update"].function(
            SimpleNamespace(deps=planner_deps),
            f"I refined the comparison question after the follow-up source ({brief['id']}).\n"
            f"```canvas:v1\n{json.dumps(proposal_body)}\n```",
        )
        proposal_events = self.store.events_after(self.mission["id"], proposal_sequence)
        self.assertTrue(any(event["type"] == "canvas.proposal.created" for event in proposal_events))
        proposal_source_event = next(
            event for event in proposal_events if event["type"] == "agent.message.created"
        )
        self.assertEqual(
            proposal_source_event["payload"]["text"],
            "I refined the comparison question after the follow-up source.",
        )
        saved_brief = self.store.canvas_document(self.mission["id"], brief["id"])
        self.assertEqual(saved_brief["proposals"][0]["base_revision"], 1)
        self.assertIn("newly found primary source", saved_brief["proposals"][0]["body"])
        self.assertEqual(
            saved_brief["proposals"][0]["source_event_sequence"], proposal_source_event["sequence"],
        )

        audit_item, final_report_item = tools["create_plan_items"].function(
            SimpleNamespace(deps=planner_deps), [
                {
                    "key": "source-audit", "title": "Verify the cited comparison",
                    "detail": "Intended role: evidence-checker\nCheck the exact claim against https://example.org/study.",
                    "depends_on": [researcher_item["id"], followup_item["id"]],
                },
                {
                    "key": "final-report", "title": "Write the final research report",
                    "detail": "Intended role: Planner\nSynthesize verified evidence, limitations and citations.",
                    "depends_on": [researcher_item["id"], followup_item["id"], "source-audit"],
                },
            ],
        )
        self.assertEqual(next(
            item for item in self.store.work_items(self.mission["id"])
            if item["id"] == final_report_item["id"]
        )["status"], "blocked")
        self.store.complete_work(
            followup_analysis["id"], planner.id, "Research question settled; verify the cited claim before reporting.",
        )
        reviewer_worker = AgentWorker(
            self.store, self.mission["id"], reviewer, object(), threading.Event(), project_team=team,
        )
        audit_created_event = next(
            event for event in reversed(self.store.events_after(self.mission["id"], 0))
            if event["type"] == "plan.item.created"
            and event["payload"]["workItem"]["id"] == audit_item["id"]
        )
        self.assertTrue(reviewer_worker._should_run(audit_created_event))
        self.assertIsNotNone(self.store.claim_work(
            self.mission["id"], reviewer.id, work_item_id=audit_item["id"],
        ))
        reviewer_deps = AgentDependencies(
            self.store, self.mission["id"], reviewer,
            WorkspaceTools(self.store, self.mission["id"], reviewer.id),
            SkillCatalog(self.repository), project_team=team, deep_research=True,
        )
        reviewer_tools = _build_agent(reviewer, "openai:test-model")._function_toolset.tools
        reviewed_note = reviewer_tools["get_artifact"].function(
            SimpleNamespace(deps=reviewer_deps), source_note["id"],
        )
        self.assertIn("The primary source fills the comparison gap", reviewed_note["current"]["body"])
        self.store.complete_work(
            audit_item["id"], reviewer.id,
            "The linked primary source supports the comparison claim; publication date checked.",
        )
        audit_completion = next(
            event for event in reversed(self.store.events_after(self.mission["id"], 0))
            if event["type"] == "plan.item.completed"
            and event["payload"]["workItem"]["id"] == audit_item["id"]
        )
        self.assertTrue(planner_worker._should_run(audit_completion))
        self.assertEqual(next(
            item for item in self.store.work_items(self.mission["id"])
            if item["id"] == final_report_item["id"]
        )["status"], "ready")
        self.assertIsNotNone(self.store.claim_work(
            self.mission["id"], planner.id, work_item_id=final_report_item["id"],
        ))
        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            asyncio.run(provider.run(
                self.store, self.mission["id"], planner_worker._provider_event(audit_completion),
            ))
        final_prompt = captured["prompt"]
        self.assertIn("The linked primary source supports the comparison claim", json.dumps(final_prompt))
        final_report = tools["create_artifact"].function(
            SimpleNamespace(deps=planner_deps), "document", "Research report",
            "# Summary\n\nThe comparison is supported by the primary source. [Study](https://example.org/study)\n\n## Limitations\n\nOne source was available for the follow-up claim.",
            "markdown",
        )
        self.assertEqual(final_report["artifactType"], "document")
        self.store.complete_work(
            final_report_item["id"], planner.id, "The source-checked report is ready.",
        )
        stored_report = tools["get_artifact"].function(
            SimpleNamespace(deps=planner_deps), final_report["id"],
        )
        self.assertIn("[Study](https://example.org/study)", stored_report["current"]["body"])
        self.assertTrue(all(
            item["status"] == "done" for item in self.store.work_items(self.mission["id"])
        ))

    def test_provider_prompt_includes_recent_repository_test_evidence(self) -> None:
        tool_call_id = "call_harness_test_evidence"
        source_tool_event = self.store.append("agent.tool.completed", "builder", self.mission["id"], {
            "toolCallId": tool_call_id, "toolName": "run_command", "outcome": "success",
            "summary": "node --test test/habits.test.js",
            "output": "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n",
        })
        evidence_event = self.store.record_harness_node_test_result(
            self.mission["id"], "builder", source_tool_event["sequence"], tool_call_id,
            "node --test test/habits.test.js", "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n",
            None, source_tool_event_id=source_tool_event["id"],
        )
        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["prompt"] = json.loads(prompt)
                return type("Result", (), {"output": "no-op"})()

        trigger = self.store.append("message.created", "user", self.mission["id"], {
            "text": "Review the latest test run", "recipient": "reviewer",
        })
        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("reviewer", "Reviewer", "Quality", "Review evidence", "reviewer.md"),
                "openai:test-model",
            )
            asyncio.run(provider.run(self.store, self.mission["id"], trigger))

        runs = captured["prompt"]["recent_test_runs"]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["event_id"], evidence_event["id"])
        self.assertEqual(runs[0]["argv"], ["node", "--test", "test/habits.test.js"])
        self.assertEqual(runs[0]["exit_code"], 0)
        self.assertIn("# pass 1", runs[0]["stdout_tail"])

    def test_agent_verification_context_includes_exact_current_plan_criteria(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Criteria context", "Deliver a verified change",
            {"id": "goal-driven-sdlc", "version": 7, "title": "Goal-driven SDLC"},
        )
        item = self.store.create_work_item(mission["id"], "Implement change")
        self.store.complete_discovery(
            mission["id"], "planner", "Inspected project instructions and identified the change scope.", [],
        )
        criterion = "All acceptance checks are satisfied exactly as finalized."
        self.store.finalize_plan(mission["id"], "planner", [{
            "criterion": criterion, "work_item_ids": [item["id"]],
        }])

        context = self.store.agent_verification_context(mission["id"])

        self.assertEqual(context["acceptance_criteria"], [criterion])
        self.assertIsInstance(context["plan_checkpoint_sequence"], int)

    def test_invalid_plan_dependency_is_returned_to_agent_without_aborting_turn(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "planner", "Planner", "Planning", "Plan work", "planner.md",
            tool_permissions=("create_plan_item",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        agent = _build_agent(definition, "openai:test-model")

        class InvalidDependencyModel(TestModel):
            def gen_tool_args(self, tool_def):
                if tool_def.name == "create_plan_item":
                    return {
                        "title": "Review delivery", "detail": "Confirm the result",
                        "depends_on": ["not-a-task-in-this-mission"],
                    }
                return super().gen_tool_args(tool_def)

        with patch.object(
            self.store, "create_work_item",
            side_effect=ValueError("work item dependencies must belong to this mission"),
        ):
            with agent.override(model=InvalidDependencyModel(
                call_tools=["create_plan_item"],
                custom_output_text="I can correct the task dependency and continue.",
            )):
                result = asyncio.run(agent.run(
                    "Add a reviewer task depending on the QA task.", deps=dependencies,
                ))

        self.assertEqual(result.output, "I can correct the task dependency and continue.")

    def test_planner_can_create_a_dependency_ordered_batch_in_one_tool_call(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "planner", "Planner", "Planning", "Plan work", "planner.md",
            tool_permissions=("create_plan_items",),
        )
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition,
            WorkspaceTools(self.store, self.mission["id"], definition.id),
            SkillCatalog(self.repository),
        )
        agent = _build_agent(definition, "openai:test-model")

        class BatchPlanModel(TestModel):
            def gen_tool_args(self, tool_def):
                if tool_def.name == "create_plan_items":
                    return {"items": [
                        {"key": "implement", "title": "Implement feature", "detail": "Build the feature."},
                        {"key": "verify", "title": "Verify feature", "detail": "Run the checks.",
                         "depends_on": ["implement"]},
                    ]}
                return super().gen_tool_args(tool_def)

        with agent.override(model=BatchPlanModel(
            call_tools=["create_plan_items"], custom_output_text="The two tasks are on the plan.",
        )):
            result = asyncio.run(agent.run("Plan the implementation and verification.", deps=dependencies))

        items = self.store.work_items(self.mission["id"])
        self.assertEqual([item["title"] for item in items], ["Implement feature", "Verify feature"])
        self.assertEqual(items[1]["depends_on"], [items[0]["id"]])
        self.assertEqual(result.output, "The two tasks are on the plan.")

    def test_provider_continues_the_prior_persisted_agent_conversation(self) -> None:
        from pydantic_ai import Agent
        from pydantic_ai.models.test import TestModel
        from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence

        conversation_id = f"tribe:{self.mission['id']}:builder"
        step_store = SqliteStepStore(database=self.store.data_dir / "agent_steps.sqlite3")
        with patch.dict(os.environ, {"PYDANTIC_AI_NO_BANNER": "1"}):
            prior_agent = Agent("openai:test-model")

        async def seed_history() -> None:
            with prior_agent.override(model=TestModel(call_tools=[], custom_output_text="Keep this finding")):
                await prior_agent.run(
                    "Earlier investigation: the index needs a migration.",
                    capabilities=[StepPersistence(
                        store=step_store, agent_name="tribe:prior:builder", capture_frontier=True,
                    )],
                    conversation_id=conversation_id,
                )

        asyncio.run(seed_history())
        captured: dict[str, object] = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured.update(prompt=prompt, **kwargs)
                return type("Result", (), {"output": "Continuing the investigation"})()

        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Continue"})
        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("builder", "Builder", "Implementation", "Build features", "builder.md"),
                "openai:test-model",
            )
            asyncio.run(provider.run(self.store, self.mission["id"], event))

        history = captured["message_history"]
        self.assertTrue(any(
            getattr(part, "content", "") == "Earlier investigation: the index needs a migration."
            for message in history for part in message.parts
        ))

    def test_provider_resumes_saved_frontier_without_repeating_the_trigger_prompt(self) -> None:
        from pydantic_ai import Agent
        from pydantic_ai.models.test import TestModel
        from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence

        event = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Resume this request", "recipient": "builder"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        step_store = SqliteStepStore(database=self.store.data_dir / "agent_steps.sqlite3")
        conversation_id = f"tribe:{self.mission['id']}:builder"
        prior_agent = Agent("openai:test-model")

        async def save_frontier() -> None:
            with prior_agent.override(model=TestModel(call_tools=[], custom_output_text="checkpoint text")):
                await prior_agent.run(
                    "The original trigger and context.",
                    capabilities=[StepPersistence(
                        store=step_store, agent_name=conversation_id,
                        metadata={"trigger_sequence": str(event["sequence"])},
                        capture_frontier=True,
                    )],
                    conversation_id=conversation_id,
                )

        asyncio.run(save_frontier())
        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured.update(prompt=prompt, **kwargs)
                return type("Result", (), {"output": "resumed output"})()

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("builder", "Builder", "Implementation", "Build features", "builder.md"),
                "openai:test-model",
            )
            asyncio.run(provider.run(
                self.store, self.mission["id"], {**event, "resumeCheckpoint": True},
            ))

        self.assertIsNone(captured["prompt"])
        self.assertTrue(any(
            getattr(part, "content", "") == "The original trigger and context."
            for message in captured["message_history"] for part in message.parts
        ))

    def test_pydantic_ai_binds_plan_read_and_revise_tools(self) -> None:
        agent = _build_agent(
            AgentDefinition("planner", "Planner", "Planning", "Plan work", "planner.md"),
            "openai:test-model",
        )
        self.assertIn("list_plan_items", agent._function_toolset.tools)
        self.assertIn("revise_plan_item", agent._function_toolset.tools)
        self.assertIn("list_artifacts", agent._function_toolset.tools)
        self.assertIn("get_artifact", agent._function_toolset.tools)
        self.assertIn("create_artifact", agent._function_toolset.tools)
        self.assertIn("comment_on_artifact", agent._function_toolset.tools)

    def test_harness_filesystem_tool_writes_and_records_a_repository_change(self) -> None:
        if os.name != "posix":
            self.skipTest("Pydantic AI's native workspace Harness is supported on POSIX hosts only")
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build work", "builder.md",
            tool_permissions=("write_file",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        skills = SkillCatalog(self.repository)
        trigger = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Write a file"}
        )
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, skills,
            file_locks={}, pending_file_changes={},
            trigger_sequence=trigger["sequence"],
        )
        agent = _build_agent(definition, "openai:test-model")
        capabilities = build_capabilities(
            workspace, skills, tool_permissions=definition.tool_permissions,
        )
        self.reveal_deferred_test_tools(agent, capabilities)
        test_model = TestModel(call_tools=["write_file"], custom_output_text="file written")

        async def run() -> str:
            with agent.override(model=test_model):
                result = await agent.run(
                    "Create a small text file with the Harness write_file tool.",
                    deps=dependencies,
                    capabilities=capabilities,
                    conversation_id=f"tribe:{self.mission['id']}:{definition.id}",
                )
            return result.output

        try:
            self.assertEqual(asyncio.run(run()), "file written")
        finally:
            if dependencies.file_locks is not None:
                for lock in dependencies.file_locks.values():
                    lock.close()
                dependencies.file_locks.clear()
        changed = [event for event in self.store.events_after(self.mission["id"], 0)
                   if event["type"] == "repo.file.changed"
                   and event["payload"].get("source") == "pydantic_ai_harness"]
        self.assertEqual(len(changed), 1)
        self.assertTrue((self.repository / changed[0]["payload"]["path"]).is_file())
        tool_events = [
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] in {"agent.tool.started", "agent.tool.completed"}
            and event["payload"].get("toolName") == "write_file"
        ]
        self.assertEqual({event["type"] for event in tool_events}, {
            "agent.tool.started", "agent.tool.completed",
        })
        self.assertTrue(all(
            event["payload"].get("triggerSequence") == trigger["sequence"]
            for event in tool_events
        ))
        self.assertFalse(any(event["type"] == "artifact.created"
                             for event in self.store.events_after(self.mission["id"], 0)))
        changed_call_id = changed[0]["payload"]["toolCallId"]
        self.assertTrue(changed_call_id)
        self.assertEqual(next(
            event["payload"]["toolCallId"] for event in tool_events
            if event["type"] == "agent.tool.started"
        ), changed_call_id)
        from pydantic_ai_harness.step_persistence import SqliteStepStore

        step_store = SqliteStepStore(database=self.store.data_dir / "agent_steps.sqlite3")
        runs = asyncio.run(step_store.list_runs(
            conversation_id=f"tribe:{self.mission['id']}:{definition.id}"
        ))
        self.assertEqual(len(runs), 1)
        snapshot = asyncio.run(step_store.latest_snapshot(run_id=runs[0].run_id))
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot.state, "complete")

    def test_harness_releases_path_lock_after_each_completed_write(self) -> None:
        if os.name != "posix":
            self.skipTest("Pydantic AI's native workspace Harness is supported on POSIX hosts only")
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build work", "builder.md",
            tool_permissions=("write_file",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        skills = SkillCatalog(self.repository)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, skills,
            file_locks={}, pending_file_changes={},
        )
        agent = _build_agent(definition, "openai:test-model")
        acquired: list[bool] = []

        @agent.tool
        async def verify_lock_released(ctx: RunContext[AgentDependencies]) -> str:
            deadline = time.monotonic() + 3
            change = None
            while time.monotonic() < deadline and change is None:
                change = next((
                    event for event in reversed(self.store.events_after(self.mission["id"], 0))
                    if event["type"] == "repo.file.changed"
                    and event["payload"].get("source") == "pydantic_ai_harness"
                ), None)
                if change is None:
                    await asyncio.sleep(0.02)
            if change is None:
                acquired.append(False)
                return "File write has not finished"
            path = workspace.resolve(change["payload"]["path"])

            def try_acquire() -> bool:
                try:
                    with workspace._path_lock(path, timeout=0.5):
                        return True
                except TimeoutError:
                    return False

            available = await asyncio.to_thread(try_acquire)
            acquired.append(available)
            return "Lock released" if available else "Lock is still held"

        test_model = TestModel(
            call_tools=["write_file", "verify_lock_released"],
            custom_output_text="write lock verified",
        )
        capabilities = build_capabilities(
            workspace, skills, tool_permissions=definition.tool_permissions,
        )
        self.reveal_deferred_test_tools(agent, capabilities)

        async def run() -> str:
            with agent.override(model=test_model):
                result = await agent.run(
                    "Write a small text file, then verify its path is available to another agent.",
                    deps=dependencies,
                    capabilities=capabilities,
                    conversation_id=f"tribe:{self.mission['id']}:{definition.id}:lock-test",
                )
            return result.output

        try:
            self.assertEqual(asyncio.run(run()), "write lock verified")
            self.assertEqual(acquired, [True])
        finally:
            if dependencies.file_locks is not None:
                for lock in dependencies.file_locks.values():
                    lock.close()
                dependencies.file_locks.clear()

    def test_harness_directory_creation_records_change_and_releases_path_lock(self) -> None:
        if os.name != "posix":
            self.skipTest("Pydantic AI's native workspace Harness is supported on POSIX hosts only")
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build work", "builder.md",
            tool_permissions=("create_directory",),
        )
        workspace = WorkspaceTools(self.store, self.mission["id"], definition.id)
        skills = SkillCatalog(self.repository)
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition, workspace, skills,
            file_locks={}, pending_file_changes={},
        )
        agent = _build_agent(definition, "openai:test-model")
        capabilities = build_capabilities(
            workspace, skills, tool_permissions=definition.tool_permissions,
        )
        self.reveal_deferred_test_tools(agent, capabilities)
        test_model = TestModel(call_tools=["create_directory"], custom_output_text="directory created")

        async def run() -> str:
            with agent.override(model=test_model):
                result = await agent.run(
                    "Create a new generated directory.",
                    deps=dependencies,
                    capabilities=capabilities,
                    conversation_id=f"tribe:{self.mission['id']}:{definition.id}:directory-lock-test",
                )
            return result.output

        try:
            self.assertEqual(asyncio.run(run()), "directory created")
            self.assertEqual(dependencies.file_locks, {})
            created = next(
                event for event in reversed(self.store.events_after(self.mission["id"], 0))
                if event["type"] == "repo.file.changed"
                and event["payload"].get("kind") == "directory"
            )
            self.assertTrue((self.repository / created["payload"]["path"]).is_dir())
        finally:
            if dependencies.file_locks is not None:
                for lock in dependencies.file_locks.values():
                    lock.close()
                dependencies.file_locks.clear()

    def test_agent_broadcast_does_not_wake_peers_but_direct_message_does(self) -> None:
        worker = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("builder", "Builder", "Implementation", "", ""),
            None, threading.Event(),
        )
        base = {"actorId": "reviewer", "type": "agent.message.created", "payload": {}}
        self.assertFalse(worker._should_run(base))
        self.assertTrue(worker._should_run({**base, "payload": {"recipient": "builder"}}))
        self.assertTrue(worker._should_run({**base, "payload": {"recipient": "builder", "replyDepth": 3}}))
        self.assertFalse(worker._should_run({**base, "payload": {"recipient": "builder", "replyDepth": 4}}))
        user_message = {"actorId": "user", "type": "message.created", "payload": {}}
        self.assertFalse(worker._should_run(user_message))
        self.assertTrue(worker._should_run({**user_message, "payload": {"recipient": "builder"}}))
        self.assertFalse(worker._should_run({**user_message, "payload": {"recipient": "reviewer"}}))
        self.assertFalse(worker._should_run({"actorId": "runtime", "type": "agent.runtime.started", "payload": {}}))
        targeted_start = {"actorId": "runtime", "type": "agent.runtime.started",
                          "payload": {"roles": ["planner"]}}
        self.assertFalse(worker._should_run(targeted_start))
        self.assertTrue(worker._should_run({**targeted_start, "payload": {"roles": ["builder"]}}))
        self.assertFalse(worker._should_run({**targeted_start, "payload": {"wakeRoles": []}}))
        self.assertFalse(worker._should_run({"actorId": "runtime", "type": "repo.test_run.completed", "payload": {}}))
        reviewer = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("reviewer", "Reviewer", "Quality", "", ""),
            None, threading.Event(),
        )
        self.assertFalse(reviewer._should_run({
            "actorId": "runtime", "type": "repo.test_run.completed", "payload": {},
        }))

    def test_direct_messages_are_visible_only_to_sender_and_recipient_agent_context(self) -> None:
        builder = AgentDefinition("builder", "Builder", "Implementation", "", "")
        reviewer = AgentDefinition("reviewer", "Reviewer", "Quality", "", "")
        message = {
            "type": "agent.message.created", "actorId": "builder",
            "payload": {"recipient": "reviewer", "text": "Please review the change."},
        }

        self.assertTrue(_agent_can_read_context_event(message, builder))
        self.assertTrue(_agent_can_read_context_event(message, reviewer))
        self.assertFalse(_agent_can_read_context_event(message, AgentDefinition(
            "planner", "Planner", "Planning", "", "",
        )))
        self.assertTrue(_agent_can_read_context_event({
            **message, "payload": {"text": "Public update."},
        }, reviewer))

    def test_worker_passes_the_selected_project_team_to_provider_context(self) -> None:
        builder = AgentDefinition("builder", "Builder", "Implementation", "", "",
                                  tool_permissions=("claim_work", "complete_work"))
        reviewer = AgentDefinition("reviewer", "Reviewer", "Quality", "", "",
                                   tool_permissions=("read_repository_file",))
        team = _project_team_context([builder, reviewer], {"builder", "reviewer"})
        worker = AgentWorker(
            self.store, self.mission["id"], builder, None, threading.Event(), project_team=team,
        )

        self.assertEqual(worker._provider_event({"type": "message.created"})["projectTeam"], team)
        self.assertTrue(team[0]["canClaimWork"])
        self.assertFalse(team[1]["canClaimWork"])
        self.assertIn("repository_read", team[1]["capabilities"])

    def test_plan_item_rejects_intended_role_outside_selected_team_with_recovery_choices(self) -> None:
        planner = next(item for item in discover_agents(ROOT / "agents") if item.id == "planner")
        workspace = WorkspaceTools(self.store, self.mission["id"], planner.id)
        team = _project_team_context([planner], {planner.id})
        dependencies = AgentDependencies(
            self.store, self.mission["id"], planner, workspace, SkillCatalog(self.repository),
            project_team=team,
        )
        tool = _build_agent(planner, "openai:test-model")._function_toolset.tools["create_plan_item"]

        result = tool.function(SimpleNamespace(deps=dependencies),
                               "Run independent tests", "Intended role: Assistant. Run the tests.")

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "intended_role_not_ready_or_cannot_claim_work")
        self.assertIn("Planner", {item["name"] for item in result["availableRoles"]})
        self.assertFalse(self.store.work_items(self.mission["id"]))

    def test_deep_research_assignments_require_ready_roles_with_profile_grants(self) -> None:
        planner = AgentDefinition(
            "planner", "Planner", "Planning", "Lead research", "planner.md",
            capabilities=("conversation", "task_coordination", "web", "artifacts"),
        )
        limited = AgentDefinition(
            "limited", "Limited researcher", "Research", "Investigate", "limited.md",
            capabilities=("conversation", "task_coordination", "web"),
        )
        researcher = AgentDefinition(
            "researcher", "Researcher", "Research", "Investigate", "researcher.md",
            capabilities=("conversation", "task_coordination", "web", "artifacts"),
        )
        unavailable = AgentDefinition(
            "unavailable", "Unavailable researcher", "Research", "Investigate", "unavailable.md",
            capabilities=("conversation", "task_coordination", "web", "artifacts"),
        )
        team = _project_team_context(
            [planner, limited, researcher, unavailable], {planner.id, limited.id, researcher.id},
        )
        dependencies = AgentDependencies(
            self.store, self.mission["id"], planner,
            WorkspaceTools(self.store, self.mission["id"], planner.id),
            SkillCatalog(self.repository), project_team=team, deep_research=True,
        )
        tools = _build_agent(planner, "openai:test-model")._function_toolset.tools

        unassigned = tools["create_plan_items"].function(SimpleNamespace(deps=dependencies), [{
            "key": "unassigned", "title": "Investigate the market", "detail": "Compare primary sources.",
        }])
        self.assertEqual(unassigned["error"], "deep_research_task_requires_an_intended_role")
        self.assertEqual({item["name"] for item in unassigned["availableRoles"]}, {"Planner", "Researcher"})

        missing_artifact = tools["create_plan_items"].function(SimpleNamespace(deps=dependencies), [{
            "key": "limited", "title": "Investigate the market",
            "detail": "Intended role: limited\nCompare primary sources.",
        }])
        self.assertEqual(missing_artifact["error"], "intended_role_missing_research_capabilities")
        self.assertEqual(missing_artifact["missingCapabilities"], ["artifacts"])

        not_ready = tools["create_plan_item"].function(
            SimpleNamespace(deps=dependencies), "Verify the second angle",
            "Intended role: unavailable\nCheck the linked sources.",
        )
        self.assertEqual(not_ready["error"], "intended_role_not_ready_or_cannot_claim_work")
        self.assertNotIn("Unavailable researcher", {item["name"] for item in not_ready["availableRoles"]})

        created = tools["create_plan_items"].function(SimpleNamespace(deps=dependencies), [{
            "key": "research", "title": "Investigate the market",
            "detail": "Intended role: researcher\nCompare primary sources.",
        }])
        self.assertEqual(len(created), 1)
        self.assertIn("Research context: Deep Research investigation.", created[0]["detail"])

        revision_error = tools["revise_plan_item"].function(
            SimpleNamespace(deps=dependencies), created[0]["id"], "Investigate the market",
            "Intended role: limited\nCompare primary sources.",
        )
        self.assertEqual(revision_error["error"], "intended_role_missing_research_capabilities")

    def test_work_items_wake_delivery_roles_before_optional_plan_finalization(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Draft plan", "Build a small app",
            {"id": "goal-driven-sdlc", "version": 7, "title": "Goal-driven SDLC"},
        )
        builder = AgentWorker(
            self.store, mission["id"], AgentDefinition(
                "builder", "Builder", "Implementation", "", "",
                tool_permissions=("claim_work", "list_plan_items"),
            ),
            None, threading.Event(),
        )
        self.store.complete_discovery(
            mission["id"], "planner", "Inspected the repository guidance and confirmed the fixture scope.", ["README.md"],
        )
        item = self.store.create_work_item(
            mission["id"], "Implement app", "Intended role: Builder. Implement the requested change.",
            actor_id="planner",
        )
        created = next(
            event for event in reversed(self.store.events_after(mission["id"], 0))
            if event["type"] == "plan.item.created"
        )

        self.assertTrue(builder._should_run(created))
        self.assertEqual(self.store.work_items(mission["id"])[0]["id"], item["id"])

    def test_claim_and_repository_edits_do_not_require_a_finalized_workflow_plan(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Draft plan", "Build a small app",
            {"id": "goal-driven-sdlc", "version": 7, "title": "Goal-driven SDLC"},
        )
        self.store.complete_discovery(
            mission["id"], "planner", "Inspected the repository guidance and confirmed the fixture scope.", ["README.md"],
        )
        item = self.store.create_work_item(mission["id"], "Implement app", actor_id="planner")
        definition = AgentDefinition(
            "builder", "Builder", "Implementation", "Build", "builder.md",
            capabilities=("task_coordination", "repository_write"),
        )
        workspace = WorkspaceTools(self.store, mission["id"], definition.id)
        dependencies = AgentDependencies(
            self.store, mission["id"], definition, workspace, SkillCatalog(self.repository),
        )
        tool = _build_agent(definition, "openai:test-model")._function_toolset.tools["update_state"]

        result = tool.function(SimpleNamespace(deps=dependencies), "task", "claim", item["id"])

        self.assertEqual(result["id"], item["id"])

        write_tool = _build_agent(definition, "openai:test-model")._function_toolset.tools[
            "write_repository_file"
        ]
        write_result = write_tool.function(
            SimpleNamespace(deps=dependencies), "optional-plan.txt", "Plan checkpoints are optional.",
        )
        self.assertEqual(write_result["path"], "optional-plan.txt")
        self.assertTrue((self.repository / "optional-plan.txt").exists())

    def test_interactive_access_is_project_scoped_and_off_by_default(self) -> None:
        self.assertEqual(self.store.project_interactive_access(self.project["id"]), {"enabled": False})
        self.assertEqual(
            self.store.set_project_interactive_access(self.project["id"], True), {"enabled": True}
        )
        self.assertEqual(self.store.project_interactive_access(self.project["id"]), {"enabled": True})
        self.assertEqual(
            self.store.set_project_interactive_access(self.project["id"], False), {"enabled": False}
        )
        with self.assertRaisesRegex(TypeError, "enabled_must_be_boolean"):
            self.store.set_project_interactive_access(self.project["id"], 1)
        with self.assertRaisesRegex(ValueError, "project_not_found"):
            self.store.project_interactive_access("missing-project")

    def test_interactive_app_artifact_attaches_only_when_enabled_and_owned(self) -> None:
        valid, _ = self.store.add_artifact(
            self.mission["id"], "planner.html", "application/vnd.tribe.interactive+html",
            "builder", b"<!doctype html><html><body>safe</body></html>",
        )
        wrong_type, _ = self.store.add_artifact(
            self.mission["id"], "notes.html", "text/html", "builder", b"<p>not an app</p>",
        )
        wrong_author, _ = self.store.add_artifact(
            self.mission["id"], "other.html", "application/vnd.tribe.interactive+html",
            "reviewer", b"<!doctype html>",
        )
        trigger = self.store.append("message.created", "user", self.mission["id"], {"text": "Build an app"})
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"], "Created the app.", None,
            interactive_artifact_ids=(valid["id"], wrong_type["id"], wrong_author["id"]),
        )
        message = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.message.created"
            and event["payload"].get("triggerSequence") == trigger["sequence"]
        )
        self.assertEqual(message["payload"]["interactiveArtifactIds"], [])

        self.store.set_project_interactive_access(self.project["id"], True)
        trigger = self.store.append("message.created", "user", self.mission["id"], {"text": "Build another app"})
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger["sequence"], "Created the app.", None,
            interactive_artifact_ids=(valid["id"], wrong_type["id"], wrong_author["id"], valid["id"]),
        )
        message = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.message.created"
            and event["payload"].get("triggerSequence") == trigger["sequence"]
        )
        self.assertEqual(message["payload"]["interactiveArtifactIds"], [valid["id"]])

    def test_interactive_artifact_tool_creates_and_attaches_only_valid_html(self) -> None:
        definition = AgentDefinition("planner", "Planner", "Planning", "Answer the user", "planner.md")
        agent = _build_agent(definition, "openai:test-model")
        authoring_instructions = agent._instructions[0].instruction
        self.assertIn("finished, task-specific mini-product", authoring_instructions)
        self.assertIn("browser-default buttons or fields", authoring_instructions)
        self.assertIn("available desktop width", authoring_instructions)
        tool = agent._function_toolset.tools["create_artifact"]
        self.assertIn(
            "interactive_app", tool.function_schema.json_schema["properties"]["artifact_type"]["enum"],
        )
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition,
            WorkspaceTools(self.store, self.mission["id"], definition.id),
            SkillCatalog(self.repository), interactive_artifact_ids=[],
        )
        ctx = SimpleNamespace(deps=dependencies)
        html = "<!doctype html><html><head><title>Split</title><style>body{display:grid;gap:1rem}</style></head><body>Split calculator</body></html>"

        with self.assertRaisesRegex(PermissionError, "disabled for this project"):
            tool.function(ctx, "interactive_app", "Bill split", html)
        self.store.set_project_interactive_access(self.project["id"], True)
        skill = dependencies.skills.find_builtin("interactive-app-authoring")
        self.assertIsNotNone(skill)
        with self.assertRaisesRegex(PermissionError, "Load Tribe's interactive-app-authoring skill"):
            tool.function(ctx, "interactive_app", "Bill split", html)
        loaded = agent._function_toolset.tools["load_skill"].function(ctx, skill.id)
        self.assertIn("Visual standard", loaded)
        self.assertIn(skill.id, dependencies.loaded_skill_ids)
        with self.assertRaisesRegex(ValueError, "complete self-contained HTML"):
            tool.function(ctx, "interactive_app", "Bill split", "<p>fragment</p>")
        with self.assertRaisesRegex(ValueError, "smaller than 500 KB"):
            tool.function(ctx, "interactive_app", "Bill split", "<!doctype html>" + ("x" * 500_000))
        with self.assertRaisesRegex(ValueError, "non-empty self-contained style block"):
            tool.function(ctx, "interactive_app", "Bill split", "<!doctype html><html><body>unstyled</body></html>")

        created = tool.function(ctx, "interactive_app", "Bill split", html)
        self.assertEqual(created["title"], "Bill split.html")
        self.assertEqual(dependencies.interactive_artifact_ids, [created["artifactId"]])
        artifact, content = self.store.artifact_content(created["artifactId"], self.mission["id"])
        self.assertEqual(artifact["media_type"], "application/vnd.tribe.interactive+html")
        self.assertEqual(content.decode(), html)

        trigger = self.store.append("message.created", "user", self.mission["id"], {"text": "Create the app"})
        self.store.begin_agent_event("planner", self.mission["id"], trigger["sequence"])
        self.store.complete_agent_event(
            "planner", self.mission["id"], trigger["sequence"], "Here is the bill splitter.", None,
            interactive_artifact_ids=tuple(dependencies.interactive_artifact_ids),
        )
        message = next(
            event for event in self.store.events_after(self.mission["id"], 0)
            if event["type"] == "agent.message.created"
            and event["payload"].get("triggerSequence") == trigger["sequence"]
        )
        self.assertEqual(message["payload"]["interactiveArtifactIds"], [created["artifactId"]])

    def test_interactive_authoring_skill_runs_through_a_scripted_model_tool_loop(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition("planner", "Planner", "Planning", "Answer the user", "planner.md")
        skills = SkillCatalog(self.repository)
        skill = skills.find_builtin("interactive-app-authoring")
        self.assertIsNotNone(skill)
        example = skills.read_resource(skill.id, "examples/bill-splitter.html")
        self.assertIn("<style>", example)
        self.assertIn("window.tribe.postAction", example)
        self.store.set_project_interactive_access(self.project["id"], True)

        agent = _build_agent(definition, "openai:test-model")
        tool_names = ("search_available_skills", "load_skill", "create_artifact")
        for name in tool_names:
            agent._function_toolset.tools[name].defer_loading = False
        agent._function_toolset.tools["load_skill"].sequential = True
        agent._function_toolset.tools["create_artifact"].sequential = True
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition,
            WorkspaceTools(self.store, self.mission["id"], definition.id), skills,
            interactive_artifact_ids=[],
        )

        class BillSplitterModel(TestModel):
            def gen_tool_args(self, tool_def):
                if tool_def.name == "search_available_skills":
                    return {"query": "interactive-app-authoring"}
                if tool_def.name == "load_skill":
                    return {"skill_id": skill.id}
                if tool_def.name == "create_artifact":
                    return {"artifact_type": "interactive_app", "title": "The Split Check", "content": example}
                return super().gen_tool_args(tool_def)

        async def run() -> str:
            with agent.override(model=BillSplitterModel(
                call_tools=list(tool_names), custom_output_text="I created The Split Check for you.",
            )):
                result = await agent.run(
                    "Create an interactive bill splitter for four people.", deps=dependencies,
                )
            return result.output

        self.assertEqual(asyncio.run(run()), "I created The Split Check for you.")
        self.assertTrue(dependencies.loaded_skill_ids)
        self.assertEqual(len(dependencies.interactive_artifact_ids), 1)
        artifact, content = self.store.artifact_content(
            dependencies.interactive_artifact_ids[0], self.mission["id"],
        )
        self.assertEqual(artifact["name"], "The Split Check.html")
        self.assertEqual(content.decode("utf-8").rstrip(), example.rstrip())
        self.assertTrue(any(
            event["type"] == "agent.skill.loaded" and event["payload"]["skillId"] == skill.id
            for event in self.store.events_after(self.mission["id"], 0)
        ))

    def test_interactive_result_share_is_bounded_active_and_team_only(self) -> None:
        self.store.set_project_agent_ids(
            self.project["id"], ["planner", "builder"], ["planner", "builder", "reviewer"], "planner",
        )
        self.store.set_project_interactive_access(self.project["id"], True)
        artifact, _ = self.store.add_artifact(
            self.mission["id"], "calculator.html", "application/vnd.tribe.interactive+html",
            "builder", b"<!doctype html><html><body>safe</body></html>",
        )
        result = self.store.record_interactive_artifact_action(
            self.mission["id"], artifact["id"], "builder", "calculate",
            {"total": 120, "people": 4},
        )
        event = result["event"]
        self.assertEqual(event["type"], "interactive_artifact.action.created")
        self.assertEqual(event["actorId"], "user")
        self.assertEqual(event["payload"]["data"], {"total": 120, "people": 4})
        builder = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("builder", "Builder", "Implementation", "", ""),
            None, threading.Event(),
        )
        planner = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("planner", "Planner", "Planning", "", ""),
            None, threading.Event(),
        )
        self.assertTrue(builder._should_run(event))
        self.assertFalse(planner._should_run(event))
        with self.assertRaisesRegex(ValueError, "interactive_action_recipient_unavailable"):
            self.store.record_interactive_artifact_action(
                self.mission["id"], artifact["id"], "reviewer", "calculate", {},
            )
        with self.assertRaisesRegex(ValueError, "interactive_action_data_too_large"):
            self.store.record_interactive_artifact_action(
                self.mission["id"], artifact["id"], "builder", "calculate", {"value": "x" * 13_000},
            )
        self.store.pause_mission(self.mission["id"])
        with self.assertRaisesRegex(PermissionError, "chat is not active"):
            self.store.record_interactive_artifact_action(
                self.mission["id"], artifact["id"], "builder", "calculate", {},
            )

    def test_interactive_access_and_share_http_routes_enforce_project_policy(self) -> None:
        from tribe_runtime import server as runtime_server

        self.store.set_project_agent_ids(
            self.project["id"], ["planner", "builder"], ["planner", "builder", "reviewer"], "planner",
        )
        artifact, _ = self.store.add_artifact(
            self.mission["id"], "calculator.html", "application/vnd.tribe.interactive+html",
            "builder", b"<!doctype html><html><body>safe</body></html>",
        )

        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            server_thread = threading.Thread(target=http.serve_forever, daemon=True)
            server_thread.start()
            try:
                base = f"http://127.0.0.1:{http.server_port}"

                def call(path: str, method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
                    request = urllib.request.Request(
                        base + path,
                        data=json.dumps(payload).encode() if payload is not None else None,
                        headers={"Content-Type": "application/json"}, method=method,
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=3) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        try:
                            return error.code, json.loads(error.read())
                        finally:
                            error.close()

                access_path = f"/api/projects/{self.project['id']}/interactive-access"
                status, result = call(access_path)
                self.assertEqual((status, result["interactiveAccess"]), (200, {"enabled": False}))
                status, result = call(access_path, "PUT", {"enabled": True})
                self.assertEqual((status, result["interactiveAccess"]), (200, {"enabled": True}))
                action_path = f"/api/missions/{self.mission['id']}/interactive-artifacts/{artifact['id']}/actions"
                status, result = call(action_path, "POST", {
                    "recipient": "builder", "action": "calculate", "data": {"people": 4},
                })
                self.assertEqual(status, 201)
                self.assertEqual(result["event"]["payload"]["data"], {"people": 4})
                status, result = call(action_path, "POST", {
                    "recipient": "reviewer", "action": "calculate", "data": {},
                })
                self.assertEqual((status, result["error"]), (422, "interactive_action_recipient_unavailable"))
                call(access_path, "PUT", {"enabled": False})
                status, result = call(action_path, "POST", {
                    "recipient": "builder", "action": "calculate", "data": {},
                })
                self.assertEqual((status, result["error"]), (403, "Interactive apps are disabled for this project."))
            finally:
                http.shutdown()
                http.server_close()
                server_thread.join(timeout=2)

    def test_planner_is_intake_for_unaddressed_user_messages_and_initial_question_skips_duplicate(self) -> None:
        planner = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("planner", "Planner", "Planning", "", ""),
            None, threading.Event(),
        )
        message = {"actorId": "user", "type": "message.created", "payload": {}}
        self.assertTrue(planner._should_run(message))
        self.assertFalse(planner._should_run({
            "actorId": "user", "type": "mission.created",
            "payload": {"hasInitialMessage": True},
        }))

    def test_plan_events_only_wake_profiles_with_plan_or_work_capabilities(self) -> None:
        events = [
            {"actorId": "builder", "type": "plan.item.created", "payload": {"workItem": {}}},
            {"actorId": "reviewer", "type": "plan.finalized", "payload": {}},
            {"actorId": "builder", "type": "plan.item.completed", "payload": {"workItem": {}}},
        ]
        messaging_only = AgentWorker(
            self.store, self.mission["id"], AgentDefinition(
                "assistant", "Assistant", "Assistant", "", "",
                tool_permissions=("post_update", "message_agent", "reply_to_agent"),
            ), None, threading.Event(),
        )
        planner = AgentWorker(
            self.store, self.mission["id"], AgentDefinition(
                "planner", "Planner", "Planning", "", "",
                tool_permissions=("list_plan_items", "claim_work", "finalize_plan"),
            ), None, threading.Event(),
        )

        self.assertEqual([messaging_only._should_run(event) for event in events], [False, False, False])
        self.assertEqual([planner._should_run(event) for event in events], [True, False, False])

    def test_planned_work_wakes_only_the_intended_role(self) -> None:
        builder = AgentWorker(
            self.store, self.mission["id"], AgentDefinition(
                "builder", "Builder", "Implementation", "", "",
                tool_permissions=("claim_work", "list_plan_items"),
            ), None, threading.Event(),
        )
        reviewer = AgentWorker(
            self.store, self.mission["id"], AgentDefinition(
                "reviewer", "Reviewer", "Quality", "", "",
                tool_permissions=("claim_work", "list_plan_items"),
            ), None, threading.Event(),
        )
        event = {
            "actorId": "planner", "type": "plan.item.created",
            "payload": {"workItem": {"status": "ready", "owner": None,
                "detail": "Intended role: Builder. Implement the requested change."}},
        }

        self.assertTrue(builder._should_run(event))
        self.assertFalse(reviewer._should_run(event))

        self.store.create_work_item(
            self.mission["id"], "Add the tracker tests", "Intended role: Builder. Add tests.",
            actor_id="planner",
        )
        completed_by_builder = {
            "actorId": "builder", "type": "plan.item.completed", "payload": {},
        }
        self.assertTrue(builder._should_run(completed_by_builder))
        self.assertFalse(reviewer._should_run(completed_by_builder))

    def test_completion_capable_role_wakes_after_last_work_item_finishes(self) -> None:
        builder = AgentDefinition("builder", "Builder", "Implementation", "", "",
                                  tool_permissions=("claim_work", "complete_work"))
        planner = AgentDefinition("planner", "Planner", "Planning", "", "",
                                  tool_permissions=("claim_work", "complete_work", "complete_mission"))
        planner_worker = AgentWorker(
            self.store, self.mission["id"], planner, None, threading.Event(),
        )
        item = self.store.create_work_item(
            self.mission["id"], "Implement export", "Intended role: Builder.", actor_id="planner",
        )
        claimed = self.store.claim_work(self.mission["id"], builder.id, work_item_id=item["id"])
        self.assertIsNotNone(claimed)
        self.store.complete_work(item["id"], builder.id, "Export implemented and verified")
        completed_event = {"actorId": builder.id, "type": "plan.item.completed", "payload": {}}

        self.assertFalse(planner_worker._has_ready_work())
        self.assertTrue(planner_worker._all_work_items_complete())
        self.assertTrue(planner_worker._should_run(completed_event))

        self_actor_event = {"actorId": planner.id, "type": "plan.item.completed", "payload": {}}
        self.assertTrue(planner_worker._should_run(self_actor_event))

    def test_initial_question_runs_planner_once_and_does_not_wake_every_role(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Explain this project", "Explain this project",
            initial_message="Explain this project",
        )
        planner_called = threading.Event()
        calls: list[tuple[str, str]] = []

        class Provider:
            def __init__(self, agent_id: str):
                self.agent_id = agent_id

            async def run(self, store, mission_id, event):
                calls.append((self.agent_id, event["type"]))
                if self.agent_id == "planner":
                    planner_called.set()
                    return "This repository contains the project implementation."
                return "unexpected role wake"

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        supervisor = EnabledSupervisor(
            self.store,
            [
                AgentDefinition("planner", "Planner", "Intake", "", "planner.md"),
                AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            ],
            provider_factory=lambda definition, model: Provider(definition.id),
        )
        try:
            supervisor.start_mission(mission["id"], initial_launch=True)
            self.assertTrue(planner_called.wait(3), "planner did not receive the initial prompt")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if any(event["type"] == "agent.message.created"
                       for event in self.store.events_after(mission["id"], 0)):
                    break
                time.sleep(0.02)
            self.assertIn(("planner", "message.created"), calls)
            self.assertNotIn(("planner", "mission.created"), calls)
            self.assertNotIn(("builder", "message.created"), calls)
            self.assertTrue(any(event["type"] == "agent.message.created"
                                and event["actorId"] == "planner"
                                for event in self.store.events_after(mission["id"], 0)))
        finally:
            supervisor.close()

    def test_resuming_unplanned_auto_chat_wakes_only_the_planner(self) -> None:
        mission = self.store.create_mission(
            self.project["id"], "Explain this project", "Explain this project",
            initial_message="Explain this project",
        )
        calls: list[str] = []

        class Provider:
            def __init__(self, agent_id: str):
                self.agent_id = agent_id

            async def run(self, store, mission_id, event):
                calls.append(self.agent_id)
                return "Project explanation."

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        supervisor = EnabledSupervisor(
            self.store,
            [
                AgentDefinition("planner", "Planner", "Intake", "", "planner.md"),
                AgentDefinition("builder", "Builder", "Implementation", "", "builder.md"),
            ],
            provider_factory=lambda definition, model: Provider(definition.id),
        )
        try:
            supervisor.start_mission(mission["id"])
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and "planner" not in calls:
                time.sleep(0.02)
            self.assertEqual(calls, ["planner"])
            started = next(
                item for item in self.store.events_after(mission["id"], 0)
                if item["type"] == "agent.runtime.started"
            )
            self.assertEqual(started["payload"]["wakeRoles"], [])
        finally:
            supervisor.close()

    def test_artifact_review_wakes_only_the_independent_reviewer(self) -> None:
        builder = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("builder", "Builder", "Implementation", "", ""),
            None, threading.Event(),
        )
        reviewer = AgentWorker(
            self.store, self.mission["id"], AgentDefinition(
                "reviewer", "Reviewer", "Review", "", "",
                tool_permissions=("claim_work", "list_plan_items"),
            ),
            None, threading.Event(),
        )
        comment_event = {"actorId": "user", "type": "artifact.review.comment.created", "payload": {}}
        self.assertFalse(builder._should_run(comment_event))
        self.assertTrue(reviewer._should_run(comment_event))
        self.assertFalse(reviewer._should_run({**comment_event, "actorId": "reviewer"}))
        reopened_event = {
            "actorId": "user", "type": "artifact.review.thread.reopened", "payload": {},
        }
        self.assertFalse(builder._should_run(reopened_event))
        self.assertTrue(reviewer._should_run(reopened_event))

    def test_reviewer_wakes_on_work_milestones_not_each_repository_event(self) -> None:
        reviewer = AgentWorker(
            self.store, self.mission["id"], AgentDefinition(
                "reviewer", "Reviewer", "Review", "", "",
                tool_permissions=("claim_work", "list_plan_items"),
            ),
            None, threading.Event(),
        )
        for kind, payload in (
            ("repo.file.changed", {"path": "src/a.py"}),
            ("artifact.created", {"artifact": {"name": "a.diff"}}),
        ):
            with self.subTest(kind=kind):
                self.assertFalse(reviewer._should_run({
                    "actorId": "builder", "type": kind, "payload": payload,
                }))
        test_event = {
            "actorId": "builder", "type": "repo.test_run.completed", "payload": {"exitCode": 0},
        }
        self.assertFalse(reviewer._should_run(test_event))
        self.store.create_work_item(
            self.mission["id"], "Review implementation", "Intended role: Reviewer. Review the requested change.",
            actor_id="planner",
        )
        self.assertTrue(reviewer._should_run(test_event))
        self.assertTrue(reviewer._should_run({
            "actorId": "builder", "type": "plan.item.completed", "payload": {
                "workItem": {"id": "work-1"},
            },
        }))

    def test_canvas_changes_wake_reviewer_and_assigned_agent_only(self) -> None:
        builder = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("builder", "Builder", "Implementation", "", ""),
            None, threading.Event(),
        )
        reviewer = AgentWorker(
            self.store, self.mission["id"], AgentDefinition("reviewer", "Reviewer", "Review", "", ""),
            None, threading.Event(),
        )
        proposal_event = {"actorId": "builder", "type": "canvas.proposal.created", "payload": {}}
        self.assertFalse(builder._should_run(proposal_event))
        self.assertTrue(reviewer._should_run(proposal_event))
        reviewer_comment = {
            "actorId": "user", "type": "canvas.comment.created", "payload": {"assignee": "reviewer"},
        }
        builder_comment = {
            "actorId": "user", "type": "canvas.comment.created", "payload": {"assignee": "builder"},
        }
        self.assertFalse(builder._should_run(reviewer_comment))
        self.assertTrue(reviewer._should_run(reviewer_comment))
        self.assertTrue(builder._should_run(builder_comment))
        self.assertFalse(reviewer._should_run(builder_comment))

    def test_direct_agent_reply_chains_allow_multiple_messages_and_stop_after_three_hops(self) -> None:
        first = _next_agent_reply_metadata(None, 0)
        self.assertEqual(first["replyDepth"], 1)
        self.assertTrue(first["replyChainId"])

        second = _next_agent_reply_metadata(first["replyChainId"], first["replyDepth"])
        third = _next_agent_reply_metadata(second["replyChainId"], second["replyDepth"])
        self.assertEqual(third, {"replyChainId": first["replyChainId"], "replyDepth": 3})
        with self.assertRaisesRegex(ValueError, "three-hop limit"):
            _next_agent_reply_metadata(third["replyChainId"], third["replyDepth"])

    def test_registering_user_role_starts_its_active_mission_worker(self) -> None:
        invoked = threading.Event()

        class Provider:
            async def run(self, store: MissionStore, mission_id: str, event: dict) -> str:
                invoked.set()
                return "no-op"

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        supervisor = EnabledSupervisor(self.store, [], provider_factory=lambda definition, model: Provider())
        definition = AgentDefinition(
            "security_auditor", "Security auditor", "Review security", "Inspect trust boundaries.", "user"
        )
        trigger = self.store.append("message.created", "user", self.mission["id"], {
            "text": "Review the repository security", "recipient": definition.id,
        })
        self.store.save_agent_offset(definition.id, self.mission["id"], trigger["sequence"] - 1)
        try:
            supervisor.register_agent(definition)
            self.assertTrue(invoked.wait(3))
            self.assertIn((self.mission["id"], definition.id), supervisor._workers)
        finally:
            supervisor.close()

    def test_project_artifact_search_pages_across_missions(self) -> None:
        other_mission = self.store.create_mission(self.project["id"], "Release review", "Review release evidence")
        self.store.add_artifact(self.mission["id"], "overview.md", "text/markdown", "planner", b"plan")
        self.store.add_artifact(other_mission["id"], "review.json", "application/json", "reviewer", b"review")
        self.store.add_artifact(other_mission["id"], "notes.txt", "text/plain", "user", b"notes")
        self.store.add_artifact(other_mission["id"], "test-results-abc.txt", "text/plain", "builder", b"output")
        self.store.add_artifact(other_mission["id"], "notes.txt.diff", "text/x-diff", "builder", b"diff")

        first = self.store.project_artifacts(self.project["id"], limit=1)
        self.assertEqual(first["total"], 3)
        self.assertTrue(first["hasMore"])
        second = self.store.project_artifacts(
            self.project["id"], before=first["nextCursor"]["createdAt"],
            before_id=first["nextCursor"]["id"], limit=1,
        )
        self.assertNotEqual(first["artifacts"][0]["id"], second["artifacts"][0]["id"])
        third = self.store.project_artifacts(
            self.project["id"], before=second["nextCursor"]["createdAt"],
            before_id=second["nextCursor"]["id"], limit=1,
        )
        self.assertFalse(third["hasMore"])
        self.assertEqual(
            len({first["artifacts"][0]["id"], second["artifacts"][0]["id"], third["artifacts"][0]["id"]}),
            3,
        )
        self.assertEqual(self.store.project_artifacts(self.project["id"], query="reviewer")["total"], 1)

        from tribe_runtime import server as runtime_server

        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                params = urlencode({"q": "reviewer", "limit": "1"})
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/artifacts?{params}",
                    timeout=3,
                ) as response:
                    page = json.loads(response.read())
                self.assertEqual(page["total"], 1)
                self.assertEqual(page["artifacts"][0]["mission_title"], "Release review")
                self.assertEqual(page["artifacts"][0]["created_by"], "reviewer")
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=2)

    def test_event_stream_resumes_after_last_event_id(self) -> None:
        first = self.store.append("message.created", "user", self.mission["id"], {"text": "Earlier"})
        second = self.store.append("message.created", "user", self.mission["id"], {"text": "Resume here"})
        third = self.store.append("message.created", "user", self.mission["id"], {"text": "Catch up too"})
        from tribe_runtime import server as runtime_server

        with patch.object(runtime_server, "STORE", self.store), patch.object(runtime_server, "SUPERVISOR") as supervisor:
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            http.daemon_threads = False
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/stream?mission={self.mission['id']}&after=0",
                    headers={"Last-Event-ID": str(first["sequence"])},
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    frame_id = response.readline().decode("utf-8").strip()
                    data_line = response.readline().decode("utf-8").strip()
                self.assertEqual(frame_id, f"id: {second['sequence']}")
                self.assertTrue(data_line.startswith("data: "))
                event = json.loads(data_line.removeprefix("data: "))
                self.assertEqual(event["payload"]["text"], "Resume here")
                supervisor.check_connection.return_value = {
                    "ok": True, "model": "openai:test-model", "latencyMs": 42,
                }
                provider_check_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/settings/check",
                    data=b"{}",
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(provider_check_request, timeout=3) as response:
                    provider_check = json.loads(response.read())
                self.assertTrue(provider_check["check"]["ok"])
                self.assertEqual(provider_check["check"]["model"], "openai:test-model")
                supervisor.check_connection.assert_called_once_with()
                class ToolRegistry:
                    def __init__(self, store):
                        self.store = store

                    async def discover_tools(self, project_id, server_name):
                        return [{"name": "search", "description": "", "readOnly": True, "enabled": True}]

                with patch.object(runtime_server, "MCPRegistry", ToolRegistry):
                    mcp_check_request = urllib.request.Request(
                        f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/mcp/check",
                        data=json.dumps({"serverName": "docs"}).encode(),
                        headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                        method="POST",
                    )
                    with urllib.request.urlopen(mcp_check_request, timeout=3) as response:
                        mcp_check = json.loads(response.read())
                self.assertEqual(mcp_check["serverName"], "docs")
                self.assertEqual(mcp_check["tools"][0]["name"], "search")
                page_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/events?mission={self.mission['id']}&before={second['sequence']}&limit=10"
                )
                with urllib.request.urlopen(page_request, timeout=3) as response:
                    page = json.loads(response.read())
                expected = [item["sequence"] for item in self.store.events_after(self.mission["id"], 0)
                            if item["sequence"] < second["sequence"]]
                self.assertEqual([item["sequence"] for item in page["events"]], expected)
                self.assertFalse(page["hasMore"])

                catchup_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/events?mission={self.mission['id']}"
                    f"&after={first['sequence']}&limit=1"
                )
                with urllib.request.urlopen(catchup_request, timeout=3) as response:
                    catchup_page = json.loads(response.read())
                self.assertEqual([item["sequence"] for item in catchup_page["events"]], [second["sequence"]])
                self.assertTrue(catchup_page["hasMore"])
                next_page_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/events?mission={self.mission['id']}"
                    f"&after={second['sequence']}&limit=1"
                )
                with urllib.request.urlopen(next_page_request, timeout=3) as response:
                    next_page = json.loads(response.read())
                self.assertEqual([item["sequence"] for item in next_page["events"]], [third["sequence"]])
                self.assertFalse(next_page["hasMore"])

                backlog = [
                    self.store.append("message.created", "user", self.mission["id"], {"text": f"Backlog {index}"})
                    for index in range(201)
                ]
                default_page_request = (
                    f"http://127.0.0.1:{http.server_port}/api/events?mission={self.mission['id']}"
                    f"&after={third['sequence']}"
                )
                with urllib.request.urlopen(default_page_request, timeout=3) as response:
                    default_page = json.loads(response.read())
                self.assertEqual(len(default_page["events"]), 200)
                self.assertTrue(default_page["hasMore"])

                stream_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/stream?mission={self.mission['id']}"
                    f"&after={third['sequence']}"
                )
                with (
                    patch.object(self.store, "events_after", side_effect=AssertionError("unbounded read")),
                    urllib.request.urlopen(stream_request, timeout=3) as response,
                ):
                    streamed_sequences = []
                    for _ in backlog:
                        frame_id = response.readline().decode("utf-8").strip()
                        response.readline()  # data frame
                        response.readline()  # frame separator
                        streamed_sequences.append(int(frame_id.removeprefix("id: ")))
                self.assertEqual(streamed_sequences, [event["sequence"] for event in backlog])

                delete_preflight = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/agents/security_auditor",
                    headers={
                        "Origin": "tauri://localhost",
                        "Access-Control-Request-Method": "DELETE",
                        "Access-Control-Request-Headers": "content-type",
                    },
                    method="OPTIONS",
                )
                with urllib.request.urlopen(delete_preflight, timeout=3) as response:
                    self.assertEqual(response.status, 204)
                    self.assertIn("DELETE", response.headers["Access-Control-Allow-Methods"])

                pause_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/missions/{self.mission['id']}/pause",
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(pause_request, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(result["mission"]["status"], "paused")
                supervisor.pause_mission.assert_called_once_with(self.mission["id"])

                goal_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/goal",
                    data=json.dumps({
                        "missionId": self.mission["id"],
                        "goal": "Keep the objective owned by the user",
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="PUT",
                )
                with urllib.request.urlopen(goal_request, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(result["project"]["goal"], "Keep the objective owned by the user")

                web_policy_url = f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/web-access"
                with urllib.request.urlopen(web_policy_url, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["webAccess"], {"enabled": False, "allowedDomains": []})
                web_policy_request = urllib.request.Request(
                    web_policy_url,
                    data=json.dumps({"enabled": True, "allowedDomains": ["docs.python.org"]}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with urllib.request.urlopen(web_policy_request, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["webAccess"], {
                    "enabled": True, "allowedDomains": ["docs.python.org"],
                })
                command_tools_url = f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/command-tools"
                with urllib.request.urlopen(command_tools_url, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["executables"], [])
                command_tools_request = urllib.request.Request(
                    command_tools_url,
                    data=json.dumps({"executables": ["terraform", "gh"]}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with urllib.request.urlopen(command_tools_request, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(result["executables"], ["gh", "terraform"])
                invalid_command_tools = urllib.request.Request(
                    command_tools_url,
                    data=json.dumps({"executables": ["../terraform"]}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with self.assertRaises(urllib.error.HTTPError) as invalid_tools_error:
                    urllib.request.urlopen(invalid_command_tools, timeout=3)
                self.assertEqual(invalid_tools_error.exception.code, 422)
                invalid_tools_error.exception.close()
                invalid_web_policy = urllib.request.Request(
                    web_policy_url,
                    data=json.dumps({"enabled": True, "allowedDomains": ["https://docs.python.org"]}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(invalid_web_policy, timeout=3)
                self.assertEqual(error.exception.code, 422)
                error.exception.close()

                proposal = self.store.propose_knowledge(
                    self.project["id"], self.mission["id"], "builder", "Reviewed memory", "Keep migrations additive."
                )
                review_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/knowledge/{proposal['id']}/review",
                    data=json.dumps({"decision": "accept"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(review_request, timeout=3) as response:
                    reviewed = json.loads(response.read())
                self.assertEqual(reviewed["proposal"]["status"], "accepted")
                self.assertEqual(reviewed["entry"]["source_mission_id"], self.mission["id"])
                archive_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/knowledge/{reviewed['entry']['id']}/archive",
                    data=json.dumps({"missionId": self.mission["id"]}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(archive_request, timeout=3) as response:
                    archived = json.loads(response.read())
                self.assertEqual(archived["entry"]["status"], "archived")

                second_repository = self.root / "second-repository"
                second_repository.mkdir()
                subprocess.run(["git", "init", "-q", str(second_repository)], check=True)
                create_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/projects",
                    data=json.dumps({
                        "repository": str(second_repository),
                        "name": "Second project",
                        "projectGoal": "Own a repository-wide outcome",
                        "missionTitle": "First session",
                        "goal": "Deliver a bounded implementation",
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(create_request, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(response.status, 201)
                self.assertEqual(result["project"]["goal"], "Own a repository-wide outcome")
                self.assertEqual(result["mission"]["goal"], "Deliver a bounded implementation")
                supervisor.start_mission.assert_called_with(result["mission"]["id"], initial_launch=True)
            finally:
                # Wake any disconnected SSE handlers so server_close can join them
                # before the temporary database directory is removed.
                self.store.append("message.created", "user", self.mission["id"], {"text": "End stream test"})
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

    def test_project_audit_export_endpoint_downloads_json(self) -> None:
        from tribe_runtime import server as runtime_server

        self.store.append("message.created", "user", self.mission["id"], {"text": "Export this"})
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/projects/{self.project['id']}/audit-export",
                    headers={"Origin": "http://localhost:5173"},
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    exported = json.loads(response.read())
                    self.assertIn("attachment; filename=\"tribe-Test-project-activity-", response.headers["Content-Disposition"])
                    self.assertIn("application/json", response.headers["Content-Type"])
                self.assertEqual(exported["format"], "tribe.project-audit")
                self.assertEqual(exported["missions"][0]["events"][-1]["payload"]["text"], "Export this")
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

    def test_agent_api_persists_and_registers_user_role(self) -> None:
        from tribe_runtime import server as runtime_server

        user_directory = self.root / "user-agents"
        definitions = discover_agents(ROOT / "agents")

        class SupervisorStub:
            registered = None
            updated = None
            unregistered = None

            def register_agent(self, definition) -> None:
                if any(agent.id == definition.id for agent in runtime_server.AGENT_DEFINITIONS):
                    raise ValueError("agent was added to the shared registry before registration")
                self.registered = definition

            def update_agent(self, definition) -> None:
                self.updated = definition

            def unregister_agent(self, agent_id) -> None:
                self.unregistered = agent_id

        supervisor = SupervisorStub()
        with (
            patch.object(runtime_server, "STORE", self.store),
            patch.object(runtime_server, "USER_AGENT_DIRECTORY", user_directory),
            patch.object(runtime_server, "AGENT_DEFINITIONS", definitions),
            patch.object(runtime_server, "SUPERVISOR", supervisor),
        ):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps({
                    "id": "security_auditor",
                    "name": "Security auditor",
                    "role": "Review security risks",
                    "instructions": "Inspect trust boundaries and report concrete findings.",
                }).encode("utf-8")
                request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/agents",
                    data=body,
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=3) as response:
                    result = json.loads(response.read())
                self.assertEqual(response.status, 201)
                self.assertEqual(result["agent"]["id"], "security_auditor")
                self.assertTrue((user_directory / "security_auditor.md").is_file())
                self.assertEqual(supervisor.registered.id, "security_auditor")

                updated_body = json.dumps({
                    "name": "Security and privacy auditor",
                    "role": "Review security and privacy risks",
                    "instructions": "Inspect trust boundaries, data handling and report concrete findings.",
                }).encode("utf-8")
                update_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/agents/security_auditor",
                    data=updated_body,
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="PUT",
                )
                with urllib.request.urlopen(update_request, timeout=3) as response:
                    updated = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(updated["agent"]["name"], "Security and privacy auditor")
                self.assertIn("data handling", (user_directory / "security_auditor.md").read_text())
                self.assertEqual(supervisor.updated.id, "security_auditor")

                message_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/messages",
                    data=json.dumps({
                        "missionId": self.mission["id"],
                        "text": "Check this boundary",
                        "recipient": "security_auditor",
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(message_request, timeout=3) as response:
                    message = json.loads(response.read())["event"]
                self.assertEqual(message["payload"]["recipient"], "security_auditor")

                research_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/messages",
                    data=json.dumps({
                        "missionId": self.mission["id"], "text": "Compare these options",
                        "recipient": "security_auditor", "deepResearch": True,
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(research_request, timeout=3) as response:
                    research_message = json.loads(response.read())["event"]
                self.assertEqual(research_message["payload"]["researchMode"], "deep_research")
                self.assertIsNone(research_message["payload"]["recipient"])

                document, _ = self.store.create_canvas_document(
                    self.mission["id"], "Architecture notes", "markdown", "user", "# Current design",
                )
                context_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/messages",
                    data=json.dumps({
                        "missionId": self.mission["id"],
                        "text": "Review this section",
                        "canvasDocument": {
                            "artifactId": document["id"], "revision": 1,
                            "selectedText": "Current design",
                        },
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(context_request, timeout=3) as response:
                    contextual_message = json.loads(response.read())["event"]
                self.assertEqual(contextual_message["payload"]["canvasDocument"], {
                    "artifactId": document["id"], "revision": 1,
                    "title": "Architecture notes", "selectedText": "Current design",
                })

                target_mission = self.store.create_mission(
                    self.project["id"], "Follow-up mission", "Reuse the architecture notes",
                )
                link_url = f"http://127.0.0.1:{http.server_port}/api/missions/{target_mission['id']}/canvas/{document['id']}/link"
                link_request = urllib.request.Request(
                    link_url, data=b"{}",
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(link_request, timeout=3) as response:
                    link_result = json.loads(response.read())
                self.assertEqual(response.status, 201)
                self.assertEqual(link_result["event"]["type"], "canvas.document.linked")
                linked_document_url = f"http://127.0.0.1:{http.server_port}/api/missions/{target_mission['id']}/canvas/{document['id']}"
                with urllib.request.urlopen(linked_document_url, timeout=3) as response:
                    self.assertEqual(json.loads(response.read())["document"]["current"]["body"], "# Current design")
                linked_context_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/messages",
                    data=json.dumps({
                        "missionId": target_mission["id"], "text": "Review the linked plan",
                        "canvasDocument": {
                            "artifactId": document["id"], "revision": 1,
                            "selectedText": "Current design",
                        },
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with urllib.request.urlopen(linked_context_request, timeout=3) as response:
                    linked_message = json.loads(response.read())["event"]
                self.assertEqual(linked_message["payload"]["canvasDocument"]["artifactId"], document["id"])
                unlink_request = urllib.request.Request(
                    link_url, headers={"Origin": "http://localhost:5173"}, method="DELETE",
                )
                with urllib.request.urlopen(unlink_request, timeout=3) as response:
                    self.assertEqual(json.loads(response.read())["event"]["type"], "canvas.document.unlinked")
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(linked_document_url, timeout=3)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()

                invalid_recipient = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/messages",
                    data=json.dumps({
                        "missionId": self.mission["id"], "text": "Unknown agent", "recipient": "missing",
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Origin": "http://localhost:5173"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(invalid_recipient, timeout=3)
                self.assertEqual(error.exception.code, 422)
                error.exception.close()

                archive_request = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/agents/security_auditor",
                    headers={"Origin": "http://localhost:5173"},
                    method="DELETE",
                )
                with urllib.request.urlopen(archive_request, timeout=3) as response:
                    archived = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(archived["archived"], "security_auditor")
                self.assertTrue(Path(archived["archivePath"]).is_file())
                self.assertEqual(supervisor.unregistered, "security_auditor")
                self.assertFalse(any(agent.id == "security_auditor" for agent in definitions))
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)


class ScheduleCase(RuntimeCase):
    def test_failed_test_event_creates_one_project_scoped_schedule_run(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Investigate failures", "Find the cause and suggest a fix", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=self.mission["id"],
        )
        self.store.append("repo.test_run.completed", "builder", self.mission["id"], {
            "testCount": 4, "passed": 3, "failed": 1, "exitCode": 1,
        })
        event = self.store.append("repo.test_run.completed", "builder", self.mission["id"], {
            "testCount": 5, "passed": 3, "failed": 2, "exitCode": 1,
        })

        claimed = self.store.claim_event_schedules()
        run = self.store.schedules(self.project["id"])[0]["runs"][0]
        events = self.store.events_after(claimed[0]["missionId"], 0)

        self.assertEqual(len(claimed), 1)
        self.assertEqual(run["source_event_sequence"], event["sequence"])
        self.assertEqual(events[-1]["actorId"], "scheduler")
        self.assertIn("2 of 5 tests failed", events[-1]["payload"]["goal"] if events[-1]["type"] == "mission.created" else events[-1]["payload"]["text"])
        self.assertEqual(self.store.claim_event_schedules(), [])

        self.store.finish_scheduled_run(claimed[0]["missionId"])
        next_event = self.store.append("repo.test_run.completed", "builder", self.mission["id"], {
            "testCount": 2, "passed": 1, "failed": 1, "exitCode": 1,
        })
        self.assertEqual(self.store.claim_event_schedules(), [])
        with self.store._connect() as db:
            db.execute(
                "UPDATE schedules SET last_event_triggered_at='2020-01-01T00:00:00+00:00' WHERE id=?",
                (schedule["id"],),
            )
        next_claim = self.store.claim_event_schedules()
        self.assertEqual(len(next_claim), 1)
        self.assertEqual(
            self.store.schedules(self.project["id"])[0]["runs"][0]["source_event_sequence"],
            next_event["sequence"],
        )

    def test_event_trigger_dispatches_background_run_to_selected_agent(self) -> None:
        self.store.set_project_agent_ids(self.project["id"], ["planner"], ["planner"], "planner")
        schedule = self.store.create_schedule(
            self.project["id"], "Investigate failures", "Find the cause", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=self.mission["id"],
        )
        source_event = self.store.append("repo.test_run.completed", "builder", self.mission["id"], {
            "testCount": 5, "passed": 3, "failed": 2, "exitCode": 1,
        })
        claimed = self.store.claim_event_schedules()
        self.assertEqual(len(claimed), 1)
        run = claimed[0]
        received_events: list[dict] = []
        dispatched = threading.Event()

        class Provider:
            async def run(self, store: MissionStore, mission_id: str, event: dict) -> str:
                received_events.append(event)
                dispatched.set()
                return "The synthetic failure was received and is ready for investigation."

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        supervisor = EnabledSupervisor(
            self.store,
            [AgentDefinition("planner", "Planner", "Investigate events", "Review the event context.", "planner.md")],
            provider_factory=lambda _definition, _model: Provider(),
        )
        try:
            supervisor.start_mission(run["missionId"])
            self.assertTrue(dispatched.wait(3), "the event-triggered mission was not dispatched")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if any(event["type"] == "agent.message.created"
                       for event in self.store.events_after(run["missionId"], 0)):
                    break
                time.sleep(0.02)

            background = self.store.mission(run["missionId"])
            self.assertTrue(background["background"])
            self.assertEqual(received_events[0]["type"], "mission.created")
            self.assertEqual(received_events[0]["payload"]["sourceEventSequence"], source_event["sequence"])
            self.assertTrue(any(
                event["type"] == "agent.message.created"
                and event["actorId"] == "planner"
                and "synthetic failure" in event["payload"].get("text", "")
                for event in self.store.events_after(run["missionId"], 0)
            ), "the selected agent's reply was not persisted in the triggered run")
            history = self.store.schedule_runs(schedule["id"])
            self.assertEqual(history["runs"][0]["source_event_sequence"], source_event["sequence"])
        finally:
            supervisor.close()

    def test_failed_event_run_can_be_retried_once_with_original_context(self) -> None:
        source_chat = self.store.create_mission(
            self.project["id"], "Test run", "Run the project tests",
        )
        schedule = self.store.create_schedule(
            self.project["id"], "Investigate failures", "Find the cause and suggest a fix", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=source_chat["id"],
        )
        source_event = self.store.append("repo.test_run.completed", "builder", source_chat["id"], {
            "testCount": 3, "passed": 1, "failed": 2, "exitCode": 1,
        })
        claimed = self.store.claim_event_schedules()
        self.assertEqual(len(claimed), 1)
        with self.store._connect() as db:
            db.execute(
                "UPDATE scheduled_runs SET status='failed',finished_at=?,error=? WHERE id=?",
                (datetime.now(UTC).isoformat(), "Agent run failed", claimed[0]["runId"]),
            )

        retry = self.store.retry_event_schedule_run(
            self.project["id"], schedule["id"], claimed[0]["runId"],
        )
        self.assertEqual(retry["status"], "queued")
        self.assertEqual(retry["mission_id"], claimed[0]["missionId"])
        self.assertEqual(retry["source_event_sequence"], source_event["sequence"])
        self.assertEqual(retry["retry_of_run_id"], claimed[0]["runId"])
        self.assertIn(retry["mission_id"], self.store.queued_scheduled_missions())
        self.assertEqual(self.store.schedules(self.project["id"])[0]["status"], "active")
        history = self.store.schedule_runs(schedule["id"])
        parent = next(run for run in history["runs"] if run["id"] == claimed[0]["runId"])
        attempt = next(run for run in history["runs"] if run["id"] == retry["id"])
        self.assertTrue(parent["has_retry"])
        self.assertEqual(attempt["retry_of_run_id"], parent["id"])
        retry_message = self.store.events_after(retry["mission_id"], attempt["trigger_sequence"] - 1)[0]
        self.assertEqual(retry_message["payload"]["sourceEventSequence"], source_event["sequence"])
        self.assertIn("2 of 3 tests failed", retry_message["payload"]["text"])
        self.assertIn("Review the earlier chat activity", retry_message["payload"]["text"])
        with self.assertRaisesRegex(ValueError, "already_been_retried"):
            self.store.retry_event_schedule_run(
                self.project["id"], schedule["id"], claimed[0]["runId"],
            )

    def test_automatic_event_retries_are_bounded_and_stop_after_any_tool_starts(self) -> None:
        source_chat = self.store.create_mission(
            self.project["id"], "Test run", "Run the project tests",
        )
        schedule = self.store.create_schedule(
            self.project["id"], "Investigate failures", "Find the cause", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=source_chat["id"], event_auto_retry_limit=2,
        )
        self.store.append("repo.test_run.completed", "builder", source_chat["id"], {
            "testCount": 3, "passed": 1, "failed": 2, "exitCode": 1,
        })
        claimed = self.store.claim_event_schedules()[0]
        with self.store._connect() as db:
            db.execute(
                "UPDATE scheduled_runs SET status='failed',invocation_started_at=?,finished_at=? WHERE id=?",
                (datetime.now(UTC).isoformat(), datetime.now(UTC).isoformat(), claimed["runId"]),
            )

        self.assertEqual(self.store.claim_automatic_event_retries(), 1)
        retry = next(
            run for run in self.store.schedule_runs(schedule["id"])["runs"]
            if run["retry_kind"] == "automatic"
        )
        self.assertEqual(retry["retry_kind"], "automatic")
        self.assertGreater(datetime.fromisoformat(retry["scheduled_for"]), datetime.now(UTC))
        self.assertEqual(self.store.queued_scheduled_missions(), [])
        self.assertEqual(self.store.claim_automatic_event_retries(), 0)

        with self.store._connect() as db:
            db.execute("UPDATE scheduled_runs SET scheduled_for=? WHERE id=?",
                       ("2020-01-01T00:00:00+00:00", retry["id"]))
            db.execute("UPDATE scheduled_runs SET status='failed',finished_at=? WHERE id=?",
                       (datetime.now(UTC).isoformat(), retry["id"]))
        self.assertEqual(self.store.claim_automatic_event_retries(), 1)
        second_retry = next(
            run for run in self.store.schedule_runs(schedule["id"])["runs"]
            if run["retry_kind"] == "automatic" and run["id"] != retry["id"]
        )
        self.assertEqual(second_retry["retry_kind"], "automatic")
        with self.store._connect() as db:
            db.execute("UPDATE scheduled_runs SET status='failed',finished_at=? WHERE id=?",
                       (datetime.now(UTC).isoformat(), second_retry["id"]))
        self.assertEqual(self.store.claim_automatic_event_retries(), 0)

        side_effect_schedule = self.store.create_schedule(
            self.project["id"], "Review again", "Inspect the failure", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=source_chat["id"], event_auto_retry_limit=1,
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE schedules SET last_event_triggered_at='2020-01-01T00:00:00+00:00' WHERE id=?",
                (side_effect_schedule["id"],),
            )
        self.store.append("repo.test_run.completed", "builder", source_chat["id"], {
            "testCount": 1, "passed": 0, "failed": 1, "exitCode": 1,
        })
        side_effect_run = next(
            item for item in self.store.claim_event_schedules()
            if item["scheduleId"] == side_effect_schedule["id"]
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE scheduled_runs SET status='failed',invocation_started_at=?,finished_at=? WHERE id=?",
                (datetime.now(UTC).isoformat(), datetime.now(UTC).isoformat(), side_effect_run["runId"]),
            )
        self.store.append("agent.tool.started", "builder", side_effect_run["missionId"], {
            "toolName": "write_file", "toolCallId": "call-side-effect",
            "triggerSequence": side_effect_run["event"]["sequence"],
        })
        self.assertEqual(self.store.claim_automatic_event_retries(), 0)
        failures = self.store.event_trigger_failures(self.project["id"])
        self.assertIn(side_effect_run["runId"], {item["id"] for item in failures["failures"]})

        replied_schedule = self.store.create_schedule(
            self.project["id"], "Avoid duplicate replies", "Summarise the failure", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=source_chat["id"], event_auto_retry_limit=1,
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE schedules SET last_event_triggered_at='2020-01-01T00:00:00+00:00' WHERE id=?",
                (replied_schedule["id"],),
            )
        self.store.append("repo.test_run.completed", "builder", source_chat["id"], {
            "testCount": 1, "passed": 0, "failed": 1, "exitCode": 1,
        })
        replied_run = next(
            item for item in self.store.claim_event_schedules()
            if item["scheduleId"] == replied_schedule["id"]
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE scheduled_runs SET status='failed',invocation_started_at=?,finished_at=? WHERE id=?",
                (datetime.now(UTC).isoformat(), datetime.now(UTC).isoformat(), replied_run["runId"]),
            )
        self.store.append("agent.message.created", "builder", replied_run["missionId"], {
            "text": "I found the cause.", "recipient": None, "channelAudience": "conversation",
            "triggerSequence": replied_run["event"]["sequence"],
        })
        self.assertEqual(self.store.claim_automatic_event_retries(), 0)
        failures = self.store.event_trigger_failures(self.project["id"])
        self.assertIn(replied_run["runId"], {item["id"] for item in failures["failures"]})

    def test_event_auto_retry_limit_rejects_unsupported_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "event_auto_retry_limit"):
            self.store.create_schedule(
                self.project["id"], "Invalid retry policy", "Investigate", "event", "UTC",
                trigger_event_type="repo.test_run.completed",
                event_source_mission_id=self.mission["id"], event_auto_retry_limit=3,
            )

    def test_event_failures_are_paginated_and_can_be_dismissed_durably(self) -> None:
        source_chat = self.store.create_mission(
            self.project["id"], "Test run", "Run the project tests",
        )
        schedules = [self.store.create_schedule(
            self.project["id"], f"Investigate failures {index}", "Find the cause", "event", "UTC",
            trigger_event_type="repo.test_run.completed",
            event_source_mission_id=source_chat["id"],
        ) for index in range(2)]
        self.store.append("repo.test_run.completed", "builder", source_chat["id"], {
            "testCount": 3, "passed": 1, "failed": 2, "exitCode": 1,
        })
        claimed = self.store.claim_event_schedules()
        self.assertEqual(len(claimed), 2)
        with self.store._connect() as db:
            for item in claimed:
                db.execute(
                    "UPDATE scheduled_runs SET status='failed',finished_at=?,error='Agent run failed' WHERE id=?",
                    (datetime.now(UTC).isoformat(), item["runId"]),
                )

        first_page = self.store.event_trigger_failures(self.project["id"], limit=1)
        self.assertEqual(first_page["total"], 2)
        self.assertTrue(first_page["has_more"])
        self.assertEqual(len(first_page["failures"]), 1)
        first = first_page["failures"][0]
        second_page = self.store.event_trigger_failures(
            self.project["id"], limit=1,
            before_started_at=first["started_at"], before_id=first["id"],
        )
        self.assertEqual(len(second_page["failures"]), 1)
        self.assertFalse(second_page["has_more"])

        dismissed = self.store.dismiss_event_trigger_failure(
            self.project["id"], first["schedule_id"], first["id"],
        )
        self.assertEqual(dismissed["scheduled_run_id"], first["id"])
        self.assertEqual(self.store.event_trigger_failures(self.project["id"])["total"], 1)
        history = self.store.schedule_runs(first["schedule_id"])
        self.assertTrue(next(run for run in history["runs"] if run["id"] == first["id"])["failure_reviewed"])
        with self.assertRaisesRegex(ValueError, "already_dismissed"):
            self.store.retry_event_schedule_run(self.project["id"], first["schedule_id"], first["id"])
        self.assertEqual(
            self.store.dismiss_event_trigger_failure(self.project["id"], first["schedule_id"], first["id"]),
            dismissed,
        )

    def test_event_schedule_cannot_watch_another_project_or_run_back_into_source_chat(self) -> None:
        (self.root / "other-event-project").mkdir()
        other_project, other_chat = self.store.create_project(
            str(self.root / "other-event-project"), "Other event project", "Other chat", "Other goal",
        )
        with self.assertRaisesRegex(ValueError, "event_source_chat_must_belong_to_project"):
            self.store.create_schedule(
                self.project["id"], "Invalid source", "Investigate", "event", "UTC",
                trigger_event_type="repo.test_run.completed",
                event_source_mission_id=other_chat["id"],
            )
        with self.assertRaisesRegex(ValueError, "event_source_and_target_chats_must_be_different"):
            self.store.create_schedule(
                self.project["id"], "Looping source", "Investigate", "event", "UTC",
                target_mission_id=self.mission["id"],
                trigger_event_type="repo.test_run.completed",
                event_source_mission_id=self.mission["id"],
            )

    def test_local_event_schedules_support_file_chat_and_artifact_events(self) -> None:
        watched = [
            ("repo.file.changed", {"path": "src/app.py", "change": "updated"}, "A repository file changed"),
            ("mission.completed", {"title": "Finished"}, "A chat completed"),
            ("artifact.created", {"title": "Research brief"}, "An artifact was created"),
        ]
        schedules = [self.store.create_schedule(
            self.project["id"], event_type, "Handle this project change", "event", "UTC",
            trigger_event_type=event_type,
            event_source_mission_id=self.mission["id"],
        ) for event_type, _payload, _summary in watched]
        source_events = [self.store.append(
            event_type, "builder", self.mission["id"], payload,
        ) for event_type, payload, _summary in watched]

        claimed = self.store.claim_event_schedules()

        self.assertEqual(len(claimed), len(watched))
        for schedule, source_event, (_event_type, _payload, summary) in zip(schedules, source_events, watched):
            run = next(item for item in self.store.schedules(self.project["id"])
                       if item["id"] == schedule["id"])["runs"][0]
            self.assertEqual(run["source_event_sequence"], source_event["sequence"])
            mission_id = next(item["missionId"] for item in claimed if item["scheduleId"] == schedule["id"])
            context = self.store.mission(mission_id)["goal"]
            self.assertIn(summary, context)

    def test_file_event_schedule_filters_paths_and_restarts_cursor_when_filter_changes(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Python file review", "Review changed Python files", "event", "UTC",
            trigger_event_type="repo.file.changed",
            event_source_mission_id=self.mission["id"],
            event_path_pattern="src/*.py",
        )
        self.assertEqual(schedule["event_path_pattern"], "src/*.py")
        ignored = self.store.append("repo.file.changed", "builder", self.mission["id"], {
            "path": "docs/readme.md", "change": "updated",
        })
        self.assertEqual(self.store.claim_event_schedules(), [])
        stored = next(item for item in self.store.schedules(self.project["id"])
                      if item["id"] == schedule["id"])
        self.assertEqual(stored["event_cursor"], ignored["sequence"])

        matching = self.store.append("repo.file.changed", "builder", self.mission["id"], {
            "path": "src/main.py", "change": "updated",
        })
        claimed = self.store.claim_event_schedules()
        self.assertEqual(len(claimed), 1)
        run = next(item for item in self.store.schedules(self.project["id"])
                   if item["id"] == schedule["id"])["runs"][0]
        self.assertEqual(run["source_event_sequence"], matching["sequence"])
        self.store.finish_scheduled_run(claimed[0]["missionId"])

        with self.assertRaisesRegex(ValueError, "event_path_pattern_must_be_project_relative"):
            self.store.create_schedule(
                self.project["id"], "Unsafe path", "Review", "event", "UTC",
                trigger_event_type="repo.file.changed",
                event_source_mission_id=self.mission["id"],
                event_path_pattern="../outside.py",
            )
        with self.assertRaisesRegex(ValueError, "event_path_pattern_requires_repository_file_trigger"):
            self.store.create_schedule(
                self.project["id"], "Wrong filter", "Review", "event", "UTC",
                trigger_event_type="artifact.created",
                event_source_mission_id=self.mission["id"],
                event_path_pattern="*.py",
            )

        prior = self.store.append("repo.file.changed", "builder", self.mission["id"], {
            "path": "docs/old.md", "change": "updated",
        })
        edited = self.store.edit_schedule(
            self.project["id"], schedule["id"], "Docs review", "Review Markdown files", "event", "UTC",
            trigger_event_type="repo.file.changed", event_source_mission_id=self.mission["id"],
            event_path_pattern="docs/*.md",
        )
        self.assertEqual(edited["event_path_pattern"], "docs/*.md")
        self.assertGreaterEqual(edited["event_cursor"], prior["sequence"])
        self.assertEqual(self.store.claim_event_schedules(), [])
        fresh = self.store.append("repo.file.changed", "builder", self.mission["id"], {
            "path": "docs/current.md", "change": "updated",
        })
        fresh_claim = self.store.claim_event_schedules()
        self.assertEqual(len(fresh_claim), 1)
        fresh_run = next(item for item in self.store.schedules(self.project["id"])
                         if item["id"] == schedule["id"])["runs"][0]
        self.assertEqual(fresh_run["source_event_sequence"], fresh["sequence"])

    def test_schedule_can_continue_existing_chat_and_marks_message_source(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Morning review", "Review recent changes", "daily", "UTC",
            target_mission_id=self.mission["id"],
        )
        with self.store._connect() as db:
            db.execute("UPDATE schedules SET next_run_at='2020-01-01T00:00:00+00:00' WHERE id=?", (schedule["id"],))

        claimed = self.store.claim_due_schedules()
        events = self.store.events_after(self.mission["id"], 0)

        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0]["missionId"], self.mission["id"])
        self.assertEqual(self.store.mission(self.mission["id"])["title"], self.mission["title"])
        self.assertEqual(events[-1]["type"], "message.created")
        self.assertEqual(events[-1]["actorId"], "scheduler")
        self.assertEqual(events[-1]["payload"]["source"], "schedule")
        self.assertEqual(events[-1]["payload"]["text"], "Review recent changes")
        run = self.store.schedules(self.project["id"])[0]["runs"][0]
        self.assertEqual(run["status"], "queued")
        self.assertEqual(run["trigger_sequence"], events[-1]["sequence"])
        self.assertEqual(self.store.queued_scheduled_missions(), [self.mission["id"]])

        self.store.begin_agent_event("planner", self.mission["id"], events[-1]["sequence"])
        started = self.store.schedules(self.project["id"])[0]["runs"][0]
        self.assertEqual(started["status"], "running")
        self.assertIsNotNone(started["invocation_started_at"])
        self.assertEqual(self.store.queued_scheduled_missions(), [])

    def test_schedule_reopens_completed_target_chat_before_delivery(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Follow-up", "Check current status", "daily", "UTC",
            target_mission_id=self.mission["id"],
        )
        with self.store._connect() as db:
            db.execute("UPDATE missions SET status='completed' WHERE id=?", (self.mission["id"],))
            db.execute("UPDATE schedules SET next_run_at='2020-01-01T00:00:00+00:00' WHERE id=?", (schedule["id"],))

        claimed = self.store.claim_due_schedules()
        events = self.store.events_after(self.mission["id"], 0)

        self.assertEqual(len(claimed), 1)
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "active")
        self.assertEqual([event["type"] for event in events[-2:]], ["mission.resumed", "message.created"])

    def test_schedule_target_must_be_unarchived_chat_in_same_project(self) -> None:
        (self.root / "other").mkdir()
        other_project, other_mission = self.store.create_project(
            str(self.root / "other"), "Other project", "Other chat", "Other goal",
        )
        with self.assertRaisesRegex(ValueError, "schedule_target_chat_must_belong_to_project"):
            self.store.create_schedule(
                self.project["id"], "Wrong project", "Run", "daily", "UTC",
                target_mission_id=other_mission["id"],
            )
        with self.store._connect() as db:
            db.execute("UPDATE missions SET archived_at='2026-01-01T00:00:00+00:00' WHERE id=?", (self.mission["id"],))
        with self.assertRaisesRegex(ValueError, "schedule_target_chat_is_archived"):
            self.store.create_schedule(
                self.project["id"], "Archived", "Run", "daily", "UTC",
                target_mission_id=self.mission["id"],
            )

    def test_paused_target_chat_holds_due_schedule(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Follow-up", "Check status", "daily", "UTC",
            target_mission_id=self.mission["id"],
        )
        with self.store._connect() as db:
            db.execute("UPDATE missions SET status='paused' WHERE id=?", (self.mission["id"],))
            db.execute("UPDATE schedules SET next_run_at='2020-01-01T00:00:00+00:00' WHERE id=?", (schedule["id"],))

        self.assertEqual(self.store.claim_due_schedules(), [])
        self.assertEqual(self.store.schedules(self.project["id"])[0]["runs_total"], 0)

    def test_dead_agent_worker_quarantines_run_without_replaying_unknown_tool_call(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Implement change"})
        work = self.store.create_work_item(self.mission["id"], "Implement safely", "Make the change")
        self.store.claim_work(self.mission["id"], "builder")
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "edit_file", "toolCallId": "call-unknown",
            "triggerSequence": event["sequence"], "summary": "src/example.py",
        })

        recovered = self.store.interrupt_dead_agent_worker("builder", self.mission["id"])
        run = self.store.agent_event_run("builder", self.mission["id"], event["sequence"])
        with self.store._connect() as db:
            released = db.execute("SELECT status,owner FROM work_items WHERE id=?", (work["id"],)).fetchone()
        events = self.store.events_after(self.mission["id"], event["sequence"])
        interrupted_calls = [item for item in events if item["type"] == "agent.tool.interrupted"]

        self.assertEqual(recovered, 1)
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), event["sequence"])
        self.assertEqual((released["status"], released["owner"]), ("ready", None))
        self.assertEqual(len(interrupted_calls), 1)
        self.assertEqual(interrupted_calls[0]["payload"]["toolCallId"], "call-unknown")
        self.assertEqual(interrupted_calls[0]["payload"]["outcome"], "unknown")
        self.assertEqual(self.store.interrupt_dead_agent_worker("builder", self.mission["id"]), 0)

    def test_startup_quarantines_interrupted_agent_run_and_releases_claim(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Implement change"})
        work = self.store.create_work_item(self.mission["id"], "Implement safely", "Make the change")
        self.store.claim_work(self.mission["id"], "builder")
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "edit_file", "toolCallId": "call-interrupted",
            "triggerSequence": event["sequence"], "summary": "src/example.py",
        })
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "run_repository_tests", "toolCallId": "call-completed",
            "triggerSequence": event["sequence"], "summary": "pytest tests",
        })
        self.store.append("agent.tool.completed", "builder", self.mission["id"], {
            "toolName": "run_repository_tests", "toolCallId": "call-completed",
            "triggerSequence": event["sequence"], "outcome": "success",
        })

        recovered = self.store.recover_interrupted_agent_runs()
        run = self.store.agent_event_run("builder", self.mission["id"], event["sequence"])
        with self.store._connect() as db:
            released = db.execute("SELECT status,owner FROM work_items WHERE id=?", (work["id"],)).fetchone()
        activity = self.store.events_after(self.mission["id"], event["sequence"])

        self.assertEqual(recovered, 1)
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), event["sequence"])
        self.assertEqual((released["status"], released["owner"]), ("ready", None))
        self.assertTrue(any(item["type"] == "agent.run.interrupted" for item in activity))
        interrupted_tool_calls = [
            item for item in activity if item["type"] == "agent.tool.interrupted"
        ]
        self.assertEqual(len(interrupted_tool_calls), 1)
        self.assertEqual(interrupted_tool_calls[0]["payload"]["toolCallId"], "call-interrupted")
        self.assertEqual(interrupted_tool_calls[0]["payload"]["outcome"], "unknown")
        run_interruption = next(item for item in activity if item["type"] == "agent.run.interrupted")
        self.assertEqual(run_interruption["payload"]["failureKind"], "unknown_side_effect")
        self.assertEqual(self.store.recover_interrupted_agent_runs(), 0)

    def test_recovery_detects_unsettled_tribe_tool_calls_for_the_trigger(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Run tool"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "write_file", "toolCallId": "write-call",
            "triggerSequence": event["sequence"],
        })

        self.assertTrue(self.store.agent_run_has_unresolved_tool_calls(
            "builder", self.mission["id"], event["sequence"],
            self.store.agent_event_run("builder", self.mission["id"], event["sequence"])["created_at"],
        ))
        self.assertTrue(self.store.agent_run_has_tool_activity(
            "builder", self.mission["id"], event["sequence"],
            self.store.agent_event_run("builder", self.mission["id"], event["sequence"])["created_at"],
        ))

        self.store.append("agent.tool.completed", "builder", self.mission["id"], {
            "toolName": "write_file", "toolCallId": "write-call",
            "triggerSequence": event["sequence"],
        })
        self.assertFalse(self.store.agent_run_has_unresolved_tool_calls(
            "builder", self.mission["id"], event["sequence"],
            self.store.agent_event_run("builder", self.mission["id"], event["sequence"])["created_at"],
        ))

    def test_recovery_reconciles_repository_writes_only_when_disk_matches_intent(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Write files"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        started_at = self.store.agent_event_run(
            "builder", self.mission["id"], event["sequence"],
        )["created_at"]
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "write_file", "toolCallId": "write-complete",
            "triggerSequence": event["sequence"], "summary": "src/done.py",
        })
        self.store.append("repo.file.write.started", "builder", self.mission["id"], {
            "toolCallId": "write-complete", "triggerSequence": event["sequence"],
            "path": "src/done.py",
        })
        self.store.append("repo.file.changed", "builder", self.mission["id"], {
            "toolCallId": "write-complete", "triggerSequence": event["sequence"],
            "path": "src/done.py", "sha256": "a" * 64,
        })
        recovered_path = self.repository / "src" / "recovered.py"
        recovered_path.parent.mkdir(parents=True, exist_ok=True)
        recovered_content = "completed before process restart\n"
        recovered_path.write_text(recovered_content, encoding="utf-8", newline="\n")
        expected_hash = hashlib.sha256(recovered_content.encode("utf-8")).hexdigest()
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "write_file", "toolCallId": "write-after-crash",
            "triggerSequence": event["sequence"], "summary": "src/recovered.py",
        })
        self.store.append("repo.file.write.started", "builder", self.mission["id"], {
            "toolCallId": "write-after-crash", "triggerSequence": event["sequence"],
            "path": "src/recovered.py", "sha256": expected_hash, "change": "created",
        })
        reconciled_count = self.store.reconcile_completed_repository_writes(
            "builder", self.mission["id"], event["sequence"], started_at,
        )
        self.assertEqual(reconciled_count, 2, msg=f"recovery events: {self.store.events_after(self.mission['id'], 0)}")
        activity = self.store.events_after(self.mission["id"], event["sequence"])
        reconciled = next(
            item for item in activity if item["type"] == "agent.tool.completed"
            and item["payload"].get("toolCallId") == "write-after-crash"
        )
        self.assertEqual(reconciled["payload"]["outcome"], "reconciled")
        recovered_change = next(
            item for item in activity if item["type"] == "repo.file.changed"
            and item["payload"].get("toolCallId") == "write-after-crash"
        )
        self.assertEqual(recovered_change["payload"]["sha256"], expected_hash)
        self.assertFalse(self.store.agent_run_has_unresolved_tool_calls(
            "builder", self.mission["id"], event["sequence"], started_at,
        ))
        self.assertFalse(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], event["sequence"], "builder",
        ))
        unknown_path = self.repository / "src" / "unknown.py"
        unknown_path.parent.mkdir(parents=True, exist_ok=True)
        unknown_path.write_text("contents changed after the agent intent\n", encoding="utf-8")
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "write_file", "toolCallId": "write-unknown",
            "triggerSequence": event["sequence"], "summary": "src/unknown.py",
        })
        self.store.append("repo.file.write.started", "builder", self.mission["id"], {
            "toolCallId": "write-unknown", "triggerSequence": event["sequence"],
            "path": "src/unknown.py", "sha256": hashlib.sha256(
                b"different intended content\n",
            ).hexdigest(),
        })
        self.assertEqual(self.store.reconcile_completed_repository_writes(
            "builder", self.mission["id"], event["sequence"], started_at,
        ), 0)
        self.assertTrue(self.store.agent_run_has_unresolved_tool_calls(
            "builder", self.mission["id"], event["sequence"], started_at,
        ))
        self.assertTrue(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], event["sequence"], "builder",
        ))

    def test_completed_read_only_mcp_call_is_retry_safe_but_write_call_is_not(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Look up a record"})
        cursor = event["sequence"]
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "docs_search", "toolCallId": "mcp-read-call",
            "triggerSequence": cursor, "mcpReadOnly": True,
        })
        self.store.append("agent.tool.completed", "builder", self.mission["id"], {
            "toolName": "docs_search", "toolCallId": "mcp-read-call",
            "triggerSequence": cursor, "mcpReadOnly": True, "outcome": "success",
        })
        self.assertFalse(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], cursor, "builder",
        ))
        self.store.append("agent.tool.started", "builder", self.mission["id"], {
            "toolName": "docs_update", "toolCallId": "mcp-write-call",
            "triggerSequence": cursor, "mcpReadOnly": False,
        })
        self.store.append("agent.tool.completed", "builder", self.mission["id"], {
            "toolName": "docs_update", "toolCallId": "mcp-write-call",
            "triggerSequence": cursor, "mcpReadOnly": False, "outcome": "success",
        })
        self.assertTrue(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], cursor, "builder",
        ))

    def test_completed_post_update_is_retry_safe_when_tool_call_is_settled(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Continue planning"})
        cursor = event["sequence"]
        call_id = "post-update-call"
        self.store.append("agent.tool.started", "planner", self.mission["id"], {
            "toolName": "post_update", "toolCallId": call_id,
            "triggerSequence": cursor,
        })
        self.store.append_agent_update(
            self.mission["id"], "planner", "Discovery is complete; I am preparing the plan.",
            metadata={"triggerSequence": cursor, "toolCallId": call_id},
        )
        self.assertTrue(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], cursor, "planner",
        ))
        self.store.append("agent.tool.completed", "planner", self.mission["id"], {
            "toolName": "post_update", "toolCallId": call_id,
            "triggerSequence": cursor, "outcome": "success",
        })
        self.assertFalse(self.store.has_unexpected_agent_effect_after(
            self.mission["id"], cursor, "planner",
        ))

    def test_agent_tool_events_persist_the_configured_read_only_mcp_classification(self) -> None:
        from pydantic_ai.models.test import TestModel

        definition = AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md")
        dependencies = AgentDependencies(
            self.store, self.mission["id"], definition,
            WorkspaceTools(self.store, self.mission["id"], definition.id),
            SkillCatalog(self.repository), trigger_sequence=self.store.latest_sequence(self.mission["id"]),
            mcp_read_only_tool_names={"docs_search"},
        )
        agent = _build_agent(definition, "openai:test-model")

        @agent.tool(name="docs_search")
        def docs_search(ctx) -> str:
            del ctx
            return "found"

        async def run() -> str:
            with agent.override(model=TestModel(call_tools=["docs_search"], custom_output_text="Done")):
                result = await agent.run(
                    "Search the documentation.", deps=dependencies,
                    conversation_id=f"tribe:{self.mission['id']}:builder:mcp-classification",
                )
            return result.output

        self.assertEqual(asyncio.run(run()), "Done")
        events = [
            item for item in self.store.events_after(self.mission["id"], 0)
            if item["type"] in {"agent.tool.started", "agent.tool.completed"}
            and item["payload"].get("toolName") == "docs_search"
        ]
        self.assertEqual(len(events), 2)
        self.assertTrue(all(item["payload"]["mcpReadOnly"] for item in events))

    def test_supervisor_recovers_abandoned_run_from_complete_harness_checkpoint(self) -> None:
        event = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Continue work after a runtime restart", "recipient": "builder"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        step_database = self.store.data_dir / "agent_steps.sqlite3"
        repository_file = self.repository / "src" / "crash-reconciled.py"
        tool_call_id = "write-before-restart"
        file_content = "durable before the completion event\n"
        source = f'''\
import asyncio
import hashlib
import os
from pathlib import Path
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence
from tribe_runtime.store import MissionStore

async def main():
    conversation_id = {f"tribe:{self.mission['id']}:builder"!r}
    step_store = SqliteStepStore(database={str(step_database)!r})
    agent = Agent("openai:test-model")
    with agent.override(model=TestModel(call_tools=[], custom_output_text="checkpoint saved")):
        await agent.run(
            "Inspect the repository before continuing.",
            capabilities=[StepPersistence(
                store=step_store, agent_name=conversation_id,
                metadata={{"trigger_sequence": {str(event["sequence"])!r}}},
                capture_frontier=True,
            )],
            conversation_id=conversation_id,
        )

asyncio.run(main())
store = MissionStore(Path({str(self.store.path)!r}))
store.append("agent.tool.started", "builder", {self.mission["id"]!r}, {{
    "toolName": "write_file", "toolCallId": {tool_call_id!r},
    "triggerSequence": {event["sequence"]}, "summary": "src/crash-reconciled.py",
}})
content = {file_content!r}
store.append("repo.file.write.started", "builder", {self.mission["id"]!r}, {{
    "toolCallId": {tool_call_id!r}, "triggerSequence": {event["sequence"]},
    "path": "src/crash-reconciled.py", "change": "created",
    "sha256": hashlib.sha256(content.encode()).hexdigest(),
}})
target = Path({str(repository_file)!r})
target.parent.mkdir(parents=True, exist_ok=True)
with target.open("w", encoding="utf-8", newline="\\n") as handle:
    handle.write(content)
    handle.flush()
    os.fsync(handle.fileno())
os._exit(23)
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 23, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        supervisor = AgentSupervisor(restarted_store, [])
        recovered = supervisor.recover_interrupted_agent_runs()
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        reclaimed = restarted_store.begin_agent_event("builder", self.mission["id"], event["sequence"])

        self.assertEqual(recovered, 1)
        self.assertEqual(
            run["status"], "retrying",
            msg=f"recovered run: {run}; events: {restarted_store.events_after(self.mission['id'], event['sequence'])}",
        )
        self.assertTrue(reclaimed["claimed"])
        self.assertTrue(reclaimed["resume_checkpoint"])
        self.assertEqual(reclaimed["attempts"], 2)
        activity = restarted_store.events_after(self.mission["id"], event["sequence"])
        recovered_tool = next(
            item for item in activity if item["type"] == "agent.tool.completed"
            and item["payload"].get("toolCallId") == tool_call_id
        )
        recovered_file = next(
            item for item in activity if item["type"] == "repo.file.changed"
            and item["payload"].get("toolCallId") == tool_call_id
        )
        self.assertEqual(recovered_tool["payload"]["outcome"], "reconciled")
        self.assertEqual(
            recovered_file["payload"]["sha256"], hashlib.sha256(file_content.encode()).hexdigest(),
        )
        self.assertFalse(restarted_store.agent_run_has_unresolved_tool_calls(
            "builder", self.mission["id"], event["sequence"], run["created_at"],
        ))

    def test_startup_recovery_starts_worker_on_saved_trigger_automatically(self) -> None:
        event = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Continue from the saved progress", "recipient": "builder"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        self.store.save_agent_offset("builder", self.mission["id"], event["sequence"] - 1)
        step_database = self.store.data_dir / "agent_steps.sqlite3"
        source = f'''\
import asyncio
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence

async def save_checkpoint():
    conversation_id = {f"tribe:{self.mission['id']}:builder"!r}
    step_store = SqliteStepStore(database={str(step_database)!r})
    agent = Agent("openai:test-model")
    with agent.override(model=TestModel(call_tools=[], custom_output_text="saved frontier")):
        await agent.run(
            "Continue from the current repository state.",
            capabilities=[StepPersistence(
                store=step_store, agent_name=conversation_id,
                metadata={{"trigger_sequence": {str(event["sequence"])!r}}},
                capture_frontier=True,
            )],
            conversation_id=conversation_id,
        )

asyncio.run(save_checkpoint())
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 0, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        provider_events: list[dict[str, Any]] = []

        class CheckpointProvider(PydanticAIProvider):
            def __init__(self, definition, model):
                self.definition = definition
                self.model = model

            async def run(self, store, mission_id, event, cancellation_token=None):
                del store, mission_id, cancellation_token
                provider_events.append(event)
                return "Resumed the saved run automatically."

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        supervisor = EnabledSupervisor(
            restarted_store,
            [AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md")],
            provider_factory=lambda definition, model: CheckpointProvider(definition, model),
        )
        try:
            self.assertEqual(supervisor.recover_interrupted_agent_runs(), 1)
            supervisor.start_mission(self.mission["id"])
            deadline = time.monotonic() + 8
            run = None
            while time.monotonic() < deadline:
                run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
                if run and run["status"] == "completed":
                    break
                time.sleep(0.02)
            self.assertIsNotNone(run)
            self.assertEqual(
                run["status"], "completed",
                f"provider_events={provider_events!r}; mission_events={restarted_store.events_after(self.mission['id'], event['sequence'])!r}; supervisor={supervisor.status!r}",
            )
            self.assertEqual(run["output_text"], "Resumed the saved run automatically.")
            self.assertEqual(len(provider_events), 1)
            self.assertTrue(provider_events[0].get("resumeCheckpoint"))
            self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 0)
        finally:
            supervisor.close()

    def test_supervisor_replays_abandoned_turn_from_trigger_when_no_tool_started(self) -> None:
        event = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Recover this request after restart", "recipient": "builder"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        self.store.reserve_agent_usage(
            "builder", self.mission["id"], event["sequence"], attempt=10, default_limit=10_000,
        )
        restarted_store = MissionStore(self.store.path)
        provider_events: list[dict[str, Any]] = []

        class ReplayProvider:
            async def run(self, store, mission_id, provider_event, cancellation_token=None):
                del store, mission_id, cancellation_token
                provider_events.append(provider_event)
                return "Recovered from the original request."

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        provider = ReplayProvider()
        supervisor = EnabledSupervisor(
            restarted_store,
            [AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md")],
            provider_factory=lambda definition, model: provider,
        )
        try:
            self.assertEqual(supervisor.recover_interrupted_agent_runs(), 1)
            run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
            self.assertEqual(run["status"], "retrying")
            self.assertEqual(run["retry_from_trigger"], 1)
            self.assertEqual(restarted_store.agent_offset("builder", self.mission["id"]), 0)
            with restarted_store._connect() as db:
                reservation = db.execute(
                    "SELECT status FROM usage_reservations WHERE agent_id='builder' AND mission_id=? "
                    "AND trigger_sequence=? AND attempt=10",
                    (self.mission["id"], event["sequence"]),
                ).fetchone()
            self.assertEqual(reservation["status"], "unknown")
            self.assertTrue(any(item["type"] == "agent.run.retrying" and
                                item["payload"].get("replayedFromTrigger") is True
                                for item in restarted_store.events_after(self.mission["id"], event["sequence"])))

            supervisor.start_mission(self.mission["id"])
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
                if run and run["status"] == "completed":
                    break
                time.sleep(0.02)

            self.assertEqual(run["status"], "completed")
            self.assertEqual(run["output_text"], "Recovered from the original request.")
            self.assertEqual(len(provider_events), 1)
            self.assertNotIn("resumeCheckpoint", provider_events[0])
            self.assertEqual(run["attempts"], 2)
            self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 0)
        finally:
            supervisor.close()

    def test_process_death_during_partial_repository_write_is_quarantined(self) -> None:
        event = self.store.append(
            "message.created", "user", self.mission["id"],
            {"text": "Write a repository file", "recipient": "builder"},
        )
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        step_database = self.store.data_dir / "agent_steps.sqlite3"
        repository_file = self.repository / "src" / "partial-write.py"
        expected_content = "the complete intended file\n"
        partial_content = "the incomplete"
        tool_call_id = "partial-write-before-restart"
        source = f'''\
import asyncio
import hashlib
import os
from pathlib import Path
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence
from tribe_runtime.store import MissionStore

async def save_checkpoint():
    conversation_id = {f"tribe:{self.mission['id']}:builder"!r}
    step_store = SqliteStepStore(database={str(step_database)!r})
    agent = Agent("openai:test-model")
    with agent.override(model=TestModel(call_tools=[], custom_output_text="checkpoint saved")):
        await agent.run(
            "Inspect and edit the target source file.",
            capabilities=[StepPersistence(
                store=step_store, agent_name=conversation_id,
                metadata={{"trigger_sequence": {str(event["sequence"])!r}}},
                capture_frontier=True,
            )],
            conversation_id=conversation_id,
        )

asyncio.run(save_checkpoint())
store = MissionStore(Path({str(self.store.path)!r}))
mission_id = {self.mission["id"]!r}
tool_call_id = {tool_call_id!r}
store.append("agent.tool.started", "builder", mission_id, {{
    "toolName": "write_file", "toolCallId": tool_call_id,
    "triggerSequence": {event["sequence"]}, "summary": "src/partial-write.py",
}})
store.append("repo.file.write.started", "builder", mission_id, {{
    "toolCallId": tool_call_id, "triggerSequence": {event["sequence"]},
    "path": "src/partial-write.py", "change": "created",
    "sha256": hashlib.sha256({expected_content!r}.encode()).hexdigest(),
}})
target = Path({str(repository_file)!r})
target.parent.mkdir(parents=True, exist_ok=True)
with target.open("w", encoding="utf-8") as handle:
    handle.write({partial_content!r})
    handle.flush()
    os.fsync(handle.fileno())
os._exit(27)
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 27, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        supervisor = AgentSupervisor(restarted_store, [])
        recovered = supervisor.recover_interrupted_agent_runs()
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        activity = restarted_store.events_after(self.mission["id"], event["sequence"])
        interrupted_tool = next(
            item for item in activity if item["type"] == "agent.tool.interrupted"
            and item["payload"].get("toolCallId") == tool_call_id
        )

        self.assertEqual(recovered, 1)
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(restarted_store.agent_offset("builder", self.mission["id"]), event["sequence"])
        self.assertEqual(repository_file.read_text(encoding="utf-8"), partial_content)
        self.assertEqual(interrupted_tool["payload"]["outcome"], "unknown")
        self.assertFalse(any(
            item["type"] == "agent.tool.completed"
            and item["payload"].get("toolCallId") == tool_call_id
            for item in activity
        ))
        self.assertFalse(any(
            item["type"] == "repo.file.changed"
            and item["payload"].get("toolCallId") == tool_call_id
            for item in activity
        ))
        self.assertEqual(supervisor.recover_interrupted_agent_runs(), 0)

    def test_startup_preserves_deferred_approval_frontier_for_safe_resume(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Check this"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        interaction = self.store.create_deferred_tool_interaction(
            mission_id=self.mission["id"], requested_by="builder", title="Run command",
            details="Run the approved command", target="pytest tests", trigger_sequence=event["sequence"],
            run_id="provider-run", conversation_id=f"tribe:{self.mission['id']}:builder",
            tool_call_id="tool-call", tool_name="run_command", tool_arguments={"command": "pytest tests"},
            message_history="[]", tool_summary="pytest tests",
            activity_labels={"working": "running a command", "finished": "ran a command"},
            work_item_id="work-item-1",
        )

        self.assertEqual(interaction["status"], "pending")
        waiting_event = next(
            item for item in self.store.events_after(self.mission["id"], event["sequence"])
            if item["type"] == "agent.tool.waiting_for_user"
        )
        self.assertEqual(waiting_event["payload"]["toolCallId"], "tool-call")
        self.assertEqual(waiting_event["payload"]["triggerSequence"], event["sequence"])
        self.assertEqual(waiting_event["payload"]["summary"], "pytest tests")
        self.assertEqual(waiting_event["payload"]["workItemId"], "work-item-1")
        self.assertEqual(self.store.recover_interrupted_agent_runs(), 0)
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], event["sequence"])["status"],
            "running",
        )
        self.assertEqual(self.store.agent_offset("builder", self.mission["id"]), event["sequence"])
        self.store.resolve_interaction(interaction["id"], "approved_once")
        self.assertEqual(
            self.store.resume_resolved_deferred_tool_approval(interaction["id"]), event["sequence"],
        )
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], event["sequence"])["status"],
            "retrying",
        )
        self.assertEqual(
            self.store.agent_offset("builder", self.mission["id"]), event["sequence"] - 1,
        )

    def test_startup_quarantines_approval_consumed_before_tool_result(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Run command"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        source = f'''\
import os
from pathlib import Path
from tribe_runtime.store import MissionStore

store = MissionStore(Path({str(self.store.path)!r}))
mission_id = {self.mission["id"]!r}
trigger_sequence = {event["sequence"]}
store.append("agent.tool.started", "builder", mission_id, {{
    "toolName": "run_command", "toolCallId": "tool-call",
    "triggerSequence": trigger_sequence, "summary": "pytest tests",
}})
interaction = store.create_deferred_tool_interaction(
    mission_id=mission_id, requested_by="builder", title="Run command",
    details="Run the approved command", target="pytest tests", trigger_sequence=trigger_sequence,
    run_id="provider-run", conversation_id=f"tribe:{{mission_id}}:builder",
    tool_call_id="tool-call", tool_name="run_command", tool_arguments={{"command": "pytest tests"}},
    message_history="[]",
)
store.resolve_interaction(interaction["id"], "approved_once")
assert store.consume_deferred_tool_approval(interaction["id"], "pytest tests")
os._exit(24)
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 24, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 1)
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        deferred = restarted_store.deferred_tool_approvals(self.mission["id"], "builder")[0]
        activity = restarted_store.events_after(self.mission["id"], event["sequence"])
        interrupted = [item for item in activity if item["type"] == "agent.tool.interrupted"]

        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(deferred["status"], "unknown_after_crash")
        self.assertEqual(len(interrupted), 1)
        self.assertEqual(interrupted[0]["payload"]["outcome"], "unknown")
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 0)

    def test_worker_replays_original_trigger_after_approval_resolves_during_restart(self) -> None:
        from tribe_runtime.agent_runtime import AgentWorker

        trigger = self.store.append("message.created", "user", self.mission["id"], {
            "text": "Run the approved check", "recipient": "builder",
        })
        self.store.begin_agent_event("builder", self.mission["id"], trigger["sequence"])
        interaction = self.store.create_deferred_tool_interaction(
            mission_id=self.mission["id"], requested_by="builder", title="Run command",
            details="Run the approved command", target="pytest tests", trigger_sequence=trigger["sequence"],
            run_id="provider-run", conversation_id=f"tribe:{self.mission['id']}:builder",
            tool_call_id="tool-call", tool_name="run_command", tool_arguments={"command": "pytest tests"},
            message_history="[]",
        )
        self.assertEqual(self.store.recover_interrupted_agent_runs(), 0)
        resolution = self.store.resolve_interaction(interaction["id"], "approved_once")
        stop = threading.Event()
        observed = []

        class Provider:
            async def run(inner_self, store, mission_id, event):
                observed.append(event)
                row = store.deferred_tool_approvals(mission_id, "builder", trigger["sequence"])[0]
                self.assertEqual(row["interaction_status"], "resolved")
                self.assertTrue(store.consume_deferred_tool_approval(row["interaction_id"], row["target"]))
                return "The approved tool result was handled."

        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md"),
            Provider(), stop,
        )
        save_agent_offset = self.store.save_agent_offset

        def stop_after_resolution_offset(agent_id, mission_id, sequence):
            save_agent_offset(agent_id, mission_id, sequence)
            if sequence == resolution["event"]["sequence"]:
                stop.set()

        self.store.save_agent_offset = stop_after_resolution_offset
        thread = threading.Thread(target=worker.run)
        thread.start()
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertEqual([event["sequence"] for event in observed], [trigger["sequence"]])
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], trigger["sequence"])["status"],
            "completed",
        )
        self.assertEqual(
            self.store.agent_offset("builder", self.mission["id"]), resolution["event"]["sequence"],
        )

    def test_provider_usage_is_durable_aggregated_and_idempotent(self) -> None:
        trigger = self.store.latest_sequence(self.mission["id"])
        self.store.set_project_usage_budget(self.project["id"], 10_000)
        self.store.begin_agent_event("builder", self.mission["id"], trigger)
        token_limit = self.store.reserve_agent_usage(
            "builder", self.mission["id"], trigger, 11
        )
        self.assertEqual(token_limit, 10_000)
        usage = {
            "requests": 2, "tool_calls": 3, "input_tokens": 1200,
            "output_tokens": 350, "cache_read_tokens": 100, "cache_write_tokens": 25,
        }

        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger, "Reviewed the project", None,
            "openai:gpt-test", usage, 11,
        )
        self.store.complete_agent_event(
            "builder", self.mission["id"], trigger, "Reviewed the project", None,
            "openai:gpt-test", usage, 11,
        )

        summary = self.store.project_usage(self.project["id"])
        self.assertEqual(summary["totals"]["runs"], 1)
        self.assertEqual(summary["totals"]["input_tokens"], 1200)
        self.assertEqual(summary["totals"]["output_tokens"], 350)
        self.assertEqual(summary["byModel"][0]["model"], "openai:gpt-test")
        self.assertEqual(summary["byAgent"][0]["agent"], "builder")
        self.assertEqual(summary["budget"]["usedTokens"], 1550)
        self.assertEqual(summary["budget"]["reservedTokens"], 0)
        self.assertEqual(summary["budget"]["remainingTokens"], 8450)

    def test_provider_cost_estimates_are_durable_and_unknown_prices_stay_unknown(self) -> None:
        first_trigger = self.store.latest_sequence(self.mission["id"])
        self.store.begin_agent_event("builder", self.mission["id"], first_trigger)
        self.store.complete_agent_event(
            "builder", self.mission["id"], first_trigger, "Priced run", None,
            "openai:gpt-test", {"requests": 1, "input_tokens": 100, "output_tokens": 20,
                                 "cost_usd": "0.012345"},
        )
        second_event = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Run an unpriced model"}
        )
        self.store.begin_agent_event("reviewer", self.mission["id"], second_event["sequence"])
        self.store.complete_agent_event(
            "reviewer", self.mission["id"], second_event["sequence"], "Unpriced run", None,
            "ollama:qwen2.5-coder:7b", {"requests": 1, "input_tokens": 80, "output_tokens": 10},
        )
        older_event = self.store.append(
            "message.created", "user", self.mission["id"], {"text": "Run from an earlier month"}
        )
        self.store.begin_agent_event("planner", self.mission["id"], older_event["sequence"])
        self.store.complete_agent_event(
            "planner", self.mission["id"], older_event["sequence"], "Earlier priced run", None,
            "anthropic:claude-test", {"requests": 1, "input_tokens": 300, "output_tokens": 100,
                                      "cost_usd": "9.99"},
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE agent_event_runs SET updated_at='2000-01-01T00:00:00+00:00' "
                "WHERE agent_id='planner' AND mission_id=? AND trigger_sequence=?",
                (self.mission["id"], older_event["sequence"]),
            )

        summary = self.store.project_usage(self.project["id"])
        self.assertEqual(summary["totals"]["cost_usd"], "10.002345")
        self.assertEqual(summary["totals"]["priced_runs"], 2)
        self.assertEqual(summary["totals"]["unpriced_runs"], 1)
        self.assertEqual(summary["monthToDate"]["completedRuns"], 2)
        self.assertEqual(summary["monthToDate"]["pricedRuns"], 1)
        self.assertEqual(summary["monthToDate"]["unpricedRuns"], 1)
        self.assertEqual(summary["monthToDate"]["estimatedCostUsd"], "0.012345")
        self.assertEqual(summary["monthToDate"]["tokens"], 210)
        current_month_model = next(
            item for item in summary["monthToDate"]["byModel"] if item["model"] == "openai:gpt-test"
        )
        self.assertEqual(current_month_model["estimatedCostUsd"], "0.012345")
        current_month_role = next(
            item for item in summary["monthToDate"]["byAgent"] if item["agent"] == "builder"
        )
        self.assertEqual(current_month_role["estimatedCostUsd"], "0.012345")
        unpriced_model = next(
            item for item in summary["monthToDate"]["byModel"]
            if item["model"] == "ollama:qwen2.5-coder:7b"
        )
        self.assertIsNone(unpriced_model["estimatedCostUsd"])
        self.assertEqual(unpriced_model["unpricedRuns"], 1)
        priced_model = next(item for item in summary["byModel"] if item["model"] == "openai:gpt-test")
        self.assertEqual(priced_model["cost_usd"], "0.012345")
        self.assertEqual(summary["byAgent"][0]["cost_usd"], "0.012345")
        run = self.store.agent_event_run("builder", self.mission["id"], first_trigger)
        self.assertEqual(run["cost_usd"], "0.012345")

    def test_schema_migrates_agent_run_cost_column(self) -> None:
        with self.store._connect() as db:
            db.execute("ALTER TABLE agent_event_runs DROP COLUMN cost_usd")
            db.execute("PRAGMA user_version = 15")
        migrated = MissionStore(self.root / "tribe.sqlite3")
        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(agent_event_runs)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("cost_usd", columns)
        self.assertEqual(version, SCHEMA_VERSION)

    def test_schema_37_adds_durable_memory_migration_reviews(self) -> None:
        legacy = self.insert_legacy_memory("Build command", "Run npm test.")
        with self.store._connect() as db:
            db.execute("DROP TABLE project_memory_migration_reviews")
            db.execute("PRAGMA user_version = 36")

        migrated = MissionStore(self.store.path)

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(project_memory_migration_reviews)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertTrue({"project_id", "entry_id", "legacy_hash", "smriti_hash", "resolution"} <= columns)
        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(migrated.project_knowledge(self.project["id"])[0]["id"], legacy["id"])

    def test_schema_38_adds_memory_migration_ledger_without_deleting_legacy_rows(self) -> None:
        legacy = self.insert_legacy_memory("Build command", "Run npm test.")
        with self.store._connect() as db:
            db.execute("DROP TABLE project_memory_migration_ledger")
            db.execute("PRAGMA user_version = 37")

        migrated = MissionStore(self.store.path)

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute(
                "PRAGMA table_info(project_memory_migration_ledger)"
            )}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertTrue({"project_id", "source_kind", "source_id", "memory_id", "source_hash"} <= columns)
        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(migrated.project_knowledge(self.project["id"])[0]["id"], legacy["id"])

    def test_schema_39_adds_custom_schedule_expression(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect", "daily", "UTC",
        )
        with self.store._connect() as db:
            db.execute("ALTER TABLE schedules DROP COLUMN cron_expression")
            db.execute("PRAGMA user_version = 38")

        migrated = MissionStore(self.store.path)

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(schedules)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
            stored = db.execute("SELECT cron_expression FROM schedules WHERE id=?", (schedule["id"],)).fetchone()
        self.assertIn("cron_expression", columns)
        self.assertEqual(stored["cron_expression"], "")
        self.assertEqual(version, SCHEMA_VERSION)

    def test_schema_40_adds_existing_chat_schedule_target(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect", "daily", "UTC",
        )
        with self.store._connect() as db:
            db.execute("ALTER TABLE schedules DROP COLUMN target_mission_id")
            db.execute("PRAGMA user_version = 39")

        migrated = MissionStore(self.store.path)

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(schedules)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
            stored = db.execute("SELECT target_mission_id FROM schedules WHERE id=?", (schedule["id"],)).fetchone()
        self.assertIn("target_mission_id", columns)
        self.assertEqual(stored["target_mission_id"], "")
        self.assertEqual(version, SCHEMA_VERSION)

    def test_schema_41_tracks_durable_scheduled_invocation_delivery(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect", "daily", "UTC",
        )
        self.store.update_schedule(schedule["id"], "run-now")
        claimed = self.store.claim_due_schedules()[0]
        self.store.begin_agent_event("planner", claimed["missionId"], claimed["event"]["sequence"])
        with self.store._connect() as db:
            db.execute("ALTER TABLE scheduled_runs DROP COLUMN trigger_sequence")
            db.execute("ALTER TABLE scheduled_runs DROP COLUMN invocation_started_at")
            db.execute("PRAGMA user_version = 40")

        migrated = MissionStore(self.store.path)

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(scheduled_runs)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
            run = db.execute("SELECT status,started_at,invocation_started_at FROM scheduled_runs").fetchone()
        self.assertIn("trigger_sequence", columns)
        self.assertIn("invocation_started_at", columns)
        self.assertEqual(run["status"], "running")
        self.assertEqual(run["invocation_started_at"], run["started_at"])
        self.assertEqual(version, SCHEMA_VERSION)

    def test_schema_migrates_agent_run_retry_at_column(self) -> None:
        with self.store._connect() as db:
            db.execute("ALTER TABLE agent_event_runs DROP COLUMN retry_at")
            db.execute("PRAGMA user_version = 29")
        migrated = MissionStore(self.root / "tribe.sqlite3")
        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(agent_event_runs)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("retry_at", columns)
        self.assertIn("retry_deadline_at", columns)
        self.assertEqual(version, SCHEMA_VERSION)

    def test_schema_migrates_agent_run_retry_from_trigger_column(self) -> None:
        with self.store._connect() as db:
            db.execute("ALTER TABLE agent_event_runs DROP COLUMN retry_from_trigger")
            db.execute("PRAGMA user_version = 33")

        migrated = MissionStore(self.root / "tribe.sqlite3")

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(agent_event_runs)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("retry_from_trigger", columns)
        self.assertEqual(version, SCHEMA_VERSION)

    def test_schema_migrates_request_usage_ledger(self) -> None:
        with self.store._connect() as db:
            db.execute("ALTER TABLE agent_request_usage DROP COLUMN compaction_receipt_count")
            db.execute("PRAGMA user_version = 32")

        migrated = MissionStore(self.root / "tribe.sqlite3")

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(agent_request_usage)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("context_message_count", columns)
        self.assertIn("compaction_receipt_count", columns)
        self.assertIn("input_tokens", columns)
        self.assertEqual(version, SCHEMA_VERSION)

    def test_provider_hook_persists_usage_before_a_later_run_failure(self) -> None:
        from pydantic_ai.capabilities import Hooks
        from pydantic_ai.messages import ModelResponse, TextContent, TextPart, UserPromptPart
        from pydantic_ai.usage import RequestUsage

        model = "openai:test-model"
        self.store.register_configured_model(model)
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])

        class AgentStub:
            async def run(self, prompt, **kwargs):
                hooks = next(item for item in kwargs["capabilities"] if isinstance(item, Hooks))
                response = ModelResponse(
                    parts=[TextPart(content="tool call")],
                    usage=RequestUsage(input_tokens=540, output_tokens=24),
                )
                messages = ["older", SimpleNamespace(parts=[UserPromptPart(content=[TextContent(
                    content="[History before this point (5 messages, ~100 tokens) was summarized"
                )])])]
                for _ in range(2):
                    await hooks.after_model_request(
                        SimpleNamespace(),
                        request_context=SimpleNamespace(messages=messages),
                        response=response,
                    )
                raise RuntimeError("later step failed")

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md",
                                model=model), model,
            )
            with self.assertRaisesRegex(RuntimeError, "later step failed"):
                asyncio.run(provider.run(self.store, self.mission["id"], event))

        restarted_store = MissionStore(self.store.path)
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 1)
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 0)
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        request = restarted_store.agent_request_usage_for_run(
            "builder", self.mission["id"], event["sequence"],
        )[0]
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual((run["requests"], run["input_tokens"], run["output_tokens"]), (1, 540, 24))
        self.assertEqual(request["context_message_count"], 2)
        self.assertEqual(request["compaction_receipt_count"], 1)
        mission_requests = restarted_store.agent_request_usage_for_mission(self.mission["id"])
        self.assertEqual(len(mission_requests), 1)
        self.assertNotIn("messages", mission_requests[0])

    def test_compaction_receipt_counter_reads_harness_text_content(self) -> None:
        from pydantic_ai.messages import TextContent, UserPromptPart

        messages = [SimpleNamespace(parts=[UserPromptPart(content=[TextContent(
            content="[History before this point (5 messages, ~100 tokens) was summarized"
        )])])]
        self.assertEqual(_count_compaction_receipts(messages), 1)

    def test_process_death_before_model_response_quarantines_without_usage_or_replay(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        source = f'''\
import asyncio
import os
from pathlib import Path
from pydantic_ai import Agent
from pydantic_ai.capabilities import Hooks
from pydantic_ai.models.test import TestModel
from tribe_runtime.store import MissionStore

store = MissionStore(Path({str(self.store.path)!r}))
async def before_model_request(ctx, request_context):
    del ctx, request_context
    os._exit(28)

agent = Agent("openai:test-model", capabilities=[Hooks(before_model_request=before_model_request)])
async def main():
    with agent.override(model=TestModel(custom_output_text="This response must never be received")):
        await agent.run("Answer briefly.", conversation_id="crash-before-response")
asyncio.run(main())
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 28, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 1)
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(run["requests"], 0)
        self.assertEqual(restarted_store.agent_request_usage_for_run(
            "builder", self.mission["id"], event["sequence"],
        ), [])
        self.assertEqual(restarted_store.agent_offset("builder", self.mission["id"]), event["sequence"])
        events = restarted_store.events_after(self.mission["id"], event["sequence"])
        self.assertFalse(any(item["type"] in {
            "agent.usage.recorded", "agent.tool.started", "agent.tool.completed",
        } for item in events))
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 0)

    def test_process_death_during_inflight_provider_request_replays_without_tool_effects(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        request_started = self.root / "provider-request-started"
        source = f'''\
import asyncio
from pathlib import Path
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

request_started = Path({str(request_started)!r})
class InFlightModel(TestModel):
    async def request(self, messages, model_settings, model_request_parameters):
        del messages, model_settings, model_request_parameters
        request_started.write_text("request entered", encoding="utf-8")
        await asyncio.Event().wait()

asyncio.run(Agent(InFlightModel()).run("Answer briefly.", conversation_id="crash-in-flight"))
'''
        process = subprocess.Popen(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            deadline = time.monotonic() + 15
            while not request_started.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            if not request_started.exists():
                stdout, stderr = process.communicate(timeout=5)
                self.fail(f"model request did not start; stdout={stdout!r}, stderr={stderr!r}")
            process.kill()
            stdout, stderr = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, f"child exited normally; stdout={stdout!r}, stderr={stderr!r}")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

        restarted_store = MissionStore(self.store.path)
        supervisor = AgentSupervisor(restarted_store, [])
        self.assertEqual(supervisor.recover_interrupted_agent_runs(), 1)
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        self.assertEqual(run["status"], "retrying")
        self.assertEqual(run["retry_from_trigger"], 1)
        self.assertEqual(run["requests"], 0)
        self.assertEqual(restarted_store.agent_request_usage_for_run(
            "builder", self.mission["id"], event["sequence"],
        ), [])
        self.assertEqual(restarted_store.agent_offset("builder", self.mission["id"]), 0)
        events = restarted_store.events_after(self.mission["id"], event["sequence"])
        retry = next(item for item in events if item["type"] == "agent.run.retrying")
        self.assertTrue(retry["payload"]["replayedFromTrigger"])
        self.assertFalse(any(item["type"] in {
            "agent.usage.recorded", "agent.tool.started", "agent.tool.completed",
            "agent.run.interrupted",
        } for item in events))
        self.assertEqual(supervisor.recover_interrupted_agent_runs(), 0)
        supervisor.close()

    def test_process_death_during_partial_http_model_response_replays_without_tool_effects(self) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        response_started = threading.Event()
        finish_response = threading.Event()

        class PartialResponseHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body_length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(body_length)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "1024")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(b'{"id":"partial-response","choices":[{"index":0,')
                self.wfile.flush()
                response_started.set()
                finish_response.wait(timeout=15)

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), PartialResponseHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        endpoint = f"http://127.0.0.1:{server.server_port}/v1"
        source = f'''\
import asyncio
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

model = OpenAIChatModel("test-model", provider=OpenAIProvider(base_url={endpoint!r}, api_key="test"))
asyncio.run(Agent(model).run("Answer briefly.", conversation_id="crash-partial-http-response"))
'''
        process = subprocess.Popen(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            if not response_started.wait(timeout=15):
                stdout, stderr = process.communicate(timeout=5)
                self.fail(f"partial HTTP response did not start; stdout={stdout!r}, stderr={stderr!r}")
            process.kill()
            stdout, stderr = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, f"child exited normally; stdout={stdout!r}, stderr={stderr!r}")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)
            finish_response.set()
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=10)

        restarted_store = MissionStore(self.store.path)
        supervisor = AgentSupervisor(restarted_store, [])
        self.assertEqual(supervisor.recover_interrupted_agent_runs(), 1)
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        self.assertEqual(run["status"], "retrying")
        self.assertEqual(run["retry_from_trigger"], 1)
        self.assertEqual(run["requests"], 0)
        self.assertEqual(restarted_store.agent_request_usage_for_run(
            "builder", self.mission["id"], event["sequence"],
        ), [])
        events = restarted_store.events_after(self.mission["id"], event["sequence"])
        retry = next(item for item in events if item["type"] == "agent.run.retrying")
        self.assertTrue(retry["payload"]["replayedFromTrigger"])
        self.assertEqual(restarted_store.agent_offset("builder", self.mission["id"]), 0)
        self.assertFalse(any(item["type"] in {
            "agent.usage.recorded", "agent.tool.started", "agent.tool.completed",
            "agent.run.interrupted",
        } for item in events))
        self.assertEqual(supervisor.recover_interrupted_agent_runs(), 0)
        supervisor.close()

    def test_process_death_after_provider_response_keeps_usage_and_quarantines_without_checkpoint(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        source = f'''\
import asyncio
import os
from pathlib import Path
from pydantic_ai import Agent
from pydantic_ai.capabilities import Hooks
from pydantic_ai.models.test import TestModel
from tribe_runtime.store import MissionStore

store = MissionStore(Path({str(self.store.path)!r}))
async def after_model_request(ctx, request_context, response):
    del ctx
    usage = response.usage
    values = {{
        key: getattr(usage, key, 0)
        for key in ("tool_calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
    }}
    await asyncio.to_thread(
        store.record_agent_request_usage, "builder", {self.mission["id"]!r},
        {event["sequence"]}, "response-before-crash", "openai:test-model", values,
        len(request_context.messages), 0,
    )
    os._exit(25)

agent = Agent("openai:test-model", capabilities=[Hooks(after_model_request=after_model_request)])
async def main():
    with agent.override(model=TestModel(custom_output_text="Provider response received")):
        await agent.run("Answer briefly.", conversation_id="crash-after-response")
asyncio.run(main())
'''
        crashed_process = subprocess.run(
            [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(crashed_process.returncode, 25, crashed_process.stderr)

        restarted_store = MissionStore(self.store.path)
        self.assertEqual(restarted_store.recover_interrupted_agent_runs(), 1)
        run = restarted_store.agent_event_run("builder", self.mission["id"], event["sequence"])
        requests = restarted_store.agent_request_usage_for_run(
            "builder", self.mission["id"], event["sequence"],
        )
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(run["requests"], 1)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["request_key"], "response-before-crash")
        self.assertNotIn("messages", requests[0])

    def test_provider_uses_reserved_budget_in_pydantic_ai_limits(self) -> None:
        from pydantic_ai import CancellationToken, UsageLimits
        from pydantic_ai_harness.compaction import SummarizingCompaction

        self.store.set_project_usage_budget(self.project["id"], 5_000, "0.25")
        self.store.register_configured_model("openai:test-model")
        self.store.update_model_metadata("openai:test-model", {
            "contextWindow": 1_000_000, "maxOutputTokens": 4_096,
        })
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.assertEqual(
            self.store.reserve_agent_usage("builder", self.mission["id"], event["sequence"], 11),
            5_000,
        )
        captured = {}
        cancellation_token = CancellationToken()

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["usage_limits"] = kwargs["usage_limits"]
                captured["cancellation_token"] = kwargs["cancellation_token"]
                captured["model_settings"] = kwargs.get("model_settings")
                captured["capabilities"] = kwargs["capabilities"]
                return type("Result", (), {"output": "no-op"})()

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("builder", "Builder", "Implementation", "Build features", "builder.md"),
                "openai:test-model",
            )
            asyncio.run(provider.run(self.store, self.mission["id"], event, cancellation_token))

        limits: UsageLimits = captured["usage_limits"]
        self.assertEqual(limits.total_tokens_limit, 5_000)
        self.assertEqual(limits.input_tokens_limit, 5_000)
        self.assertEqual(limits.output_tokens_limit, 5_000)
        self.assertEqual(limits.cost_limit, Decimal("0.25"))
        self.assertIsNone(limits.request_limit)
        self.assertIsNone(limits.tool_calls_limit)
        self.assertTrue(limits.count_tokens_before_request)
        self.assertIs(captured["cancellation_token"], cancellation_token)
        self.assertEqual(captured["model_settings"], {"max_tokens": 4_096})
        compaction = next(
            capability for capability in captured["capabilities"]
            if isinstance(capability, SummarizingCompaction)
        )
        self.assertEqual(compaction.context_window, 1_000_000)
        self.assertEqual(compaction.keep_tokens, 200_000)
        self.assertEqual(compaction.max_fraction, 0.75)
        self.assertTrue(compaction.keep_user_messages)
        self.assertEqual(compaction.model_settings, {"max_tokens": 4_096})

    def test_incremental_compaction_preserves_exact_context_across_multiple_summaries(self) -> None:
        from pydantic_ai import RunContext, RunUsage
        from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
        from pydantic_ai.models.function import FunctionModel
        from pydantic_ai_harness.compaction import SummarizingCompaction

        summary_prompts: list[str] = []

        summary_content = (
            "Goal: deliver the focus timer. Constraints: avoid new dependencies and run the tests. "
            "Decision: keep persistence in localStorage. Exact paths: README.md and src/timer.py. "
            "Unfinished work: implement pause/resume and verify keyboard controls."
        )

        def summarize(messages, _agent_info):
            summary_prompts.append(str(messages))
            return ModelResponse(parts=[TextPart(content=summary_content)])

        model = FunctionModel(summarize, model_name="test-compaction")
        history = [ModelRequest(parts=[UserPromptPart(
            content=(
                "Initial goal: deliver the focus timer; constraints: no new dependencies; "
                "decision: localStorage; exact paths: README.md and src/timer.py; "
                "unfinished: pause/resume and keyboard verification. "
                f"Progress update {index}."
            ),
        )]) for index in range(8)]
        context = RunContext(deps=None, model=model, usage=RunUsage(), messages=history)
        compaction = SummarizingCompaction(
            max_messages=4, keep_messages=2, keep_user_messages=True,
            incremental=True, receipts=True,
        )

        first = asyncio.run(compaction.compact(history, context))
        context.messages[:] = first
        follow_up = ModelRequest(parts=[UserPromptPart(content="Implement pause/resume before verifying keyboard controls.")])
        context.messages.append(follow_up)
        second = asyncio.run(compaction.compact(context.messages.copy(), context))
        context.messages[:] = second
        final_follow_up = ModelRequest(parts=[UserPromptPart(content="Run the tests and report unfinished work.")])
        context.messages.append(final_follow_up)
        third = asyncio.run(compaction.compact(context.messages.copy(), context))

        self.assertEqual(len(summary_prompts), 3)
        self.assertIn("<previous-summary>", summary_prompts[1])
        self.assertIn("<previous-summary>", summary_prompts[2])
        for preserved in (
            "deliver the focus timer", "avoid new dependencies", "localStorage",
            "README.md", "src/timer.py", "pause/resume", "keyboard controls",
        ):
            self.assertIn(preserved, summary_content)
            self.assertIn(preserved, str(third))
        self.assertIn("Implement pause/resume", str(second))
        self.assertIn("Run the tests", str(third))
        self.assertIn("History before this point", str(first))
        self.assertIn("History before this point", str(second))
        self.assertIn("History before this point", str(third))

    def test_project_run_cost_limit_is_durable_and_preserved_by_legacy_budget_update(self) -> None:
        self.store.set_project_usage_budget(self.project["id"], 5_000, "0.1250")
        self.assertEqual(self.store.usage_cost_limit_for_run(self.mission["id"]), Decimal("0.125"))

        self.store.set_project_usage_budget(self.project["id"], 6_000)

        budget = self.store.project_usage(self.project["id"])["budget"]
        self.assertEqual(budget["monthlyTokenLimit"], 6_000)
        self.assertEqual(budget["maxRunCostUsd"], "0.125")

    def test_default_agent_run_has_no_cumulative_token_limit(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.assertEqual(
            self.store.reserve_agent_usage("builder", self.mission["id"], event["sequence"], 1),
            0,
        )
        self.assertIsNone(self.store.usage_token_limit_for_run(
            "builder", self.mission["id"], event["sequence"],
        ))
        self.store.set_project_usage_budget(self.project["id"], None, max_run_tokens=12_345)
        limited_event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start with explicit cap"})
        self.assertEqual(
            self.store.reserve_agent_usage("builder", self.mission["id"], limited_event["sequence"], 2),
            12_345,
        )
        self.assertEqual(self.store.usage_token_limit_for_run(
            "builder", self.mission["id"], limited_event["sequence"],
        ), 12_345)

    def test_failed_agent_run_preserves_partial_provider_usage(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        self.store.fail_agent_event(
            "builder", self.mission["id"], event["sequence"], 2, "provider disconnected",
            usage_attempt=21, usage_model="openai:test-model",
            usage={"requests": 3, "tool_calls": 2, "input_tokens": 700,
                   "output_tokens": 80, "cache_read_tokens": 100, "cost_usd": "0.04"},
        )

        run = self.store.agent_event_run("builder", self.mission["id"], event["sequence"])
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["requests"], 3)
        self.assertEqual(run["input_tokens"], 700)
        self.assertEqual(run["output_tokens"], 80)
        usage = self.store.project_usage(self.project["id"])
        self.assertGreaterEqual(usage["totals"]["requests"], 3)
        self.assertGreaterEqual(usage["totals"]["input_tokens"], 700)

    def test_completed_request_usage_is_idempotent_and_survives_interruption(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        usage = {
            "tool_calls": 1, "input_tokens": 420, "output_tokens": 31,
            "cache_read_tokens": 20, "cache_write_tokens": 4, "cost_usd": "0.012",
        }
        self.assertTrue(self.store.record_agent_request_usage(
            "builder", self.mission["id"], event["sequence"], "response-1",
            "openai:test-model", usage, context_message_count=7,
        ))
        self.assertFalse(self.store.record_agent_request_usage(
            "builder", self.mission["id"], event["sequence"], "response-1",
            "openai:test-model", usage, context_message_count=7,
        ))
        active_usage = self.store.project_usage(self.project["id"])["totals"]
        self.assertEqual(active_usage["requests"], 1)
        self.assertEqual(active_usage["input_tokens"], 420)
        self.assertTrue(self.store.interrupt_agent_event(
            "builder", self.mission["id"], event["sequence"], "worker stopped",
        ))

        run = self.store.agent_event_run("builder", self.mission["id"], event["sequence"])
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(run["requests"], 1)
        self.assertEqual(run["input_tokens"], 420)
        request_rows = self.store.agent_request_usage_for_run(
            "builder", self.mission["id"], event["sequence"],
        )
        self.assertEqual(request_rows[0]["context_message_count"], 7)
        project_usage = self.store.project_usage(self.project["id"])
        self.assertGreaterEqual(project_usage["totals"]["input_tokens"], 420)

    def test_schema_migrates_project_run_cost_limit(self) -> None:
        with self.store._connect() as db:
            db.execute("ALTER TABLE project_usage_budgets DROP COLUMN max_run_cost_usd")
            db.execute("PRAGMA user_version = 21")

        migrated = MissionStore(self.root / "tribe.sqlite3")

        with migrated._connect() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(project_usage_budgets)")}
            version = db.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("max_run_cost_usd", columns)
        self.assertEqual(version, SCHEMA_VERSION)

    def test_ollama_provider_keeps_run_limits_without_pre_request_token_counting(self) -> None:
        from pydantic_ai import UsageLimits

        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start local run"})
        self.store.reserve_agent_usage("builder", self.mission["id"], event["sequence"], 17)
        captured = {}

        class AgentStub:
            async def run(self, prompt, **kwargs):
                captured["usage_limits"] = kwargs["usage_limits"]
                return type("Result", (), {"output": "no-op"})()

        with patch("tribe_runtime.agent_runtime._build_agent", return_value=AgentStub()):
            provider = PydanticAIProvider(
                AgentDefinition("builder", "Builder", "Implementation", "Build features", "builder.md"),
                "ollama:qwen2.5-coder:7b",
            )
            asyncio.run(provider.run(self.store, self.mission["id"], event, None))

        limits: UsageLimits = captured["usage_limits"]
        self.assertFalse(limits.count_tokens_before_request)
        self.assertIsNone(limits.request_limit)
        self.assertIsNone(limits.tool_calls_limit)
        self.assertIsNone(limits.total_tokens_limit)

    def test_cancel_requested_before_agent_result_quarantines_run_instead_of_publishing(self) -> None:
        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Make a change"})
        item = self.store.create_work_item(self.mission["id"], "Make change", "Implement it")
        self.store.claim_work(self.mission["id"], "builder")
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])

        self.assertTrue(self.store.request_agent_run_cancel("builder", self.mission["id"], event["sequence"]))
        self.store.complete_agent_event(
            "builder", self.mission["id"], event["sequence"], "Claimed successful work", item["id"]
        )

        run = self.store.agent_event_run("builder", self.mission["id"], event["sequence"])
        self.assertEqual(run["status"], "interrupted")
        interruption = next(
            entry for entry in self.store.events_after(self.mission["id"], event["sequence"])
            if entry["type"] == "agent.run.interrupted"
        )
        self.assertTrue(interruption["payload"]["cancelledByUser"])
        self.assertFalse(any(
            entry["type"] == "agent.message.created"
            and entry["payload"].get("text") == "Claimed successful work"
            for entry in self.store.events_after(self.mission["id"], event["sequence"])
        ))

    def test_supervisor_stop_requests_public_pydantic_cancellation_token(self) -> None:
        from pydantic_ai import CancellationToken

        event = self.store.append("message.created", "user", self.mission["id"], {"text": "Start"})
        self.store.begin_agent_event("builder", self.mission["id"], event["sequence"])
        supervisor = AgentSupervisor(self.store, [])
        cancel_event = threading.Event()
        token = CancellationToken()
        supervisor._active_runs[(self.mission["id"], "builder")] = (
            event["sequence"], cancel_event, token
        )

        self.assertTrue(supervisor.stop_agent_run(self.mission["id"], "builder"))
        self.assertTrue(cancel_event.is_set())
        self.assertTrue(token.cancelled)
        self.assertEqual(
            self.store.agent_event_run("builder", self.mission["id"], event["sequence"])["status"],
            "cancelling",
        )

    def test_worker_commits_interrupted_status_when_stop_arrives_during_provider_run(self) -> None:
        started, release, mission_stop = threading.Event(), threading.Event(), threading.Event()
        event = self.store.append("message.created", "user", self.mission["id"], {
            "text": "Implement", "recipient": "builder",
        })
        supervisor = AgentSupervisor(self.store, [])

        class BlockingProvider:
            async def run(self, store, mission_id, trigger):
                started.set()
                await asyncio.to_thread(release.wait, 5)
                return AgentRunResult("I completed the work", None)

        worker = AgentWorker(
            self.store, self.mission["id"],
            AgentDefinition("builder", "Builder", "Implementation", "Build", "builder.md"),
            BlockingProvider(), mission_stop,
            supervisor._register_active_run, supervisor._finish_active_run,
        )
        thread = threading.Thread(target=worker.run)
        thread.start()
        try:
            self.assertTrue(started.wait(3), "provider did not start")
            self.assertTrue(supervisor.stop_agent_run(self.mission["id"], "builder"))
            release.set()
            mission_stop.set()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive(), "worker did not finish after provider returned")
            run = self.store.agent_event_run("builder", self.mission["id"], event["sequence"])
            self.assertEqual(run["status"], "interrupted")
            self.assertFalse(any(
                item["type"] == "agent.message.created"
                and item["payload"].get("text") == "I completed the work"
                for item in self.store.events_after(self.mission["id"], event["sequence"])
            ))
        finally:
            mission_stop.set()
            release.set()
            thread.join(timeout=2)

    def test_monthly_budget_reservations_are_atomic_and_recovered_conservatively(self) -> None:
        self.store.set_project_usage_budget(self.project["id"], 200_000, None, 128_000)
        barrier = threading.Barrier(2)
        reservations: list[int | None] = [None, None]

        def reserve(index: int, agent_id: str) -> None:
            barrier.wait(timeout=3)
            reservations[index] = self.store.reserve_agent_usage(
                agent_id, self.mission["id"], 10, 11
            )

        workers = [
            threading.Thread(target=reserve, args=(0, "builder")),
            threading.Thread(target=reserve, args=(1, "reviewer")),
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
        reserved, second = reservations
        blocked = self.store.reserve_agent_usage("planner", self.mission["id"], 10, 11)

        self.assertEqual(sorted((reserved, second)), [72_000, 128_000])
        self.assertIsNone(blocked)
        self.assertEqual(self.store.project_usage(self.project["id"])["budget"]["remainingTokens"], 0)

        self.assertEqual(self.store.recover_usage_reservations(), 2)
        self.store.set_project_usage_budget(self.project["id"], 250_000)
        next_reservation = self.store.reserve_agent_usage("planner", self.mission["id"], 10, 21)
        self.assertEqual(next_reservation, 50_000)

    def test_local_scheduler_timezone_prefers_valid_TZ_configuration(self) -> None:
        with patch.dict(os.environ, {"TZ": "Pacific/Auckland"}):
            self.assertEqual(self.store.local_timezone_name(), "Pacific/Auckland")

    def test_local_scheduler_timezone_falls_back_to_platform_timezone_provider(self) -> None:
        with (
            patch.dict(os.environ, {"TZ": ""}),
            patch.object(Path, "resolve", side_effect=OSError("not available")),
            patch.object(Path, "read_text", side_effect=OSError("not available")),
            patch("tribe_runtime.store.get_localzone_name", return_value="Europe/London"),
        ):
            self.assertEqual(self.store.local_timezone_name(), "Europe/London")

    def test_one_time_schedule_requires_a_valid_future_local_datetime(self) -> None:
        with self.assertRaisesRegex(ValueError, "one_time_schedule_requires_run_at"):
            self.store.create_schedule(
                self.project["id"], "Review", "Inspect", "once", "UTC"
            )
        with self.assertRaisesRegex(ValueError, "run_at_must_be_in_the_future"):
            self.store.create_schedule(
                self.project["id"], "Review", "Inspect", "once", "UTC",
                run_at="2000-01-01T09:00",
            )
        schedule = self.store.create_schedule(
            self.project["id"], "Review", "Inspect", "once", "Australia/Sydney",
            run_at="2099-01-01T09:00",
        )
        due = datetime.fromisoformat(schedule["next_run_at"])
        self.assertEqual(due.astimezone(ZoneInfo("Australia/Sydney")).hour, 9)

    def test_schedule_can_be_edited_before_a_run_starts(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect current state", "daily", "UTC",
        )

        updated = self.store.edit_schedule(
            self.project["id"], schedule["id"], "Weekly review", "Review delivery risks", "weekly", "Australia/Sydney",
            "10:30",
        )

        self.assertEqual(updated["title"], "Weekly review")
        self.assertEqual(updated["prompt"], "Review delivery risks")
        self.assertEqual(updated["cadence"], "weekly")
        self.assertEqual(updated["timezone"], "Australia/Sydney")
        self.assertEqual(updated["delivery_time"], "10:30")

    def test_schedule_cannot_be_edited_while_a_run_is_in_progress(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Inspect current state", "hourly", "UTC",
        )
        self.store.update_schedule(schedule["id"], "run-now")
        self.store.claim_due_schedules()

        with self.assertRaisesRegex(ValueError, "schedule_has_a_chat_in_progress"):
            self.store.edit_schedule(
                self.project["id"], schedule["id"], "Hourly review", "New prompt", "hourly", "UTC",
            )

    def test_schedule_actions_and_edits_are_bound_to_the_project(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Inspect current state", "hourly", "UTC",
        )
        other_workspace = self.root / "different-project"
        other_workspace.mkdir()
        other_project = self.store.register_project(str(other_workspace), "Different project")

        self.assertIsNone(self.store.update_project_schedule(other_project["id"], schedule["id"], "pause"))
        self.assertIsNone(self.store.edit_schedule(
            other_project["id"], schedule["id"], "Changed", "Prompt", "daily", "UTC",
        ))
        self.assertEqual(self.store.schedules(self.project["id"])[0]["status"], "active")

    def test_workspace_schedule_list_covers_projects_and_names_each_project(self) -> None:
        first = self.store.create_schedule(
            self.project["id"], "First review", "Inspect this project", "daily", "UTC",
        )
        other_workspace = self.root / "workspace-schedule-project"
        other_workspace.mkdir()
        other_project = self.store.register_project(str(other_workspace), "Second project")
        second = self.store.create_schedule(
            other_project["id"], "Second review", "Inspect that project", "weekly", "UTC",
        )

        schedules = self.store.workspace_schedules()

        self.assertEqual({item["id"] for item in schedules}, {first["id"], second["id"]})
        self.assertEqual(
            {item["id"]: item["project_name"] for item in schedules},
            {first["id"]: self.project["name"], second["id"]: "Second project"},
        )

    def test_workspace_schedule_api_aggregates_all_projects_without_removing_project_scope(self) -> None:
        from tribe_runtime import server as runtime_server

        first = self.store.create_schedule(
            self.project["id"], "First review", "Inspect this project", "daily", "UTC",
        )
        other_workspace = self.root / "api-schedule-project"
        other_workspace.mkdir()
        other_project = self.store.register_project(str(other_workspace), "Second project")
        second = self.store.create_schedule(
            other_project["id"], "Second review", "Inspect that project", "weekly", "UTC",
        )
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/schedules", timeout=3,
                ) as response:
                    workspace_payload = json.loads(response.read())
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{http.server_port}/api/schedules?project={self.project['id']}",
                    timeout=3,
                ) as response:
                    project_payload = json.loads(response.read())
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=3)

        self.assertEqual({item["id"] for item in workspace_payload["schedules"]}, {first["id"], second["id"]})
        self.assertEqual([item["id"] for item in project_payload["schedules"]], [first["id"]])

    def test_schedule_dispatch_creates_background_mission_without_pausing_foreground(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Nightly review", "Review repository health", "once", "UTC",
            run_at="2099-01-01T09:00",
        )
        self.store.update_schedule(schedule["id"], "run-now")

        claimed = self.store.claim_due_schedules()

        self.assertEqual(len(claimed), 1)
        background = self.store.mission(claimed[0]["missionId"])
        self.assertTrue(background["background"])
        self.assertEqual(background["status"], "active")
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "active")
        scheduled = self.store.schedules(self.project["id"])[0]
        self.assertEqual(scheduled["status"], "active")
        self.assertEqual(scheduled["runs"][0]["status"], "queued")

        self.store.begin_agent_event("planner", background["id"], claimed[0]["event"]["sequence"])
        self.assertEqual(self.store.schedules(self.project["id"])[0]["runs"][0]["status"], "running")

        with self.store._connect() as db:
            db.execute("UPDATE missions SET status='completed' WHERE id=?", (background["id"],))
        self.store.reconcile_scheduled_runs()
        self.assertEqual(self.store.schedules(self.project["id"])[0]["status"], "completed")
        self.assertEqual(self.store.claim_due_schedules(), [])

    def test_overdue_schedule_runs_once_after_restart_and_advances_from_current_time(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Review repository health", "hourly", "UTC",
        )
        with self.store._connect() as db:
            db.execute(
                "UPDATE schedules SET next_run_at=? WHERE id=?",
                ("2020-01-01T00:00:00+00:00", schedule["id"]),
            )

        restarted = MissionStore(self.store.path)
        claimed = restarted.claim_due_schedules()

        self.assertEqual(len(claimed), 1)
        self.assertEqual(restarted.claim_due_schedules(), [])
        updated = restarted.schedules(self.project["id"])[0]
        self.assertEqual(len(updated["runs"]), 1)
        self.assertGreater(datetime.fromisoformat(updated["next_run_at"]), datetime.now().astimezone())

    def test_schedule_history_pages_all_runs_in_stable_order(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Review repository health", "hourly", "UTC"
        )
        for _ in range(12):
            self.store.update_schedule(schedule["id"], "run-now")
            run = self.store.claim_due_schedules()[0]
            with self.store._connect() as db:
                db.execute("UPDATE missions SET status='completed' WHERE id=?", (run["missionId"],))
            self.store.reconcile_scheduled_runs()

        summary = self.store.schedules(self.project["id"])[0]
        first_page = self.store.schedule_runs(schedule["id"], limit=10)
        cursor = first_page["runs"][-1]
        self.store.update_schedule(schedule["id"], "run-now")
        newly_inserted = self.store.claim_due_schedules()[0]
        with self.store._connect() as db:
            db.execute("UPDATE missions SET status='completed' WHERE id=?", (newly_inserted["missionId"],))
        self.store.reconcile_scheduled_runs()
        second_page = self.store.schedule_runs(
            schedule["id"], limit=10, before_started_at=cursor["started_at"], before_id=cursor["id"]
        )

        self.assertEqual(summary["runs_total"], 12)
        self.assertEqual(len(summary["runs"]), 10)
        self.assertEqual(first_page["total"], 12)
        self.assertEqual(second_page["total"], 13)
        self.assertTrue(first_page["has_more"])
        self.assertEqual(len(first_page["runs"]), 10)
        self.assertFalse(second_page["has_more"])
        self.assertEqual(len(second_page["runs"]), 2)
        self.assertEqual(
            {run["id"] for run in first_page["runs"]} & {run["id"] for run in second_page["runs"]},
            set(),
        )
        self.assertNotIn(newly_inserted["runId"], {run["id"] for run in second_page["runs"]})

    def test_schedule_history_pagination_is_bounded_and_validated(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Review repository health", "hourly", "UTC"
        )

        with self.assertRaisesRegex(ValueError, "limit_must_be_between"):
            self.store.schedule_runs(schedule["id"], limit=1000)
        with self.assertRaisesRegex(ValueError, "cursor_requires_started_at_and_id"):
            self.store.schedule_runs(schedule["id"], before_started_at="2026-10-25T00:00:00Z")
        self.assertIsNone(self.store.schedule_runs("missing-schedule"))

    def test_schedule_history_route_returns_a_bounded_page(self) -> None:
        from tribe_runtime import server as runtime_server

        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Review repository health", "hourly", "UTC"
        )
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{http.server_port}/api/schedules/{schedule['id']}/runs?limit=5"
                with urllib.request.urlopen(url, timeout=3) as response:
                    payload = json.loads(response.read())
                self.assertEqual(payload, {"runs": [], "total": 0, "has_more": False})

                invalid = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/schedules/{schedule['id']}/runs?limit=500",
                )
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(invalid, timeout=3)
                self.assertEqual(failure.exception.code, 422)
            finally:
                http.shutdown()
                http.server_close()

    def test_schedule_management_routes_require_the_owning_project(self) -> None:
        from tribe_runtime import server as runtime_server

        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect", "daily", "UTC",
        )
        other_workspace = self.root / "schedule-route-other-project"
        other_workspace.mkdir()
        other_project = self.store.register_project(str(other_workspace), "Other project")
        with patch.object(runtime_server, "STORE", self.store):
            http = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                create = urllib.request.Request(
                    f"http://127.0.0.1:{http.server_port}/api/schedules",
                    data=json.dumps({
                        "projectId": self.project["id"], "title": "Custom review",
                        "prompt": "Inspect risks", "cadence": "cron", "timezone": "UTC",
                        "cronExpression": "0 9 * * MON-FRI",
                    }).encode(),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(create, timeout=3) as response:
                    created_schedule = json.loads(response.read())["schedule"]
                self.assertEqual(created_schedule["cron_expression"], "0 9 * * MON-FRI")

                base = f"http://127.0.0.1:{http.server_port}/api/schedules/{schedule['id']}"
                edit = urllib.request.Request(
                    base,
                    data=json.dumps({
                        "projectId": self.project["id"], "title": "Weekly review",
                        "prompt": "Inspect risks", "cadence": "cron", "timezone": "UTC",
                        "deliveryTime": "10:30", "cronExpression": "0 9 * * MON-FRI",
                    }).encode(),
                    headers={"Content-Type": "application/json"}, method="PUT",
                )
                with urllib.request.urlopen(edit, timeout=3) as response:
                    edited_schedule = json.loads(response.read())["schedule"]
                self.assertEqual(edited_schedule["title"], "Weekly review")
                self.assertEqual(edited_schedule["cron_expression"], "0 9 * * MON-FRI")

                pause_other = urllib.request.Request(
                    f"{base}/pause", data=json.dumps({"projectId": other_project["id"]}).encode(),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(pause_other, timeout=3)
                self.assertEqual(failure.exception.code, 404)
                self.assertEqual(self.store.schedules(self.project["id"])[0]["status"], "active")
            finally:
                http.shutdown()
                http.server_close()

    def test_schedule_rejects_unknown_timezone(self) -> None:
        with self.assertRaisesRegex(ValueError, "IANA_timezone"):
            self.store.create_schedule(self.project["id"], "Review", "Inspect", "daily", "Mars/Olympus")

    def test_daily_schedule_uses_configured_local_delivery_time(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect", "daily", "Australia/Sydney", "09:30"
        )
        due = datetime.fromisoformat(schedule["next_run_at"]).astimezone(ZoneInfo("Australia/Sydney"))

        self.assertEqual(schedule["delivery_time"], "09:30")
        self.assertEqual((due.hour, due.minute), (9, 30))
        self.assertGreater(due, datetime.now(ZoneInfo("Australia/Sydney")))

    def test_weekly_schedule_uses_monday_at_configured_local_time(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Weekly review", "Inspect", "weekly", "UTC", "08:15"
        )
        due = datetime.fromisoformat(schedule["next_run_at"]).astimezone(UTC)

        self.assertEqual((due.weekday(), due.hour, due.minute), (0, 8, 15))
        self.assertGreater(due, datetime.now(UTC))

    def test_weekday_schedule_skips_weekends(self) -> None:
        after = datetime(2026, 10, 31, 8, 0, tzinfo=UTC)  # Saturday

        due = self.store._schedule_due("weekdays", ZoneInfo("UTC"), "09:00", after)

        self.assertEqual(due, datetime(2026, 11, 2, 9, 0, tzinfo=UTC))

    def test_cron_schedule_supports_names_steps_and_timezone(self) -> None:
        after = datetime(2026, 10, 31, 8, 0, tzinfo=UTC)

        due = self.store._schedule_due(
            "cron", ZoneInfo("Australia/Sydney"), "09:00", after, "0 9 * * MON-FRI",
        )

        self.assertEqual(due, datetime(2026, 11, 2, 9, 0, tzinfo=ZoneInfo("Australia/Sydney")).astimezone(UTC))

    def test_cron_schedule_uses_standard_or_semantics_for_day_fields(self) -> None:
        after = datetime(2026, 10, 31, 8, 0, tzinfo=UTC)

        due = self.store._schedule_due(
            "cron", ZoneInfo("UTC"), "09:00", after, "0 9 1 * MON",
        )

        self.assertEqual(due, datetime(2026, 11, 1, 9, 0, tzinfo=UTC))

    def test_cron_schedule_skips_nonexistent_local_time_during_dst_jump(self) -> None:
        after = datetime(2026, 10, 3, 16, 0, tzinfo=UTC)

        due = self.store._schedule_due(
            "cron", ZoneInfo("Australia/Sydney"), "09:00", after, "30 2 * * *",
        )

        self.assertEqual(due, datetime(2026, 10, 5, 2, 30, tzinfo=ZoneInfo("Australia/Sydney")).astimezone(UTC))

    def test_cron_schedule_rejects_invalid_expressions(self) -> None:
        for expression in ("0 9 * *", "60 9 * * *", "0 9 31 FEB *"):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                self.store.create_schedule(
                    self.project["id"], "Custom review", "Inspect", "cron", "UTC",
                    cron_expression=expression,
                )

    def test_cron_schedule_persists_expression_through_edit(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Custom review", "Inspect", "cron", "UTC",
            cron_expression="0 9 * * MON-FRI",
        )

        updated = self.store.edit_schedule(
            self.project["id"], schedule["id"], "Custom review", "Inspect again", "cron", "UTC",
            cron_expression="30 8 * * MON-FRI",
        )

        self.assertEqual(updated["cron_expression"], "30 8 * * MON-FRI")
        self.assertEqual(updated["cadence"], "cron")

    def test_monthly_schedule_runs_on_the_first_of_the_next_month(self) -> None:
        after = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)

        due = self.store._schedule_due("monthly", ZoneInfo("UTC"), "09:00", after)

        self.assertEqual(due, datetime(2026, 11, 1, 9, 0, tzinfo=UTC))

    def test_monthly_schedule_advances_after_the_first_run_time(self) -> None:
        after = datetime(2026, 11, 1, 10, 0, tzinfo=UTC)

        due = self.store._schedule_due("monthly", ZoneInfo("UTC"), "09:00", after)

        self.assertEqual(due, datetime(2026, 12, 1, 9, 0, tzinfo=UTC))

    def test_schedule_rejects_invalid_delivery_time(self) -> None:
        with self.assertRaisesRegex(ValueError, "delivery_time_must_be_HH_MM"):
            self.store.create_schedule(self.project["id"], "Review", "Inspect", "daily", "UTC", "9:30")

    def test_schedule_schema_migration_preserves_existing_local_run_time(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Daily review", "Inspect", "daily", "Australia/Sydney", "09:30"
        )
        with self.store._connect() as db:
            db.execute("ALTER TABLE schedules DROP COLUMN delivery_time")
            db.execute("PRAGMA user_version = 14")

        migrated_store = MissionStore(self.store.path)
        migrated = next(item for item in migrated_store.schedules(self.project["id"])
                        if item["id"] == schedule["id"])

        self.assertEqual(migrated["delivery_time"], "09:30")

    def test_schedule_does_not_overlap_a_running_mission(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Review repository health", "hourly", "UTC"
        )
        self.store.update_schedule(schedule["id"], "run-now")

        first = self.store.claim_due_schedules()
        second = self.store.claim_due_schedules()

        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])
        self.store.finish_scheduled_run(first[0]["missionId"])
        runs = self.store.schedules(self.project["id"])[0]["runs"]
        self.assertEqual(runs[0]["status"], "completed")

    def test_scheduled_run_tracks_pause_block_and_completion_without_overlapping(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "Hourly review", "Review repository health", "hourly", "UTC"
        )
        self.store.update_schedule(schedule["id"], "run-now")
        first = self.store.claim_due_schedules()[0]
        mission_id = first["missionId"]

        self.store.pause_mission(mission_id)
        self.store.reconcile_scheduled_runs()
        run = self.store.schedules(self.project["id"])[0]["runs"][0]
        self.assertEqual(run["status"], "paused")
        self.assertIsNone(run["finished_at"])
        with self.assertRaisesRegex(ValueError, "mission in progress"):
            self.store.update_schedule(schedule["id"], "run-now")
        with self.store._connect() as db:
            db.execute("UPDATE schedules SET next_run_at=? WHERE id=?", (datetime.now(UTC).isoformat(), schedule["id"]))
        self.assertEqual(self.store.claim_due_schedules(), [])

        resumed = self.store.activate_mission(mission_id)
        self.assertEqual(resumed["status"], "active")
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "active")
        event_sequence = first["event"]["sequence"]
        self.store.begin_agent_event("planner", mission_id, event_sequence)
        self.store.reconcile_scheduled_runs()
        self.assertEqual(self.store.schedules(self.project["id"])[0]["runs"][0]["status"], "running")

        with self.store._connect() as db:
            db.execute("UPDATE missions SET blocked_reason='Waiting for your response: approval' WHERE id=?", (mission_id,))
        self.store.reconcile_scheduled_runs()
        self.assertEqual(self.store.schedules(self.project["id"])[0]["runs"][0]["status"], "blocked")
        self.assertEqual(self.store.claim_due_schedules(), [])

        with self.store._connect() as db:
            db.execute("UPDATE missions SET blocked_reason=NULL,status='completed' WHERE id=?", (mission_id,))
        self.store.reconcile_scheduled_runs()
        run = self.store.schedules(self.project["id"])[0]["runs"][0]
        self.assertEqual(run["status"], "completed")
        self.assertIsNotNone(run["finished_at"])
        self.assertEqual(len(self.store.claim_due_schedules()), 1)

    def test_resuming_scheduled_mission_does_not_pause_foreground_work(self) -> None:
        schedule = self.store.create_schedule(
            self.project["id"], "One-off review", "Review repository health", "once", "UTC",
            run_at="2099-01-01T09:00",
        )
        self.store.update_schedule(schedule["id"], "run-now")
        background_mission = self.store.claim_due_schedules()[0]["missionId"]
        self.store.pause_mission(background_mission)

        resumed = self.store.activate_mission(background_mission)

        self.assertEqual(resumed["status"], "active")
        self.assertEqual(self.store.mission(self.mission["id"])["status"], "active")
        events = self.store.events_after(background_mission, 0)
        self.assertTrue(any(event["type"] == "mission.resumed" for event in events))

        supervisor = AgentSupervisor(self.store, [])
        background_stop = threading.Event()
        supervisor._mission_stops[background_mission] = background_stop
        try:
            supervisor.pause_other_missions(self.mission["id"])
            self.assertFalse(background_stop.is_set())
        finally:
            supervisor.close()


class SupervisorResumeCase(unittest.TestCase):
    tearDown = RuntimeCase.tearDown
    git = RuntimeCase.git

    def setUp(self) -> None:
        RuntimeCase.setUp(self)
        message = self.store.append("message.created", "user", self.mission["id"], {
            "text": "Exercise builder worker lifecycle", "recipient": "builder",
        })
        self.store.save_agent_offset("builder", self.mission["id"], message["sequence"] - 1)
        self.store.create_work_item(self.mission["id"], "Keep the worker lifecycle task active")

    def test_resume_waits_for_in_flight_worker_then_restarts(self) -> None:
        started = threading.Event()
        release = threading.Event()
        resumed = threading.Event()
        calls = 0
        calls_lock = threading.Lock()

        class BlockingProvider:
            async def run(inner_self, store: MissionStore, mission_id: str, event: dict) -> str:
                nonlocal calls
                with calls_lock:
                    calls += 1
                    invocation = calls
                if invocation == 1:
                    started.set()
                    release.wait(8)
                else:
                    resumed.set()
                return "no-op"

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        agents = [AgentDefinition("builder", "Builder", "Implement", "", "builder.md")]
        second_mission = self.store.create_mission(self.project["id"], "Second", "Pause first")
        self.store.activate_mission(self.mission["id"])
        supervisor = EnabledSupervisor(
            self.store, agents, provider_factory=lambda definition, model: BlockingProvider()
        )
        try:
            supervisor.start_mission(self.mission["id"])
            self.assertTrue(started.wait(5))
            supervisor.pause_other_missions(second_mission["id"])
            self.store.activate_mission(self.mission["id"])
            supervisor.pause_other_missions(self.mission["id"])
            supervisor.start_mission(self.mission["id"])
            time.sleep(0.2)
            self.assertEqual(calls, 1)
            release.set()
            self.assertTrue(resumed.wait(5))
        finally:
            release.set()
            supervisor.close()

    def test_paused_mission_status_stops_worker_even_without_stop_signal(self) -> None:
        started = threading.Event()
        release = threading.Event()
        calls = 0

        class BlockingProvider:
            async def run(inner_self, store: MissionStore, mission_id: str, event: dict) -> str:
                nonlocal calls
                calls += 1
                started.set()
                release.wait(8)
                return "no-op"

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        supervisor = EnabledSupervisor(
            self.store,
            [AgentDefinition("builder", "Builder", "Implement", "", "builder.md")],
            provider_factory=lambda definition, model: BlockingProvider(),
        )
        try:
            supervisor.start_mission(self.mission["id"])
            self.assertTrue(started.wait(5))
            self.store.pause_mission(self.mission["id"])
            self.store.append("message.created", "user", self.mission["id"], {"text": "Do not process"})
            release.set()
            worker = supervisor._workers[(self.mission["id"], "builder")]
            worker.join(timeout=5)
            time.sleep(0.3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(calls, 1)
            self.assertEqual(self.store.mission(self.mission["id"])["status"], "paused")
        finally:
            release.set()
            supervisor.close()

    def test_role_update_waits_for_in_flight_worker_then_uses_new_definition(self) -> None:
        started = threading.Event()
        release = threading.Event()
        restarted = threading.Event()
        factory_calls = []
        factory_lock = threading.Lock()

        class Provider:
            def __init__(self, first_run: bool):
                self.first_run = first_run

            async def run(self, store: MissionStore, mission_id: str, event: dict) -> str:
                if self.first_run:
                    started.set()
                    release.wait(8)
                else:
                    restarted.set()
                return "no-op"

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        def provider_factory(definition, model):
            with factory_lock:
                factory_calls.append(definition)
                first_run = len(factory_calls) == 1
            return Provider(first_run)

        original = AgentDefinition("builder", "Builder", "Implementation", "Old role", "builder.md")
        supervisor = EnabledSupervisor(self.store, [original], provider_factory=provider_factory)
        try:
            supervisor.start_mission(self.mission["id"])
            self.assertTrue(started.wait(5))
            updated = AgentDefinition("builder", "Builder", "Implementation", "Updated role", "builder.md")
            supervisor.update_agent(updated)
            time.sleep(0.1)
            self.assertEqual(len(factory_calls), 1)
            release.set()
            self.assertTrue(restarted.wait(5))
            self.assertEqual(factory_calls[1].instructions, "Updated role")
        finally:
            release.set()
            supervisor.close()

    def test_model_change_restarts_active_workers_with_new_provider_settings(self) -> None:
        started = threading.Event()
        release = threading.Event()
        restarted = threading.Event()
        provider_models = []

        class Provider:
            def __init__(self, model: str):
                self.model = model

            async def run(self, store: MissionStore, mission_id: str, event: dict) -> str:
                if self.model == "openai:old-model":
                    started.set()
                    release.wait(8)
                else:
                    restarted.set()
                return "no-op"

        class EnabledSupervisor(AgentSupervisor):
            @property
            def enabled(self) -> bool:
                return True

        def provider_factory(definition, model):
            provider_models.append(model)
            return Provider(model)

        supervisor = EnabledSupervisor(
            self.store,
            [AgentDefinition("builder", "Builder", "Implement", "", "builder.md")],
            provider_factory=provider_factory,
        )
        try:
            with patch.dict(os.environ, {}, clear=True), patch("tribe_runtime.agent_runtime.save_api_key"):
                supervisor.configure("openai:old-model", "old-secret")
                self.assertTrue(started.wait(5))
                supervisor.configure("anthropic:new-model", "new-secret")
                self.assertEqual(provider_models, ["openai:old-model"])
                release.set()
                self.assertTrue(restarted.wait(5))
                self.assertEqual(provider_models, ["openai:old-model", "anthropic:new-model"])
                from tribe_runtime.credentials import PROVIDERS
                self.assertNotIn(PROVIDERS["openai"], os.environ)
                self.assertNotIn(PROVIDERS["anthropic"], os.environ)
        finally:
            release.set()
            supervisor.close()


if __name__ == "__main__":
    unittest.main()
