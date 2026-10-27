from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import time
from unittest.mock import patch

import httpx2
from fastmcp.client.auth.oauth import OAuth
from key_value.aio.stores.memory import MemoryStore
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from tribe_runtime.oauth_auth import LeasedOAuth
from tribe_runtime.oauth_lock import OAuthConnectionLease


class LeasedOAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_authorization_pkce_persists_tokens_and_timeout_fails_closed(self) -> None:
        state = {
            "code_challenge": None, "redirect_uri": None, "access_token": None,
            "browser_error": None, "requests": [],
        }

        class OAuthServer(BaseHTTPRequestHandler):
            def log_message(self, *_args) -> None:
                return

            def respond(self, status: int, body: dict, headers: dict[str, str] | None = None) -> None:
                content = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(content)

            def do_GET(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                state["requests"].append(("GET", parsed.path))
                query = urllib.parse.parse_qs(parsed.query)
                if parsed.path == "/mcp":
                    if self.headers.get("Authorization") == "Bearer integration-access":
                        self.respond(200, {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})
                    else:
                        self.respond(401, {}, {"WWW-Authenticate": f'Bearer resource_metadata="{base_url}/oauth-resource"'})
                    return
                if parsed.path == "/oauth-resource":
                    self.respond(200, {
                        "resource": f"{base_url}/mcp",
                        "authorization_servers": [base_url],
                    })
                    return
                if parsed.path in ("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"):
                    self.respond(200, {
                        "issuer": base_url,
                        "authorization_endpoint": f"{base_url}/authorize",
                        "token_endpoint": f"{base_url}/token",
                        "registration_endpoint": f"{base_url}/register",
                        "response_types_supported": ["code"],
                        "grant_types_supported": ["authorization_code", "refresh_token"],
                        "token_endpoint_auth_methods_supported": ["none"],
                        "code_challenge_methods_supported": ["S256"],
                    })
                    return
                if parsed.path == "/authorize":
                    state["code_challenge"] = query.get("code_challenge", [None])[0]
                    callback = query["redirect_uri"][0]
                    state["redirect_uri"] = callback
                    location = f"{callback}?code=integration-code&state={urllib.parse.quote(query['state'][0])}"
                    self.send_response(302)
                    self.send_header("Location", location)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.respond(404, {"error": "not_found"})

            def do_POST(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                state["requests"].append(("POST", parsed.path))
                content = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if parsed.path == "/mcp":
                    if self.headers.get("Authorization") == "Bearer integration-access":
                        self.respond(200, {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})
                    else:
                        self.respond(401, {}, {"WWW-Authenticate": f'Bearer resource_metadata="{base_url}/oauth-resource"'})
                    return
                if parsed.path == "/register":
                    registration = json.loads(content)
                    self.respond(201, {
                        "client_id": "tribe-integration-client",
                        "client_name": "Tribe",
                        "grant_types": ["authorization_code", "refresh_token"],
                        "response_types": ["code"],
                        "redirect_uris": registration["redirect_uris"],
                        "token_endpoint_auth_method": "none",
                    })
                    return
                if parsed.path == "/token":
                    fields = urllib.parse.parse_qs(content.decode())
                    verifier = fields.get("code_verifier", [""])[0]
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                    if (fields.get("grant_type") != ["authorization_code"]
                            or challenge != state["code_challenge"]
                            or fields.get("redirect_uri") != [state["redirect_uri"]]):
                        self.respond(400, {"error": "invalid_grant"})
                        return
                    state["access_token"] = "integration-access"
                    self.respond(200, {
                        "access_token": state["access_token"],
                        "refresh_token": "integration-refresh",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                    })
                    return
                self.respond(404, {"error": "not_found"})

        server = ThreadingHTTPServer(("127.0.0.1", 0), OAuthServer)
        server.daemon_threads = True
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        def stop_server() -> None:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)

        self.addCleanup(stop_server)
        host, port = server.server_address
        base_url = f"http://{host}:{port}"
        browser_threads = []

        def open_browser(url: str) -> bool:
            def complete_authorization() -> None:
                try:
                    import time as time_module
                    time_module.sleep(0.15)
                    with urllib.request.urlopen(url, timeout=5) as response:
                        response.read()
                except (OSError, urllib.error.URLError) as error:
                    state["browser_error"] = str(error)

            worker = threading.Thread(target=complete_authorization, daemon=True)
            worker.start()
            browser_threads.append(worker)
            return True

        with tempfile.TemporaryDirectory() as directory:
            storage = MemoryStore()
            lease = OAuthConnectionLease(Path(directory), "project", "service", base_url)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                auth = LeasedOAuth(
                    mcp_url=f"{base_url}/mcp", token_storage=storage, lease=lease,
                    allow_interactive=True, callback_host="127.0.0.1", callback_timeout=5,
                )
            with patch("webbrowser.open", side_effect=open_browser):
                async with httpx2.AsyncClient(auth=auth, timeout=8) as client:
                    response = await client.post(f"{base_url}/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            for worker in browser_threads:
                worker.join(timeout=2)

            self.assertEqual(response.status_code, 200, state["requests"])
            self.assertEqual(state["access_token"], "integration-access")
            self.assertIsNotNone(state["code_challenge"])
            self.assertIsNone(state["browser_error"])
            tokens = await auth.token_storage_adapter.get_tokens()
            self.assertEqual(tokens.access_token, "integration-access")
            self.assertEqual(tokens.refresh_token, "integration-refresh")

            await auth.token_storage_adapter.clear()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                cancelled_auth = LeasedOAuth(
                    mcp_url=f"{base_url}/mcp", token_storage=storage, lease=lease,
                    allow_interactive=True, callback_host="127.0.0.1", callback_timeout=0.15,
                )
            with patch("webbrowser.open", return_value=True), \
                    patch("fastmcp.client.auth.oauth.logger.exception"), \
                    patch("mcp.client.auth.oauth2.logger.exception"):
                async with httpx2.AsyncClient(auth=cancelled_auth, timeout=8) as client:
                    with self.assertRaises(BaseExceptionGroup) as raised:
                        await client.post(
                            f"{base_url}/mcp",
                            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                        )
            def contains_timeout(error: BaseException) -> bool:
                if isinstance(error, BaseExceptionGroup):
                    return any(contains_timeout(child) for child in error.exceptions)
                return isinstance(error, TimeoutError)

            self.assertTrue(contains_timeout(raised.exception))
            self.assertIsNone(await cancelled_auth.token_storage_adapter.get_tokens())

    async def test_expired_token_refreshes_before_authenticated_mcp_request(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            storage = MemoryStore()
            lease = OAuthConnectionLease(Path(directory), "project", "service", "https://mcp.example")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                auth = LeasedOAuth(
                    mcp_url="https://mcp.example/mcp", token_storage=storage, lease=lease,
                )
                await auth.token_storage_adapter.set_tokens(OAuthToken(
                    access_token="expired-access", token_type="Bearer",
                    refresh_token="refresh-before", expires_in=3600,
                ))
            await auth.token_storage_adapter.set_client_info(OAuthClientInformationFull(
                client_id="tribe-test-client",
                redirect_uris=["http://localhost:18765/callback"],
                token_endpoint_auth_method="none",
            ))
            await storage.put(
                key=auth.token_storage_adapter._get_token_expiry_cache_key(),
                value={"expires_at": time() - 10},
                collection="mcp-oauth-token-expiry",
                ttl=3600,
            )
            refresh_requests = []

            def respond(request: httpx2.Request) -> httpx2.Response:
                if request.url.path == "/token":
                    refresh_requests.append(request)
                    self.assertIn(b"refresh_token=refresh-before", request.content)
                    return httpx2.Response(200, json={
                        "access_token": "fresh-access",
                        "refresh_token": "refresh-after",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                    })
                if request.url.path == "/mcp":
                    self.assertEqual(request.headers.get("authorization"), "Bearer fresh-access")
                    return httpx2.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})
                return httpx2.Response(404)

            async with httpx2.AsyncClient(
                transport=httpx2.MockTransport(respond), auth=auth,
            ) as client:
                response = await client.post("https://mcp.example/mcp", json={"method": "tools/list"})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(refresh_requests), 1)
            persisted = await auth.token_storage_adapter.get_tokens()
            self.assertEqual(persisted.access_token, "fresh-access")
            self.assertEqual(persisted.refresh_token, "refresh-after")

            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                restarted = LeasedOAuth(
                    mcp_url="https://mcp.example/mcp", token_storage=storage, lease=lease,
                )
            self.assertEqual((await restarted.token_storage_adapter.get_tokens()).refresh_token, "refresh-after")

    async def test_normal_authenticated_requests_from_workers_are_not_serialised(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            storage = MemoryStore()
            lease = OAuthConnectionLease(Path(directory), "project", "service", "https://mcp.example")
            request = httpx2.Request("POST", "https://mcp.example/mcp", json={"method": "tools/list"})

            async def pass_through(self, outgoing):
                yield outgoing

            with patch.object(OAuth, "async_auth_flow", pass_through):
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    first = LeasedOAuth(mcp_url="https://mcp.example/mcp", token_storage=storage, lease=lease)
                    second = LeasedOAuth(mcp_url="https://mcp.example/mcp", token_storage=storage, lease=lease)
                await first.token_storage_adapter.set_tokens(OAuthToken(
                    access_token="valid-access", token_type="Bearer", refresh_token="valid-refresh", expires_in=3600,
                ))
                first_flow = first.async_auth_flow(request)
                second_flow = second.async_auth_flow(request)
                first_request, second_request = await asyncio.gather(
                    first_flow.__anext__(), second_flow.__anext__(),
                )
                self.assertEqual(str(first_request.url), str(request.url))
                self.assertEqual(str(second_request.url), str(request.url))
                await asyncio.gather(first_flow.aclose(), second_flow.aclose())

    async def test_rotated_refresh_token_is_reused_without_sending_old_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            storage = MemoryStore()
            lease = OAuthConnectionLease(Path(directory), "project", "service", "https://mcp.example")
            auth = LeasedOAuth(mcp_url="https://mcp.example/mcp", token_storage=storage, lease=lease)
            await auth.token_storage_adapter.set_tokens(OAuthToken(
                access_token="latest-access", token_type="Bearer", refresh_token="latest-refresh", expires_in=3600,
            ))
            request = httpx2.Request("POST", "https://mcp.example/mcp", json={"method": "tools/list"})
            refresh_request = httpx2.Request(
                "POST", "https://auth.example/token",
                data={"grant_type": "refresh_token", "refresh_token": "old-refresh", "client_id": "client"},
            )
            received_response = []

            async def stale_sdk_flow(self, outgoing):
                response = yield refresh_request
                received_response.append(response)
                yield outgoing

            with patch.object(OAuth, "async_auth_flow", stale_sdk_flow):
                flow = auth.async_auth_flow(request)
                replay = await flow.__anext__()
                self.assertEqual(str(replay.url), str(request.url))
                await flow.aclose()

            self.assertEqual(len(received_response), 1)
            self.assertEqual(received_response[0].status_code, 200)
            self.assertEqual(received_response[0].json()["access_token"], "latest-access")


if __name__ == "__main__":
    unittest.main()
