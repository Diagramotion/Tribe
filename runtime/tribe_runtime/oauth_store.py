"""Keychain-backed AsyncKeyValue storage for FastMCP OAuth credentials."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from typing import Any, SupportsFloat

_KEYRING_SERVICE = "Tribe MCP OAuth"


class OAuthKeyringStore:
    """Persist FastMCP token records in the OS credential store, scoped to a connection."""

    def __init__(
        self, project_id: str, server_name: str, *, workspace_id: str = "default", clock=time.time,
        fallback: "OAuthKeyringStore | None" = None,
    ) -> None:
        if not project_id or not server_name:
            raise ValueError("project_and_server_required")
        self._project_id = project_id
        self._server_name = server_name
        self._workspace_id = hashlib.sha256(workspace_id.encode("utf-8")).hexdigest()[:24]
        self._clock = clock
        self._fallback = fallback

    def _account(self, key: str, collection: str | None) -> str:
        collection_key = f"{collection or 'default'}\0{key}".encode("utf-8")
        digest = hashlib.sha256(collection_key).hexdigest()
        return f"{self._workspace_id}:{self._project_id}:{self._server_name}:{digest}"

    @staticmethod
    def _keyring():
        import keyring

        return keyring

    def _read_sync(self, key: str, collection: str | None) -> tuple[dict[str, Any] | None, float | None]:
        keyring = self._keyring()
        account = self._account(key, collection)
        try:
            raw = keyring.get_password(_KEYRING_SERVICE, account)
        except keyring.errors.KeyringError as error:
            raise RuntimeError("OS credential storage is unavailable") from error
        if raw is None:
            return None, None
        try:
            envelope = json.loads(raw)
            value = envelope["value"]
            expires_at = envelope.get("expiresAt")
            if not isinstance(value, dict) or (
                expires_at is not None and not isinstance(expires_at, (int, float))
            ):
                raise ValueError("invalid_record")
        except (TypeError, ValueError, KeyError, json.JSONDecodeError) as error:
            raise RuntimeError("OAuth credentials could not be read from the OS credential store") from error
        if expires_at is not None and expires_at <= self._clock():
            self._delete_sync(key, collection)
            return None, None
        return value, expires_at

    def _delete_sync(self, key: str, collection: str | None) -> bool:
        keyring = self._keyring()
        try:
            keyring.delete_password(_KEYRING_SERVICE, self._account(key, collection))
            return True
        except keyring.errors.PasswordDeleteError:
            return False
        except keyring.errors.KeyringError as error:
            raise RuntimeError("OS credential storage is unavailable") from error

    def _put_sync(
        self,
        key: str,
        value: Mapping[str, Any],
        collection: str | None,
        ttl: SupportsFloat | None,
    ) -> None:
        expires_at = None if ttl is None else self._clock() + float(ttl)
        envelope = json.dumps({"value": dict(value), "expiresAt": expires_at}, separators=(",", ":"))
        keyring = self._keyring()
        try:
            keyring.set_password(_KEYRING_SERVICE, self._account(key, collection), envelope)
        except keyring.errors.KeyringError as error:
            raise RuntimeError("OS credential storage is unavailable") from error

    async def get(self, key: str, *, collection: str | None = None) -> dict[str, Any] | None:
        value, _ = await asyncio.to_thread(self._read_sync, key, collection)
        if value is None and self._fallback is not None:
            value, remaining = await self._fallback._read_with_ttl(key, collection)
            if value is not None:
                await self.put(key, value, collection=collection, ttl=remaining)
                await self._fallback.delete(key, collection=collection)
        return value

    async def _read_with_ttl(
        self, key: str, collection: str | None,
    ) -> tuple[dict[str, Any] | None, float | None]:
        value, expires_at = await asyncio.to_thread(self._read_sync, key, collection)
        remaining = None if expires_at is None else max(0.0, expires_at - self._clock())
        return value, remaining

    async def ttl(
        self, key: str, *, collection: str | None = None
    ) -> tuple[dict[str, Any] | None, float | None]:
        value, expires_at = await asyncio.to_thread(self._read_sync, key, collection)
        if value is None and self._fallback is not None:
            value, remaining = await self._fallback._read_with_ttl(key, collection)
            if value is not None:
                await self.put(key, value, collection=collection, ttl=remaining)
                await self._fallback.delete(key, collection=collection)
                return value, remaining
        return value, None if expires_at is None else max(0.0, expires_at - self._clock())

    async def put(
        self,
        key: str,
        value: Mapping[str, Any],
        *,
        collection: str | None = None,
        ttl: SupportsFloat | None = None,
    ) -> None:
        if not isinstance(value, Mapping):
            raise ValueError("oauth_storage_value_must_be_an_object")
        if ttl is not None and float(ttl) <= 0:
            await self.delete(key, collection=collection)
            return
        await asyncio.to_thread(self._put_sync, key, value, collection, ttl)

    async def delete(self, key: str, *, collection: str | None = None) -> bool:
        return await asyncio.to_thread(self._delete_sync, key, collection)

    async def get_many(
        self, keys: Sequence[str], *, collection: str | None = None
    ) -> list[dict[str, Any] | None]:
        return [await self.get(key, collection=collection) for key in keys]

    async def ttl_many(
        self, keys: Sequence[str], *, collection: str | None = None
    ) -> list[tuple[dict[str, Any] | None, float | None]]:
        return [await self.ttl(key, collection=collection) for key in keys]

    async def put_many(
        self,
        keys: Sequence[str],
        values: Sequence[Mapping[str, Any]],
        *,
        collection: str | None = None,
        ttl: SupportsFloat | None = None,
    ) -> None:
        if len(keys) != len(values):
            raise ValueError("oauth_storage_keys_and_values_must_match")
        for key, value in zip(keys, values, strict=True):
            await self.put(key, value, collection=collection, ttl=ttl)

    async def delete_many(self, keys: Sequence[str], *, collection: str | None = None) -> int:
        deleted = 0
        for key in keys:
            deleted += await self.delete(key, collection=collection)
        return deleted
