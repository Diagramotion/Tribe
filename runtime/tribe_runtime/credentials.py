"""Provider key access through OS credential storage, with environment fallback."""

from __future__ import annotations

import ipaddress
import inspect
import os
from urllib.parse import urlsplit

SERVICE_NAME = "Tribe"
PROVIDERS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "xai": "XAI_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "cohere": "CO_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "together": "TOGETHER_API_KEY",
    "ollama": "OLLAMA_API_KEY",
}
_SECRET_ENV_MARKERS = ("API_KEY", "API_TOKEN", "_TOKEN", "SECRET", "PASSWORD", "ACCESS_KEY")


def provider_for_model(model: str) -> str:
    provider = model.partition(":")[0].strip().lower()
    if not provider:
        raise ValueError("Use a Pydantic AI model identifier in provider:model format")
    if provider == "openai-codex":
        raise ValueError("Coding-agent harness subscriptions are not supported as model providers; configure a provider API instead")
    if provider not in PROVIDERS:
        try:
            from pydantic_ai.providers import infer_provider_class

            infer_provider_class(provider)
        except ImportError as error:
            raise ValueError(
                f"Provider '{provider}' is not available in the installed AI runtime"
            ) from error
        except ValueError as error:
            raise ValueError(
                f"Unsupported provider '{provider}'. Use a provider:model identifier supported by Pydantic AI"
            ) from error
    return provider


def provider_supports_custom_url(provider: str) -> bool:
    if provider.startswith("gateway/"):
        return True
    from pydantic_ai.providers import infer_provider_class

    parameters = inspect.signature(infer_provider_class(provider)).parameters
    return "base_url" in parameters or "api_base" in parameters


def validate_openai_base_url(value: str | None) -> str:
    """Validate an OpenAI-compatible endpoint without allowing credential-bearing URLs."""
    url = (value or "").strip()
    if not url:
        return ""
    if len(url) > 2048:
        raise ValueError("Endpoint URL must be 2048 characters or fewer")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        # Accessing port validates malformed port syntax.
        _ = parsed.port
    except ValueError as error:
        raise ValueError("Enter a valid endpoint URL") from error
    if not hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Endpoint URL must not contain credentials, a query string or a fragment")
    if parsed.scheme == "https":
        return url.rstrip("/")
    if parsed.scheme != "http":
        raise ValueError("Endpoint URL must use HTTPS, or HTTP for localhost only")
    try:
        is_loopback = hostname.lower() == "localhost" or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        is_loopback = hostname.lower() == "localhost"
    if not is_loopback:
        raise ValueError("Remote endpoint URLs must use HTTPS")
    return url.rstrip("/")


def get_api_key(model: str) -> str | None:
    provider = provider_for_model(model)
    env_name = PROVIDERS.get(provider)
    env_key = os.environ.get(env_name) if env_name else None
    if env_key:
        return env_key
    if provider == "ollama":
        return "api-key-not-set"
    try:
        import keyring

        return keyring.get_password(SERVICE_NAME, provider)
    except Exception:  # noqa: BLE001 - OS keyring backends expose provider-specific exceptions.
        return None


def redact_secret_values(message: str, *explicit_secrets: str | None) -> str:
    """Remove credential values from provider errors before they enter UI or event history."""
    secrets = {secret for secret in explicit_secrets if isinstance(secret, str) and secret}
    for name, value in os.environ.items():
        if (isinstance(value, str) and value
                and any(marker in name.upper() for marker in _SECRET_ENV_MARKERS)):
            secrets.add(value)
    redacted = message
    for secret in sorted(secrets, key=len, reverse=True):
        redacted = redacted.replace(secret, "[redacted]")
    return redacted


def save_api_key(model: str, api_key: str) -> None:
    provider = provider_for_model(model)
    if not api_key.strip():
        return
    try:
        import keyring

        keyring.set_password(SERVICE_NAME, provider, api_key.strip())
    except ImportError as error:
        raise RuntimeError(
            "Install keyring to save provider credentials in the OS keychain"
        ) from error
    except Exception as error:
        raise RuntimeError("The OS credential store rejected the provider key") from error


