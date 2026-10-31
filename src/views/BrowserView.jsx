import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowRight, Bug, DownloadSimple, DotsThree, Eraser, Globe, SlidersHorizontal, Stop, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { SelectControl } from "../components/SelectControl.jsx";

function normaliseAddress(value) {
  const address = String(value ?? "").trim();
  if (!address) throw new Error("Enter a website address.");
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(address)
    ? address
    : /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(:\d+)?(?:\/|$)/i.test(address)
      ? `http://${address}`
      : `https://${address}`;
  const parsed = new URL(withScheme);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Use an HTTP or HTTPS website address without a username or password.");
  }
  return parsed.href;
}

function formatStorageEstimate(usage) {
  if (!usage) return "";
  const bytes = Math.max(0, Number(usage.bytes) || 0);
  if (bytes < 1024) return bytes === 0 ? "No browser data" : "Under 1 KB of browser data";
  const unit = bytes < 1024 ** 2 ? "KB" : "MB";
  const divisor = unit === "KB" ? 1024 : 1024 ** 2;
  const amount = (bytes / divisor).toFixed(1).replace(/\.0$/, "");
  return `${usage.complete ? "About" : "At least"} ${amount} ${unit} of browser data`;
}

function formatStorageBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.floor(value)} B`;
  const unit = value < 1024 ** 2 ? "KB" : "MB";
  const divisor = unit === "KB" ? 1024 : 1024 ** 2;
  return `${(value / divisor).toFixed(1).replace(/\.0$/, "")} ${unit}`;
}

const siteStorageLabels = {
  appcache: "App cache",
  cache_storage: "Cache storage",
  file_systems: "File system",
  indexeddb: "IndexedDB",
  local_storage: "Local storage",
  other: "Other",
  service_workers: "Service workers",
  storage_buckets: "Storage buckets",
  websql: "WebSQL",
};

export function BrowserView({ visible = true, projects = [], onStateChange }) {
  const surfaceRef = useRef(null);
  const toolsMenuRef = useRef(null);
  const addressInputRef = useRef(null);
  const downloadsControlRef = useRef(null);
  const [state, setState] = useState({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false, error: "", downloads: [], permissionRequests: [], tabs: [], activeTabId: null });
  const publishState = useCallback((next) => { setState(next); onStateChange?.(next); }, [onStateChange]);
  const [address, setAddress] = useState("");
  const addressDraftRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [confirmClearData, setConfirmClearData] = useState(false);
  const [profileDialog, setProfileDialog] = useState(false);
  const [profileUsage, setProfileUsage] = useState({});
  const [profileUsageLoading, setProfileUsageLoading] = useState(false);
  const [siteStorage, setSiteStorage] = useState(null);
  const [siteStorageLoading, setSiteStorageLoading] = useState(false);
  const [siteStorageError, setSiteStorageError] = useState("");
  const [siteInventory, setSiteInventory] = useState([]);
  const [siteInventoryLoading, setSiteInventoryLoading] = useState(false);
  const [measuringSiteOrigin, setMeasuringSiteOrigin] = useState("");
  const [siteToClear, setSiteToClear] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [deleteProfileId, setDeleteProfileId] = useState("");
  const [customViewportDialog, setCustomViewportDialog] = useState(false);
  const [customViewport, setCustomViewport] = useState({ width: 1024, height: 768 });
  const [emulationDialog, setEmulationDialog] = useState(false);
  const [emulationSettings, setEmulationSettings] = useState({ locale: "", network: "unthrottled", reducedMotion: "system" });
  const [diagnosticsDialog, setDiagnosticsDialog] = useState(false);
  const [diagnosticTab, setDiagnosticTab] = useState("console");
  const [diagnostics, setDiagnostics] = useState({ url: "", page: [], console: [], network: [] });
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const bridge = window.tribeDesktopBrowser;
  const scope = "workspace";
  const overlayOpen = profileDialog || customViewportDialog || emulationDialog || diagnosticsDialog || toolsMenuOpen;
  const overlayOpenRef = useRef(overlayOpen);
  overlayOpenRef.current = overlayOpen;
  const selectedProfile = (state.profiles ?? []).find((profile) => profile.id === state.selectedProfileId);
  const activeTabId = (state.tabs ?? []).find((tab) => tab.active)?.id;

  useEffect(() => {
    if (!toolsMenuOpen) return undefined;
    function dismissToolsMenu(event) {
      if (event.type === "keydown" && event.key === "Escape") setToolsMenuOpen(false);
      else if (event.type === "pointerdown" && !toolsMenuRef.current?.contains(event.target)) setToolsMenuOpen(false);
    }
    document.addEventListener("pointerdown", dismissToolsMenu);
    document.addEventListener("keydown", dismissToolsMenu);
    return () => {
      document.removeEventListener("pointerdown", dismissToolsMenu);
      document.removeEventListener("keydown", dismissToolsMenu);
    };
  }, [toolsMenuOpen]);

  useEffect(() => {
    if (!profileDialog || typeof bridge?.profileUsage !== "function") return undefined;
    let active = true;
    setProfileUsageLoading(true);
    void bridge.profileUsage().then((rows) => {
      if (active) setProfileUsage(Object.fromEntries(rows.map((row) => [row.profileId, row])));
    }).catch((cause) => {
      if (active) setError(cause?.message ?? "Browser profile storage could not be checked.");
    }).finally(() => {
      if (active) setProfileUsageLoading(false);
    });
    return () => { active = false; };
  }, [bridge, profileDialog]);

  useEffect(() => {
    if (!profileDialog || typeof bridge?.siteStorage !== "function") return undefined;
    if (!/^https?:\/\//i.test(state.url)) {
      setSiteStorage(null);
      setSiteStorageError("");
      setSiteStorageLoading(false);
      return undefined;
    }
    let active = true;
    setSiteStorageLoading(true);
    setSiteStorageError("");
    void bridge.siteStorage(scope).then((usage) => {
      if (active) setSiteStorage(usage);
    }).catch((cause) => {
      if (active) {
        setSiteStorage(null);
        setSiteStorageError(cause?.message ?? "This site's storage could not be checked.");
      }
    }).finally(() => {
      if (active) setSiteStorageLoading(false);
    });
    return () => { active = false; };
  }, [activeTabId, bridge, profileDialog, scope, state.url]);

  useEffect(() => {
    if (!profileDialog || typeof bridge?.siteInventory !== "function") return undefined;
    let active = true;
    setSiteInventoryLoading(true);
    void bridge.siteInventory(scope).then((sites) => {
      if (active) setSiteInventory(sites);
    }).catch((cause) => {
      if (active) setSiteStorageError(cause?.message ?? "Website data could not be loaded.");
    }).finally(() => {
      if (active) setSiteInventoryLoading(false);
    });
    return () => { active = false; };
  }, [bridge, profileDialog, scope, state.selectedProfileId, state.url]);

  const syncBounds = useCallback(() => {
    if (!bridge || !scope || !surfaceRef.current) return;
    if (!visible || overlayOpenRef.current) {
      void bridge.setBounds(scope, { x: 0, y: 0, width: 0, height: 0 }, false);
      return;
    }
    const rect = surfaceRef.current.getBoundingClientRect();
    const bounds = {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
    void bridge.setBounds(scope, bounds, rect.width > 0 && rect.height > 0);
  }, [bridge, scope, visible]);

  useEffect(() => {
    if (!bridge || !scope) return undefined;
    let active = true;
    const unsubscribe = bridge.subscribe(scope, (next) => {
      if (!active) return;
      publishState(next);
      setError(next.error ?? "");
      if (!addressDraftRef.current) setAddress(next.url || "");
    });
    void bridge.open(scope).then((next) => {
      if (!active) return;
      publishState(next);
      window.requestAnimationFrame(syncBounds);
    }).catch((cause) => setError(cause?.message ?? "The embedded browser could not start."));
    const resize = new ResizeObserver(syncBounds);
    if (surfaceRef.current) resize.observe(surfaceRef.current);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    const frame = window.requestAnimationFrame(syncBounds);
    return () => {
      active = false;
      resize.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      window.cancelAnimationFrame(frame);
      unsubscribe?.();
      bridge.hide(scope);
    };
  }, [bridge, scope, syncBounds, publishState]);

  useEffect(() => {
    if (!bridge || typeof bridge.onCommand !== "function") return undefined;
    return bridge.onCommand((command) => {
      if (command?.scope !== scope) return;
      if (command.action === "focus-address") {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      } else if (command.action === "show-downloads") {
        const button = downloadsControlRef.current?.querySelector("button");
        if (button) void openDownloads({ currentTarget: button });
      } else if (command.action === "show-tools") {
        setToolsMenuOpen(true);
      }
    });
  }, [bridge, scope]);

  useEffect(() => {
    syncBounds();
  }, [overlayOpen, syncBounds]);

  async function navigate(event) {
    event.preventDefault();
    if (!bridge || !scope) return;
    setBusy(true);
    setError("");
    try {
      const url = normaliseAddress(address);
      await bridge.navigate(scope, url);
      addressDraftRef.current = false;
      setAddress(url);
    } catch (cause) {
      setError(cause?.message ?? "The website could not be opened.");
    } finally {
      setBusy(false);
      syncBounds();
    }
  }

  function replaceAddress(value) {
    addressDraftRef.current = false;
    setAddress(value || "");
  }

  async function action(name) {
    if (!bridge || !scope) return;
    setBusy(true);
    try {
      await bridge.action(scope, name);
    } catch (cause) {
      setError(cause?.message ?? "The browser action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function resolvePermission(requestId, decision) {
    try {
      const next = await bridge.resolvePermission(scope, requestId, decision);
      publishState(next);
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "The website permission could not be updated.");
    }
  }

  async function setAgentControlPaused(paused) {
    try {
      const next = await bridge.setAgentControlPaused(scope, paused);
      publishState(next);
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "Browser agent control could not be updated.");
    }
  }

  async function setViewport(viewport) {
    if (!bridge || !scope) return;
    setToolsMenuOpen(false);
    if (viewport === "custom") {
      setCustomViewportDialog(true);
      return;
    }
    overlayOpenRef.current = false;
    syncBounds();
    try {
      const next = await bridge.setViewport(scope, viewport);
      publishState(next);
    } catch (cause) {
      setError(cause?.message ?? "The viewport could not be changed.");
    }
  }

  async function applyCustomViewport(event) {
    event.preventDefault();
    setCustomViewportDialog(false);
    overlayOpenRef.current = false;
    syncBounds();
    try {
      const next = await bridge.setViewport(scope, {
        width: Number(customViewport.width), height: Number(customViewport.height),
      });
      publishState(next);
      setCustomViewportDialog(false);
      setError("");
    } catch (cause) {
      setCustomViewportDialog(true);
      overlayOpenRef.current = true;
      syncBounds();
      setError(cause?.message ?? "The custom viewport could not be applied.");
    }
  }

  function openEmulationSettings() {
    setToolsMenuOpen(false);
    setEmulationSettings({ locale: state.locale || "", network: state.network || "unthrottled", reducedMotion: state.reducedMotion || "system" });
    setEmulationDialog(true);
  }

  async function applyEmulationSettings(event) {
    event.preventDefault();
    setEmulationDialog(false);
    overlayOpenRef.current = false;
    syncBounds();
    try {
      const next = await bridge.setViewport(scope, emulationSettings);
      publishState(next);
      setEmulationDialog(false);
      setError("");
    } catch (cause) {
      setEmulationDialog(true);
      overlayOpenRef.current = true;
      syncBounds();
      setError(cause?.message ?? "Page emulation settings could not be applied.");
    }
  }

  async function zoom(delta) {
    if (!bridge || !scope) return;
    try {
      const next = await bridge.setZoom(scope, delta);
      publishState(next);
    } catch (cause) {
      setError(cause?.message ?? "The page zoom could not be changed.");
    }
  }

  async function openDownloads(event) {
    try {
      const rect = event.currentTarget.getBoundingClientRect();
      const repositories = projects
        .filter((project) => project?.id && project?.name && project?.repository)
        .map(({ id, name, repository }) => ({ id, name, repository }));
      await bridge.showDownloads(repositories, { x: Math.round(rect.left), y: Math.round(rect.bottom) });
    } catch (cause) {
      setError(cause?.message ?? "Downloads could not be opened.");
    }
  }

  async function refreshDiagnostics() {
    setDiagnosticsLoading(true);
    try {
      setDiagnostics(await bridge.diagnostics(scope, 100));
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "Page diagnostics could not be loaded.");
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function openDiagnostics() {
    await refreshDiagnostics();
    setDiagnosticTab("page");
    setDiagnosticsDialog(true);
  }

  async function clearBrowsingData() {
    try {
      await bridge.clearData(scope, false);
      setConfirmClearData(false);
      setError("");
      const usage = await bridge.profileUsage();
      setProfileUsage(Object.fromEntries(usage.map((row) => [row.profileId, row])));
      setSiteInventory(await bridge.siteInventory(scope));
      if (/^https?:\/\//i.test(state.url)) setSiteStorage(await bridge.siteStorage(scope));
    } catch (cause) {
      setError(cause?.message ?? "Browser data could not be cleared.");
    }
  }

  async function clearSiteData(origin) {
    try {
      const sites = await bridge.clearSiteData(scope, origin);
      setSiteInventory(sites);
      setSiteToClear("");
      setSiteStorageError("");
      setError("");
      const usage = await bridge.profileUsage();
      setProfileUsage(Object.fromEntries(usage.map((row) => [row.profileId, row])));
      if (/^https?:\/\//i.test(state.url)) setSiteStorage(await bridge.siteStorage(scope));
    } catch (cause) {
      setError(cause?.message ?? "Site data could not be cleared.");
    }
  }

  async function estimateSiteStorage(origin) {
    if (measuringSiteOrigin) return;
    setMeasuringSiteOrigin(origin);
    try {
      const result = await bridge.siteInventory(scope, origin);
      const measuredSite = result.find((site) => site.origin === origin);
      if (!measuredSite) throw new Error("The site's storage estimate could not be loaded.");
      setSiteInventory((sites) => sites.map((site) => site.origin === origin ? measuredSite : site));
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "The site's storage estimate could not be loaded.");
    } finally {
      setMeasuringSiteOrigin("");
    }
  }

  async function createProfile(event) {
    event.preventDefault();
    try {
      const created = await bridge.createProfile(newProfileName);
      const next = await bridge.selectProfile(scope, created.id);
      publishState(next);
      replaceAddress("");
      setNewProfileName("");
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "The browser profile could not be created.");
    }
  }

  async function selectProfile(profileId) {
    try {
      const next = await bridge.selectProfile(scope, profileId);
      publishState(next);
      replaceAddress("");
      setProfileDialog(false);
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "The browser profile could not be selected.");
    }
  }

  async function deleteProfile(profileId) {
    try {
      await bridge.deleteProfile(profileId);
      const next = await bridge.state(scope);
      publishState(next);
      replaceAddress(next.url);
      setDeleteProfileId("");
      setError("");
    } catch (cause) {
      setError(cause?.message ?? "The browser profile could not be deleted.");
    }
  }

  if (!bridge) return <section aria-label="Browser" className="tribe-browser">
    <div className="tribe-browser-unavailable"><Globe size={24} /><strong>Use Tribe desktop to browse websites</strong><span>The web preview cannot host a real browser view. Open this chat in the desktop app to load pages directly inside Tribe.</span></div>
  </section>;

  return <section aria-label="Browser" className="tribe-browser">
    <form aria-label="Browser navigation" className="tribe-browser-toolbar" onSubmit={(event) => void navigate(event)}>
      <div aria-label="Page navigation" className="tribe-browser-navigation-actions">
        <IconButton disabled={!state.url || busy || !state.canGoBack} label="Go back" onClick={() => void action("back")} type="button"><ArrowLeft size={16} /></IconButton>
        <IconButton disabled={!state.url || busy || !state.canGoForward} label="Go forward" onClick={() => void action("forward")} type="button"><ArrowRight size={16} /></IconButton>
        <IconButton disabled={!state.url || busy} label={state.loading ? "Stop loading" : "Reload page"} onClick={() => void action(state.loading ? "stop" : "reload")} type="button">{state.loading ? <Stop size={15} /> : <ArrowClockwise size={16} />}</IconButton>
      </div>
      <label className="tribe-browser-address"><Globe aria-hidden="true" size={15} /><input aria-label="Browser address" autoComplete="url" ref={addressInputRef} onChange={(event) => { addressDraftRef.current = true; setAddress(event.target.value); }} onFocus={(event) => event.currentTarget.select()} placeholder="Enter a website address" spellCheck="false" value={address} /></label>
      <div className="tribe-browser-downloads-control" ref={downloadsControlRef}>
        <IconButton aria-haspopup="menu" label={`Downloads${state.downloads?.length ? ` · ${state.downloads.length}` : ""}`} onClick={(event) => void openDownloads(event)} type="button"><DownloadSimple size={16} />{state.downloads?.length > 0 && <span className="tribe-browser-downloads-count">{state.downloads.length}</span>}</IconButton>
      </div>
      <div className="tribe-browser-tools-wrap" ref={toolsMenuRef}>
        <IconButton aria-expanded={toolsMenuOpen} aria-haspopup="menu" label="Browser tools" onClick={() => setToolsMenuOpen((open) => !open)} type="button"><DotsThree size={20} weight="bold" /></IconButton>
        {toolsMenuOpen && <div aria-label="Browser tools" className="tribe-browser-tools-menu" role="menu">
          <label className="tribe-browser-tools-field">Viewport
            <SelectControl aria-label="Browser viewport" onChange={(value) => void setViewport(value)} options={[{ value: "responsive", label: "Responsive" }, { value: "iphone-15", label: "iPhone 15" }, { value: "pixel-7", label: "Pixel 7" }, { value: "ipad-mini", label: "iPad mini" }, { value: "laptop-1280", label: "1280 × 800" }, { value: "custom", label: state.customViewport ? `Custom ${state.customViewport.width} × ${state.customViewport.height}` : "Custom size…" }]} size="full" value={state.viewport ?? "responsive"} />
          </label>
          {(state.agentControlActive || state.agentControlPaused) && <button onClick={() => { setToolsMenuOpen(false); void setAgentControlPaused(!state.agentControlPaused); }} role="menuitem" type="button">
            {state.agentControlPaused ? <ArrowClockwise size={15} /> : <Stop size={15} />}
            {state.agentControlPaused ? "Resume agent control" : "Stop agent control"}
          </button>}
          <button onClick={() => openEmulationSettings()} role="menuitem" type="button"><SlidersHorizontal size={15} />Page emulation</button>
          <button onClick={() => { setToolsMenuOpen(false); setProfileDialog(true); }} role="menuitem" type="button"><Globe size={15} />Profiles and site data <small>{state.profileName || "Temporary"}</small></button>
          <button onClick={() => { setToolsMenuOpen(false); void openDiagnostics(); }} role="menuitem" type="button"><Bug size={15} />Page diagnostics</button>
          <button onClick={() => { setToolsMenuOpen(false); setConfirmClearData(true); }} role="menuitem" type="button"><Eraser size={15} />Clear browser data</button>
        </div>}
      </div>
    </form>
    {(state.permissionRequests ?? []).map((request) => <div className="tribe-browser-permission" key={request.id} role="group" aria-label="Website permission request">
      <div><strong>{request.origin}</strong><span>wants to {request.label}.{request.canRemember ? " Save a choice to this profile, or decide once." : " Create or select a saved profile to remember a choice."}</span></div>
      <button onClick={() => void resolvePermission(request.id, "block-once")} type="button">Block</button>
      <button onClick={() => void resolvePermission(request.id, "allow-once")} type="button">Allow once</button>
      {request.canRemember && <><button onClick={() => void resolvePermission(request.id, "block-profile")} type="button">Always block</button><button onClick={() => void resolvePermission(request.id, "allow-profile")} type="button">Always allow</button></>}
    </div>)}
    {customViewportDialog && <div className="tribe-browser-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCustomViewportDialog(false); }}>
      <form aria-labelledby="tribe-browser-custom-viewport-title" aria-modal="true" className="tribe-browser-profile-dialog tribe-browser-custom-viewport" onSubmit={(event) => void applyCustomViewport(event)} role="dialog">
        <header><div><h2 id="tribe-browser-custom-viewport-title">Custom viewport</h2><p>Set the page dimensions for responsive checks.</p></div><IconButton label="Close custom viewport" onClick={() => setCustomViewportDialog(false)} type="button"><X size={16} /></IconButton></header>
        <div className="tribe-browser-custom-fields">
          <label>Width<input inputMode="numeric" onChange={(event) => setCustomViewport((value) => ({ ...value, width: event.target.value }))} placeholder="240–3840" required type="text" value={customViewport.width} /></label>
          <label>Height<input inputMode="numeric" onChange={(event) => setCustomViewport((value) => ({ ...value, height: event.target.value }))} placeholder="240–3840" required type="text" value={customViewport.height} /></label>
        </div>
        <footer><button onClick={() => setCustomViewportDialog(false)} type="button">Cancel</button><button type="submit">Apply viewport</button></footer>
      </form>
    </div>}
    {emulationDialog && <div className="tribe-browser-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEmulationDialog(false); }}>
      <form aria-labelledby="tribe-browser-emulation-title" aria-modal="true" className="tribe-browser-profile-dialog tribe-browser-custom-viewport" onSubmit={(event) => void applyEmulationSettings(event)} role="dialog">
        <header><div><h2 id="tribe-browser-emulation-title">Page emulation</h2><p>Set this tab’s language, motion preference and network connection.</p></div><IconButton label="Close page emulation" onClick={() => setEmulationDialog(false)} type="button"><X size={16} /></IconButton></header>
        <div className="tribe-browser-custom-fields tribe-browser-emulation-fields">
          <label>Locale<SelectControl onChange={(locale) => setEmulationSettings((value) => ({ ...value, locale }))} options={[{ value: "", label: "System default" }, { value: "en-AU", label: "English · Australia" }, { value: "en-US", label: "English · United States" }, { value: "en-GB", label: "English · United Kingdom" }, { value: "fr-FR", label: "French · France" }, { value: "de-DE", label: "German · Germany" }, { value: "ja-JP", label: "Japanese · Japan" }]} size="full" value={emulationSettings.locale} /></label>
          <label>Network<SelectControl onChange={(network) => setEmulationSettings((value) => ({ ...value, network }))} options={[{ value: "unthrottled", label: "No throttling" }, { value: "fast-3g", label: "Fast 3G" }, { value: "slow-3g", label: "Slow 3G" }, { value: "4g", label: "4G" }, { value: "offline", label: "Offline" }]} size="full" value={emulationSettings.network} /></label>
          <label>Reduced motion<SelectControl onChange={(reducedMotion) => setEmulationSettings((value) => ({ ...value, reducedMotion }))} options={[{ value: "system", label: "System default" }, { value: "reduce", label: "Reduce motion" }, { value: "no-preference", label: "No preference" }]} size="full" value={emulationSettings.reducedMotion} /></label>
        </div>
        <p className="settings-note">Device presets emulate viewport, touch and browser identity; they do not run a mobile operating system. Reload a page after changing its locale or motion preference.</p>
        <footer><button onClick={() => setEmulationDialog(false)} type="button">Cancel</button><button type="submit">Apply to this tab</button></footer>
      </form>
    </div>}
    {diagnosticsDialog && <div className="tribe-browser-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDiagnosticsDialog(false); }}>
      <section aria-labelledby="tribe-browser-diagnostics-title" aria-modal="true" className="tribe-browser-profile-dialog tribe-browser-diagnostics-dialog" role="dialog">
        <header><div><h2 id="tribe-browser-diagnostics-title">Page diagnostics</h2><p title={diagnostics.url}>{diagnostics.url || "Current browser tab"}</p></div><div className="tribe-browser-dialog-actions"><IconButton disabled={diagnosticsLoading} label="Refresh diagnostics" onClick={() => void refreshDiagnostics()} type="button"><ArrowClockwise className={diagnosticsLoading ? "spin" : ""} size={15} /></IconButton><IconButton label="Close page diagnostics" onClick={() => setDiagnosticsDialog(false)} type="button"><X size={16} /></IconButton></div></header>
        <nav aria-label="Diagnostic type" className="tribe-browser-diagnostics-tabs" role="tablist">
          <button aria-selected={diagnosticTab === "page"} onClick={() => setDiagnosticTab("page")} role="tab" type="button">Page <span>{diagnostics.page?.length ?? 0}</span></button>
          <button aria-selected={diagnosticTab === "console"} onClick={() => setDiagnosticTab("console")} role="tab" type="button">Console <span>{diagnostics.console?.length ?? 0}</span></button>
          <button aria-selected={diagnosticTab === "network"} onClick={() => setDiagnosticTab("network")} role="tab" type="button">Network <span>{diagnostics.network?.length ?? 0}</span></button>
        </nav>
        <div aria-live="polite" className="tribe-browser-diagnostics-list" role="tabpanel">
          {diagnosticTab === "page" ? (diagnostics.page?.length
            ? [...diagnostics.page].reverse().map((item, index) => <article className={`tribe-browser-diagnostic-row is-${String(item.event || "page").toLowerCase()}`} key={`${item.timestamp}:${index}`}>
              <span>{String(item.event || "page").replaceAll("-", " ").toUpperCase()}</span><div><p>{item.message || "Page event"}</p><small>{item.url || "Current page"}{item.httpStatusCode ? ` · HTTP ${item.httpStatusCode}${item.httpStatusText ? ` ${item.httpStatusText}` : ""}` : ""}{item.errorCode !== undefined && item.errorCode !== null ? ` · Error ${item.errorCode}` : ""} · {new Date(item.timestamp).toLocaleTimeString()}</small></div>
            </article>)
            : <p className="tribe-browser-diagnostics-empty">No page events recorded for this tab.</p>) : diagnosticTab === "console" ? (diagnostics.console?.length
            ? [...diagnostics.console].reverse().map((item, index) => <article className={`tribe-browser-diagnostic-row is-${String(item.level || "info").toLowerCase()}`} key={`${item.timestamp}:${index}`}>
              <span>{String(item.level || "info").toUpperCase()}</span><div><p>{item.message || "Console entry"}</p><small>{item.source || "Page console"}{item.line ? ` · line ${item.line}` : ""} · {new Date(item.timestamp).toLocaleTimeString()}</small></div>
            </article>)
            : <p className="tribe-browser-diagnostics-empty">No console entries recorded for this tab.</p>) : (diagnostics.network?.length
            ? [...diagnostics.network].reverse().map((item, index) => <article className={`tribe-browser-diagnostic-row is-${String(item.status).toLowerCase()}`} key={`${item.timestamp}:${index}`}>
              <span>{item.method || "GET"} · {item.status ?? "pending"}</span><div><p>{item.url || "Website request"}</p><small>{item.resourceType || "request"}{Number.isFinite(item.durationMs) ? ` · ${item.durationMs} ms` : ""} · {new Date(item.timestamp).toLocaleTimeString()}{item.error ? ` · ${item.error}` : ""}</small></div>
            </article>)
            : <p className="tribe-browser-diagnostics-empty">No network requests recorded for this tab.</p>)}
        </div>
      </section>
    </div>}
    {profileDialog && <div className="tribe-browser-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileDialog(false); }}>
      <section aria-labelledby="tribe-browser-profiles-title" aria-modal="true" className="tribe-browser-profile-dialog" role="dialog">
        <header><div><h2 id="tribe-browser-profiles-title">Browser profiles</h2><p>Profiles keep website sign-ins and site data between Tribe sessions.</p></div><IconButton label="Close browser profiles" onClick={() => setProfileDialog(false)} type="button"><X size={16} /></IconButton></header>
        <div className="tribe-browser-profile-list">
          <div className={`tribe-browser-profile-row${state.temporary ? " is-selected" : ""}`}>
            <div><strong>Temporary</strong><span>Cleared when Tribe closes.</span></div>
            <button disabled={state.temporary} onClick={() => void selectProfile("")} type="button">{state.temporary ? "In use" : "Use"}</button>
          </div>
          {(state.profiles ?? []).map((profile) => <div className={`tribe-browser-profile-row${state.selectedProfileId === profile.id ? " is-selected" : ""}`} key={profile.id}>
            <div><strong>{profile.name}</strong><span>{state.selectedProfileId === profile.id ? "In use" : "Saved on this device"} · {profileUsageLoading ? "Checking storage…" : formatStorageEstimate(profileUsage[profile.id]) || "Storage estimate unavailable"}</span></div>
            <div className="tribe-browser-profile-row-actions">
              <button disabled={state.selectedProfileId === profile.id} onClick={() => void selectProfile(profile.id)} type="button">{state.selectedProfileId === profile.id ? "In use" : "Use"}</button>
              <IconButton label={`Delete ${profile.name} profile`} onClick={() => setDeleteProfileId(profile.id)} type="button"><Trash size={14} /></IconButton>
            </div>
          </div>)}
        </div>
        <section aria-label="Current site storage" className="tribe-browser-site-storage">
          <div className="tribe-browser-site-storage-heading"><h3>Current site storage</h3>{siteStorage?.origin && <span title={siteStorage.origin}>{siteStorage.origin}</span>}</div>
          {!/^https?:\/\//i.test(state.url)
            ? <p>Open a website to view its storage.</p>
            : siteStorageLoading
              ? <p>Checking this site’s storage…</p>
              : siteStorageError
                ? <p role="status">{siteStorageError}</p>
                : siteStorage
                  ? <>
                    <div className="tribe-browser-site-storage-total"><span>Estimated total</span><strong>{formatStorageBytes(siteStorage.bytes)}</strong>{siteStorage.quotaBytes > 0 && <small>of {formatStorageBytes(siteStorage.quotaBytes)} available</small>}</div>
                    {siteStorage.breakdown?.length
                      ? <div className="tribe-browser-site-storage-breakdown">{siteStorage.breakdown.map((item) => <div key={item.type}><span>{siteStorageLabels[item.type] ?? "Other"}</span><strong>{formatStorageBytes(item.bytes)}</strong></div>)}</div>
                      : <p>No site storage categories were reported.</p>}
                  </>
                  : <p>Storage information is unavailable for this page.</p>}
          <div aria-label="Browser site data inventory" className="tribe-browser-site-origins">
            <div className="tribe-browser-site-origins-heading"><h3>Site data in this {state.temporary ? "session" : "profile"}</h3><span>Includes embedded and API origins</span></div>
            {siteInventoryLoading
              ? <p>Loading sites…</p>
              : siteInventory.length
                ? siteInventory.map((site) => <div className="tribe-browser-site-origin" key={site.origin}>
                  <span><strong title={site.origin}>{site.origin}</strong><small>{measuringSiteOrigin === site.origin ? "Measuring…" : site.estimateStatus === "not-measured" ? "Not measured" : site.bytes == null ? "Estimate unavailable" : formatStorageBytes(site.bytes)}</small></span>
                  <div className="tribe-browser-site-origin-actions">
                    {site.estimateStatus !== "measured" && <IconButton disabled={Boolean(measuringSiteOrigin)} label={`${site.estimateStatus === "unavailable" ? "Retry" : "Estimate"} storage for ${site.origin}`} onClick={() => void estimateSiteStorage(site.origin)} type="button"><ArrowClockwise size={13} /></IconButton>}
                    <IconButton label={`Clear site data for ${site.origin}`} onClick={() => setSiteToClear(site.origin)} type="button"><Trash size={14} /></IconButton>
                  </div>
                </div>)
                : <p>Open a website to add it here.</p>}
            <p className="tribe-browser-site-origins-note">Recent sites are estimated automatically. Use the estimate control to check other sites.</p>
          </div>
          {siteToClear && <div aria-label="Confirm site data removal" className="tribe-browser-site-confirm" role="alertdialog">
            <span>Clear cookies and site storage for <strong>{siteToClear}</strong>? This may sign you out.</span>
            <button onClick={() => setSiteToClear("")} type="button">Cancel</button>
            <button onClick={() => void clearSiteData(siteToClear)} type="button">Clear site data</button>
          </div>}
        </section>
        {state.selectedProfileId && <section aria-label="Saved website permissions" className="tribe-browser-saved-permissions">
          <h3>Saved website permissions</h3>
          {selectedProfile?.permissions?.length
            ? selectedProfile.permissions.map((rule) => <div className="tribe-browser-saved-permission" key={`${rule.origin}:${rule.permission}`}>
              <span><strong>{rule.origin}</strong><small>{rule.permission.replaceAll("-", " ")} · {rule.decision === "allow" ? "Always allow" : "Always block"}</small></span>
              <IconButton label={`Remove ${rule.permission} rule for ${rule.origin}`} onClick={async () => {
                try {
                  const next = await bridge.removePermission(scope, state.selectedProfileId, rule.origin, rule.permission);
                  publishState(next);
                } catch (cause) {
                  setError(cause?.message ?? "The saved website permission could not be removed.");
                }
              }} type="button"><X size={14} /></IconButton>
            </div>)
            : <p>No saved site permissions. Websites will ask before using protected features.</p>}
        </section>}
        {deleteProfileId && <div className="tribe-browser-profile-delete" role="alertdialog" aria-label="Confirm profile deletion">
          <span>Delete this profile and its saved site data? Open tabs using it will close.</span>
          <button onClick={() => setDeleteProfileId("")} type="button">Cancel</button>
          <button onClick={() => void deleteProfile(deleteProfileId)} type="button">Delete profile</button>
        </div>}
        <form className="tribe-browser-profile-create" onSubmit={(event) => void createProfile(event)}>
          <label htmlFor="tribe-browser-profile-name">Create a profile</label>
          <div><input id="tribe-browser-profile-name" maxLength={48} onChange={(event) => setNewProfileName(event.target.value)} placeholder="Profile name" value={newProfileName} /><button disabled={!newProfileName.trim()} type="submit">Create and use</button></div>
        </form>
      </section>
    </div>}
    {confirmClearData && <div aria-labelledby="tribe-browser-clear-title" aria-modal="true" className="tribe-browser-confirm" role="alertdialog">
      <div><strong id="tribe-browser-clear-title">Clear browser data?</strong><span>This removes cookies, cache and saved site data for the selected profile. You may be signed out of websites.</span></div>
      <div><button className="tribe-browser-confirm-cancel" onClick={() => setConfirmClearData(false)} type="button">Cancel</button><button className="tribe-browser-confirm-clear" onClick={() => void clearBrowsingData()} type="button">Clear data</button></div>
    </div>}
    {error && <div className="tribe-browser-notice" role="alert"><WarningCircle size={15} />{error}</div>}
    <div className={`tribe-browser-page${!state.url || state.url === "about:blank" ? " is-new-tab" : ""}${state.viewport && state.viewport !== "responsive" ? " has-emulated-viewport" : ""}${overlayOpen ? " has-native-overlay" : ""}`} ref={surfaceRef}>
      {!state.url || state.url === "about:blank" ? <div className="tribe-browser-empty"><Globe size={22} /><strong>Your browser is ready</strong><span>Enter a website address above. Pages open directly inside Tribe.</span></div> : null}
      {state.pageStopped && <div className="tribe-browser-page-stopped" role="alert"><Globe size={22} /><strong>This page stopped unexpectedly</strong><span>Reload it to continue browsing.</span><button className="button" onClick={() => void action("reload")} type="button"><ArrowClockwise size={15} />Reload page</button></div>}
    </div>
    <footer className="tribe-browser-status"><span className={state.agentControlActive || state.agentControlPaused ? "tribe-browser-agent-active" : ""}>{state.agentControlPaused ? "Agent control paused" : state.agentControlActive ? "Agent is using this page" : state.pageStopped ? "Page stopped" : state.loading ? "Loading page" : state.title || "Browser ready"}</span><span className="tribe-browser-status-actions">
      {state.url && state.url !== "about:blank" && <><button aria-label="Zoom out" onClick={() => void zoom(-1)} title="Zoom out" type="button">−</button><span>{Math.round(100 * (1.2 ** (state.zoomLevel ?? 0)))}%</span><button aria-label="Zoom in" onClick={() => void zoom(1)} title="Zoom in" type="button">+</button></>}
      {state.viewportSize && <span>Page · {state.viewportSize.width} × {state.viewportSize.height} · DPR {Math.round((Number(state.viewportSize.deviceScaleFactor) || 1) * 100) / 100}{state.viewportSize.touch ? " · Touch" : ""}</span>}
      <span className="tribe-browser-profile-status" title={state.temporary ? "Temporary profile · cleared when Tribe closes" : `Browser profile · ${state.profileName}`}>{state.temporary ? "Temporary profile" : `Profile · ${state.profileName}`}</span>
    </span></footer>
  </section>;
}
