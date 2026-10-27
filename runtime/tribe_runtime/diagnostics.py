"""Offline diagnostics that can run inside packaged sidecars."""

from __future__ import annotations

import os
from unittest.mock import patch

from .agent_runtime import _build_agent
from .agents import AgentDefinition
from .credentials import PROVIDERS

_MODEL_NAMES = {
    "openrouter": "openai/tribe-smoke-model",
    "fireworks": "accounts/fireworks/models/tribe-smoke-model",
    "ollama": "qwen3",
}


def check_provider_construction() -> list[str]:
    """Construct every configured PydanticAI provider without network or keychain access."""
    definition = AgentDefinition("provider_smoke", "Provider smoke", "Provider check", "", "")
    constructed = []
    for provider in PROVIDERS:
        model = f"{provider}:{_MODEL_NAMES.get(provider, 'tribe-smoke-model')}"
        api_key = "tribe-smoke-key"
        # Provider construction is offline; Ollama still needs its endpoint even
        # though this smoke check never makes a request.
        base_url = "http://127.0.0.1:11434/v1" if provider == "ollama" else ""
        _build_agent(definition, model, api_key, base_url)
        constructed.append(provider)
    with patch.dict(os.environ, {
        "AZURE_OPENAI_ENDPOINT": "https://tribe-smoke.openai.azure.com",
        "AZURE_OPENAI_API_KEY": "tribe-smoke-key",
        "OPENAI_API_VERSION": "2024-10-21",
    }):
        _build_agent(definition, "azure:tribe-smoke-deployment", "tribe-smoke-key")
    constructed.append("azure")
    return constructed
