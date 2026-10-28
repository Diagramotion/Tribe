from __future__ import annotations

import asyncio
import subprocess
from types import SimpleNamespace

from pydantic_ai import Agent
from pydantic_ai.capabilities import Hooks
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestContext, ModelRequestParameters
from pydantic_ai.models.test import TestModel

from tribe_runtime.context_pruning import ContextPruning
from tribe_runtime.store import MissionStore


def _call(name: str, args: dict, call_id: str) -> ModelResponse:
    return ModelResponse(parts=[ToolCallPart(tool_name=name, args=args, tool_call_id=call_id)])


def _result(name: str, content: str, call_id: str) -> ModelRequest:
    return ModelRequest(parts=[ToolReturnPart(tool_name=name, content=content, tool_call_id=call_id)])


def _run(messages):
    deps = SimpleNamespace(context_pruning_metrics={})
    ctx = SimpleNamespace(deps=deps)
    request = ModelRequestContext(
        model=TestModel(), messages=messages, model_settings=None,
        model_request_parameters=ModelRequestParameters(),
    )
    result = asyncio.run(ContextPruning().before_model_request(ctx, request))
    return result.messages, deps.context_pruning_metrics


def _result_text(messages, call_id: str) -> str:
    return next(part.content for message in messages for part in message.parts
                if isinstance(part, ToolReturnPart) and part.tool_call_id == call_id)


def test_file_read_edit_read_prunes_only_outbound_stale_result():
    history = [
        _call("read_repository_file", {"path": "src/app.py"}, "r1"),
        _result("read_repository_file", "old contents" * 20, "r1"),
        _call("write_repository_file", {"path": "src/app.py", "content": "new"}, "w1"),
        _result("write_repository_file", "updated", "w1"),
        _call("read_repository_file", {"path": "src/app.py"}, "r2"),
        _result("read_repository_file", "new contents", "r2"),
    ]
    outbound, metrics = _run(history)
    assert _result_text(outbound, "r1").startswith("[Earlier tool output omitted")
    assert _result_text(outbound, "r2") == "new contents"
    assert _result_text(history, "r1").startswith("old contents")
    assert metrics["results"] == 1
    assert metrics["estimated_tokens"] > 0


def test_duplicate_read_only_commands_are_pruned_but_tests_are_not():
    history = [
        _call("run_command", {"command": "rg TODO src"}, "c1"),
        _result("run_command", "first search output" * 10, "c1"),
        _call("run_command", {"command": "rg TODO src"}, "c2"),
        _result("run_command", "latest search output", "c2"),
        _call("run_command", {"command": "npm test"}, "t1"),
        _result("run_command", "test run one", "t1"),
        _call("run_command", {"command": "npm test"}, "t2"),
        _result("run_command", "test run two", "t2"),
    ]
    outbound, metrics = _run(history)
    assert _result_text(outbound, "c1").startswith("[Earlier tool output omitted")
    assert _result_text(outbound, "c2") == "latest search output"
    assert _result_text(outbound, "t1") == "test run one"
    assert _result_text(outbound, "t2") == "test run two"
    assert metrics["results"] == 1


def test_unresolved_approval_and_distinct_files_are_preserved():
    history = [
        _call("read_file", {"path": "one.txt"}, "one"),
        _result("read_file", "one contents", "one"),
        _call("read_file", {"path": "two.txt"}, "two"),
        _result("read_file", "two contents", "two"),
        _call("write_file", {"path": "three.txt", "content": "x"}, "pending"),
    ]
    outbound, metrics = _run(history)
    assert _result_text(outbound, "one") == "one contents"
    assert _result_text(outbound, "two") == "two contents"
    assert not any(isinstance(part, ToolReturnPart) and part.tool_call_id == "pending"
                   for message in outbound for part in message.parts)
    assert metrics["results"] == 0


def test_mutating_command_breaks_duplicate_command_window():
    history = [
        _call("run_command", {"command": "ls src"}, "a"),
        _result("run_command", "before edit", "a"),
        _call("write_file", {"path": "src/new.py", "content": "x"}, "w"),
        _result("write_file", "written", "w"),
        _call("run_command", {"command": "ls src"}, "b"),
        _result("run_command", "after edit", "b"),
    ]
    outbound, metrics = _run(history)
    assert _result_text(outbound, "a") == "before edit"
    assert _result_text(outbound, "b") == "after edit"
    assert metrics["results"] == 0


def test_live_agent_hook_changes_request_projection_not_saved_history_or_answer():
    history = [
        ModelRequest(parts=[UserPromptPart(content="Read this file")]),
        _call("read_file", {"path": "README.md"}, "read-1"),
        _result("read_file", "old README contents" * 20, "read-1"),
        _call("read_file", {"path": "README.md"}, "read-2"),
        _result("read_file", "current README", "read-2"),
    ]
    seen_by_model = []
    pruning = ContextPruning()

    async def before_request(ctx, request_context):
        updated = await pruning.before_model_request(ctx, request_context)
        seen_by_model.append(_result_text(updated.messages, "read-1"))
        return updated

    baseline = Agent(TestModel(custom_output_text="same answer"))
    baseline_result = baseline.run_sync("Summarise the current README", message_history=history)
    agent = Agent(
        TestModel(custom_output_text="same answer"),
        deps_type=SimpleNamespace,
        capabilities=[Hooks(before_model_request=before_request)],
    )
    result = agent.run_sync(
        "Summarise the current README", deps=SimpleNamespace(context_pruning_metrics={}), message_history=history,
    )
    assert result.output == "same answer"
    assert seen_by_model == ["[Earlier tool output omitted; newer output is available.]"]
    assert _result_text(history, "read-1").startswith("old README contents")
    assert _result_text(result.all_messages(), "read-1").startswith("old README contents")
    assert result.output == baseline_result.output
    assert result.usage.input_tokens < baseline_result.usage.input_tokens


def test_request_usage_keeps_on_off_comparison_and_provider_token_totals(tmp_path):
    repository = tmp_path / "repository"
    repository.mkdir()
    subprocess.run(["git", "init", "--quiet", str(repository)], check=True)
    store = MissionStore(tmp_path / "tribe.sqlite3")
    project, mission = store.create_project(str(repository), "Context test", "Measure", "Measure context")
    del project
    event = store.append("user.message", "user", mission["id"], {"text": "Measure context"})
    store.begin_agent_event("builder", mission["id"], event["sequence"])
    store.record_agent_request_usage(
        "builder", mission["id"], event["sequence"], "experiment-on", "test:model",
        {"input_tokens": 31, "output_tokens": 8}, context_message_count=3,
        pruning_metrics=(2, 12, True),
    )
    summary = store.context_pruning_summary()
    assert summary["enabled"] == {
        "requests": 1, "input_tokens": 31, "output_tokens": 8,
        "pruned_results": 2, "estimated_tokens_removed": 12,
    }
