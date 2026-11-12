from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tribe_runtime.browser_sessions import BrowserPolicyError, BrowserSessionManager, _validated_url


class _PageHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/next"):
            title = "Next page"
        else:
            title = "Tribe browser test"
        body = f"""<!doctype html><html><head><title>{title}</title><style>
        body {{ margin: 0; }} h1 {{ position: absolute; left: 20px; top: 0; }}
        button {{ position: absolute; left: 20px; top: 60px; width: 160px; height: 44px; }}
        #note {{ position: absolute; left: 20px; top: 130px; width: 180px; height: 35px; }}
        </style></head>
        <body><main><h1>Browser session test</h1><button onclick="document.querySelector('h1').textContent='Clicked successfully'">Continue</button>
        <label for='note'>Note</label><input id='note' type='text'>
        <label for='secret'>Password</label><input id='secret' type='password'>
        <label for='theme'>Theme</label><select id='theme'><option value='light'>Light</option>
        <option value='dark'>Dark</option></select><a href='/next'>Next page</a></main></body></html>""".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


@pytest.fixture
def site():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _PageHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/test?private=must-not-escape"
    finally:
        server.shutdown()
        worker.join(timeout=2)
        server.server_close()


@pytest.fixture
def browser():
    manager = BrowserSessionManager()
    if not manager.browser_installed():
        pytest.skip("Playwright Chromium is not installed")
    yield manager
    manager.close_all()


def test_headless_session_shares_snapshot_screenshot_and_live_pointer(browser, site):
    opened = browser.open("project-a", "mission-a", "builder", site, [])
    assert opened["status"] == "open"
    assert opened["title"] == "Tribe browser test"
    assert opened["hostname"] == "127.0.0.1"
    assert opened["url"] == site
    assert browser.snapshot("mission-a", "builder").find("Browser session test") >= 0
    assert browser.screenshot("mission-a", "builder").startswith(b"\xff\xd8")

    clicked = browser.click("mission-a", "builder", "button", "role", "Continue")
    assert clicked["screenshotRevision"] >= 2
    assert clicked["pointer"]["visible"] is True
    assert browser.view("mission-a")["sessions"][0]["agentId"] == "builder"
    assert browser.screenshot_for(opened["id"], "mission-a").startswith(b"\xff\xd8")


def test_browser_policy_rejects_unapproved_hosts_credentials_and_non_http(browser):
    with pytest.raises(BrowserPolicyError):
        browser.open("p", "m", "a", "https://not-allowed.example/path", ["allowed.example"])
    with pytest.raises(BrowserPolicyError):
        browser.open("p", "m", "a", "https://user:pass@allowed.example", ["allowed.example"])
    with pytest.raises(BrowserPolicyError):
        browser.open("p", "m", "a", "file:///etc/passwd", [])
    with pytest.raises(BrowserPolicyError):
        browser.open("p", "m", "a", "https://sub.allowed.example", ["allowed.example"])


def test_cleartext_browser_urls_are_limited_to_loopback_hosts():
    assert _validated_url("http://127.0.0.2:8080/preview")[1] == "127.0.0.2"
    assert _validated_url("http://[::1]:8080/preview")[1] == "::1"
    with pytest.raises(BrowserPolicyError, match="localhost and loopback"):
        _validated_url("http://example.com/preview")


def test_external_pages_cannot_reach_loopback_services():
    assert BrowserSessionManager.request_allowed(
        "https://docs.example/guide", frozenset({"docs.example"}), False,
    )
    assert not BrowserSessionManager.request_allowed(
        "http://127.0.0.1:4317/api/settings", frozenset({"docs.example"}), False,
    )
    assert BrowserSessionManager.request_allowed(
        "http://127.0.0.1:5173/preview", frozenset(), True,
    )


def test_browser_fill_refuses_passwords_and_bounds_text(browser, site):
    browser.open("project-a", "mission-a", "builder", site, [])
    with pytest.raises(BrowserPolicyError):
        browser.fill("mission-a", "builder", "Password", "not-secret", "label")
    with pytest.raises(ValueError):
        browser.fill("mission-a", "builder", "Note", "x" * 20_001, "label")
    result = browser.fill("mission-a", "builder", "Note", "hello", "label")
    assert result["lastAction"] == "Entered text in a page field"


def test_browser_select_hover_history_and_responsive_resize(browser, site):
    opened = browser.open("project-a", "mission-a", "builder", site, [])
    selected = browser.select("mission-a", "builder", "Theme", "dark", "label")
    assert selected["lastAction"] == "Selected a page option"
    hovered = browser.hover("mission-a", "builder", "button", "role", "Continue")
    assert hovered["pointer"]["visible"] is True
    browser.click("mission-a", "builder", "link", "role", "Next page")
    assert browser.view("mission-a")["sessions"][0]["title"] == "Next page"
    assert browser.go_back("mission-a", "builder")["title"] == "Tribe browser test"
    assert browser.go_forward("mission-a", "builder")["title"] == "Next page"
    assert browser.session_action("mission-a", opened["id"], "back")["title"] == "Tribe browser test"
    assert browser.session_action("mission-a", opened["id"], "forward")["title"] == "Next page"
    assert browser.session_action("mission-a", opened["id"], "reload")["title"] == "Next page"
    resized = browser.resize("mission-a", "builder", 375, 812)
    assert resized["viewport"] == {"width": 375, "height": 812}
    with pytest.raises(ValueError):
        browser.resize("mission-a", "builder", 200, 200)


def test_address_bar_navigation_keeps_the_same_session_and_enforces_allowed_hosts(browser, site):
    opened = browser.open("project-a", "mission-a", "user", site, [])
    next_url = site.rsplit("/", 1)[0] + "/next"
    navigated = browser.navigate_session("mission-a", opened["id"], next_url, [])
    assert navigated["id"] == opened["id"]
    assert navigated["url"] == next_url
    assert navigated["title"] == "Next page"
    with pytest.raises(BrowserPolicyError):
        browser.navigate_session("mission-a", opened["id"], "https://not-allowed.example", [])


def test_agent_coordinates_and_user_pane_input_control_the_real_page(browser, site):
    opened = browser.open("project-a", "mission-a", "builder", site, [])
    clicked = browser.click_at("mission-a", "builder", 60, 80)
    assert clicked["pointer"]["visible"] is True
    assert "Clicked successfully" in browser.snapshot("mission-a", "builder")
    browser.click_at("mission-a", "builder", 60, 145)
    typed = browser.type_text("mission-a", "builder", "color")
    assert typed["screenshotRevision"] > clicked["screenshotRevision"]

    user_session = browser.open("project-a", "mission-a", "user", site, [])
    user_result = browser.interact("mission-a", user_session["id"], "click", x=60, y=80)
    assert user_result["pointer"]["visible"] is True
    browser.interact("mission-a", user_session["id"], "click", x=60, y=145)
    updated = browser.interact("mission-a", user_session["id"], "type", value="palette")
    assert updated["screenshotRevision"] > user_result["screenshotRevision"]


def test_session_isolation_and_explicit_stop(browser, site):
    opened = browser.open("project-a", "mission-a", "builder", site, [])
    assert browser.view("mission-b")["sessions"] == []
    assert browser.screenshot_for(opened["id"], "mission-b") is None
    with pytest.raises(RuntimeError):
        browser.snapshot("mission-b", "builder")
    assert browser.stop(opened["id"], "mission-a") is True
    assert browser.view("mission-a")["sessions"] == []
