"""Isolated, ephemeral browser sessions shared by agent tools and the Browser pane."""

from __future__ import annotations

import queue
import re
import threading
import time
import uuid
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

MAX_SNAPSHOT_CHARS = 40_000
MAX_CONSOLE_MESSAGES = 100
MAX_SCREENSHOT_BYTES = 4_000_000
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
BROWSER_READ_TOOLS = frozenset({
    "browser_snapshot", "browser_screenshot", "browser_tabs", "browser_console_messages",
})
BROWSER_ACTION_TOOLS = frozenset({
    "browser_open", "browser_click", "browser_fill", "browser_select", "browser_hover",
    "browser_press", "browser_scroll", "browser_go_back", "browser_go_forward",
    "browser_resize", "browser_new_tab", "browser_close_tab", "browser_click_at",
    "browser_type",
})


class BrowserUnavailable(RuntimeError):
    pass


class BrowserPolicyError(ValueError):
    pass


@dataclass
class _Session:
    id: str
    project_id: str
    mission_id: str
    agent_id: str
    context: Any
    page: Any
    allowed_domains: frozenset[str]
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    status: str = "open"
    sequence: int = 0
    title: str = ""
    hostname: str = ""
    screenshot: bytes = b""
    screenshot_revision: int = 0
    viewport: dict[str, int] = field(default_factory=lambda: {"width": 1280, "height": 800})
    pointer: dict[str, Any] = field(default_factory=lambda: {"x": 0, "y": 0, "visible": False, "action": ""})
    last_action: str = ""
    console: list[dict[str, str]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    navigation_target_host: str = ""
    url: str = ""
    blocked_hosts: list[str] = field(default_factory=list)


def _validated_url(value: str) -> tuple[str, str]:
    if not isinstance(value, str) or len(value) > 4096:
        raise BrowserPolicyError("Enter a valid web address.")
    parsed = urlparse(value.strip())
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password):
        raise BrowserPolicyError("Browser pages must use an HTTP or HTTPS address without embedded credentials.")
    try:
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        _ = parsed.port
    except (UnicodeError, ValueError) as error:
        raise BrowserPolicyError("The web address is invalid.") from error
    return value.strip(), host


class BrowserSessionManager:
    """Own a single isolated Chromium process and mission/agent-scoped pages.

    All Playwright objects stay on one worker thread. HTTP readers consume only
    bounded in-memory metadata and screenshots; page contents are never persisted.
    """

    def __init__(self, *, headless: bool = True):
        self.headless = headless
        self._queue: queue.Queue[tuple[str, tuple[Any, ...], Future]] = queue.Queue()
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}
        self._session_ids: dict[str, str] = {}
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._startup_error: str | None = None
        self._stopping = False

    @staticmethod
    def browser_installed() -> bool:
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as playwright:
                return Path(playwright.chromium.executable_path).is_file()
        except (ImportError, OSError, RuntimeError):
            return False

    @classmethod
    def install_browser(cls) -> dict[str, str]:
        """Install the pinned Playwright Chromium binary into the user's browser cache."""
        try:
            from playwright._impl._driver import compute_driver_executable
        except ImportError as error:
            raise BrowserUnavailable("Browser support is not installed in this version of Tribe.") from error
        import subprocess

        driver = compute_driver_executable()
        try:
            result = subprocess.run(
                [*driver, "install", "chromium"], capture_output=True, text=True,
                timeout=600, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise BrowserUnavailable("Chromium could not be installed. Check the connection and try again.") from error
        if result.returncode:
            raise BrowserUnavailable("Chromium could not be installed. Check the connection and available disk space.")
        return {"installed": "chromium"}

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            if self._stopping:
                raise BrowserUnavailable("The browser service is shutting down.")
            self._ready.clear()
            self._startup_error = None
            self._thread = threading.Thread(target=self._worker, name="tribe-browser", daemon=True)
            self._thread.start()
        if not self._ready.wait(15):
            raise BrowserUnavailable("The browser did not start in time.")
        if self._startup_error:
            raise BrowserUnavailable(self._startup_error)

    def _worker(self) -> None:
        playwright = browser = None
        try:
            from playwright.sync_api import sync_playwright
            playwright = sync_playwright().start()
            if not Path(playwright.chromium.executable_path).is_file():
                raise BrowserUnavailable("Install Chromium from Settings before using the browser.")
            browser = playwright.chromium.launch(headless=self.headless)
        except Exception as error:  # noqa: BLE001 - expose a bounded product error
            self._startup_error = str(error)[:300] or "The browser could not be started."
            self._ready.set()
            if playwright:
                playwright.stop()
            return
        self._ready.set()
        try:
            while True:
                method, args, future = self._queue.get()
                if method == "__stop__":
                    future.set_result(None)
                    break
                if future.cancelled():
                    continue
                try:
                    future.set_result(getattr(self, f"_do_{method}")(browser, *args))
                except Exception as error:  # noqa: BLE001 - tool failures become recoverable results
                    future.set_exception(error)
        finally:
            with self._lock:
                for session in list(self._sessions.values()):
                    session.status = "ended"
                self._sessions.clear()
                self._session_ids.clear()
            browser.close()
            playwright.stop()

    def _call(self, method: str, *args: Any, timeout: float = 45) -> Any:
        self._ensure_worker()
        future: Future = Future()
        self._queue.put((method, args, future))
        return future.result(timeout=timeout)

    @staticmethod
    def _key(mission_id: str, agent_id: str) -> str:
        return f"{mission_id}:{agent_id}"

    def open(self, project_id: str, mission_id: str, agent_id: str, url: str,
             allowed_domains: list[str] | tuple[str, ...], *, allow_local: bool = True) -> dict[str, Any]:
        safe_url, host = _validated_url(url)
        allowed = frozenset(domain.casefold().rstrip(".") for domain in allowed_domains if isinstance(domain, str))
        if host not in allowed and not (allow_local and host in LOCAL_HOSTS):
            raise BrowserPolicyError("This website is not in the project's allowed website list.")
        return self._call("open", project_id, mission_id, agent_id, safe_url, allowed)

    def update_policy(self, mission_id: str, agent_id: str,
                      allowed_domains: list[str] | tuple[str, ...]) -> None:
        allowed = frozenset(domain.casefold().rstrip(".") for domain in allowed_domains
                            if isinstance(domain, str))
        self._call("update_policy", mission_id, agent_id, allowed)

    def snapshot(self, mission_id: str, agent_id: str) -> str:
        return str(self._call("snapshot", mission_id, agent_id))

    def screenshot(self, mission_id: str, agent_id: str) -> bytes:
        return bytes(self._call("screenshot", mission_id, agent_id))

    def click(self, mission_id: str, agent_id: str, selector: str, by: str, name: str = "") -> dict[str, Any]:
        return self._call("click", mission_id, agent_id, selector, by, name)

    def click_at(self, mission_id: str, agent_id: str, x: float, y: float) -> dict[str, Any]:
        return self._call("click_at", mission_id, agent_id, x, y)

    def type_text(self, mission_id: str, agent_id: str, value: str) -> dict[str, Any]:
        if not isinstance(value, str) or len(value) > 20_000:
            raise ValueError("Text entry is limited to 20,000 characters.")
        return self._call("type_text", mission_id, agent_id, value)

    def interact(self, mission_id: str, session_id: str, action: str, *,
                 x: float = 0, y: float = 0, value: str = "", key: str = "",
                 delta_y: int = 0) -> dict[str, Any]:
        if action not in {"click", "type", "press", "scroll"}:
            raise ValueError("That browser interaction is not available.")
        if action == "type" and (not isinstance(value, str) or len(value) > 20_000):
            raise ValueError("Text entry is limited to 20,000 characters.")
        if action == "scroll" and (not isinstance(delta_y, int) or abs(delta_y) > 2_000):
            raise ValueError("Scroll amount must be no more than 2,000 pixels.")
        with self._lock:
            key_id = self._session_ids.get(session_id)
            session = self._sessions.get(key_id) if key_id else None
            if not session or session.mission_id != mission_id or session.status != "open":
                raise BrowserUnavailable("This browser session is no longer available.")
            agent_id = session.agent_id
        return self._call("interact", mission_id, agent_id, session_id, action,
                          x, y, value, key, delta_y)

    def fill(self, mission_id: str, agent_id: str, selector: str, value: str, by: str, name: str = "") -> dict[str, Any]:
        if len(value) > 20_000:
            raise ValueError("Text entry is limited to 20,000 characters.")
        return self._call("fill", mission_id, agent_id, selector, value, by, name)

    def select(self, mission_id: str, agent_id: str, selector: str, value: str,
               by: str, name: str = "") -> dict[str, Any]:
        if len(value) > 1000:
            raise ValueError("A select option value must be no longer than 1,000 characters.")
        return self._call("select", mission_id, agent_id, selector, value, by, name)

    def hover(self, mission_id: str, agent_id: str, selector: str, by: str, name: str = "") -> dict[str, Any]:
        return self._call("hover", mission_id, agent_id, selector, by, name)

    def press(self, mission_id: str, agent_id: str, key: str) -> dict[str, Any]:
        return self._call("press", mission_id, agent_id, key)

    def scroll(self, mission_id: str, agent_id: str, direction: Literal["up", "down"], amount: int = 500) -> dict[str, Any]:
        if amount < 1 or amount > 2000:
            raise ValueError("Scroll amount must be between 1 and 2,000 pixels.")
        return self._call("scroll", mission_id, agent_id, direction, amount)

    def go_back(self, mission_id: str, agent_id: str) -> dict[str, Any]:
        return self._call("go_back", mission_id, agent_id)

    def go_forward(self, mission_id: str, agent_id: str) -> dict[str, Any]:
        return self._call("go_forward", mission_id, agent_id)

    def resize(self, mission_id: str, agent_id: str, width: int, height: int) -> dict[str, Any]:
        if not 320 <= width <= 2560 or not 240 <= height <= 2000:
            raise ValueError("Browser size must be between 320×240 and 2560×2000 pixels.")
        return self._call("resize", mission_id, agent_id, width, height)

    def new_tab(self, project_id: str, mission_id: str, agent_id: str, url: str,
                allowed_domains: list[str] | tuple[str, ...]) -> dict[str, Any]:
        safe_url, host = _validated_url(url)
        allowed = frozenset(domain.casefold().rstrip(".") for domain in allowed_domains if isinstance(domain, str))
        if host not in allowed and host not in LOCAL_HOSTS:
            raise BrowserPolicyError("This website is not in the project's allowed website list.")
        return self._call("new_tab", project_id, mission_id, agent_id, safe_url, allowed)

    def close_tab(self, mission_id: str, agent_id: str) -> dict[str, Any]:
        return self._call("close_tab", mission_id, agent_id)

    def navigate_session(self, mission_id: str, session_id: str, url: str,
                         allowed_domains: list[str] | tuple[str, ...]) -> dict[str, Any]:
        safe_url, host = _validated_url(url)
        allowed = frozenset(domain.casefold().rstrip(".") for domain in allowed_domains
                            if isinstance(domain, str))
        if host not in allowed and host not in LOCAL_HOSTS:
            raise BrowserPolicyError("This website is not in the project's allowed website list.")
        with self._lock:
            key = self._session_ids.get(session_id)
            session = self._sessions.get(key) if key else None
            if not session or session.mission_id != mission_id or session.status != "open":
                raise BrowserUnavailable("This browser session is no longer available.")
            agent_id = session.agent_id
        return self._call("navigate_session", mission_id, agent_id, session_id, safe_url, allowed)

    def session_action(self, mission_id: str, session_id: str, action: str) -> dict[str, Any]:
        if action not in {"back", "forward", "reload"}:
            raise ValueError("That browser action is not available.")
        with self._lock:
            key = self._session_ids.get(session_id)
            session = self._sessions.get(key) if key else None
            if not session or session.mission_id != mission_id or session.status != "open":
                raise BrowserUnavailable("This browser session is no longer available.")
            agent_id = session.agent_id
        return self._call("session_action", mission_id, agent_id, session_id, action)

    def tabs(self, mission_id: str, agent_id: str) -> list[dict[str, str]]:
        return self._call("tabs", mission_id, agent_id)

    def console_messages(self, mission_id: str, agent_id: str) -> list[dict[str, str]]:
        return self._call("console_messages", mission_id, agent_id)

    def close(self, mission_id: str, agent_id: str) -> dict[str, Any]:
        return self._call("close", mission_id, agent_id)

    def _get_session(self, mission_id: str, agent_id: str) -> _Session:
        session = self._sessions.get(self._key(mission_id, agent_id))
        if not session or session.status != "open":
            raise BrowserUnavailable("No active browser session for this agent.")
        return session

    def _attach_page(self, session: _Session, page: Any) -> None:
        session.page = page
        page.on("framenavigated", lambda frame: self._update_page(session, frame.page))
        page.on("console", lambda message: self._console(session, message))
        page.on("pageerror", lambda error: self._console_text(session, "error", str(error)))
        self._guard_page(session, page)
        self._update_page(session, page)

    def _guard_page(self, session: _Session, page: Any) -> None:
        def guard(route: Any) -> None:
            request = route.request
            request_host = (urlparse(request.url).hostname or "").casefold().rstrip(".")
            current_host = (urlparse(page.url).hostname or "").casefold().rstrip(".")
            navigation_target = session.navigation_target_host
            explicit_local_navigation = (
                request.is_navigation_request() and request.frame == page.main_frame
                and not request.redirected_from
                and (navigation_target == "*" or request_host == navigation_target)
            )
            pending_external_navigation = navigation_target not in {"", "*", *LOCAL_HOSTS}
            local_page = current_host in LOCAL_HOSTS and not pending_external_navigation
            if self.request_allowed(request.url, session.allowed_domains,
                                    local_page or explicit_local_navigation):
                route.continue_()
            else:
                if request_host and request_host not in session.blocked_hosts:
                    session.blocked_hosts.append(request_host)
                    session.blocked_hosts = session.blocked_hosts[-20:]
                route.abort()
        page.route("**/*", guard)

    @staticmethod
    def request_allowed(url: str, allowed_domains: frozenset[str], local_preview: bool) -> bool:
        try:
            _, host = _validated_url(url)
        except BrowserPolicyError:
            return False
        return host in allowed_domains or (local_preview and host in LOCAL_HOSTS)

    def _update_page(self, session: _Session, page: Any) -> None:
        try:
            current = page.url
            parsed = urlparse(current)
            session.url = current[:4096]
            if parsed.hostname:
                session.hostname = parsed.hostname.encode("idna").decode("ascii").lower()[:253]
            session.title = page.title()[:200]
            session.viewport = page.evaluate("() => ({width: innerWidth, height: innerHeight})")
            session.updated_at = time.time()
        except Exception:  # noqa: BLE001 - a closed or navigating page can race metadata reads
            return

    def _publish(self, session: _Session, action: str = "") -> None:
        self._update_page(session, session.page)
        try:
            image = session.page.screenshot(type="jpeg", quality=65, animations="disabled", timeout=5000)
            if len(image) <= MAX_SCREENSHOT_BYTES:
                with self._lock:
                    session.screenshot = image
                    session.screenshot_revision += 1
                    session.sequence += 1
                    if action:
                        session.last_action = action[:160]
                    session.updated_at = time.time()
        except Exception as error:  # noqa: BLE001 - retain the previous safe snapshot
            session.errors.append(str(error)[:200])
            session.errors = session.errors[-10:]

    def _pointer_to(self, session: _Session, locator: Any, action: str) -> None:
        try:
            box = locator.bounding_box(timeout=3000)
            if not box:
                return
            x = min(max(0, int(box["x"] + box["width"] / 2)), session.viewport["width"])
            y = min(max(0, int(box["y"] + box["height"] / 2)), session.viewport["height"])
            start_x = int(session.pointer.get("x", 0))
            start_y = int(session.pointer.get("y", 0))
            session.pointer = {"x": start_x, "y": start_y, "visible": True, "action": action}
            for step in range(1, 7):
                next_x = round(start_x + (x - start_x) * step / 6)
                next_y = round(start_y + (y - start_y) * step / 6)
                session.page.mouse.move(next_x, next_y)
                session.pointer = {"x": next_x, "y": next_y, "visible": True, "action": action}
                time.sleep(0.035)
            self._publish(session, f"Moving to {action}")
            # Leave a visible beat in the split view before the action completes.
            time.sleep(0.18)
        except Exception:  # noqa: BLE001 - locator disappearance should not interrupt the browser worker
            return

    @staticmethod
    def _bounded_point(session: _Session, x: float, y: float) -> tuple[int, int]:
        if (isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float))
                or not isinstance(y, (int, float))):
            raise ValueError("Use browser screenshot coordinates for the click.")
        if not 0 <= x < session.viewport["width"] or not 0 <= y < session.viewport["height"]:
            raise ValueError("Click coordinates must be inside the browser viewport.")
        return round(x), round(y)

    def _move_pointer(self, session: _Session, x: int, y: int, action: str) -> None:
        start_x = int(session.pointer.get("x", 0))
        start_y = int(session.pointer.get("y", 0))
        for step in range(1, 7):
            next_x = round(start_x + (x - start_x) * step / 6)
            next_y = round(start_y + (y - start_y) * step / 6)
            session.page.mouse.move(next_x, next_y)
            session.pointer = {"x": next_x, "y": next_y, "visible": True, "action": action}
            time.sleep(0.025)

    @staticmethod
    def _locator(page: Any, selector: str, by: str, name: str = "") -> Any:
        selector = selector.strip()
        if not selector or len(selector) > 500:
            raise ValueError("Provide a concise role, label, text or CSS selector.")
        if by == "role":
            return page.get_by_role(selector, name=name or None, exact=True)
        if by == "label":
            return page.get_by_label(selector, exact=True)
        if by == "placeholder":
            return page.get_by_placeholder(selector, exact=True)
        if by == "text":
            return page.get_by_text(selector, exact=True)
        if by == "css":
            return page.locator(selector)
        raise ValueError("Use role, label, placeholder, text or css to identify an element.")

    def _do_open(self, browser: Any, project_id: str, mission_id: str, agent_id: str,
                 url: str, allowed: frozenset[str]) -> dict[str, Any]:
        key = self._key(mission_id, agent_id)
        with self._lock:
            old = self._sessions.get(key)
        if old:
            old.status = "ended"
            old.context.close()
        context = browser.new_context(
            viewport={"width": 1280, "height": 800}, service_workers="block",
            accept_downloads=False, permissions=[],
        )
        page = context.new_page()
        session = _Session(str(uuid.uuid4()), project_id, mission_id, agent_id, context, page, allowed)
        session.navigation_target_host = (urlparse(url).hostname or "").casefold().rstrip(".")
        self._attach_page(session, page)
        with self._lock:
            self._sessions[key] = session
            self._session_ids[session.id] = key
        try:
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            finally:
                session.navigation_target_host = ""
            self._publish(session, "Opened page")
        except Exception as error:  # noqa: BLE001 - keep failed navigation visible and recoverable
            session.status = "open"
            session.errors.append(str(error)[:200])
            self._publish(session, "Navigation needs attention")
            return self._metadata(session)
        return self._metadata(session)

    def _active_page(self, mission_id: str, agent_id: str) -> _Session:
        return self._get_session(mission_id, agent_id)

    def _do_snapshot(self, browser: Any, mission_id: str, agent_id: str) -> str:
        session = self._active_page(mission_id, agent_id)
        text = session.page.locator("body").aria_snapshot(timeout=5000)
        self._publish(session)
        return (text or "(The page has no accessible content.)")[:MAX_SNAPSHOT_CHARS]

    def _do_update_policy(self, browser: Any, mission_id: str, agent_id: str,
                          allowed: frozenset[str]) -> None:
        session = self._sessions.get(self._key(mission_id, agent_id))
        if not session:
            return
        session.allowed_domains = allowed
        session.blocked_hosts.clear()
        if session.hostname not in allowed and session.hostname not in LOCAL_HOSTS:
            self._do_close(browser, mission_id, agent_id)

    def _do_screenshot(self, browser: Any, mission_id: str, agent_id: str) -> bytes:
        session = self._active_page(mission_id, agent_id)
        self._publish(session)
        return session.screenshot

    def _do_click(self, browser: Any, mission_id: str, agent_id: str,
                  selector: str, by: str, name: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        locator = self._locator(session.page, selector, by, name)
        count = locator.count()
        if count != 1:
            raise ValueError(f"The selector matched {count} elements; use a more specific target.")
        self._pointer_to(session, locator, "Control")
        locator.click(timeout=10_000)
        session.pointer["action"] = "Click"
        self._publish(session, "Clicked a page control")
        return self._metadata(session)

    def _do_click_at(self, browser: Any, mission_id: str, agent_id: str,
                     x: float, y: float) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        point = self._bounded_point(session, x, y)
        self._move_pointer(session, *point, "Click")
        self._publish(session, "Moving to page control")
        time.sleep(0.15)
        session.page.mouse.click(*point)
        self._publish(session, "Clicked page control")
        return self._metadata(session)

    def _do_type_text(self, browser: Any, mission_id: str, agent_id: str,
                      value: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        input_type = session.page.evaluate(
            "() => document.activeElement instanceof HTMLInputElement ? document.activeElement.type : ''"
        )
        if input_type and input_type.casefold() in {"password", "file"}:
            raise BrowserPolicyError("Password and file fields are not available to agent browser tools.")
        session.page.keyboard.insert_text(value)
        session.pointer["action"] = "Enter text"
        self._publish(session, "Entered text in the focused page field")
        return self._metadata(session)

    def _do_interact(self, browser: Any, mission_id: str, agent_id: str,
                     session_id: str, action: str, x: float, y: float,
                     value: str, key: str, delta_y: int) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        if session.id != session_id:
            raise BrowserUnavailable("This browser session is no longer available.")
        if action == "click":
            point = self._bounded_point(session, x, y)
            session.page.mouse.click(*point)
            session.pointer = {"x": point[0], "y": point[1], "visible": True, "action": "Click"}
            label = "Clicked page control"
        elif action == "type":
            input_type = session.page.evaluate(
                "() => document.activeElement instanceof HTMLInputElement ? document.activeElement.type : ''"
            )
            if input_type and input_type.casefold() in {"password", "file"}:
                raise BrowserPolicyError("Password and file fields are not available in the browser pane.")
            session.page.keyboard.insert_text(value)
            label = "Entered text in focused field"
        elif action == "press":
            if key not in {"Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft",
                           "ArrowRight", "Space", "Backspace", "Delete", "Home", "End"}:
                raise ValueError("That keyboard action is not available.")
            session.page.keyboard.press(key)
            label = f"Pressed {key}"
        else:
            point = self._bounded_point(session, x, y)
            session.page.mouse.move(*point)
            session.page.mouse.wheel(0, delta_y)
            label = "Scrolled page"
        self._publish(session, label)
        return self._metadata(session)

    def _do_fill(self, browser: Any, mission_id: str, agent_id: str,
                 selector: str, value: str, by: str, name: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        locator = self._locator(session.page, selector, by, name)
        count = locator.count()
        if count != 1:
            raise ValueError(f"The selector matched {count} elements; use a more specific target.")
        input_type = locator.get_attribute("type")
        if input_type and input_type.casefold() == "password":
            raise BrowserPolicyError("Password fields are not available to agent browser tools.")
        self._pointer_to(session, locator, "Field")
        locator.fill(value, timeout=10_000)
        session.pointer["action"] = "Enter text"
        self._publish(session, "Entered text in a page field")
        return self._metadata(session)

    def _do_select(self, browser: Any, mission_id: str, agent_id: str, selector: str,
                   value: str, by: str, name: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        locator = self._locator(session.page, selector, by, name)
        count = locator.count()
        if count != 1:
            raise ValueError(f"The selector matched {count} elements; use a more specific target.")
        self._pointer_to(session, locator, "Control")
        locator.select_option(value=value, timeout=10_000)
        session.pointer["action"] = "Choose option"
        self._publish(session, "Selected a page option")
        return self._metadata(session)

    def _do_hover(self, browser: Any, mission_id: str, agent_id: str, selector: str,
                  by: str, name: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        locator = self._locator(session.page, selector, by, name)
        count = locator.count()
        if count != 1:
            raise ValueError(f"The selector matched {count} elements; use a more specific target.")
        self._pointer_to(session, locator, "Control")
        locator.hover(timeout=10_000)
        self._publish(session, "Hovered over a page control")
        return self._metadata(session)

    def _do_press(self, browser: Any, mission_id: str, agent_id: str, key: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        if key not in {"Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Backspace"}:
            raise ValueError("That keyboard action is not available.")
        session.page.keyboard.press(key)
        session.pointer["action"] = key
        self._publish(session, f"Pressed {key}")
        return self._metadata(session)

    def _do_scroll(self, browser: Any, mission_id: str, agent_id: str,
                   direction: str, amount: int) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        session.page.mouse.wheel(0, amount if direction == "down" else -amount)
        self._publish(session, f"Scrolled {direction}")
        return self._metadata(session)

    def _do_go_back(self, browser: Any, mission_id: str, agent_id: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        session.navigation_target_host = "*"
        try:
            session.page.go_back(wait_until="domcontentloaded", timeout=15_000)
        finally:
            session.navigation_target_host = ""
        self._publish(session, "Went back")
        return self._metadata(session)

    def _do_go_forward(self, browser: Any, mission_id: str, agent_id: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        session.navigation_target_host = "*"
        try:
            session.page.go_forward(wait_until="domcontentloaded", timeout=15_000)
        finally:
            session.navigation_target_host = ""
        self._publish(session, "Went forward")
        return self._metadata(session)

    def _do_navigate_session(self, browser: Any, mission_id: str, agent_id: str,
                             session_id: str, url: str,
                             allowed: frozenset[str]) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        if session.id != session_id:
            raise BrowserUnavailable("This browser session is no longer available.")
        session.allowed_domains = allowed
        session.navigation_target_host = (urlparse(url).hostname or "").casefold().rstrip(".")
        try:
            session.page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        finally:
            session.navigation_target_host = ""
        self._publish(session, "Navigated to address")
        return self._metadata(session)

    def _do_session_action(self, browser: Any, mission_id: str, agent_id: str,
                           session_id: str, action: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        if session.id != session_id:
            raise BrowserUnavailable("This browser session is no longer available.")
        session.navigation_target_host = "*"
        try:
            if action == "back":
                session.page.go_back(wait_until="domcontentloaded", timeout=15_000)
            elif action == "forward":
                session.page.go_forward(wait_until="domcontentloaded", timeout=15_000)
            else:
                session.page.reload(wait_until="domcontentloaded", timeout=15_000)
        finally:
            session.navigation_target_host = ""
        self._publish(session, {"back": "Went back", "forward": "Went forward",
                                "reload": "Reloaded page"}[action])
        return self._metadata(session)

    def _do_resize(self, browser: Any, mission_id: str, agent_id: str,
                   width: int, height: int) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        session.page.set_viewport_size({"width": width, "height": height})
        session.viewport = {"width": width, "height": height}
        self._publish(session, "Resized the browser preview")
        return self._metadata(session)

    def _do_new_tab(self, browser: Any, project_id: str, mission_id: str, agent_id: str,
                    url: str, allowed: frozenset[str]) -> dict[str, Any]:
        key = self._key(mission_id, agent_id)
        session = self._sessions.get(key)
        if not session:
            return self._do_open(browser, project_id, mission_id, agent_id, url, allowed)
        session.allowed_domains = allowed
        page = session.context.new_page()
        session.navigation_target_host = (urlparse(url).hostname or "").casefold().rstrip(".")
        self._attach_page(session, page)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        finally:
            session.navigation_target_host = ""
        self._publish(session, "Opened a new tab")
        return self._metadata(session)

    def _do_close_tab(self, browser: Any, mission_id: str, agent_id: str) -> dict[str, Any]:
        session = self._active_page(mission_id, agent_id)
        pages = session.context.pages
        if len(pages) <= 1:
            return self._do_close(browser, mission_id, agent_id)
        session.page.close()
        session.page = session.context.pages[-1]
        self._attach_page(session, session.page)
        self._publish(session, "Closed a tab")
        return self._metadata(session)

    def _do_tabs(self, browser: Any, mission_id: str, agent_id: str) -> list[dict[str, str]]:
        session = self._active_page(mission_id, agent_id)
        result = []
        for index, page in enumerate(session.context.pages):
            try:
                result.append({"index": str(index), "title": page.title()[:200],
                               "hostname": urlparse(page.url).hostname or ""})
            except Exception:  # noqa: BLE001 - a tab can close while its title is being read
                result.append({"index": str(index), "title": "", "hostname": ""})
        return result

    def _do_console_messages(self, browser: Any, mission_id: str, agent_id: str) -> list[dict[str, str]]:
        session = self._active_page(mission_id, agent_id)
        return list(session.console[-MAX_CONSOLE_MESSAGES:])

    def _do_close(self, browser: Any, mission_id: str, agent_id: str) -> dict[str, Any]:
        key = self._key(mission_id, agent_id)
        session = self._sessions.get(key)
        if not session:
            return {"closed": False, "status": "unavailable"}
        session.status = "ended"
        session.screenshot = b""
        session.context.close()
        with self._lock:
            self._sessions.pop(key, None)
            self._session_ids.pop(session.id, None)
        return {"closed": True, "status": "ended"}

    @staticmethod
    def _console(session: _Session, message: Any) -> None:
        if message.type in {"error", "warning"}:
            BrowserSessionManager._console_text(session, message.type, message.text)

    @staticmethod
    def _console_text(session: _Session, level: str, text: str) -> None:
        # Do not collect arbitrary page console output; retain errors without URLs or payloads.
        clean = re.sub(r"https?://[^\s]+", "[url]", text)
        session.console.append({"level": level[:20], "message": clean[:500]})
        session.console = session.console[-MAX_CONSOLE_MESSAGES:]

    @staticmethod
    def _metadata(session: _Session) -> dict[str, Any]:
        return {
            "id": session.id, "projectId": session.project_id,
            "missionId": session.mission_id, "agentId": session.agent_id,
            "status": session.status, "title": session.title, "hostname": session.hostname,
            "url": session.url,
            "blockedHosts": list(session.blocked_hosts),
            "updatedAt": session.updated_at,
            "sequence": session.sequence, "screenshotRevision": session.screenshot_revision,
            "viewport": dict(session.viewport), "pointer": dict(session.pointer),
            "lastAction": session.last_action, "errorCount": len(session.errors),
        }

    def view(self, mission_id: str) -> dict[str, Any]:
        with self._lock:
            sessions = [self._metadata(item) for item in self._sessions.values()
                        if item.mission_id == mission_id]
        sessions.sort(key=lambda item: item["updatedAt"], reverse=True)
        return {"sessions": sessions, "status": "open" if sessions else "unavailable"}

    def screenshot_for(self, session_id: str, mission_id: str) -> bytes | None:
        with self._lock:
            key = self._session_ids.get(session_id)
            session = self._sessions.get(key) if key else None
            if not session or session.mission_id != mission_id or session.status != "open":
                return None
            return bytes(session.screenshot) if session.screenshot else None

    def stop(self, session_id: str, mission_id: str) -> bool:
        with self._lock:
            key = self._session_ids.get(session_id)
            session = self._sessions.get(key) if key else None
            if not session or session.mission_id != mission_id:
                return False
            agent_id = session.agent_id
        self.close(mission_id, agent_id)
        return True

    def close_all(self) -> None:
        with self._lock:
            thread = self._thread
            self._stopping = True
        if not thread or not thread.is_alive():
            return
        future: Future = Future()
        self._queue.put(("__stop__", (), future))
        try:
            future.result(timeout=10)
        except TimeoutError:
            thread.join(timeout=2)
            return
        thread.join(timeout=2)

