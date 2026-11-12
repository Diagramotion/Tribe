from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from tribe_runtime import server as runtime_server
from tribe_runtime.browser_sessions import BrowserSessionManager


class _PageHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<html><head><title>Preview route</title><style>body{margin:0}button{position:absolute;left:20px;top:20px;width:100px;height:40px}</style></head><body><h1>Preview</h1><button onclick=\"document.querySelector('h1').textContent='Clicked'\">Click</button></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


class _MissionStore:
    def mission(self, mission_id):
        return {"id": mission_id, "project_id": "project"}

    def project_web_access(self, project_id):
        return {"enabled": True, "allowedDomains": []}


def test_browser_http_routes_scope_sessions_and_serve_uncached_screenshots():
    if not BrowserSessionManager.browser_installed():
        pytest.skip("Playwright Chromium is not installed")
    site = ThreadingHTTPServer(("127.0.0.1", 0), _PageHandler)
    site_thread = threading.Thread(target=site.serve_forever, daemon=True)
    site_thread.start()
    manager = BrowserSessionManager()
    app = runtime_server.LocalHTTPServer(("127.0.0.1", 0), runtime_server.Handler)
    app_thread = threading.Thread(target=app.serve_forever, daemon=True)
    app_thread.start()
    mission_id = str(uuid.uuid4())
    other_mission_id = str(uuid.uuid4())
    try:
        session = manager.open(
            "project", mission_id, "builder",
            f"http://127.0.0.1:{site.server_port}/", [],
        )
        with patch.object(runtime_server, "BROWSER", manager), \
             patch.object(runtime_server, "STORE", _MissionStore()):
            base = f"http://127.0.0.1:{app.server_port}"
            with urlopen(f"{base}/api/missions/{mission_id}/browser") as response:
                payload = json.loads(response.read())
                assert response.headers["Cache-Control"] == "no-store"
            assert payload["sessions"][0]["id"] == session["id"]
            assert payload["sessions"][0]["hostname"] == "127.0.0.1"
            assert payload["sessions"][0]["url"].startswith("http://127.0.0.1:")

            with urlopen(
                f"{base}/api/missions/{mission_id}/browser/{session['id']}/screenshot"
            ) as response:
                assert response.headers["Content-Type"] == "image/jpeg"
                assert response.headers["Cache-Control"] == "no-store"
                assert response.read().startswith(b"\xff\xd8")

            target_url = f"http://127.0.0.1:{site.server_port}/next"
            request = Request(
                f"{base}/api/missions/{mission_id}/browser/{session['id']}/navigate",
                data=json.dumps({"url": target_url}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urlopen(request) as response:
                navigated = json.loads(response.read())["session"]
            assert navigated["id"] == session["id"]
            assert navigated["url"] == target_url
            assert navigated["title"] == "Preview route"

            interaction = Request(
                f"{base}/api/missions/{mission_id}/browser/{session['id']}/interact",
                data=json.dumps({"action": "click", "x": 40, "y": 35}).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urlopen(interaction) as response:
                result = json.loads(response.read())["session"]
            assert result["pointer"]["visible"] is True
            assert result["lastAction"] == "Clicked page control"

            try:
                urlopen(f"{base}/api/missions/{other_mission_id}/browser/{session['id']}/screenshot")
            except HTTPError as error:
                assert error.code == 404
            else:
                raise AssertionError("another chat must not read this browser screenshot")

            request = Request(
                f"{base}/api/missions/{mission_id}/browser/{session['id']}/stop",
                data=b"{}", headers={"Content-Type": "application/json"}, method="POST",
            )
            with urlopen(request) as response:
                assert json.loads(response.read()) == {"stopped": True}
            assert manager.view(mission_id)["sessions"] == []
    finally:
        manager.close_all()
        app.shutdown()
        app.server_close()
        app_thread.join(timeout=2)
        site.shutdown()
        site.server_close()
        site_thread.join(timeout=2)


def test_runtime_accepts_cleartext_origins_only_for_localhost_and_loopback():
    from types import SimpleNamespace

    handler = runtime_server.Handler
    for origin in (
        "http://localhost:5173",
        "http://127.0.0.2:5173",
        "http://[::1]:5173",
    ):
        request = SimpleNamespace(headers={"Origin": origin})
        assert handler._local_origin(request)
    for origin in ("http://terminal.local:5173", "http://example.com:5173", "https://example.com"):
        request = SimpleNamespace(headers={"Origin": origin})
        assert not handler._local_origin(request)


def test_runtime_http_server_rejects_non_loopback_bind_addresses():
    with pytest.raises(ValueError, match="must bind to a loopback address"):
        runtime_server.LocalHTTPServer(("0.0.0.0", 0), runtime_server.Handler)
