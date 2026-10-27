"""FastMCP OAuth with Tribe's durable connection lease."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import aclosing
from time import time
from urllib.parse import parse_qs, urlencode

import httpx2
from fastmcp.client.auth.oauth import OAuth
from mcp.shared.auth import OAuthToken
from pydantic import ValidationError

from .oauth_lock import OAuthConnectionLease


class LeasedOAuth(OAuth):
    """Persisted FastMCP OAuth flow coordinated across Tribe workers/processes.

    FastMCP keeps auth state on an OAuth instance. Tribe creates instances for
    independent worker event loops, so the SDK's own lock cannot prevent two
    workers from consuming the same rotating refresh token. The lease covers
    each auth flow, including its response, and is released on cancellation.
    """

    def __init__(self, *args, lease: OAuthConnectionLease, allow_interactive: bool = False, **kwargs):
        self._tribe_lease = lease
        self._allow_interactive = allow_interactive
        super().__init__(*args, **kwargs)

    async def async_auth_flow(self, request) -> AsyncGenerator:
        lease_context = None

        if not self._allow_interactive:
            tokens = await self.token_storage_adapter.get_tokens()
            expiry = await self.token_storage_adapter.get_token_expiry()
            access_valid = bool(tokens and tokens.access_token and (expiry is None or expiry > time()))
            if not access_valid and not (tokens and tokens.refresh_token):
                raise OAuthSignInRequired("Sign in to this service from its connection settings.")

        async def acquire_lease() -> None:
            nonlocal lease_context
            if lease_context is None:
                lease_context = self._tribe_lease.hold()
                await lease_context.__aenter__()

        async def release_lease() -> None:
            nonlocal lease_context
            if lease_context is not None:
                held, lease_context = lease_context, None
                await held.__aexit__(None, None, None)

        async def reload_tokens():
            await self._initialize()
            return self.context.current_tokens

        def refresh_grant(candidate) -> str | None:
            if candidate.method != "POST":
                return None
            try:
                fields = parse_qs(candidate.content.decode("utf-8"))
            except (UnicodeDecodeError, AttributeError):
                return None
            if fields.get("grant_type") != ["refresh_token"]:
                return None
            return fields.get("refresh_token", [None])[0]

        def with_current_refresh_token(candidate, token: str):
            fields = parse_qs(candidate.content.decode("utf-8"))
            fields["refresh_token"] = [token]
            headers = dict(candidate.headers)
            headers.pop("content-length", None)
            return httpx2.Request(candidate.method, candidate.url, data=fields, headers=headers)

        async def current_token_response(candidate):
            tokens = await self.token_storage_adapter.get_tokens()
            expiry = await self.token_storage_adapter.get_token_expiry()
            if tokens is None:
                return None
            if expiry is not None:
                remaining = max(0, int(expiry - time()))
                if remaining == 0:
                    return None
                tokens = tokens.model_copy(update={"expires_in": remaining})
            self.context.current_tokens = tokens
            if expiry is not None:
                self.context.token_expiry_time = expiry
            else:
                self.context.update_token_expiry(tokens)
            if not tokens.access_token:
                return None
            return httpx2.Response(
                200,
                json=tokens.model_dump(exclude_none=True),
                request=candidate,
            )

        try:
            async with aclosing(super().async_auth_flow(request)) as flow:
                response = None
                while True:
                    try:
                        outgoing = await flow.asend(response)
                    except StopAsyncIteration:
                        break
                    response = None

                    requested_refresh_token = refresh_grant(outgoing)
                    if requested_refresh_token is not None:
                        # The SDK has already loaded the stored state. Take the lease before
                        # refresh, then re-read it so a peer's rotated token is never replayed.
                        await acquire_lease()
                        latest_tokens = await reload_tokens()
                        if latest_tokens and latest_tokens.refresh_token != requested_refresh_token:
                            cached_response = await current_token_response(outgoing)
                            if cached_response is not None:
                                response = cached_response
                                continue
                            if latest_tokens.refresh_token:
                                outgoing = with_current_refresh_token(outgoing, latest_tokens.refresh_token)
                            else:
                                response = httpx2.Response(
                                    400, json={"error": "invalid_grant"}, request=outgoing,
                                )
                                continue

                    if lease_context is not None and outgoing.url == request.url:
                        # Refresh or initial authorisation has persisted its credentials.
                        # Let normal MCP requests proceed concurrently using that token.
                        await release_lease()

                    response = yield outgoing
                    if requested_refresh_token is not None:
                        valid_refresh = response.status_code == 200
                        if valid_refresh:
                            try:
                                await response.aread()
                                OAuthToken.model_validate_json(response.content)
                            except (ValidationError, ValueError):
                                valid_refresh = False
                        if not valid_refresh:
                            await self.token_storage_adapter.clear()
                            if not self._allow_interactive:
                                raise OAuthSignInRequired("Sign in to this service again from its connection settings.")
                    if (lease_context is None and outgoing.url == request.url
                            and (response.status_code == 401
                                 or response.status_code == 403 and "insufficient_scope" in response.headers.get("www-authenticate", ""))):
                        await acquire_lease()
                        latest_tokens = await reload_tokens()
                        sent_token = outgoing.headers.get("authorization", "").removeprefix("Bearer ")
                        if (response.status_code == 401 and latest_tokens and latest_tokens.access_token
                                and latest_tokens.access_token != sent_token and self.context.is_token_valid()):
                            retry = httpx2.Request(outgoing.method, outgoing.url, headers=outgoing.headers,
                                                   content=outgoing.content)
                            retry.headers["Authorization"] = f"Bearer {latest_tokens.access_token}"
                            response = yield retry
                            if response.status_code < 400:
                                continue
                        if not self._allow_interactive:
                            await self.token_storage_adapter.clear()
                            raise OAuthSignInRequired("Sign in to this service again from its connection settings.")
        finally:
            await release_lease()


class OAuthSignInRequired(RuntimeError):
    """The user must re-authorise this service before agents can use it."""
