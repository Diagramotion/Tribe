"""Exercise the runtime's project-policy wrapper against the live Electron bridge."""

import json
import os
import sys
import asyncio
import time
from types import SimpleNamespace
from urllib.parse import urlsplit
from pathlib import Path

from tribe_runtime import agent_runtime
from tribe_runtime.agents import discover_agents
from tribe_runtime.agent_runtime import AgentDependencies, _build_agent, _tools_for_agent
from pydantic_ai.models.test import TestModel


class FixtureStore:
    def __init__(self):
        self.events = []

    def mission(self, mission_id):
        assert mission_id == "browser-e2e"
        return {"project_id": "browser-e2e-project"}

    def project_web_access(self, project_id):
        assert project_id == "browser-e2e-project"
        return {"enabled": True, "allowedDomains": [urlsplit(os.environ["TRIBE_BROWSER_FIXTURE_URL"]).hostname]}

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
context = SimpleNamespace(deps=SimpleNamespace(
    store=FixtureStore(), mission_id="browser-e2e",
))

navigation = agent_runtime._browser_api(context, "state")
if navigation["url"] != os.environ["TRIBE_BROWSER_FIXTURE_URL"]:
    raise AssertionError("The runtime state did not report the browser's active URL.")
before = agent_runtime._browser_api(context, "snapshot")
if "Count: 0" not in before["text"]:
    raise AssertionError("The project-scoped runtime did not read the active fixture page.")
button = next((item for item in before["elements"] if item["name"] == "Increment counter"), None)
if not button or not button.get("ref"):
    raise AssertionError("The runtime snapshot did not include a current control reference.")
click = agent_runtime._browser_api(context, "click", {"ref": button["ref"]})
after = agent_runtime._browser_api(context, "snapshot")
if "Count: 1" not in after["text"]:
    raise AssertionError("The runtime click did not change the same active page.")
site_storage = agent_runtime._browser_api(context, "storage")
expected_origin = urlsplit(os.environ["TRIBE_BROWSER_FIXTURE_URL"])._replace(path="", query="", fragment="").geturl()
if site_storage["origin"] != expected_origin:
    raise AssertionError("Site storage must report only the current fixture origin.")
indexeddb = next((item for item in site_storage["breakdown"] if item["type"] == "indexeddb"), None)
if indexeddb is None or indexeddb["bytes"] <= 0:
    raise AssertionError(f"The runtime did not report fixture IndexedDB storage: {site_storage!r}")
diagnostics = agent_runtime._browser_api(context, "diagnostics", {"limit": 50})
if not any(item.get("httpStatusCode") == 200 for item in diagnostics.get("page", [])):
    raise AssertionError("The runtime diagnostics did not include the successful page response.")
if not any("fixture console diagnostic" in item.get("message", "") for item in diagnostics.get("console", [])):
    raise AssertionError("The runtime diagnostics did not include the fixture console message.")
emulated = agent_runtime._browser_api(context, "viewport", {
    "viewport": "pixel-7", "locale": "fr-FR", "network": "4g", "reducedMotion": "reduce",
})
if emulated["locale"] != "fr-FR" or emulated["network"] != "4g" or emulated["reducedMotion"] != "reduce":
    raise AssertionError("The project-scoped runtime did not apply browser locale, network and motion settings.")
try:
    agent_runtime._browser_api(context, "navigate", {"url": "https://example.com/"})
except PermissionError:
    pass
else:
    raise AssertionError("The runtime must reject navigation outside the project's host grant.")

builder = next(item for item in discover_agents(Path.cwd() / "agents") if item.id == "builder")
agent = agent_runtime._build_agent(
    builder, "openai:test-model", api_key="test-only", base_url="http://127.0.0.1:1/v1",
)
granted_tools = _tools_for_agent(agent, builder.repository_access, builder.tool_permissions)
for tool in granted_tools:
    if getattr(tool, "defer_loading", False):
        tool.defer_loading = False
browser_agent = AgentDependencies(
    store=FixtureStore(), mission_id="browser-e2e", definition=builder,
    workspace=None, skills=None,
)
fresh_snapshot = agent_runtime._browser_api(context, "snapshot")
increment_ref = next(
    (item["ref"] for item in fresh_snapshot["elements"]
     if item["name"] == "Increment counter"),
    None,
)
if not increment_ref:
    raise AssertionError("The agent run did not receive a current browser control reference.")
current_click_ref = increment_ref
current_fill_ref = None
current_fill_value = "Annual plan"
current_upload_ref = None


class BrowserActionModel(TestModel):
    def gen_tool_args(self, tool_def):
        if tool_def.name == "browser_click":
            return {"ref": current_click_ref}
        if tool_def.name == "browser_upload":
            return {"ref": current_upload_ref}
        if tool_def.name == "browser_fill":
            return {"ref": current_fill_ref, "value": current_fill_value}
        return super().gen_tool_args(tool_def)


async def run_browser_agent(ref, instruction, output, tool_name="browser_click"):
    global current_click_ref, current_fill_ref, current_upload_ref
    if tool_name == "browser_upload":
        current_upload_ref = ref
    elif tool_name == "browser_fill":
        current_fill_ref = ref
    else:
        current_click_ref = ref
    with agent.override(model=BrowserActionModel(
        call_tools=[tool_name], custom_output_text=output,
    )):
        with agent.override(tools=granted_tools):
            return await agent.run(instruction, deps=browser_agent)


agent_result = asyncio.run(run_browser_agent(
    increment_ref, "Use the browser to click Increment counter.",
    "The visible browser control was clicked.",
))
if agent_result.output != "The visible browser control was clicked.":
    raise AssertionError("The structured browser tool call did not finish through the production agent loop.")
after_agent_click = agent_runtime._browser_api(context, "snapshot")
if "Count: 2" not in after_agent_click["text"]:
    raise AssertionError("The structured agent browser tool did not mutate the user's visible page.")
select = next((item for item in after_agent_click["elements"] if item["name"] == "Plan period"), None)
if not select or {option["label"] for option in select.get("options", []) if not option["disabled"]} != {
        "Monthly plan", "Annual plan"}:
    raise AssertionError("The browser snapshot did not expose the enabled native select labels.")
asyncio.run(run_browser_agent(
    select["ref"], "Use the browser to choose Annual plan for Plan period.",
    "The requested plan option was selected.", tool_name="browser_fill",
))
after_select = agent_runtime._browser_api(context, "snapshot")
if "Plan: annual" not in after_select["text"]:
    raise AssertionError("The structured browser fill tool did not select the requested native option.")
selected_plan = next((item for item in after_select["elements"] if item["name"] == "Plan period"), None)
if not selected_plan or [option["label"] for option in selected_plan["options"] if option["selected"]] != ["Annual plan"]:
    raise AssertionError("The browser snapshot did not report the selected single-select option.")
multi_select = next((item for item in after_select["elements"] if item["name"] == "Features"), None)
if not multi_select or not multi_select.get("multiple") or {option["label"] for option in multi_select.get("options", []) if not option["disabled"]} != {
        "Advanced analytics", "Priority support", "Daily backups"}:
    raise AssertionError("The browser snapshot did not expose the multi-select state and its enabled options.")
current_fill_value = ["Advanced analytics", "Priority support"]
asyncio.run(run_browser_agent(
    multi_select["ref"], "Use the browser to choose Advanced analytics and Priority support for Features.",
    "The requested feature options were selected.", tool_name="browser_fill",
))
after_multi_select = agent_runtime._browser_api(context, "snapshot")
if "Features: analytics, support" not in after_multi_select["text"]:
    raise AssertionError("The structured browser fill tool did not select the requested multi-select options.")
selected_features = next((item for item in after_multi_select["elements"] if item["name"] == "Features"), None)
if not selected_features or {option["label"] for option in selected_features["options"] if option["selected"]} != {
        "Advanced analytics", "Priority support"}:
    raise AssertionError("The browser snapshot did not report the selected multi-select options.")

approval_verified = False
upload_verified = False
if (os.environ.get("TRIBE_BROWSER_E2E_INTERACTIVE") == "1"
        or os.environ.get("TRIBE_BROWSER_E2E_AUTO_UPLOAD") == "1"):
    if os.environ.get("TRIBE_BROWSER_E2E_SKIP_APPROVAL") != "1":
        first_approval_snapshot = agent_runtime._browser_api(context, "snapshot")
        delete_ref = next(
            (item["ref"] for item in first_approval_snapshot["elements"]
             if item["name"] == "Delete fixture record"),
            None,
        )
        if not delete_ref:
            raise AssertionError("The live approval fixture did not expose its delete action.")
        asyncio.run(run_browser_agent(
            delete_ref, "Use the browser to click Delete fixture record.",
            "The browser action request was cancelled.",
        ))
        after_cancel = agent_runtime._browser_api(context, "snapshot")
        if "Fixture record exists" not in after_cancel["text"]:
            raise AssertionError("Cancelling a native browser approval must leave the page unchanged.")
        delete_ref = next(
            (item["ref"] for item in after_cancel["elements"]
             if item["name"] == "Delete fixture record"),
            None,
        )
        asyncio.run(run_browser_agent(
            delete_ref, "Use the browser to click Delete fixture record.",
            "The browser action was approved and completed.",
        ))
        after_approval = agent_runtime._browser_api(context, "snapshot")
        if "Fixture record exists" in after_approval["text"]:
            raise AssertionError("Approving the exact browser action must let it affect only the fixture page.")
        approval_verified = True

    if os.environ.get("TRIBE_BROWSER_E2E_UPLOAD_PRECHECK_VERIFIED") == "1":
        upload_verified = True
    else:
        upload_snapshot = agent_runtime._browser_api(context, "snapshot")
        upload_ref = next(
            (item["ref"] for item in upload_snapshot["elements"]
             if item["name"] == "Choose test file" and item["type"] == "file"),
            None,
        )
        if not upload_ref:
            raise AssertionError("The upload fixture did not expose a current labelled file input.")
        upload_agent_result = asyncio.run(run_browser_agent(
            upload_ref,
            "Use the browser to upload the selected fixture file.",
            "The browser fixture file was selected.",
            tool_name="browser_upload",
        ))
        if upload_agent_result.output != "The browser fixture file was selected.":
            raise AssertionError("The structured browser_upload tool did not finish through the production agent loop.")
        upload_deadline = time.monotonic() + 35
        uploaded_snapshot = None
        while time.monotonic() < upload_deadline:
            uploaded_snapshot = agent_runtime._browser_api(context, "snapshot")
            if "Fixture upload received" in uploaded_snapshot["text"]:
                break
            time.sleep(0.2)
        if not uploaded_snapshot or "Fixture upload received" not in uploaded_snapshot["text"]:
            latest_text = uploaded_snapshot["text"] if uploaded_snapshot else "unavailable"
            upload_diagnostics = agent_runtime._browser_api(context, "diagnostics", {"limit": 50})
            raise AssertionError(
                "The approved fixture file did not reach the local upload endpoint. "
                f"Latest page snapshot: {latest_text}; "
                f"recent network diagnostics: {json.dumps(upload_diagnostics.get('network', [])[-12:])}"
            )
        upload_verified = True

print(json.dumps({
    "activeTabId": navigation["activeTabId"],
    "url": navigation["url"],
    "snapshotTitle": after["title"],
    "clickResult": click,
    "countUpdated": True,
    "storageOrigin": site_storage["origin"],
    "storageCategory": indexeddb["type"],
    "storageBytes": indexeddb["bytes"],
    "pageDiagnosticCount": len(diagnostics["page"]),
    "consoleDiagnosticCount": len(diagnostics["console"]),
    "structuredBrowserTool": "browser_click",
    "agentModelOutput": agent_result.output,
    "countAfterStructuredAgentClick": "Count: 2" in after_agent_click["text"],
    "nativeSelectOptions": select["options"],
    "nativeSelectFilledByLabel": "Plan: annual" in after_select["text"],
    "multiSelectOptions": multi_select["options"],
    "multiSelectFilledByLabels": "Features: analytics, support" in after_multi_select["text"],
    "selectedMultiSelectOptions": [option["label"] for option in selected_features["options"] if option["selected"]],
    "liveApprovalAndCancellation": approval_verified,
    "liveUploadConfirmation": upload_verified and os.environ.get("TRIBE_BROWSER_E2E_INTERACTIVE") == "1",
    "uploadTransferVerified": upload_verified,
}))
