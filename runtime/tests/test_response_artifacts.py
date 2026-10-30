from __future__ import annotations

import unittest
from types import SimpleNamespace

from pydantic_ai.messages import BinaryImage, FilePart, ModelResponse, NativeToolReturnPart, ToolReturnPart

from tribe_runtime.agent_runtime import _persist_generated_images


class _ArtifactStore:
    def __init__(self) -> None:
        self.saved: list[dict[str, object]] = []

    def add_artifact(
        self, mission_id: str, name: str, media_type: str, created_by: str, content: bytes,
    ) -> tuple[dict[str, str], None]:
        artifact_id = f"image-{len(self.saved) + 1}"
        self.saved.append({
            "mission_id": mission_id,
            "name": name,
            "media_type": media_type,
            "created_by": created_by,
            "content": content,
        })
        return {"id": artifact_id}, None


class GeneratedImagePersistenceTests(unittest.TestCase):
    def test_direct_and_native_image_results_become_artifacts(self) -> None:
        parts = [
            ToolReturnPart(
                tool_name="generate_image",
                content=[BinaryImage(data=b"direct-png", media_type="image/png")],
            ),
            NativeToolReturnPart(
                tool_name="generate_image",
                tool_kind="image_generation",
                content=[BinaryImage(data=b"native-jpeg", media_type="image/jpeg")],
            ),
            ToolReturnPart(
                tool_name="search",
                content=[BinaryImage(data=b"unrelated", media_type="image/png")],
            ),
            NativeToolReturnPart(
                tool_name="browser_screenshot",
                tool_kind="browser_screenshot",
                content=[BinaryImage(data=b"unrelated-native", media_type="image/png")],
            ),
            ToolReturnPart(
                tool_name="generate_image",
                outcome="failed",
                content=[BinaryImage(data=b"failed", media_type="image/png")],
            ),
            ToolReturnPart(
                tool_name="generate_image",
                content=[BinaryImage(data=b"unsupported", media_type="image/gif")],
            ),
        ]
        result = SimpleNamespace(new_messages=lambda: [ModelResponse(parts=parts)])
        store = _ArtifactStore()

        artifact_ids = _persist_generated_images(store, "chat-1", "agent-1", result)

        self.assertEqual(artifact_ids, ("image-1", "image-2"))
        self.assertEqual([item["name"] for item in store.saved], [
            "Generated image 1.png", "Generated image 2.jpg",
        ])
        self.assertEqual([item["content"] for item in store.saved], [
            b"direct-png", b"native-jpeg",
        ])

    def test_native_response_images_become_artifacts(self) -> None:
        response = ModelResponse(parts=[FilePart(
            content=BinaryImage(data=b"response-webp", media_type="image/webp"),
        )])
        result = SimpleNamespace(new_messages=lambda: [response])
        store = _ArtifactStore()

        artifact_ids = _persist_generated_images(store, "chat-1", "agent-1", result)

        self.assertEqual(artifact_ids, ("image-1",))
        self.assertEqual(store.saved[0]["name"], "Generated image 1.webp")
        self.assertEqual(store.saved[0]["content"], b"response-webp")


if __name__ == "__main__":
    unittest.main()
