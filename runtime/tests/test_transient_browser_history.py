from dataclasses import dataclass

from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart

from tribe_runtime.transient_media import TransientMediaStepStore, sanitized_browser_messages


@dataclass
class _Snapshot:
    messages: list


class _Store:
    saved = None

    async def save_snapshot(self, snapshot):
        self.saved = snapshot


def test_browser_messages_are_redacted_in_saved_copy_but_live_history_is_untouched():
    live = [
        ModelRequest(parts=[TextPart("inspect this")]),
        ModelResponse(parts=[ToolCallPart("browser_fill", {"selector": "Email", "value": "private@example.com"}, "call_1")]),
        ModelRequest(parts=[ToolReturnPart("browser_snapshot", "private page text", "call_2")]),
    ]
    safe = sanitized_browser_messages(live)
    assert "private@example.com" in str(live)
    assert "private@example.com" not in str(safe)
    assert "private page text" not in str(safe)
    assert "private page text" in str(live)


def test_step_store_persists_redacted_browser_calls_and_ephemeral_results():
    import asyncio

    live = [
        ModelResponse(parts=[ToolCallPart("browser_fill", {"value": "secret"}, "call_1")]),
        ModelRequest(parts=[ToolReturnPart("browser_open", {"title": "private page title"}, "call_1")]),
        ModelRequest(parts=[ToolReturnPart("browser_snapshot", "private page text", "call_2")]),
    ]
    store = _Store()
    wrapper = TransientMediaStepStore(store, transient_tool_names={"browser_snapshot", "browser_open"})
    asyncio.run(wrapper.save_snapshot(_Snapshot(live)))
    persisted = str(store.saved.messages)
    assert "secret" not in persisted
    assert "private page text" not in persisted
    assert "private page title" not in persisted
    assert "secret" in str(live)
