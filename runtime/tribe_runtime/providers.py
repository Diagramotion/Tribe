"""Small provider discovery helpers for local runtimes."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .credentials import get_api_key, provider_for_model, validate_openai_base_url

OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
MAX_OLLAMA_RESPONSE_BYTES = 1_000_000
MAX_PROVIDER_MODELS_RESPONSE_BYTES = 2_000_000
PROVIDER_MODEL_ENDPOINTS = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com",
    "openrouter": "https://openrouter.ai/api/v1",
    "xai": "https://api.x.ai/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "together": "https://api.together.xyz/v1",
}


class _NoProviderRedirects(HTTPRedirectHandler):
    """Do not forward provider credentials to a redirected host."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def list_ollama_models(timeout: float = 2.0, base_url: str = "") -> list[dict[str, str | int]]:
    """Return installed model names from the configured Ollama service."""
    configured_url = base_url or os.environ.get("TRIBE_OLLAMA_BASE_URL") or os.environ.get("OLLAMA_BASE_URL") or ""
    endpoint = validate_openai_base_url(configured_url) if configured_url else OLLAMA_TAGS_URL
    if configured_url:
        root = endpoint[:-3] if endpoint.endswith("/v1") else endpoint
        endpoint = f"{root}/api/tags"
    request = Request(endpoint, headers={"Accept": "application/json"})
    try:
        opener = build_opener(_NoProviderRedirects)
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(MAX_OLLAMA_RESPONSE_BYTES + 1)
    except (OSError, URLError, TimeoutError) as error:
        raise RuntimeError("ollama_unavailable") from error
    if len(payload) > MAX_OLLAMA_RESPONSE_BYTES:
        raise RuntimeError("ollama_response_too_large")
    try:
        body = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("ollama_invalid_response") from error
    if not isinstance(body, dict) or not isinstance(body.get("models"), list):
        raise RuntimeError("ollama_invalid_response")

    models = []
    for item in body["models"]:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            continue
        size = item.get("size")
        models.append({
            "name": name.strip(),
            "size": size if isinstance(size, int) and size >= 0 else 0,
            "modifiedAt": item.get("modified_at") if isinstance(item.get("modified_at"), str) else "",
        })
    return sorted(models, key=lambda model: str(model["name"]).casefold())


def list_provider_models(
    provider: str, api_key: str = "", base_url: str = "", timeout: float = 8.0,
) -> list[dict[str, object]]:
    """Discover model IDs from Ollama or a provider's OpenAI-compatible catalogue."""
    provider = provider.strip().lower()
    provider_for_model(f"{provider}:catalog")
    if provider == "ollama":
        return [
            {
                "id": str(model["name"]), "name": str(model["name"]),
                "contextWindow": None, "maxOutputTokens": None,
                "inputModalities": None, "outputModalities": None,
                "toolCalling": None, "reasoningEfforts": None,
                "metadataSource": "ollama model list",
            }
            for model in list_ollama_models(timeout=min(timeout, 3.0), base_url=base_url)
        ]
    endpoint = validate_openai_base_url(base_url) if base_url else ""
    if not endpoint:
        endpoint = PROVIDER_MODEL_ENDPOINTS.get(provider, "")
    if not endpoint:
        raise RuntimeError("provider_model_discovery_unsupported")
    key = api_key.strip() or get_api_key(f"{provider}:catalog") or ""
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = Request(f"{endpoint.rstrip('/')}/models", headers=headers)
    try:
        opener = build_opener(_NoProviderRedirects)
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(MAX_PROVIDER_MODELS_RESPONSE_BYTES + 1)
    except HTTPError as error:
        if error.code in {401, 403}:
            raise RuntimeError("provider_models_unauthorized") from None
        if error.code == 404:
            raise RuntimeError("provider_model_discovery_unsupported") from None
        raise RuntimeError("provider_models_unavailable") from None
    except (OSError, URLError, TimeoutError) as error:
        raise RuntimeError("provider_models_unavailable") from error
    if len(payload) > MAX_PROVIDER_MODELS_RESPONSE_BYTES:
        raise RuntimeError("provider_models_response_too_large")
    try:
        body = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("provider_models_invalid_response") from error
    records = body.get("data") if isinstance(body, dict) else None
    if not isinstance(records, list):
        raise RuntimeError("provider_models_invalid_response")
    models: list[dict[str, object]] = []
    for item in records:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 500:
            continue
        architecture = (
            item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
        )
        context_window = item.get("context_window", item.get("context_length"))
        top_provider = item.get("top_provider")
        max_output = item.get("max_completion_tokens")
        if max_output is None and isinstance(top_provider, dict):
            max_output = top_provider.get("max_completion_tokens")
        input_modalities = architecture.get("input_modalities")
        output_modalities = architecture.get("output_modalities")
        supported_parameters = item.get("supported_parameters")
        tool_calling = (
            True if isinstance(supported_parameters, list) and "tools" in supported_parameters
            else None
        )
        models.append({
            "id": model_id.strip(), "name": str(item.get("name") or model_id).strip(),
            "contextWindow": (
                context_window if isinstance(context_window, int)
                and not isinstance(context_window, bool) and context_window > 0 else None
            ),
            "maxOutputTokens": (
                max_output if isinstance(max_output, int)
                and not isinstance(max_output, bool) and max_output > 0 else None
            ),
            "inputModalities": input_modalities if isinstance(input_modalities, list) else None,
            "outputModalities": output_modalities if isinstance(output_modalities, list) else None,
            "toolCalling": tool_calling,
            "reasoningEfforts": None,
            "metadataSource": "provider catalogue",
        })
    return sorted(models, key=lambda model: str(model["name"]).casefold())
