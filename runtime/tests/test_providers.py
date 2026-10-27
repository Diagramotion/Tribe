from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

from tribe_runtime.providers import list_ollama_models


class OllamaDiscoveryTests(unittest.TestCase):
    def test_lists_installed_models_in_stable_order(self) -> None:
        response = io.BytesIO(json.dumps({"models": [
            {"name": "zeta:latest", "size": 12, "modified_at": "today"},
            {"name": "Alpha:7b", "size": 0},
            {"name": "", "size": 4},
            "invalid",
        ]}).encode())
        with patch("tribe_runtime.providers.urlopen", return_value=response) as open_url:
            models = list_ollama_models()

        self.assertEqual([model["name"] for model in models], ["Alpha:7b", "zeta:latest"])
        self.assertEqual(models[1]["modifiedAt"], "today")
        self.assertEqual(open_url.call_args.args[0].full_url, "http://127.0.0.1:11434/api/tags")
        self.assertEqual(open_url.call_args.kwargs["timeout"], 2.0)

    def test_reports_unavailable_without_exposing_transport_details(self) -> None:
        with patch("tribe_runtime.providers.urlopen", side_effect=OSError("private host detail")):
            with self.assertRaisesRegex(RuntimeError, "^ollama_unavailable$"):
                list_ollama_models()

    def test_rejects_oversized_response(self) -> None:
        class LargeResponse(io.BytesIO):
            def read(self, amount: int = -1) -> bytes:
                return b"x" * amount

        with patch("tribe_runtime.providers.urlopen", return_value=LargeResponse(b"")):
            with self.assertRaisesRegex(RuntimeError, "^ollama_response_too_large$"):
                list_ollama_models()


if __name__ == "__main__":
    unittest.main()
