from __future__ import annotations

import io
import json
import unittest
from unittest.mock import Mock, patch

from tribe_runtime.providers import list_ollama_models


class OllamaDiscoveryTests(unittest.TestCase):
    def test_lists_installed_models_in_stable_order(self) -> None:
        response = io.BytesIO(json.dumps({"models": [
            {"name": "zeta:latest", "size": 12, "modified_at": "today"},
            {"name": "Alpha:7b", "size": 0},
            {"name": "", "size": 4},
            "invalid",
        ]}).encode())
        opener = Mock()
        opener.open.return_value = response
        with patch("tribe_runtime.providers.build_opener", return_value=opener):
            models = list_ollama_models()

        self.assertEqual([model["name"] for model in models], ["Alpha:7b", "zeta:latest"])
        self.assertEqual(models[1]["modifiedAt"], "today")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/api/tags")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 2.0)

    def test_reports_unavailable_without_exposing_transport_details(self) -> None:
        opener = Mock()
        opener.open.side_effect = OSError("private host detail")
        with patch("tribe_runtime.providers.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "^ollama_unavailable$"):
                list_ollama_models()

    def test_rejects_oversized_response(self) -> None:
        class LargeResponse(io.BytesIO):
            def read(self, amount: int = -1) -> bytes:
                return b"x" * amount

        opener = Mock()
        opener.open.return_value = LargeResponse(b"")
        with patch("tribe_runtime.providers.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "^ollama_response_too_large$"):
                list_ollama_models()


if __name__ == "__main__":
    unittest.main()
