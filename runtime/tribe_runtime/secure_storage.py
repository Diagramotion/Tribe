"""Small OS-keyring-backed encryption boundary for resumable approvals."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
from pathlib import Path


_KEYRING_SERVICE = "Tribe secure storage"
_KEY_CACHE_LOCK = threading.Lock()
_KEY_CACHE: dict[str, bytes] = {}


class SecureStorageUnavailable(RuntimeError):
    """Raised when Tribe cannot protect durable approval state on this device."""


def _workspace_account(data_dir: str | Path) -> str:
    resolved = Path(data_dir).expanduser().resolve(strict=False)
    return hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()


def _workspace_key(account: str, *, create: bool) -> bytes | None:
    cached = _KEY_CACHE.get(account)
    if cached is not None:
        return cached
    try:
        import keyring

        with _KEY_CACHE_LOCK:
            cached = _KEY_CACHE.get(account)
            if cached is not None:
                return cached
            value = keyring.get_password(_KEYRING_SERVICE, account)
            if value is None:
                if not create:
                    return None
                value = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
                keyring.set_password(_KEYRING_SERVICE, account, value)
        key = base64.urlsafe_b64decode(value.encode("ascii"))
    except Exception as error:  # noqa: BLE001 - OS keyring backends expose provider-specific errors.
        raise SecureStorageUnavailable(
            "Tribe cannot access secure device storage to protect a pending approval."
        ) from error
    if len(key) != 32:
        raise SecureStorageUnavailable("Tribe's secure device key is invalid.")
    _KEY_CACHE[account] = key
    return key


def workspace_key(data_dir: str | Path, *, create: bool = True) -> bytes | None:
    return _workspace_key(_workspace_account(data_dir), create=create)


def action_fingerprint(
    data_dir: str | Path, tool_name: str, arguments: object, *, create_key: bool = True,
) -> str | None:
    import json

    payload = json.dumps(
        {"tool": tool_name, "arguments": arguments},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str,
    ).encode("utf-8")
    key = workspace_key(data_dir, create=create_key)
    if key is None:
        return None
    fingerprint_key = hmac.new(
        key, b"Tribe exact-action fingerprint v1", hashlib.sha256,
    ).digest()
    digest = hmac.new(fingerprint_key, payload, hashlib.sha256).hexdigest()
    safe_tool_name = "".join(char if char.isalnum() or char in "_.-" else "_" for char in tool_name)[:120]
    return f"tool_action_hmac:{safe_tool_name}:{digest}"


def encrypt_approval_history(data_dir: str | Path, interaction_id: str, value: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = secrets.token_bytes(12)
    associated_data = f"tribe:deferred-tool-history:v1:{interaction_id}".encode("utf-8")
    key = workspace_key(data_dir)
    if key is None:
        raise SecureStorageUnavailable("Tribe cannot create a secure device key for approval history.")
    ciphertext = AESGCM(key).encrypt(
        nonce, value.encode("utf-8"), associated_data,
    )
    return "v1:" + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def decrypt_approval_history(data_dir: str | Path, interaction_id: str, value: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not value.startswith("v1:"):
        return value
    payload = base64.urlsafe_b64decode(value[3:].encode("ascii"))
    nonce, ciphertext = payload[:12], payload[12:]
    associated_data = f"tribe:deferred-tool-history:v1:{interaction_id}".encode("utf-8")
    try:
        key = workspace_key(data_dir, create=False)
        if key is None:
            raise SecureStorageUnavailable("Tribe's secure device key is unavailable.")
        return AESGCM(key).decrypt(
            nonce, ciphertext, associated_data,
        ).decode("utf-8")
    except Exception as error:  # noqa: BLE001 - authentication failures must stop approval replay.
        raise SecureStorageUnavailable(
            "Tribe could not unlock the saved approval context; the action was not replayed."
        ) from error
