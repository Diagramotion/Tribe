import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowUpRight, DownloadSimple, Globe, Stop, WarningCircle } from "@phosphor-icons/react";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { runtime } from "../api/runtime.js";

export function BrowserView({ mission, agents = [], onOpenWebsiteSettings }) {
  const [sessions, setSessions] = useState([]);
  const [browserReady, setBrowserReady] = useState(null);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState("");
  const [installing, setInstalling] = useState(false);
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const addressInput = useRef(null);
  const textBuffer = useRef({ value: "", timer: 0 });
  const wheelBuffer = useRef({ delta: 0, x: 0, y: 0, timer: 0 });
  const activeSession = sessions[0];
  const refresh = useCallback(async () => {
    if (!mission?.id) return;
    try {
      const view = await runtime.getBrowserSessions(mission.id);
      setSessions(view.sessions ?? []);
      setError((current) => current?.startsWith("Failed to execute 'json'") ? "" : current);
      if (!addressFocused && document.activeElement !== addressInput.current) {
        setAddress(view.sessions?.[0]?.url ?? "");
      }
    } catch (cause) {
      setError(cause?.message ?? "Browser preview could not be loaded.");
    }
  }, [mission?.id, addressFocused]);

  useEffect(() => {
    void refresh();
    runtime.getBrowserRuntime().then((status) => setBrowserReady(Boolean(status.installed))).catch(() => setBrowserReady(false));
    const timer = window.setInterval(() => void refresh(), 120);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(textBuffer.current.timer);
      window.clearTimeout(wheelBuffer.current.timer);
    };
  }, [refresh]);

  async function stopSession(session) {
    setStopping(session.id);
    try {
      await runtime.stopBrowserSession(mission.id, session.id);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? "The browser session could not be stopped.");
    } finally {
      setStopping("");
    }
  }

  async function installBrowser() {
    setInstalling(true);
    try {
      await runtime.installBrowser();
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? "Browser support could not be installed.");
    } finally {
      setInstalling(false);
    }
  }

  async function navigate(event) {
    event.preventDefault();
    let url = address.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      const host = url.split(/[/?#]/, 1)[0].replace(/^\[|\]$/g, "");
      const local = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(:\d+)?$/i.test(host);
      url = `${local ? "http" : "https"}://${url}`;
    }
    setNavigating(true);
    setError("");
    try {
      if (activeSession) await runtime.navigateBrowserSession(mission.id, activeSession.id, url);
      else await runtime.openBrowserSession(mission.id, url);
      setAddress(url);
      setAddressFocused(false);
      addressInput.current?.blur();
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? "The address could not be opened.");
    } finally {
      setNavigating(false);
    }
  }

  async function browserAction(action) {
    if (!activeSession) return;
    setNavigating(true);
    setError("");
    try {
      await runtime.browserSessionAction(mission.id, activeSession.id, action);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? "The browser action could not be completed.");
    } finally {
      setNavigating(false);
    }
  }

  async function sendPageInput(input) {
    if (!activeSession) return;
    try {
      setError("");
      await runtime.interactWithBrowserSession(mission.id, activeSession.id, input);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? "The page could not receive that input.");
    }
  }

  function viewportPoint(event, viewport) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - bounds.left) * viewport.width / bounds.width),
      y: Math.round((event.clientY - bounds.top) * viewport.height / bounds.height),
    };
  }

  function flushTypedText() {
    const value = textBuffer.current.value;
    window.clearTimeout(textBuffer.current.timer);
    textBuffer.current.value = "";
    if (value) return sendPageInput({ action: "type", value });
    return Promise.resolve();
  }

  function onPageKeyDown(event) {
    if (!activeSession || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      textBuffer.current.value += event.key;
      window.clearTimeout(textBuffer.current.timer);
      textBuffer.current.timer = window.setTimeout(() => void flushTypedText(), 65);
      return;
    }
    const key = event.key === " " ? "Space" : event.key;
    if (["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Backspace", "Delete", "Home", "End"].includes(key)) {
      event.preventDefault();
      void flushTypedText().then(() => sendPageInput({ action: "press", key }));
    }
  }

  function onPageWheel(event, viewport) {
    event.preventDefault();
    const point = viewportPoint(event, viewport);
    wheelBuffer.current.delta = Math.max(-2000, Math.min(2000, wheelBuffer.current.delta + Math.round(event.deltaY)));
    wheelBuffer.current.x = point.x;
    wheelBuffer.current.y = point.y;
    window.clearTimeout(wheelBuffer.current.timer);
    wheelBuffer.current.timer = window.setTimeout(() => {
      const { delta, x, y } = wheelBuffer.current;
      wheelBuffer.current.delta = 0;
      void sendPageInput({ action: "scroll", x, y, deltaY: delta });
    }, 70);
  }

  return <section aria-label="Managed browser" className="browser-workspace">
    <form className="browser-addressbar" onSubmit={(event) => void navigate(event)}>
      <div className="browser-address-actions">
        <IconButton disabled={!activeSession || navigating} label="Go back" onClick={() => void browserAction("back")} type="button"><ArrowLeft size={16} /></IconButton>
        <IconButton disabled={!activeSession || navigating} label="Go forward" onClick={() => void browserAction("forward")} type="button"><ArrowRight size={16} /></IconButton>
        <IconButton disabled={!activeSession || navigating} label="Reload page" onClick={() => void browserAction("reload")} type="button"><ArrowClockwise className={navigating ? "spin" : ""} size={16} /></IconButton>
      </div>
      <label className="browser-address-field">
        <Globe aria-hidden="true" size={15} />
        <input aria-label="Browser address" autoComplete="url" onBlur={() => setAddressFocused(false)} onChange={(event) => setAddress(event.target.value)} onFocus={() => setAddressFocused(true)} placeholder="Enter a website address" ref={addressInput} spellCheck="false" value={address} />
      </label>
      <button aria-label="Open address" className="browser-address-go" disabled={!address.trim() || navigating || browserReady === false} title="Open address" type="submit">{navigating ? <ArrowClockwise className="spin" size={16} /> : <ArrowUpRight size={17} />}</button>
    </form>
    {error && <div className="browser-workspace-notice" role="alert"><WarningCircle size={16} />{error}</div>}
    {sessions.length === 0 ? <div className="browser-workspace-empty">
      <Globe aria-hidden="true" size={22} />
      <strong>{browserReady === false ? "Browser setup needed" : "No active browser session"}</strong>
      <span>{browserReady === false
        ? "Install Chromium to open a website here or share live pages with agents. External websites must be allowed for this project."
        : "Enter an address above or let an agent open a page. Its live preview will appear here."}</span>
      {browserReady === false && <button className="button button--secondary browser-install-button" disabled={installing} onClick={() => void installBrowser()} type="button">{installing ? <ArrowClockwise className="spin" size={15} /> : <DownloadSimple size={15} />}{installing ? "Installing…" : "Install browser support"}</button>}
      {onOpenWebsiteSettings && <button className="button button--quiet browser-settings-button" onClick={onOpenWebsiteSettings} type="button">Configure website access</button>}
    </div> : <div className="browser-session-list">
      {sessions.map((session) => {
        const agent = agents.find((item) => item.id === session.agentId);
        const viewport = session.viewport ?? { width: 1280, height: 800 };
        const pointer = session.pointer ?? {};
        return <article className="browser-session" key={session.id}>
          <header className="browser-session-header">
            <div className="browser-session-title">
              <span className="browser-live-indicator" aria-hidden="true" />
              <div><strong>{session.title || session.hostname || "Untitled page"}</strong>
                <small>{session.hostname || "Loading page"}{agent?.name ? ` · ${agent.name}` : ""}</small></div>
            </div>
            <IconButton disabled={stopping === session.id} label="Stop browser session" onClick={() => void stopSession(session)}>
              {stopping === session.id ? <ArrowClockwise className="spin" size={16} /> : <Stop size={16} />}
            </IconButton>
          </header>
          <div className="browser-screen" style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}>
            <img alt={`Live browser preview${session.hostname ? ` of ${session.hostname}` : ""}`} src={runtime.browserScreenshotUrl(mission.id, session.id, session.screenshotRevision)} />
            <div aria-label="Interactive browser page. Click to use the page, then type or scroll." className="browser-interaction-layer" onClick={(event) => { const point = viewportPoint(event, viewport); void flushTypedText().then(() => sendPageInput({ action: "click", ...point })); }} onKeyDown={onPageKeyDown} onPaste={(event) => { const value = event.clipboardData.getData("text/plain"); if (value) { event.preventDefault(); void flushTypedText().then(() => sendPageInput({ action: "type", value })); } }} onWheel={(event) => onPageWheel(event, viewport)} role="application" tabIndex={0} />
            {pointer.visible && <span aria-hidden="true" className="browser-agent-pointer" style={{ left: `${Math.max(0, Math.min(100, pointer.x / viewport.width * 100))}%`, top: `${Math.max(0, Math.min(100, pointer.y / viewport.height * 100))}%` }}><svg viewBox="0 0 90 90"><defs><linearGradient id="browser-cursor-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#80b4ff" /><stop offset="0.52" stopColor="#4e86f5" /><stop offset="1" stopColor="#2e5fdb" /></linearGradient><linearGradient id="browser-cursor-edge" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0" stopColor="#c1d9ff" stopOpacity=".85" /><stop offset="1" stopColor="#1642ae" stopOpacity=".9" /></linearGradient></defs><path className="browser-agent-pointer-shape" d="M8 4 C4 2 1 6 2 11 L12 74 C14 84 24 87 31 79 L48 59 C54 52 59 48 68 45 L79 41 C89 38 90 26 81 21 Z" fill="url(#browser-cursor-fill)" stroke="url(#browser-cursor-edge)" strokeWidth="3" strokeLinejoin="round" /><path d="M8 8 L17 69 C18 76 22 78 27 73" fill="none" stroke="#d7e7ff" strokeOpacity=".45" strokeWidth="3" strokeLinecap="round" /></svg><small>{agent?.name ?? (session.agentId === "user" ? "You" : "Agent")}</small></span>}
          </div>
          <footer className="browser-session-footer"><span>{session.lastAction || "Session ready"}</span><span>{session.errorCount ? `${session.errorCount} browser issue${session.errorCount === 1 ? "" : "s"}` : "Interactive preview · click, type or scroll"}</span></footer>
        </article>;
      })}
    </div>}
  </section>;
}
