"""Exercise the production agent upload tool against the live Electron tab."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

from pydantic_ai.models.test import TestModel

from tribe_runtime import agent_runtime
from tribe_runtime.agent_runtime import AgentDependencies, _build_agent, _tools_for_agent
from tribe_runtime.agents import discover_agents


class FixtureStore:
    def __init__(self):
        self.events = []

    def mission(self, mission_id):
        assert mission_id == "browser-e2e"
        return {"project_id": "browser-e2e-project"}

    def project_web_access(self, project_id):
        assert project_id == "browser-e2e-project"
        return {"enabled": True, "allowedDomains": [os.environ["TRIBE_BROWSER_FIXTURE_HOST"]]}

    def append(self, event_type, actor_id, mission_id, payload):
        event = {
            "id": f"browser-e2e-event-{len(self.events) + 1}",
            "type": event_type,
            "actor_id": actor_id,
            "mission_id": mission_id,
            "payload": payload,
        }
        self.events.append(event)
        return event


agent_runtime.configure_browser_api_token(sys.stdin.readline().strip())
context = SimpleNamespace(deps=SimpleNamespace(store=FixtureStore(), mission_id="browser-e2e"))
snapshot = agent_runtime._browser_api(context, "snapshot")
upload_ref = next(
    (item["ref"] for item in snapshot["elements"]
     if item["name"] == "Choose test file" and item["type"] == "file"),
    None,
)
if not upload_ref:
    raise AssertionError("The live upload fixture did not expose its labelled file input.")

builder = next(item for item in discover_agents(Path.cwd() / "agents") if item.id == "builder")
agent = _build_agent(builder, "openai:test-model", api_key="test-only", base_url="http://127.0.0.1:1/v1")
granted_tools = _tools_for_agent(agent, builder.repository_access, builder.tool_permissions)
for tool in granted_tools:
    if getattr(tool, "defer_loading", False):
        tool.defer_loading = False
dependencies = AgentDependencies(
    store=FixtureStore(), mission_id="browser-e2e", definition=builder,
    workspace=None, skills=None,
)


class UploadModel(TestModel):
    def gen_tool_args(self, tool_def):
        if tool_def.name == "browser_upload":
            return {"ref": upload_ref}
        return super().gen_tool_args(tool_def)


async def upload_with_agent():
    with agent.override(model=UploadModel(
        call_tools=["browser_upload"], custom_output_text="The fixture upload completed.",
    )):
        with agent.override(tools=granted_tools):
            return await agent.run("Upload the selected test fixture in the browser.", deps=dependencies)


result = asyncio.run(upload_with_agent())
if result.output != "The fixture upload completed.":
    raise AssertionError("The production browser_upload tool did not complete through the agent loop.")

deadline = time.monotonic() + 35
while time.monotonic() < deadline:
    current = agent_runtime._browser_api(context, "snapshot")
    if "Fixture upload received" in current["text"]:
        print(json.dumps({"uploadTransferVerified": True, "filename": "fixture-upload.txt"}))
        raise SystemExit(0)
    time.sleep(0.2)

diagnostics = agent_runtime._browser_api(context, "diagnostics", {"limit": 50})
raise AssertionError(
    "The production browser_upload tool did not transfer the fixture before emulation. "
    f"Page: {current['text']}; network: {json.dumps(diagnostics.get('network', [])[-12:])}"
)
