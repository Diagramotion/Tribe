from __future__ import annotations

import asyncio
import threading
import unittest
from types import SimpleNamespace

from pydantic_ai.messages import BinaryContent, ModelMessagesTypeAdapter, ModelRequest, ToolReturnPart
from pydantic_ai_harness.step_persistence import ContinuableSnapshot

from tribe_runtime.computer_use import (
    ComputerObservationBroker, MAX_IMAGE_BYTES, MAX_PENDING_REQUESTS,
)
from tribe_runtime.agents import AgentDefinition
from tribe_runtime.agent_runtime import _build_agent
from tribe_runtime.transient_media import TransientMediaStepStore


class ComputerObservationBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.broker = ComputerObservationBroker()

    def tearDown(self) -> None:
        self.broker.close()

    def test_response_is_bound_to_request_and_consumed_once(self) -> None:
        request = self.broker.create("mission-a", "reviewer", purpose="Inspect the rendered settings page")
        pending = self.broker.pending()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["id"], request["id"])
        self.assertEqual(pending[0]["purpose"], "Inspect the rendered settings page")
        self.assertNotEqual(pending[0]["completionToken"], request["id"])
        claimed = self.broker.claim(request["id"], pending[0]["completionToken"])
        self.assertEqual(self.broker.pending(), [])

        self.broker.complete(
            request["id"], claimed["completionToken"],
            application="Editor", window_title="Draft",
            accessibility_text="Document body", image=b"png-bytes",
        )
        observation = self.broker.wait(request["id"], timeout=0)

        self.assertEqual(observation["missionId"], "mission-a")
        self.assertEqual(observation["agentId"], "reviewer")
        self.assertEqual(observation["image"], b"png-bytes")
        self.assertEqual(self.broker.pending(), [])
        with self.assertRaisesRegex(ValueError, "not_pending"):
            self.broker.complete(
                request["id"], pending[0]["completionToken"],
                application="Editor", window_title="Draft",
                accessibility_text="", image=b"png-bytes",
            )

    def test_invalid_capability_does_not_complete_request(self) -> None:
        request = self.broker.create("mission-a", "builder")
        with self.assertRaisesRegex(ValueError, "token_invalid"):
            self.broker.claim(request["id"], "wrong-token")
        self.assertIsNone(self.broker.wait(request["id"], timeout=0))

    def test_response_validation_rejects_wrong_type_and_oversized_observations(self) -> None:
        request = self.broker.create("mission-a", "builder")
        token = self.broker.pending()[0]["completionToken"]
        self.broker.claim(request["id"], token)
        with self.assertRaisesRegex(ValueError, "must_be_png"):
            self.broker.complete(
                request["id"], token, application="Editor", window_title="Draft",
                accessibility_text="", image=b"png-bytes", content_type="text/plain",
            )
        with self.assertRaisesRegex(ValueError, "outline_too_large"):
            self.broker.complete(
                request["id"], token, application="Editor", window_title="Draft",
                accessibility_text="x" * 20_001, image=b"png-bytes",
            )
        with self.assertRaisesRegex(ValueError, "image_must_be"):
            self.broker.complete(
                request["id"], token, application="Editor", window_title="Draft",
                accessibility_text="", image=b"x" * (MAX_IMAGE_BYTES + 1),
            )
        self.assertEqual(self.broker.pending(), [])

    def test_mission_cancellation_cannot_cancel_another_missions_request(self) -> None:
        request = self.broker.create("mission-a", "builder")
        self.assertFalse(self.broker.cancel(request["id"], "mission-b"))
        self.assertEqual(self.broker.cancel_mission("mission-b"), 0)
        self.assertEqual(len(self.broker.pending()), 1)
        self.broker.claim(request["id"], self.broker.pending()[0]["completionToken"])
        self.assertEqual(self.broker.cancel_mission("mission-a"), 1)
        self.assertIsNone(self.broker.wait(request["id"], timeout=0))

    def test_discarding_claimed_observation_wakes_agent_without_sharing_image(self) -> None:
        request = self.broker.create("mission-a", "reviewer")
        token = self.broker.pending()[0]["completionToken"]
        self.broker.claim(request["id"], token)
        result: list[dict | None] = []
        waiter = threading.Thread(target=lambda: result.append(self.broker.wait(request["id"])))
        waiter.start()
        waiter.join(timeout=0.02)
        self.assertTrue(waiter.is_alive(), "the agent should remain waiting while the user reviews the frame")

        self.assertTrue(self.broker.cancel(request["id"], "mission-a"))
        waiter.join(timeout=1)

        self.assertFalse(waiter.is_alive())
        self.assertEqual(result, [None])
        self.assertEqual(self.broker.pending(), [])

    def test_mission_pause_purges_completed_observation_not_yet_consumed(self) -> None:
        request = self.broker.create("mission-a", "reviewer")
        token = self.broker.pending()[0]["completionToken"]
        self.broker.claim(request["id"], token)
        self.broker.complete(
            request["id"], token, application="Editor", window_title="Draft",
            accessibility_text="Private text", image=b"private-image",
        )

        self.assertEqual(self.broker.cancel_mission("mission-a"), 1)
        self.assertIsNone(self.broker.wait(request["id"], timeout=0))

    def test_native_client_can_cancel_completed_observation_before_agent_consumes_it(self) -> None:
        request = self.broker.create("mission-a", "reviewer")
        token = self.broker.pending()[0]["completionToken"]
        self.broker.claim(request["id"], token)
        self.broker.complete(
            request["id"], token, application="Editor", window_title="Draft",
            accessibility_text="Private text", image=b"private-image",
        )

        context = self.broker.context(request["id"], token)

        self.assertEqual(context["missionId"], "mission-a")
        self.assertTrue(self.broker.cancel(request["id"], context["missionId"]))
        self.assertIsNone(self.broker.wait(request["id"], timeout=0))

    def test_expired_request_is_not_returned_to_native_client(self) -> None:
        clock = [100.0]
        broker = ComputerObservationBroker(clock=lambda: clock[0])
        request = broker.create("mission-a", "reviewer", ttl_seconds=2)
        clock[0] = 103.0

        self.assertEqual(broker.pending(), [])
        self.assertIsNone(broker.wait(request["id"], timeout=0))
        broker.close()

    def test_unconsumed_completed_observation_is_purged_at_expiry(self) -> None:
        clock = [100.0]
        broker = ComputerObservationBroker(clock=lambda: clock[0])
        request = broker.create("mission-a", "reviewer", ttl_seconds=2)
        token = broker.pending()[0]["completionToken"]
        broker.claim(request["id"], token)
        broker.complete(
            request["id"], token, application="Editor", window_title="Draft",
            accessibility_text="Private text", image=b"private-image",
        )
        clock[0] = 103.0

        self.assertIsNone(broker.wait(request["id"], timeout=0))
        self.assertEqual(broker.pending(), [])
        broker.close()

    def test_close_wakes_waiting_agent_without_an_observation(self) -> None:
        request = self.broker.create("mission-a", "reviewer")
        self.broker.claim(request["id"], self.broker.pending()[0]["completionToken"])
        result: list[dict | None] = []
        waiter = threading.Thread(target=lambda: result.append(self.broker.wait(request["id"])))
        waiter.start()
        self.broker.close()
        waiter.join(timeout=1)

        self.assertFalse(waiter.is_alive())
        self.assertEqual(result, [None])

    def test_waiter_remains_blocked_after_desktop_claim_until_observation_arrives(self) -> None:
        request = self.broker.create("mission-a", "reviewer")
        token = self.broker.pending()[0]["completionToken"]
        claimed = self.broker.claim(request["id"], token)
        result: list[dict | None] = []
        waiter = threading.Thread(target=lambda: result.append(self.broker.wait(request["id"])))
        waiter.start()
        waiter.join(timeout=0.02)
        self.assertTrue(waiter.is_alive(), "a claimed request must keep waiting for native completion")

        self.broker.complete(
            request["id"], claimed["completionToken"], application="Editor",
            window_title="Draft", accessibility_text="Text", image=b"png",
        )
        waiter.join(timeout=1)
        self.assertFalse(waiter.is_alive())
        self.assertEqual(result[0]["image"], b"png")

    def test_short_wait_timeout_keeps_request_available_for_later_capture(self) -> None:
        request = self.broker.create("mission-a", "reviewer")

        self.assertIsNone(self.broker.wait(request["id"], timeout=0))
        self.assertTrue(self.broker.is_live(request["id"]))
        token = self.broker.pending()[0]["completionToken"]
        self.broker.claim(request["id"], token)
        self.broker.complete(
            request["id"], token, application="Editor", window_title="Draft",
            accessibility_text="", image=b"png",
        )
        self.assertEqual(self.broker.wait(request["id"], timeout=0)["image"], b"png")

    def test_pending_request_capacity_is_bounded(self) -> None:
        for index in range(MAX_PENDING_REQUESTS):
            self.broker.create(f"mission-{index}", "reviewer")
        with self.assertRaisesRegex(ValueError, "too_many_pending"):
            self.broker.create("mission-overflow", "reviewer")


class TransientMediaPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_computer_observation_is_redacted_only_from_saved_snapshot(self) -> None:
        class CapturingStore:
            snapshot = None

            async def save_snapshot(self, snapshot):
                self.snapshot = snapshot

        store = CapturingStore()
        image = BinaryContent(data=b"private-pixels", media_type="image/png")
        original = ContinuableSnapshot(
            run_id="run-1", step_index=1,
            messages=[ModelRequest(parts=[ToolReturnPart(
                "computer_observe", ["Private accessibility text", image], tool_call_id="call-1",
            )])],
        )
        wrapper = TransientMediaStepStore(store, transient_tool_names={"computer_observe"})

        await wrapper.save_snapshot(original)

        original_content = original.messages[0].parts[0].content
        saved_content = store.snapshot.messages[0].parts[0].content
        self.assertIsInstance(original_content[1], BinaryContent)
        self.assertIn("Private accessibility text", original_content)
        self.assertIsInstance(saved_content, str)
        self.assertIn("fresh observation", saved_content)
        saved_json = ModelMessagesTypeAdapter.dump_json(store.snapshot.messages)
        self.assertNotIn(b"private-pixels", saved_json)
        self.assertNotIn(b"Private accessibility text", saved_json)


class ComputerObservationToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_tool_returns_selected_frame_to_only_the_live_step(self) -> None:
        definition = AgentDefinition("reviewer", "Reviewer", "Review", "Review changes", "reviewer.md")
        agent = _build_agent(definition, "openai:gpt-4o-mini", "test-key")
        tool = agent._function_toolset.tools["computer_observe"]
        broker = ComputerObservationBroker()
        store = SimpleNamespace(events=[])
        store.append = lambda *args: store.events.append(args)
        ctx = SimpleNamespace(deps=SimpleNamespace(
            computer_access_enabled=True, computer_observations=broker,
            mission_id="mission-a", store=store, active_work_item_id="task-a",
            cancellation_token=None,
        ))

        try:
            run = asyncio.create_task(tool.function(ctx, purpose="Inspect the rendered error"))
            while not broker.pending():
                await asyncio.sleep(0.01)
            request = broker.pending()[0]
            broker.claim(request["id"], request["completionToken"])
            broker.complete(
                request["id"], request["completionToken"], application="Selected window",
                window_title="Error dialog", accessibility_text="", image=b"private-pixels",
            )

            result = await run

            self.assertEqual(store.events[0][0], "computer.observation.requested")
            self.assertEqual(result.return_value[0].splitlines()[1], "Selected window: Error dialog")
            self.assertIsInstance(result.return_value[1], BinaryContent)
            self.assertEqual(result.return_value[1].data, b"private-pixels")
        finally:
            broker.close()


if __name__ == "__main__":
    unittest.main()
