const { app, BrowserWindow, Menu, View, WebContentsView, dialog, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {
  browserRequestAllowed,
  normaliseBrowserDomains,
} = require("./browser-policy.cjs");
const {
  getPermissionRule,
  normalisePermissionOrigin,
  removePermissionRule,
  setPermissionRule,
} = require("./browser-permissions.cjs");
const {
  boundedDiagnosticLimit,
  sanitiseDiagnosticMessage,
  sanitiseDiagnosticUrl,
} = require("./browser-diagnostics.cjs");
const { estimateDirectoryBytes, forgetSiteOrigin, normaliseSiteOrigin, normaliseSiteOrigins, normaliseSiteStorage, rememberSiteOrigin, shouldTrackSiteOriginResourceType } = require("./browser-storage.cjs");
const { moveManagedDownloadToRepository } = require("./browser-downloads.cjs");
const { faviconDataUrl, normaliseFaviconUrl } = require("./browser-favicons.cjs");
const { syncDeviceEmulation, deviceProfileFor, normalizeLocale, normalizeNetworkProfile, normalizeReducedMotion } = require("./browser-device-emulation.cjs");
const { resolveViewport, viewportBounds, VIEWPORT_PRESETS } = require("./browser-viewport.cjs");
const { waitForBrowserPaint } = require("./browser-paint.cjs");
const { shouldShowBrowserHost } = require("./browser-visibility.cjs");
const { createBrowserAgentControl } = require("./browser-agent-control.cjs");
const { normaliseBrowserSessionRecord, normaliseBrowserSessionStore, safeSessionUrl } = require("./browser-sessions.cjs");
const { normaliseFileSelection, validateUploadTarget } = require("./browser-upload.cjs");
const { authorizeBrowserAction, browserActionRequiresHandoff, classifyBrowserAction } = require("./browser-approvals.cjs");
const { browserShortcutForInput } = require("./browser-shortcuts.cjs");
const { readDesignReference } = require("./browser-design-reference.cjs");
app.setName(process.env.TRIBE_BROWSER_E2E === "1" ? "Tribe Browser E2E" : "Tribe");
if (process.env.TRIBE_ELECTRON_DATA_DIR) {
  const electronDataDirectory = path.resolve(process.env.TRIBE_ELECTRON_DATA_DIR);
  fs.mkdirSync(electronDataDirectory, { recursive: true, mode: 0o700 });
  app.setPath("userData", electronDataDirectory);
}
let browserApiPort = Number(process.env.TRIBE_BROWSER_API_PORT || 0);
let browserApiToken = "";
delete process.env.TRIBE_BROWSER_API_TOKEN;
delete process.env.TRIBE_BROWSER_API_PORT;

const browserViews = new Map();
const browserHosts = new Map();
const browserTabs = new Map();
const activeBrowserTabs = new Map();
const previousActiveBrowserTabs = new Map();
const browserVisitedSites = new Map();
const MAX_MEASURED_SITE_ORIGINS = 40;
const SITE_ORIGIN_RECORD_COOLDOWN_MS = 60_000;
const browserBounds = new Map();
const browserState = new Map();
const browserDiagnostics = new Map();
const browserDiagnosticRequests = new Map();
const browserRequestPolicies = new Map();
const configuredBrowserSessions = new WeakSet();
const browserContentsOwners = new Map();
const pendingBrowserPermissions = new Map();
const downloadItems = new Map();
const browserAgentTimers = new Map();
const browserAgentControl = createBrowserAgentControl();
const browserAgentRequests = new Map();
const browserSessionTimers = new Map();
const browserSessionRestoring = new Set();
const browserSessionRestorePromises = new Map();
let browserProfileStore;
let browserDownloadStore;
let browserSessionStore;
let mainWindow;
let browserAutomationServer;
let runtimeChild;
let runtimeLog;
let packagedUiServer;
let packagedUiUrl = "";
let runtimePort = Number(process.env.TRIBE_PORT || 4317);
let appIsQuitting = false;

function runBrowserShortcut(action, scope = "workspace") {
  const tabs = tabsFor(scope);
  const ids = [...tabs.keys()];
  const tabId = activeTabId(scope);
  const tab = tabs.get(tabId);
  const contents = tab?.view.webContents;
  if (action === "new-tab") {
    void createBrowserTab(scope).catch((error) => publish(scope, { error: error.message }));
    return;
  }
  if (action === "focus-address" || action === "show-downloads" || action === "show-tools") {
    mainWindow?.webContents.send("tribe:browser-command", { scope, action });
    return;
  }
  if (!tab || !contents || contents.isDestroyed()) return;
  if (["back", "forward", "reload", "hard-reload"].includes(action)) {
    clearAgentRequestPolicy(scope, tabId);
    tab.agentAllowedDomains = null;
  }
  if (action === "close-tab") {
    closeBrowserTab(scope, tabId);
  } else if (action === "next-tab" || action === "previous-tab") {
    if (ids.length < 2) return;
    const current = ids.indexOf(tabId);
    const offset = action === "next-tab" ? 1 : -1;
    activateBrowserTab(scope, ids[(current + offset + ids.length) % ids.length]);
  } else if (action.startsWith("select-tab-")) {
    const index = Number(action.slice("select-tab-".length)) - 1;
    if (ids[index]) activateBrowserTab(scope, ids[index]);
  } else if (action === "back" && contents.navigationHistory.canGoBack()) {
    contents.navigationHistory.goBack();
  } else if (action === "forward" && contents.navigationHistory.canGoForward()) {
    contents.navigationHistory.goForward();
  } else if (action === "reload") {
    reloadBrowserTab(scope, tabId);
  } else if (action === "hard-reload") {
    contents.reloadIgnoringCache();
  } else if (action === "zoom-in" || action === "zoom-out" || action === "reset-zoom") {
    const delta = action === "zoom-in" ? 1 : action === "zoom-out" ? -1 : -(tab.userZoomLevel || 0);
    tab.userZoomLevel = action === "reset-zoom" ? 0 : Math.max(-5, Math.min(10, (tab.userZoomLevel || 0) + delta));
    contents.setZoomFactor(1.2 ** tab.userZoomLevel);
    publish(scope, { zoomLevel: tab.userZoomLevel });
    scheduleBrowserSessionSave(scope);
  }
}

function installMacApplicationMenu() {
  if (process.platform !== "darwin") return;
  const run = (action) => () => runBrowserShortcut(action);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { label: "File", submenu: [
      { id: "tribe-browser-new-tab", label: "New Browser Tab", accelerator: "CmdOrCtrl+T", enabled: false, click: run("new-tab") },
      { id: "tribe-browser-close-tab", label: "Close Browser Tab", accelerator: "CmdOrCtrl+W", enabled: false, click: run("close-tab") },
    ] },
    { role: "editMenu" },
    { label: "Go", submenu: [
      { id: "tribe-browser-back", label: "Back", accelerator: "CmdOrCtrl+[", enabled: false, click: run("back") },
      { id: "tribe-browser-forward", label: "Forward", accelerator: "CmdOrCtrl+]", enabled: false, click: run("forward") },
      { type: "separator" },
      { id: "tribe-browser-focus-address", label: "Focus Address Bar", accelerator: "CmdOrCtrl+L", enabled: false, click: run("focus-address") },
      { id: "tribe-browser-show-downloads", label: "Show Downloads", enabled: false, click: run("show-downloads") },
    ] },
    { label: "View", submenu: [
      { id: "tribe-browser-reload", label: "Reload Page", accelerator: "CmdOrCtrl+R", enabled: false, click: run("reload") },
      { id: "tribe-browser-hard-reload", label: "Force Reload Page", accelerator: "Shift+CmdOrCtrl+R", enabled: false, click: run("hard-reload") },
      { type: "separator" },
      { id: "tribe-browser-zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+Plus", enabled: false, click: run("zoom-in") },
      { id: "tribe-browser-zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", enabled: false, click: run("zoom-out") },
      { id: "tribe-browser-reset-zoom", label: "Actual Size", accelerator: "CmdOrCtrl+0", enabled: false, click: run("reset-zoom") },
      { type: "separator" },
      { id: "tribe-browser-show-tools", label: "Browser Tools", enabled: false, click: run("show-tools") },
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [] },
  ]));
  updateBrowserMenuState();
}

function updateBrowserMenuState() {
  if (process.platform !== "darwin") return;
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const active = Boolean(browserBounds.get("workspace")?.visible && tabsFor("workspace").size);
  for (const id of [
    "tribe-browser-new-tab", "tribe-browser-close-tab", "tribe-browser-focus-address",
    "tribe-browser-show-downloads", "tribe-browser-reload", "tribe-browser-hard-reload",
    "tribe-browser-back", "tribe-browser-forward", "tribe-browser-zoom-in",
    "tribe-browser-zoom-out", "tribe-browser-reset-zoom", "tribe-browser-show-tools",
  ]) {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = active;
  }
  const back = menu.getMenuItemById("tribe-browser-back");
  const forward = menu.getMenuItemById("tribe-browser-forward");
  const state = active ? publicBrowserState("workspace") : null;
  if (back) back.enabled = Boolean(state?.canGoBack);
  if (forward) forward.enabled = Boolean(state?.canGoForward);
}

function safeUrl(value) {
  const parsed = new URL(String(value ?? ""));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Browser addresses must be HTTP or HTTPS URLs without embedded credentials.");
  }
  return parsed.href;
}

function stateFor(scope) {
  return browserState.get(scope) ?? {
    scope, url: "", title: "", loading: false, canGoBack: false,
    canGoForward: false, error: "", pageStopped: false, downloads: downloadsFor(scope), viewport: "responsive", zoomLevel: 0,
    activeTabId: "", tabs: [], permissionRequests: [], agentControlPaused: false, agentControlActive: false,
  };
}

function permissionRequestsFor(scope) {
  return [...pendingBrowserPermissions.values()]
    .filter((request) => request.scope === scope)
    .map(({ id, origin, permission, label }) => ({
      id, origin, permission, label,
      canRemember: Boolean(publicProfileState(scope).selectedProfileId),
    }));
}

function permissionRuleForScope(scope, origin, permission) {
  const store = loadBrowserProfileStore();
  const profileId = store.assignments[scope];
  const profile = store.profiles.find((item) => item.id === profileId);
  return getPermissionRule(profile?.permissions, origin, permission);
}

function diagnosticsFor(scope, tabId, limit = 50) {
  const diagnostics = browserDiagnostics.get(scope) || { page: [], console: [], network: [] };
  const boundedLimit = boundedDiagnosticLimit(limit);
  const recent = (rows) => rows.filter((row) => row.tabId === tabId).slice(-boundedLimit)
    .map(({ tabId: _tabId, requestId: _requestId, ...row }) => row);
  return {
    page: recent(diagnostics.page),
    console: recent(diagnostics.console),
    network: recent(diagnostics.network),
  };
}

function clearBrowserTabDiagnostics(scope, tabId) {
  const diagnostics = browserDiagnostics.get(scope);
  if (diagnostics) {
    diagnostics.page = diagnostics.page.filter((row) => row.tabId !== tabId);
    diagnostics.console = diagnostics.console.filter((row) => row.tabId !== tabId);
    diagnostics.network = diagnostics.network.filter((row) => row.tabId !== tabId);
    browserDiagnostics.set(scope, diagnostics);
  }
  for (const [requestId, request] of browserDiagnosticRequests) {
    if (request.scope === scope && request.tabId === tabId) browserDiagnosticRequests.delete(requestId);
  }
}

function appendBrowserDiagnostic(scope, category, entry, limit) {
  const diagnostics = browserDiagnostics.get(scope) || { page: [], console: [], network: [] };
  const rows = diagnostics[category];
  const timestamp = Date.now();
  const existingIndex = entry.requestId ? rows.findIndex((row) => row.requestId === entry.requestId) : -1;
  if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...entry, timestamp };
  else rows.push({ ...entry, timestamp });
  if (rows.length > limit) rows.splice(0, rows.length - limit);
  browserDiagnostics.set(scope, diagnostics);
}

function revealManagedDownload(id) {
  const filename = downloadItems.get(id);
  if (!filename || !managedDownloadPath(filename) || !fs.existsSync(filename)) throw new Error("The download is no longer available.");
  shell.showItemInFolder(filename);
  return true;
}

function saveBrowserPermissionRule(profileId, origin, permission, decision) {
  const store = loadBrowserProfileStore();
  const profile = store.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("Choose a saved browser profile to remember website permissions.");
  profile.permissions = setPermissionRule(profile.permissions, origin, permission, decision);
  saveBrowserProfileStore();
}

function resolveBrowserPermission(id, decision) {
  const request = pendingBrowserPermissions.get(id);
  if (!request) return false;
  const rememberedDecision = decision === "allow-profile" ? "allow"
    : decision === "block-profile" ? "block" : "";
  let error = "";
  if (rememberedDecision) {
    const profileId = loadBrowserProfileStore().assignments[request.scope];
    try {
      if (!profileId) throw new Error("Select a saved browser profile before remembering website permissions.");
      saveBrowserPermissionRule(profileId, request.origin, request.permission, rememberedDecision);
    } catch (cause) {
      error = cause?.message || "The website permission could not be saved.";
      decision = "block-once";
    }
  }
  pendingBrowserPermissions.delete(id);
  clearTimeout(request.timer);
  request.callback(decision === "allow-once" || decision === "allow-profile");
  publish(request.scope, { permissionRequests: permissionRequestsFor(request.scope), error });
  return true;
}

function requestBrowserPermission(contents, permission, callback, details = {}) {
  const owner = browserContentsOwners.get(contents.id);
  if (!owner) {
    callback(false);
    return;
  }
  const labels = {
    "clipboard-read": "read the clipboard",
    "display-capture": "capture the screen",
    geolocation: "access your location",
    media: "use your camera or microphone",
    notifications: "send notifications",
  };
  const origin = normalisePermissionOrigin(details.securityOrigin || details.requestingUrl || contents.getURL()) || "This website";
  const decision = permissionRuleForScope(owner.scope, origin, permission);
  if (decision) {
    callback(decision === "allow");
    return;
  }
  const id = crypto.randomUUID();
  const request = {
    id, scope: owner.scope, tabId: owner.tabId, origin, permission,
    label: labels[permission] || `use ${String(permission).replaceAll("-", " ")}`,
    callback, timer: null,
  };
  request.timer = setTimeout(() => resolveBrowserPermission(id, false), 60_000);
  request.timer.unref?.();
  pendingBrowserPermissions.set(id, request);
  publish(owner.scope, { permissionRequests: permissionRequestsFor(owner.scope) });
}

function viewKey(scope, tabId) { return `${scope}:${tabId}`; }

function tabsFor(scope) {
  let tabs = browserTabs.get(scope);
  if (!tabs) browserTabs.set(scope, tabs = new Map());
  return tabs;
}

function activeTabId(scope) { return activeBrowserTabs.get(scope) || ""; }

function viewFor(scope, tabId = activeTabId(scope)) {
  return tabId ? browserViews.get(viewKey(scope, tabId)) : undefined;
}

async function extractActiveBrowserDesignReference(scope) {
  if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) {
    throw new Error("A browser workspace scope is required.");
  }
  const tabId = activeTabId(scope);
  const view = viewFor(scope, tabId);
  if (!view || view.webContents.isDestroyed()) {
    throw new Error("Open a page in Tribe Browser before capturing its styles.");
  }
  return readDesignReference(view.webContents, () =>
    activeTabId(scope) === tabId && viewFor(scope, tabId) === view,
  );
}

function browserHostIsVisible(host) {
  if (!host?.getVisible?.() || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return false;
  const bounds = host.getBounds();
  return bounds.width > 0 && bounds.height > 0;
}

function publicTabs(scope) {
  const active = activeTabId(scope);
  return [...tabsFor(scope).values()].map(({ id, view, viewport, customViewport, reducedMotion, favicon }) => {
    const contents = view?.webContents;
    return {
      id, active: id === active, viewport, customViewport: customViewport || null, reducedMotion: reducedMotion || "system",
      url: contents && !contents.isDestroyed() ? sanitisePageUrl(contents.getURL()) : "",
      title: contents && !contents.isDestroyed() ? contents.getTitle() : "New tab",
      favicon: favicon || "",
      loading: contents && !contents.isDestroyed() ? contents.isLoading() : false,
    };
  });
}

async function updateBrowserFavicon(scope, tabId, urls) {
  const tab = tabsFor(scope).get(tabId);
  const contents = tab?.view?.webContents;
  if (!tab || !contents || contents.isDestroyed()) return;
  const requestId = crypto.randomUUID();
  tab.faviconRequestId = requestId;
  tab.favicon = "";
  publish(scope);
  for (const candidate of urls.slice(0, 8)) {
    const faviconUrl = normaliseFaviconUrl(candidate, tab.agentAllowedDomains);
    if (!faviconUrl) continue;
    try {
      const response = await session.fromPartition(partitionFor(scope)).fetch(faviconUrl, {
        headers: { Accept: "image/png,image/jpeg,image/webp,image/gif,image/x-icon" },
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      const contentType = response.headers.get("content-type") || "";
      const advertisedSize = Number(response.headers.get("content-length"));
      if (!response.ok || (Number.isFinite(advertisedSize) && advertisedSize > 128 * 1024)) continue;
      const reader = response.body?.getReader();
      if (!reader) continue;
      const chunks = [];
      let size = 0;
      let complete = false;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { complete = true; break; }
        size += chunk.value.byteLength;
        if (size > 128 * 1024) {
          await reader.cancel();
          break;
        }
        chunks.push(Buffer.from(chunk.value));
      }
      if (!complete) continue;
      const data = faviconDataUrl(contentType, Buffer.concat(chunks, size));
      if (!data || tab.faviconRequestId !== requestId || contents.isDestroyed()) continue;
      tab.favicon = data;
      publish(scope);
      return;
    } catch { /* A missing, blocked, oversized, or unsupported icon uses the built-in browser icon. */ }
  }
}

function domainAllowed(url, domains) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return Array.isArray(domains) && domains.some((domain) => domain === host);
  } catch {
    return false;
  }
}

function setAgentRequestPolicy(scope, tabId, contents, domains) {
  const normalizedDomains = normaliseBrowserDomains(domains);
  const tab = tabsFor(scope).get(tabId);
  if (tab) tab.agentAllowedDomains = normalizedDomains;
  browserRequestPolicies.set(contents.id, {
    scope, tabId, domains: new Set(normalizedDomains), blockedHosts: new Set(),
  });
}

function clearAgentRequestPolicy(contents) {
  if (!contents?.isDestroyed()) browserRequestPolicies.delete(contents.id);
}

function configureBrowserSession(browserSession) {
  if (configuredBrowserSessions.has(browserSession)) return;
  configuredBrowserSessions.add(browserSession);
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details = {}) => {
    const owner = contents && browserContentsOwners.get(contents.id);
    if (!owner) return false;
    const origin = normalisePermissionOrigin(details.securityOrigin || requestingOrigin || details.requestingUrl);
    return permissionRuleForScope(owner.scope, origin, permission) === "allow";
  });
  browserSession.setPermissionRequestHandler(requestBrowserPermission);
  browserSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const policy = browserRequestPolicies.get(details.webContentsId ?? details.webContents?.id);
      const owner = browserContentsOwners.get(details.webContentsId ?? details.webContents?.id);
      const allowed = !policy || browserRequestAllowed(policy, details.url);
      const diagnostic = owner ? {
        scope: owner.scope, tabId: owner.tabId, startedAt: Date.now(), url: sanitiseDiagnosticUrl(details.url),
      } : null;
      if (diagnostic) browserDiagnosticRequests.set(details.id, diagnostic);
      if (allowed) callback({});
      else callback({ cancel: true });
      if (owner) {
        setImmediate(() => {
          try {
            const tab = tabsFor(owner.scope).get(owner.tabId);
            if (allowed && tab && !tab.suppressSiteOriginRecord && shouldTrackSiteOriginResourceType(details.resourceType)) {
              rememberBrowserSite(owner.scope, details.url);
            }
            appendBrowserDiagnostic(owner.scope, "network", {
              tabId: owner.tabId, requestId: details.id, method: details.method, url: diagnostic.url,
              resourceType: details.resourceType, status: "started",
            }, 300);
          } catch (error) {
            if (process.env.TRIBE_BROWSER_E2E === "1") console.error(`Browser E2E request diagnostics failed: ${error.message}`);
          }
        });
      }
      if (!allowed && policy) {
        const host = (() => {
          try { return new URL(details.url).hostname.toLowerCase().replace(/\.$/, "") || "website"; }
          catch { return "website"; }
        })();
        if (!policy.blockedHosts.has(host)) {
          policy.blockedHosts.add(host);
          publish(policy.scope, { error: "A page request was blocked because its website is not allowed for this project." });
        }
      }
    },
  );
  browserSession.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
    const request = browserDiagnosticRequests.get(details.id);
    if (!request) return;
    browserDiagnosticRequests.delete(details.id);
    if (details.resourceType === "mainFrame") {
      appendBrowserDiagnostic(request.scope, "page", {
        tabId: request.tabId,
        event: "loaded",
        message: details.statusCode >= 400 ? `Page returned HTTP ${details.statusCode}.` : "Page loaded.",
        url: request.url,
        httpStatusCode: Number.isInteger(details.statusCode) ? details.statusCode : null,
        httpStatusText: sanitiseDiagnosticMessage(details.statusLine || "").slice(0, 120),
      }, 100);
    }
    appendBrowserDiagnostic(request.scope, "network", {
      tabId: request.tabId, requestId: details.id, method: details.method, url: request.url, resourceType: details.resourceType,
      status: details.statusCode, durationMs: Math.max(0, Date.now() - request.startedAt),
    }, 300);
  });
  browserSession.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (details) => {
    const request = browserDiagnosticRequests.get(details.id);
    if (!request) return;
    browserDiagnosticRequests.delete(details.id);
    if (details.resourceType === "mainFrame") {
      appendBrowserDiagnostic(request.scope, "page", {
        tabId: request.tabId,
        event: "load-failed",
        message: sanitiseDiagnosticMessage(details.error || "The page could not be loaded."),
        url: request.url,
      }, 100);
    }
    appendBrowserDiagnostic(request.scope, "network", {
      tabId: request.tabId, requestId: details.id, method: details.method, url: request.url, resourceType: details.resourceType,
      status: "failed", error: sanitiseDiagnosticMessage(details.error || "request_failed").slice(0, 120),
      durationMs: Math.max(0, Date.now() - request.startedAt),
    }, 300);
  });
}

function readBrowserViewportMetrics(contents) {
  return contents.executeJavaScript(`(async () => {
    const hints = navigator.userAgentData;
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      maxTouchPoints: navigator.maxTouchPoints,
      touch: Boolean(navigator.maxTouchPoints || window.matchMedia("(pointer: coarse)").matches),
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      userAgentData: hints ? {
        brands: hints.brands,
        mobile: hints.mobile,
        platform: hints.platform,
        highEntropy: await hints.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList"]),
      } : null,
    };
  })()`, true);
}

function publicBrowserState(scope) {
  const state = stateFor(scope);
  const view = viewFor(scope);
  const contents = view?.webContents;
  const activeTab = tabsFor(scope).get(activeTabId(scope));
  return {
    url: contents && !contents.isDestroyed() ? sanitisePageUrl(contents.getURL()) : sanitisePageUrl(state.url),
    title: contents && !contents.isDestroyed() ? contents.getTitle() : state.title,
    loading: state.loading,
    pageStopped: Boolean(activeTab?.pageStopped),
    canGoBack: contents && !contents.isDestroyed() ? contents.navigationHistory.canGoBack() : false,
    canGoForward: contents && !contents.isDestroyed() ? contents.navigationHistory.canGoForward() : false,
    viewport: activeTab?.viewport || state.viewport,
    customViewport: activeTab?.customViewport || null,
    viewportSize: activeTab?.viewportSize || null,
    locale: activeTab?.locale || "",
    network: activeTab?.network || "unthrottled",
    reducedMotion: activeTab?.reducedMotion || "system",
    zoomLevel: activeTab?.userZoomLevel ?? state.zoomLevel,
    activeTabId: activeTabId(scope),
    tabs: publicTabs(scope),
    downloads: downloadsFor(scope),
    permissionRequests: permissionRequestsFor(scope),
    ...browserAgentControlState(scope),
    ...publicProfileState(scope),
  };
}

function publish(scope, patch = {}) {
  const current = { ...stateFor(scope), ...patch };
  const contents = viewFor(scope)?.webContents;
  if (contents && !contents.isDestroyed()) {
    current.url = contents.getURL();
    current.title = contents.getTitle();
    current.canGoBack = contents.navigationHistory.canGoBack();
    current.canGoForward = contents.navigationHistory.canGoForward();
    const activeTab = tabsFor(scope).get(activeTabId(scope));
    current.pageStopped = Boolean(activeTab?.pageStopped);
    current.zoomLevel = activeTab?.userZoomLevel || 0;
    current.viewport = activeTab?.viewport || "responsive";
    current.customViewport = activeTab?.customViewport || null;
  }
  current.activeTabId = activeTabId(scope);
  current.tabs = publicTabs(scope);
  Object.assign(current, browserAgentControlState(scope));
  Object.assign(current, publicProfileState(scope));
  browserState.set(scope, current);
  updateBrowserMenuState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("tribe:browser-state", current);
  return current;
}

function markAgentAction(scope, action) {
  publish(scope, { agentAction: action });
  clearTimeout(browserAgentTimers.get(scope));
  const timer = setTimeout(() => publish(scope, { agentAction: "" }), 1500);
  timer.unref?.();
  browserAgentTimers.set(scope, timer);
}

function browserAgentControlState(scope) {
  return {
    agentControlPaused: browserAgentControl.state(scope).paused,
    agentControlActive: [...browserAgentRequests.values()].some((request) => request.scope === scope),
  };
}

function setBrowserAgentControlPaused(scope, paused) {
  const next = browserAgentControl.setPaused(scope, paused);
  if (next.paused) {
    for (const request of browserAgentRequests.values()) {
      if (request.scope !== scope) continue;
      request.cancelled = true;
      if (["navigate", "reload", "back", "forward"].includes(request.action)
          && request.contents && !request.contents.isDestroyed() && request.contents.isLoading()) {
        request.contents.stop();
      }
    }
    for (const tab of tabsFor(scope).values()) clearAgentRequestPolicy(tab.view.webContents);
  }
  return publish(scope, browserAgentControlState(scope));
}

async function showAgentPointer(contents, x, y) {
  const pointX = Math.max(0, Math.min(100_000, Number(x) || 0));
  const pointY = Math.max(0, Math.min(100_000, Number(y) || 0));
  const left = Math.max(0, pointX - 1);
  const top = Math.max(0, pointY - 1);
  const script = `(() => {
    let cursor = document.getElementById("tribe-agent-pointer");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "tribe-agent-pointer";
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.cssText = "position:fixed;z-index:2147483647;width:14px;height:17.5px;pointer-events:none;opacity:0;transform:translate(0,1px) scale(.94);transform-origin:1px 1px;transition:transform 110ms cubic-bezier(.2,.8,.2,1),opacity 110ms ease;filter:drop-shadow(0 1px .8px rgba(5,12,23,.28));";
      cursor.innerHTML = '<svg aria-hidden="true" width="14" height="17.5" viewBox="0 0 24 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1.8 22 14.5l-6.6 2.2 3.9 7.3-3.8 2-3.9-7.3-4.8 4.6L2 1.8Z" fill="#4EACFF" stroke="#0A1421" stroke-width="2.1" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
    }
    cursor.style.left = ${JSON.stringify(left + "px")};
    cursor.style.top = ${JSON.stringify(top + "px")};
    cursor.style.opacity = "1";
    cursor.style.transform = "translate(0,0) scale(1)";
    clearTimeout(cursor.__tribeTimer);
    cursor.__tribeTimer = setTimeout(() => { cursor.style.opacity = "0"; cursor.style.transform = "translate(1px,1px) scale(.96)"; }, 420);
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`;
  await contents.executeJavaScript(script, true).catch(() => {});
}

async function settleBrowserAction(contents) {
  if (!contents || contents.isDestroyed()) return;
  await contents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    true,
  ).catch(() => {});
}

function partitionFor(scope) {
  loadBrowserProfileStore();
  const profileId = browserProfileStore?.assignments?.[scope];
  if (profileId && browserProfileStore.profiles.some((profile) => profile.id === profileId)) {
    return `persist:tribe-profile-${profileId}`;
  }
  const id = crypto.createHash("sha256").update(scope).digest("hex").slice(0, 24);
  return `tribe-chat-${id}`;
}

function browserSiteOriginsFor(scope) {
  const profileId = loadBrowserProfileStore().assignments[scope];
  const profile = browserProfileStore.profiles.find((item) => item.id === profileId);
  return normaliseSiteOrigins(profile ? profile.siteOrigins : browserVisitedSites.get(scope));
}

function rememberBrowserSite(scope, value, { force = false } = {}) {
  let origin = "";
  try { origin = normaliseSiteOrigin(new URL(value).origin); } catch { return; }
  if (!origin) return;
  const lastVisitedAt = Date.now();
  if (!force) {
    const existing = browserSiteOriginsFor(scope).find((site) => site.origin === origin);
    if (existing && lastVisitedAt - existing.lastVisitedAt < SITE_ORIGIN_RECORD_COOLDOWN_MS) return;
  }
  const site = { origin, lastVisitedAt };
  const profileId = loadBrowserProfileStore().assignments[scope];
  const profile = browserProfileStore.profiles.find((item) => item.id === profileId);
  if (profile) {
    profile.siteOrigins = rememberSiteOrigin(profile.siteOrigins, origin, site.lastVisitedAt);
    saveBrowserProfileStore();
    return;
  }
  const sites = browserVisitedSites.get(scope) || [];
  browserVisitedSites.set(scope, rememberSiteOrigin(sites, origin, site.lastVisitedAt));
}

function forgetBrowserSite(scope, origin) {
  const update = (items) => forgetSiteOrigin(items, origin);
  const profileId = loadBrowserProfileStore().assignments[scope];
  const profile = browserProfileStore.profiles.find((item) => item.id === profileId);
  if (profile) {
    profile.siteOrigins = update(profile.siteOrigins);
    saveBrowserProfileStore();
  } else {
    browserVisitedSites.set(scope, update(browserVisitedSites.get(scope) || []));
  }
}

function browserProfileStorePath() {
  return path.join(app.getPath("userData"), "browser-profiles.json");
}

function browserDownloadStorePath() {
  return path.join(app.getPath("userData"), "browser-downloads.json");
}

function browserSessionStorePath() {
  return path.join(app.getPath("userData"), "browser-sessions.json");
}

function loadBrowserSessionStore() {
  if (browserSessionStore) return browserSessionStore;
  try {
    browserSessionStore = normaliseBrowserSessionStore(JSON.parse(fs.readFileSync(browserSessionStorePath(), "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read browser sessions:", error.message);
    browserSessionStore = { version: 1, sessions: {} };
  }
  return browserSessionStore;
}

function saveBrowserSessionStore() {
  const store = loadBrowserSessionStore();
  const file = browserSessionStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

function saveBrowserSession(scope) {
  clearTimeout(browserSessionTimers.get(scope));
  browserSessionTimers.delete(scope);
  if (browserSessionRestoring.has(scope)) return;
  const tabs = [...tabsFor(scope).values()];
  if (!tabs.length) return;
  const selectedProfileId = loadBrowserProfileStore().assignments[scope] || "";
  const store = loadBrowserSessionStore();
  store.sessions[scope] = normaliseBrowserSessionRecord({
    profileId: selectedProfileId,
    activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId(scope))),
    tabs: tabs.map((tab) => ({
      url: safeSessionUrl(tab.view.webContents.isDestroyed() ? "" : tab.view.webContents.getURL()),
      viewport: tab.viewport,
      customViewport: tab.customViewport,
      locale: tab.locale,
      network: tab.network,
      reducedMotion: tab.reducedMotion,
      zoomLevel: tab.userZoomLevel,
    })),
  });
  try { saveBrowserSessionStore(); }
  catch (error) { console.error("Could not save browser sessions:", error.message); }
}

function scheduleBrowserSessionSave(scope) {
  if (browserSessionRestoring.has(scope)) return;
  clearTimeout(browserSessionTimers.get(scope));
  const timer = setTimeout(() => saveBrowserSession(scope), 750);
  timer.unref?.();
  browserSessionTimers.set(scope, timer);
}

function managedDownloadPath(candidate) {
  const root = path.resolve(app.getPath("userData"), "browser-downloads");
  const resolved = path.resolve(candidate);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : "";
}

function loadBrowserDownloadStore() {
  if (browserDownloadStore) return browserDownloadStore;
  try {
    const parsed = JSON.parse(fs.readFileSync(browserDownloadStorePath(), "utf8"));
    browserDownloadStore = Array.isArray(parsed.downloads) ? parsed.downloads
      .filter((item) => typeof item?.id === "string" && /^[\da-f-]{36}$/i.test(item.id)
        && typeof item?.scope === "string" && typeof item?.filename === "string"
        && typeof item?.path === "string" && managedDownloadPath(item.path)
        && path.basename(item.path) === item.filename)
      .map((item) => {
        const exists = fs.existsSync(managedDownloadPath(item.path));
        const state = item.state === "progressing" ? "interrupted" : item.state;
        const normalizedState = state === "moved" ? "moved" : (exists && state === "completed" ? "completed" : (exists ? state : "missing"));
        downloadItems.set(item.id, item.path);
        return { ...item, state: normalizedState };
      }) : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read browser downloads:", error.message);
    browserDownloadStore = [];
  }
  return browserDownloadStore;
}

function downloadsFor(scope) {
  return loadBrowserDownloadStore()
    .filter((item) => item.scope === scope)
    .slice(-20)
    .map(({ id, filename, state, receivedBytes, totalBytes, movedToRepositoryName }) => ({
      id, filename, state, receivedBytes: Number(receivedBytes) || 0, totalBytes: Number(totalBytes) || 0,
      ...(state === "moved" && movedToRepositoryName ? { movedToRepositoryName } : {}),
    }));
}

async function moveBrowserDownloadToRepository(id, project) {
  const record = loadBrowserDownloadStore().find((item) => item.id === id);
  if (!record || record.state !== "completed") throw new Error("Choose a completed download.");
  if (!project || typeof project.id !== "string" || !project.id.trim()
    || typeof project.name !== "string" || !project.name.trim()
    || typeof project.repository !== "string" || !project.repository.trim()) {
    throw new Error("Choose a project with a Git repository.");
  }
  await moveManagedDownloadToRepository({
    managedRoot: path.join(app.getPath("userData"), "browser-downloads"),
    sourcePath: record.path,
    filename: record.filename,
    repositoryPath: project.repository,
  });
  downloadItems.delete(id);
  updateBrowserDownload(id, {
    state: "moved",
    movedToRepositoryId: project.id.trim().slice(0, 128),
    movedToRepositoryName: project.name.trim().slice(0, 96),
  });
  publish(record.scope, { downloads: downloadsFor(record.scope), error: "" });
}

function saveBrowserDownloadStore() {
  const downloads = loadBrowserDownloadStore();
  const file = browserDownloadStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify({ downloads }, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

function updateBrowserDownload(id, patch) {
  const downloads = loadBrowserDownloadStore();
  const index = downloads.findIndex((item) => item.id === id);
  if (index < 0) return null;
  downloads[index] = { ...downloads[index], ...patch, updatedAt: Date.now() };
  saveBrowserDownloadStore();
  return downloads[index];
}

function loadBrowserProfileStore() {
  if (browserProfileStore) return browserProfileStore;
  const file = browserProfileStorePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles
      .filter((profile) => typeof profile?.id === "string" && /^[\da-f-]{36}$/i.test(profile.id)
        && typeof profile?.name === "string" && profile.name.trim().length > 0)
      .map((profile) => ({
        id: profile.id,
        name: profile.name.trim().slice(0, 48),
        createdAt: Number(profile.createdAt) || Date.now(),
        siteOrigins: normaliseSiteOrigins(profile.siteOrigins),
        permissions: Array.isArray(profile.permissions) ? profile.permissions
          .filter((rule) => normalisePermissionOrigin(rule?.origin)
            && typeof rule?.permission === "string" && rule.permission.length > 0 && rule.permission.length <= 64
            && ["allow", "block"].includes(rule?.decision))
          .map((rule) => ({
            origin: normalisePermissionOrigin(rule.origin),
            permission: rule.permission,
            decision: rule.decision,
            updatedAt: Number(rule.updatedAt) || Date.now(),
          })) : [],
      })) : [];
    const ids = new Set(profiles.map((profile) => profile.id));
    const assignments = parsed.assignments && typeof parsed.assignments === "object" && !Array.isArray(parsed.assignments)
      ? Object.fromEntries(Object.entries(parsed.assignments).filter(([scope, id]) => typeof scope === "string" && scope.length <= 256 && ids.has(id)))
      : {};
    browserProfileStore = { profiles, assignments };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read browser profiles:", error.message);
    browserProfileStore = { profiles: [], assignments: {} };
  }
  return browserProfileStore;
}

function saveBrowserProfileStore() {
  const store = loadBrowserProfileStore();
  const file = browserProfileStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

function publicProfileState(scope) {
  const store = loadBrowserProfileStore();
  const selectedId = store.assignments[scope] || "";
  const selected = store.profiles.find((profile) => profile.id === selectedId);
  return {
    selectedProfileId: selected?.id || "",
    profileName: selected?.name || "Temporary",
    temporary: !selected,
    profiles: store.profiles.map(({ id, name, createdAt, permissions }) => ({
      id, name, createdAt, permissions: Array.isArray(permissions) ? permissions : [],
    })),
  };
}

function disposeBrowserScope(scope) {
  if (tabsFor(scope).size) saveBrowserSession(scope);
  for (const tab of tabsFor(scope).values()) {
    for (const request of pendingBrowserPermissions.values()) {
      if (request.scope === scope && request.tabId === tab.id) resolveBrowserPermission(request.id, false);
    }
    const host = browserHosts.get(viewKey(scope, tab.id));
    host?.setVisible(false);
    if (host) mainWindow?.contentView.removeChildView(host);
    clearAgentRequestPolicy(tab.view.webContents);
    browserContentsOwners.delete(tab.view.webContents.id);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    browserViews.delete(viewKey(scope, tab.id));
    browserHosts.delete(viewKey(scope, tab.id));
  }
  browserTabs.delete(scope);
  activeBrowserTabs.delete(scope);
  browserState.delete(scope);
  browserDiagnostics.delete(scope);
  for (const [requestId, request] of browserDiagnosticRequests) {
    if (request.scope === scope) browserDiagnosticRequests.delete(requestId);
  }
}

function fitBrowserView(scope, tabId) {
  const tab = tabsFor(scope).get(tabId);
  const view = viewFor(scope, tabId);
  const host = browserHosts.get(viewKey(scope, tabId));
  const layout = browserBounds.get(scope)?.bounds;
  if (!tab || !view || !host || !layout) return;
  if (layout.width <= 0 || layout.height <= 0) return;
  const config = tab.viewport === "custom" ? resolveViewport(tab.customViewport).config : VIEWPORT_PRESETS[tab.viewport];
  const emulation = {
    deviceProfile: deviceProfileFor(tab.viewport, process.versions.chrome),
    locale: tab.locale,
    network: tab.network,
    reducedMotion: tab.reducedMotion,
    defaultUserAgent: tab.defaultUserAgent,
    defaultPlatform: tab.defaultPlatform,
    defaultLocale: tab.defaultLocale,
  };
  const signature = JSON.stringify({ config, width: layout.width, height: layout.height, ...emulation });
  if (signature !== tab.deviceEmulationSignature) {
    tab.deviceEmulationSignature = signature;
    tab.deviceMetricsPromise = (tab.deviceMetricsPromise || Promise.resolve())
      .then(() => syncDeviceEmulation(view.webContents.debugger, tab, config, emulation))
      .catch((error) => {
        publish(scope, { error: `Device emulation could not be applied: ${error.message}` });
      });
  }
  view.setBounds(viewportBounds(config, layout));
  view.webContents.setZoomFactor(1.2 ** (tab.userZoomLevel || 0));
  return tab.deviceMetricsPromise || Promise.resolve();
}

async function applyViewport(scope, tabId, resolved, settings = {}) {
  const tab = tabsFor(scope).get(tabId);
  if (!tab) throw new Error("The browser tab is no longer available.");
  const host = browserHosts.get(viewKey(scope, tabId));
  tab.viewportTransitionCount = (tab.viewportTransitionCount || 0) + 1;
  host?.setVisible(false);
  if (resolved) {
    tab.viewport = resolved.name;
    tab.customViewport = resolved.customViewport || null;
  }
  if (Object.hasOwn(settings, "locale")) tab.locale = normalizeLocale(settings.locale);
  if (Object.hasOwn(settings, "network")) tab.network = normalizeNetworkProfile(settings.network);
  if (Object.hasOwn(settings, "reducedMotion")) tab.reducedMotion = normalizeReducedMotion(settings.reducedMotion);
  try {
    await fitBrowserView(scope, tabId);
  } finally {
    const currentLayout = browserBounds.get(scope);
    if (host && currentLayout && !tab.view.webContents.isDestroyed()) {
      try {
        host.setBounds(currentLayout.bounds);
        await fitBrowserView(scope, tabId);
      } catch {}
    }
    tab.viewportTransitionCount = Math.max(0, (tab.viewportTransitionCount || 1) - 1);
    const settledLayout = browserBounds.get(scope);
    if (!tab.viewportTransitionCount && host && settledLayout && !tab.view.webContents.isDestroyed()) {
      const show = shouldShowBrowserHost(settledLayout, tab, activeTabId(scope) === tabId);
      host.setVisible(show);
      if (show) await waitForBrowserPaint(tab.view.webContents);
    }
  }
  scheduleBrowserSessionSave(scope);
}

async function siteStorageForOrigin(tab, origin) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) throw new Error("The browser tab is no longer available.");
  const safeOrigin = normaliseSiteOrigin(origin);
  if (!safeOrigin) throw new Error("Site storage needs a valid website origin.");
  const inspect = async () => {
    const debuggerClient = contents.debugger;
    const attachedHere = !debuggerClient.isAttached();
    if (attachedHere) debuggerClient.attach("1.3");
    try {
      const usage = await debuggerClient.sendCommand("Storage.getUsageAndQuota", { origin: safeOrigin });
      return normaliseSiteStorage(safeOrigin, usage);
    } finally {
      if (attachedHere && debuggerClient.isAttached() && !tab.deviceMetricsDebuggerOwned) debuggerClient.detach();
    }
  };
  const pending = (tab.deviceMetricsPromise || Promise.resolve()).catch(() => {}).then(inspect);
  tab.deviceMetricsPromise = pending.catch(() => {});
  return pending;
}

async function siteStorageForTab(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) throw new Error("The browser tab is no longer available.");
  let origin = "";
  try { origin = new URL(contents.getURL()).origin; } catch {}
  if (!normaliseSiteOrigin(origin)) throw new Error("Open a website to inspect its storage.");
  return siteStorageForOrigin(tab, origin);
}

async function siteStorageInventory(scope, requestedOrigin) {
  const allSites = browserSiteOriginsFor(scope);
  let sites = allSites;
  if (requestedOrigin !== undefined) {
    const safeOrigin = normaliseSiteOrigin(requestedOrigin);
    if (!safeOrigin) throw new Error("Choose a valid website origin to estimate.");
    sites = allSites.filter((site) => site.origin === safeOrigin);
    if (!sites.length) throw new Error("Choose a website already opened in this browser profile.");
  }
  const tab = tabsFor(scope).get(activeTabId(scope));
  return Promise.all(sites.map(async (site, index) => {
    if (!tab) return { ...site, bytes: null, quotaBytes: null, breakdown: [], estimateStatus: "unavailable" };
    if (requestedOrigin === undefined && index >= MAX_MEASURED_SITE_ORIGINS) {
      return { ...site, bytes: null, quotaBytes: null, breakdown: [], estimateStatus: "not-measured" };
    }
    try {
      return { ...site, ...await siteStorageForOrigin(tab, site.origin), estimateStatus: "measured" };
    } catch {
      return { ...site, bytes: null, quotaBytes: null, breakdown: [], estimateStatus: "unavailable" };
    }
  }));
}

async function clearBrowserSiteData(scope, origin) {
  const safeOrigin = normaliseSiteOrigin(origin);
  if (!safeOrigin || !browserSiteOriginsFor(scope).some((site) => site.origin === safeOrigin)) {
    throw new Error("Choose a website already opened in this browser profile.");
  }
  const browserSession = session.fromPartition(partitionFor(scope));
  await browserSession.clearStorageData({ origin: safeOrigin });
  forgetBrowserSite(scope, safeOrigin);
  return siteStorageInventory(scope);
}

function parseBrowserEmulationRequest(value) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const hasViewport = typeof value === "string" || Boolean(object && (
    Object.hasOwn(object, "viewport") || Object.hasOwn(object, "width") || Object.hasOwn(object, "height")
  ));
  const resolved = hasViewport
    ? resolveViewport(object && Object.hasOwn(object, "viewport") ? object.viewport : value)
    : null;
  const settings = {};
  if (object && Object.hasOwn(object, "locale")) settings.locale = normalizeLocale(object.locale);
  if (object && Object.hasOwn(object, "network")) settings.network = normalizeNetworkProfile(object.network);
  if (object && Object.hasOwn(object, "reducedMotion")) settings.reducedMotion = normalizeReducedMotion(object.reducedMotion);
  if (!resolved && !Object.keys(settings).length) throw new Error("Choose a viewport, locale, network condition or motion preference.");
  return { resolved, settings };
}

function createBrowserView(scope, tabId = crypto.randomUUID()) {
  const key = viewKey(scope, tabId);
  const existing = browserViews.get(key);
  if (existing && !existing.webContents.isDestroyed()) return existing;
  const partition = partitionFor(scope);
  const browserSession = session.fromPartition(partition);
  configureBrowserSession(browserSession);
  browserSession.on("will-download", (_event, item, contents) => {
    if (contents !== browserViews.get(key)?.webContents) return;
    const downloadRoot = path.join(app.getPath("userData"), "browser-downloads");
    fs.mkdirSync(downloadRoot, { recursive: true, mode: 0o700 });
    const filename = path.basename(item.getFilename()).replace(/[\\/\u0000-\u001f]/g, "_") || "download";
    const extension = path.extname(filename);
    const stem = path.basename(filename, extension);
    let destination = path.join(downloadRoot, filename);
    let suffix = 1;
    while (fs.existsSync(destination)) destination = path.join(downloadRoot, `${stem} (${suffix++})${extension}`);
    item.setSavePath(destination);
    const record = {
      id: crypto.randomUUID(), scope, filename: path.basename(destination), path: destination,
      state: "progressing", receivedBytes: 0, totalBytes: item.getTotalBytes(), createdAt: Date.now(),
    };
    downloadItems.set(record.id, destination);
    loadBrowserDownloadStore().push(record);
    saveBrowserDownloadStore();
    publish(scope, { downloads: downloadsFor(scope) });
    item.on("updated", (_updateEvent, state) => {
      updateBrowserDownload(record.id, {
        state: state === "interrupted" ? "interrupted" : "progressing",
        receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
      });
      publish(scope, { downloads: downloadsFor(scope) });
    });
    item.once("done", (_doneEvent, state) => {
      updateBrowserDownload(record.id, {
        state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
      });
      publish(scope, { downloads: downloadsFor(scope) });
    });
  });

  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const contents = view.webContents;
  contents.setZoomMode("isolated");
  contents.on("before-input-event", (event, input) => {
    const shortcut = browserShortcutForInput(input, process.platform);
    if (!shortcut) return;
    event.preventDefault();
    const currentTab = tabsFor(scope).get(tabId);
    if (currentTab && process.env.TRIBE_BROWSER_E2E === "1") currentTab.lastShortcut = shortcut;
    runBrowserShortcut(shortcut, scope);
  });
  contents.on("console-message", (details) => {
    const item = details && typeof details === "object" ? details : { message: details };
    appendBrowserDiagnostic(scope, "console", {
      tabId,
      level: String(item.level ?? "info").slice(0, 24),
      message: sanitiseDiagnosticMessage(item.message),
      source: sanitiseDiagnosticUrl(item.sourceId || ""),
      line: Number.isInteger(item.lineNumber) ? item.lineNumber : null,
    }, 200);
  });
  contents.setWindowOpenHandler(({ url }) => {
    const agentAllowedDomains = tabsFor(scope).get(tabId)?.agentAllowedDomains || null;
    createBrowserTab(scope, url, { agentAllowedDomains }).catch((error) => publish(scope, { error: error.message }));
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    try { safeUrl(url); } catch { event.preventDefault(); }
    const agentPolicy = tabsFor(scope).get(tabId)?.agentAllowedDomains;
    if (agentPolicy && !domainAllowed(url, agentPolicy)) {
      event.preventDefault();
      publish(scope, { error: "The agent stopped a navigation outside the project's allowed websites." });
    }
  });
  contents.on("will-redirect", (event, url, isMainFrame) => {
    const agentPolicy = tabsFor(scope).get(tabId)?.agentAllowedDomains;
    if (isMainFrame && agentPolicy && !domainAllowed(url, agentPolicy)) {
      event.preventDefault();
      publish(scope, { error: "The agent stopped a redirect outside the project's allowed websites." });
    }
  });
  contents.on("did-start-loading", () => {
    const tab = tabsFor(scope).get(tabId);
    if (tab) tab.pageStopped = false;
    if (activeTabId(scope) === tabId) publish(scope, { loading: true, error: "", pageStopped: false });
  });
  contents.on("did-stop-loading", () => {
    const tab = tabsFor(scope).get(tabId);
    if (tab) tab.suppressSiteOriginRecord = false;
    publish(scope, { loading: false });
  });
  contents.on("did-finish-load", () => {
    const tab = tabsFor(scope).get(tabId);
    if (!tab || contents.isDestroyed()) return;
    readBrowserViewportMetrics(contents).then((viewportSize) => {
      tab.viewportSize = viewportSize;
      if (activeTabId(scope) === tabId) publish(scope, { viewportSize });
    }).catch(() => {});
  });
  contents.on("did-navigate", (_event, url) => {
    const tab = tabsFor(scope).get(tabId);
    if (tab) tab.hasPage = url !== "about:blank";
    const layout = browserBounds.get(scope);
    const host = browserHosts.get(viewKey(scope, tabId));
    if (host && layout) host.setVisible(shouldShowBrowserHost(layout, tab, tabId === activeTabId(scope)));
    if (!tabsFor(scope).get(tabId)?.suppressSiteOriginRecord) rememberBrowserSite(scope, url);
    publish(scope, { url, loading: false, error: "" });
    scheduleBrowserSessionSave(scope);
  });
  contents.on("did-navigate-in-page", (_event, url) => {
    const tab = tabsFor(scope).get(tabId);
    if (tab) tab.hasPage = url !== "about:blank";
    const layout = browserBounds.get(scope);
    const host = browserHosts.get(viewKey(scope, tabId));
    if (host && layout) host.setVisible(shouldShowBrowserHost(layout, tab, tabId === activeTabId(scope)));
    if (!tabsFor(scope).get(tabId)?.suppressSiteOriginRecord) rememberBrowserSite(scope, url);
    appendBrowserDiagnostic(scope, "page", {
      tabId,
      event: "route-changed",
      message: "Page URL changed without a full navigation.",
      url: sanitisePageUrl(url),
    }, 100);
    publish(scope, { url });
    scheduleBrowserSessionSave(scope);
  });
  contents.on("page-title-updated", (_event, title) => publish(scope, { title }));
  contents.on("page-favicon-updated", (_event, favicons) => {
    void updateBrowserFavicon(scope, tabId, Array.isArray(favicons) ? favicons : []);
  });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      const tab = tabsFor(scope).get(tabId);
      if (tab) tab.suppressSiteOriginRecord = false;
      appendBrowserDiagnostic(scope, "page", {
        tabId,
        event: "load-failed",
        message: sanitiseDiagnosticMessage(description || "The page could not be loaded."),
        errorCode: Number.isInteger(code) ? code : null,
        url: sanitisePageUrl(_url),
      }, 100);
      publish(scope, { loading: false, error: description || "The page could not be loaded." });
    }
  });
  contents.once("destroyed", () => browserRequestPolicies.delete(contents.id));
  contents.once("destroyed", () => browserContentsOwners.delete(contents.id));
  contents.on("render-process-gone", (_event, details) => {
    appendBrowserDiagnostic(scope, "page", {
      tabId,
      event: "renderer-stopped",
      message: `The browser page stopped unexpectedly (${sanitiseDiagnosticMessage(details.reason)}).`,
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
    }, 100);
    const tab = tabsFor(scope).get(tabId);
    if (tab) tab.pageStopped = true;
    browserHosts.get(viewKey(scope, tabId))?.setVisible(false);
    if (activeTabId(scope) === tabId) publish(scope, { loading: false, pageStopped: true, error: `The browser page stopped unexpectedly (${details.reason}).` });
  });
  const host = new View();
  host.setBackgroundColor("#e6eaf0");
  host.addChildView(view);
  mainWindow.contentView.addChildView(host);
  host.setVisible(false);
  browserViews.set(key, view);
  browserHosts.set(key, host);
  const defaultPlatform = process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64";
  tabsFor(scope).set(tabId, { id: tabId, view, hasPage: false, viewport: "responsive", customViewport: null, locale: "", network: "unthrottled", reducedMotion: "system", defaultUserAgent: contents.getUserAgent(), defaultPlatform, defaultLocale: app.getLocale(), userZoomLevel: 0, deviceEmulationSignature: "", agentAllowedDomains: null });
  browserContentsOwners.set(contents.id, { scope, tabId });
  const layout = browserBounds.get(scope);
  if (layout) host.setBounds(layout.bounds);
  fitBrowserView(scope, tabId);
  return view;
}

async function restoreBrowserSession(scope, initialUrl = "") {
  const currentProfileId = loadBrowserProfileStore().assignments[scope] || "";
  const stored = loadBrowserSessionStore().sessions[scope];
  const record = stored?.profileId === currentProfileId ? normaliseBrowserSessionRecord(stored) : null;
  if (!record) {
    const created = await createBrowserTab(scope, initialUrl);
    scheduleBrowserSessionSave(scope);
    return created.state;
  }
  browserSessionRestoring.add(scope);
  let activeId = "";
  try {
    for (let index = 0; index < record.tabs.length; index += 1) {
      const saved = record.tabs[index];
      const { tabId } = await createBrowserTab(scope, "", { activate: false });
      const tab = tabsFor(scope).get(tabId);
      tab.viewport = saved.viewport;
      tab.customViewport = saved.customViewport;
      tab.locale = saved.locale;
      tab.network = saved.network;
      tab.reducedMotion = saved.reducedMotion;
      tab.userZoomLevel = saved.zoomLevel;
      if (saved.url) await tab.view.webContents.loadURL(safeUrl(saved.url)).catch(() => {});
      await Promise.resolve(fitBrowserView(scope, tabId)).catch(() => {});
      tab.view.webContents.setZoomFactor(1.2 ** tab.userZoomLevel);
      if (index === record.activeIndex) activeId = tabId;
    }
  } finally {
    browserSessionRestoring.delete(scope);
  }
  if (!activeId) activeId = [...tabsFor(scope).keys()][0];
  activateBrowserTab(scope, activeId);
  if (initialUrl) await viewFor(scope).webContents.loadURL(safeUrl(initialUrl));
  scheduleBrowserSessionSave(scope);
  return publish(scope);
}

async function createBrowserTab(scope, url = "", { activate = true, agentAllowedDomains = null } = {}) {
  const tabId = crypto.randomUUID();
  const view = createBrowserView(scope, tabId);
  if (agentAllowedDomains) setAgentRequestPolicy(scope, tabId, view.webContents, agentAllowedDomains);
  if (activate) activateBrowserTab(scope, tabId);
  if (url) await view.webContents.loadURL(safeUrl(url));
  publish(scope);
  scheduleBrowserSessionSave(scope);
  return { tabId, state: publicBrowserState(scope) };
}

function activateBrowserTab(scope, tabId) {
  const target = tabsFor(scope).get(tabId);
  if (!target || target.view.webContents.isDestroyed()) throw new Error("The browser tab is no longer available.");
  const previousTabId = activeTabId(scope);
  if (previousTabId && previousTabId !== tabId && tabsFor(scope).has(previousTabId)) {
    previousActiveBrowserTabs.set(scope, previousTabId);
  }
  activeBrowserTabs.set(scope, tabId);
  const layout = browserBounds.get(scope);
  for (const tab of tabsFor(scope).values()) browserHosts.get(viewKey(scope, tab.id))?.setVisible(
    shouldShowBrowserHost(layout, tab, tab.id === tabId),
  );
  publish(scope);
  scheduleBrowserSessionSave(scope);
  return target.view;
}

function reloadBrowserTab(scope, tabId) {
  const tab = tabsFor(scope).get(tabId);
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error("The browser tab is no longer available.");
  const layout = browserBounds.get(scope);
  if (tab.pageStopped) {
    tab.pageStopped = false;
    publish(scope, { pageStopped: false, error: "", loading: true });
    browserHosts.get(viewKey(scope, tabId))?.setVisible(
      shouldShowBrowserHost(layout, tab, tabId === activeTabId(scope)),
    );
  }
  tab.view.webContents.reload();
  return publicBrowserState(scope);
}

function closeBrowserTab(scope, tabId) {
  const tabs = tabsFor(scope);
  const target = tabs.get(tabId);
  if (!target) return false;
  const wasActive = activeTabId(scope) === tabId;
  const host = browserHosts.get(viewKey(scope, tabId));
  host?.setVisible(false);
  if (host) mainWindow.contentView.removeChildView(host);
  for (const request of pendingBrowserPermissions.values()) {
    if (request.scope === scope && request.tabId === tabId) resolveBrowserPermission(request.id, false);
  }
  clearAgentRequestPolicy(target.view.webContents);
  clearBrowserTabDiagnostics(scope, tabId);
  browserContentsOwners.delete(target.view.webContents.id);
  if (!target.view.webContents.isDestroyed()) target.view.webContents.close();
  tabs.delete(tabId);
  browserViews.delete(viewKey(scope, tabId));
  browserHosts.delete(viewKey(scope, tabId));
  if (previousActiveBrowserTabs.get(scope) === tabId) previousActiveBrowserTabs.delete(scope);
  if (tabs.size === 0) {
    activeBrowserTabs.delete(scope);
    previousActiveBrowserTabs.delete(scope);
    publish(scope);
    scheduleBrowserSessionSave(scope);
  } else if (wasActive) {
    const previousTabId = previousActiveBrowserTabs.get(scope);
    activateBrowserTab(scope, previousTabId && tabs.has(previousTabId) ? previousTabId : tabs.keys().next().value);
  }
  else {
    publish(scope);
    scheduleBrowserSessionSave(scope);
  }
  return true;
}

function sanitisePageUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|auth|code|key|session)/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.href;
  } catch {
    return "";
  }
}

function snapshotPage(prefix) {
  document.querySelectorAll("[data-tribe-browser-ref]").forEach((element) => element.removeAttribute("data-tribe-browser-ref"));
  const labelFor = (element) => {
    const aria = element.getAttribute("aria-label") || element.getAttribute("title");
    if (aria) return aria.trim();
    const labels = element.labels ? [...element.labels].map((label) => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll("input,textarea,select").forEach((control) => control.remove());
      return copy.innerText || copy.textContent || "";
    }).join(" ") : "";
    return (labels || element.innerText || element.textContent || element.getAttribute("placeholder") || element.getAttribute("alt") || "")
      .replace(/\s+/g, " ").trim().slice(0, 180);
  };
  const nodes = [...document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[tabindex]")]
    .filter((element) => !element.disabled && element.getAttribute("aria-hidden") !== "true")
    .slice(0, 250);
  const elements = nodes.map((element, index) => {
    const ref = `${prefix}-${index + 1}`;
    element.setAttribute("data-tribe-browser-ref", ref);
    const type = element.getAttribute("type") || "";
    const href = element instanceof HTMLAnchorElement ? element.href : "";
    return {
      ref,
      role: element.getAttribute("role") || (element instanceof HTMLInputElement ? "textbox" : element.tagName.toLowerCase()),
      name: labelFor(element),
      type,
      accept: type === "file" ? String(element.accept || "").slice(0, 256) : undefined,
      multiple: element instanceof HTMLSelectElement || type === "file" ? Boolean(element.multiple) : undefined,
      value: ["password", "hidden", "file"].includes(type) ? undefined : undefined,
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      disabled: Boolean(element.disabled),
      options: element instanceof HTMLSelectElement
        ? [...element.options].slice(0, 100).map((option) => ({
            label: String(option.label || option.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
            value: String(option.value).slice(0, 256),
            disabled: Boolean(option.disabled || option.parentElement?.disabled),
            selected: Boolean(option.selected),
          }))
        : undefined,
      rect: (() => { const r = element.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })(),
      href: href ? `${new URL(href).origin}${new URL(href).pathname}` : undefined,
    };
  });
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || "").slice(0, 16000),
    elements,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  };
}

function describeFileInput(ref, prepareClick = false) {
  const element = [...document.querySelectorAll("[data-tribe-browser-ref]")]
    .find((candidate) => candidate.getAttribute("data-tribe-browser-ref") === ref);
  if (!(element instanceof HTMLInputElement) || element.type !== "file") {
    throw new Error("The file input reference expired. Take a fresh browser snapshot.");
  }
  const visible = (candidate) => {
    if (!candidate) return false;
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0;
  };
  const label = [...(element.labels || [])].find(visible);
  const trigger = label || (visible(element) ? element : null);
  if (prepareClick && trigger) trigger.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = trigger?.getBoundingClientRect();
  return {
    ref,
    tagName: element.tagName,
    type: element.type,
    accept: String(element.accept || "").slice(0, 256),
    multiple: Boolean(element.multiple),
    ...(rect ? { point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } } : {}),
  };
}

function describeBrowserActionTarget(ref, x, y, intent = "click") {
  const source = ref
    ? [...document.querySelectorAll("[data-tribe-browser-ref]")].find((candidate) => candidate.getAttribute("data-tribe-browser-ref") === ref)
    : Number.isFinite(x) && Number.isFinite(y)
      ? document.elementFromPoint(x, y)
      : document.activeElement;
  if (!source) throw new Error("The page control is no longer available. Take a fresh browser snapshot.");
  const selector = "button,a[href],input,textarea,select,[role=button],[role=link]";
  const target = source.closest?.(selector) || source;
  if (intent === "click" && ref) target.scrollIntoView?.({ block: "center", inline: "center" });
  const form = target.form || source.form || target.closest?.("form") || null;
  const label = (element) => {
    const aria = element.getAttribute?.("aria-label") || element.getAttribute?.("title");
    if (aria) return aria.replace(/\s+/g, " ").trim().slice(0, 180);
    const labels = element.labels ? [...element.labels].map((item) => {
      const copy = item.cloneNode(true);
      copy.querySelectorAll("input,textarea,select").forEach((control) => control.remove());
      return copy.innerText || copy.textContent || "";
    }).join(" ") : "";
    return (labels || element.innerText || element.textContent || element.getAttribute?.("placeholder") || "")
      .replace(/\s+/g, " ").trim().slice(0, 180);
  };
  const submitter = form?.querySelector('button[type="submit"],input[type="submit"],input[type="image"],button:not([type])');
  const descriptorElement = intent === "enter" && submitter ? submitter : target;
  const type = String(descriptorElement.getAttribute?.("type") || "").toLowerCase();
  const isSubmit = Boolean(form && (type === "submit" || type === "image" || (descriptorElement.tagName === "BUTTON" && type !== "button")));
  const formControls = form ? [...form.elements].map((element) => `${label(element)} ${element.name || ""} ${element.autocomplete || ""}`).join(" ") : "";
  const financialForm = Boolean(form && /\b(pay|payment|billing|purchase|checkout|credit card|card number|bank account|transfer|amount due)\b/i.test(`${label(form)} ${formControls}`));
  const safePagePath = (value) => {
    try { const url = new URL(value, location.href); return `${url.origin}${url.pathname}`.slice(0, 600); }
    catch { return ""; }
  };
  const rect = target.getBoundingClientRect?.();
  return {
    tagName: String(descriptorElement.tagName || "").toUpperCase(),
    role: descriptorElement.getAttribute?.("role") || "",
    name: label(descriptorElement),
    type,
    href: descriptorElement instanceof HTMLAnchorElement ? safePagePath(descriptorElement.href) : "",
    formAction: form ? safePagePath(form.action) : "",
    formMethod: form ? String(descriptorElement.formMethod || form.method || "GET").toUpperCase() : "",
    inForm: Boolean(form),
    isSubmit,
    financialForm,
    fileInput: Boolean(source.matches?.('input[type="file"]') || source.closest?.("label")?.querySelector('input[type="file"]') || source.control?.matches?.('input[type="file"]')),
    point: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
  };
}

async function approveAgentBrowserAction({ scope, tabId, contents, host, origin, target, intent, ref = "", x = null, y = null }) {
  if (browserActionRequiresHandoff(target, intent)) {
    const actionLabel = classifyBrowserAction(target, intent) || "Make a purchase or payment";
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Take over this browser action",
      message: `${actionLabel} on ${origin}.`,
      detail: "For your security, the agent stopped before the transaction. Continue in the Browser yourself.",
      buttons: ["Continue in Browser"],
      defaultId: 0,
      noLink: true,
    });
    return { handoffRequired: true };
  }
  try {
    return await authorizeBrowserAction({
      dialog, window: mainWindow, target, intent, origin,
      isStillCurrent: async () => {
        try {
          return activeTabId(scope) === tabId && browserHostIsVisible(host) && new URL(contents.getURL()).origin === origin;
        } catch { return false; }
      },
      getCurrentTarget: () => contents.executeJavaScript(`(${describeBrowserActionTarget.toString()})(${JSON.stringify(ref)},${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(intent)})`, true),
    });
  } catch (error) {
    if (/changed during approval/.test(String(error?.message || ""))) {
      error.statusCode = 409;
      error.message = `${error.message} Take a fresh snapshot before continuing.`;
    }
    throw error;
  }
}

function browserAutomationRequest(request, response) {
  const e2e = process.env.TRIBE_BROWSER_E2E === "1";
  if (e2e) console.log(`Browser E2E request started: ${request.method} ${request.url}.`);
  const configuredToken = browserApiToken;
  const suppliedToken = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const configuredBuffer = Buffer.from(configuredToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  if (!configuredToken || configuredBuffer.length !== suppliedBuffer.length
      || !crypto.timingSafeEqual(configuredBuffer, suppliedBuffer)) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorised" }));
    return;
  }
  if (request.method !== "POST" || request.headers.origin) {
    response.writeHead(405, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
      const browserActions = `state|navigate|snapshot|screenshot|diagnostics|storage${e2e ? "|site-inventory|clear-site-data|new-tab|select-tab|close-tab|crash|agent-control|hold|shortcut|menu-state|menu-command|layout-state|extract-design-reference|approval-ui-state|approval-ui-action" : ""}|click|click-at|fill|upload|press|type|scroll|viewport|reload|back|forward`;
  const match = new RegExp(`^/v1/browser/([a-zA-Z0-9-]{1,80})/(${browserActions})$`)
    .exec(new URL(request.url, "http://127.0.0.1").pathname);
  if (!match) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const [, , action] = match;
  const scope = "workspace";
  const controlSnapshot = browserAgentControl.state(scope);
  if (controlSnapshot.paused && !(e2e && action === "agent-control")) {
    response.writeHead(423, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Browser control was stopped by the user." }));
    return;
  }
  const requestId = crypto.randomUUID();
  const agentRequest = { scope, action, tabId: "", contents: null, cancelled: false };
  browserAgentRequests.set(requestId, agentRequest);
  publish(scope, browserAgentControlState(scope));
  let finished = false;
  const finishRequest = () => {
    if (finished) return;
    finished = true;
    browserAgentRequests.delete(requestId);
    publish(scope, browserAgentControlState(scope));
  };
  response.once("finish", finishRequest);
  response.once("close", finishRequest);
  request.once("aborted", finishRequest);
  const assertAgentControl = () => browserAgentControl.assertAllowed(scope, controlSnapshot.revision);
  let bytes = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 128_000) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", async () => {
    if (e2e) console.log(`Browser E2E request body received: ${bytes} bytes.`);
    try {
      if (!(e2e && action === "agent-control")) assertAgentControl();
      const payload = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (e2e && action === "extract-design-reference") {
        const result = await mainWindow.webContents.executeJavaScript(
          `(async () => window.tribeDesktopBrowser.extractDesignReference(${JSON.stringify(scope)}))()`,
          true,
        );
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result }));
        return;
      }
      if (e2e && action === "approval-ui-state") {
        const result = await mainWindow.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector(".project-settings-dialog");
          const projectButtons = [...document.querySelectorAll(".explorer-project-button")];
          const testScheduleRow = [...document.querySelectorAll(".command-run")]
            .find((item) => item.querySelector(".command-run-meta strong")?.textContent.trim() === "Investigate failing tests");
          return {
            runtimeBaseUrl: window.tribeDesktop?.runtimeBaseUrl || "",
            projectNames: projectButtons.map((button) => button.textContent.trim()),
            sidebarCollapsed: document.querySelector(".app-shell")?.classList.contains("app-shell--sidebar-collapsed") ?? null,
            projectVisible: projectButtons
              .some((button) => button.querySelector("span")?.textContent.trim() === "Approval UI Acceptance"),
            settingsOpen: Boolean(dialog),
            activeSection: dialog?.querySelector('[role="tab"][aria-selected="true"]')?.id || "",
            selectedMode: dialog?.querySelector('input[name="approval-mode"]:checked')?.value || "",
            availableModes: [...(dialog?.querySelectorAll('input[name="approval-mode"]') || [])].map((input) => input.value),
            modesEnabled: [...(dialog?.querySelectorAll('input[name="approval-mode"]') || [])].length === 3
              && [...dialog.querySelectorAll('input[name="approval-mode"]')].every((input) => !input.disabled),
            modeTitles: [...(dialog?.querySelectorAll(".approval-mode-copy strong") || [])].map((item) => item.textContent.trim()),
            grantBoundaryVisible: Boolean(dialog && [...dialog.querySelectorAll("p")].some((item) => item.textContent.includes("cannot grant tools or access"))),
            exactApprovalVisible: Boolean(dialog && [...dialog.querySelectorAll("p")].some((item) => item.textContent.includes("Exact approvals for destructive changes and external actions remain in place"))),
            savedNotice: dialog?.querySelector('[role="status"]')?.textContent.trim() || "",
            scheduleViewVisible: Boolean(document.querySelector(".schedule-view")),
            scheduleDialogOpen: Boolean(document.querySelector(".schedule-dialog")),
            scheduleCadenceValue: document.querySelector('.schedule-dialog button[aria-label="Repeat"]')?.textContent.trim() || "",
            triggerValue: document.querySelector('.schedule-dialog button[aria-label="Trigger"]')?.textContent.trim() || "",
            triggerOptions: [...document.querySelectorAll('.schedule-dialog [role="option"]')].map((item) => item.textContent.trim()),
            scheduleOptionLabels: [...document.querySelectorAll('.schedule-dialog [role="option"]')].map((item) => item.textContent.trim()),
            pathFilterVisible: Boolean(document.querySelector("#schedule-event-path-pattern")),
            githubRepositoryFieldVisible: Boolean(document.querySelector("#schedule-event-github-repository")),
            scheduleCreateEnabled: Boolean(document.querySelector(".schedule-dialog button[type=submit]:not(:disabled)")),
            testScheduleButtons: [...(testScheduleRow?.querySelectorAll("button[aria-label]") || [])]
              .map((button) => button.getAttribute("aria-label")),
            designSystemsViewVisible: Boolean(document.querySelector(".design-systems-view")),
            designSystemEditorOpen: Boolean(document.querySelector(".design-system-editor")),
            designSystemDraftName: document.querySelector(".design-system-editor input")?.value || "",
            designSystemDetailName: document.querySelector(".design-system-detail-heading h3")?.textContent.trim() || "",
            designSystemDetailVersion: document.querySelector(".design-system-detail-heading .eyebrow")?.textContent.trim() || "",
            designSystemSavedNames: [...document.querySelectorAll(".design-system-library .design-system-option strong")]
              .map((item) => item.textContent.trim()),
            designSystemAppliedLabel: document.querySelector(".design-system-apply > div:first-child span")?.textContent.trim() || "",
          };
        })()`);
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result }));
        return;
      }
      if (e2e && action === "approval-ui-action") {
        const operation = String(payload.operation || "");
        const mode = String(payload.mode || "");
        const data = String(payload.data || "");
        let exportedFile = null;
        let exportDownload = null;
        if (operation === "export-design-system") {
          exportDownload = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Design-system export did not download.")), 10_000);
            mainWindow.webContents.session.once("will-download", (_event, item, contents) => {
              if (contents !== mainWindow.webContents) {
                clearTimeout(timer);
                item.cancel();
                reject(new Error("Unexpected download while verifying design-system export."));
                return;
              }
              const filename = item.getFilename();
              const filepath = path.join(app.getPath("temp"), `tribe-design-system-export-${crypto.randomUUID()}.json`);
              item.setSavePath(filepath);
              item.once("done", async (_doneEvent, state) => {
                clearTimeout(timer);
                if (state !== "completed") {
                  reject(new Error(`Design-system export download ended with ${state}.`));
                  return;
                }
                try {
                  exportedFile = { filename, content: await fs.promises.readFile(filepath, "utf8") };
                  await fs.promises.unlink(filepath);
                  resolve(exportedFile);
                } catch (error) {
                  reject(error);
                }
              });
            });
          });
        }
        const dispatched = await mainWindow.webContents.executeJavaScript(`(() => {
          const operation = ${JSON.stringify(operation)};
          const mode = ${JSON.stringify(mode)};
          const data = ${JSON.stringify(data)};
          const projectMenu = [...document.querySelectorAll("button[aria-label]")]
            .find((button) => button.getAttribute("aria-label") === "More actions for Approval UI Acceptance");
          const projectSettings = [...document.querySelectorAll('button[role="menuitem"]')]
            .find((button) => button.textContent.trim() === "Project settings");
          const targets = {
            "open-project-menu": projectMenu,
            "open-project-settings": projectSettings,
            "open-approvals-section": document.getElementById("project-settings-tab-approvals"),
            "close-project-settings": document.querySelector('.project-settings-dialog button[aria-label="Close project settings"]'),
            "save-approval-mode": document.querySelector(".approval-settings-form button[type=submit]"),
            "open-scheduled-tasks": [...document.querySelectorAll(".sidebar-nav-group--workspace .nav-item")]
              .find((button) => button.textContent.trim() === "Scheduled tasks" || button.title === "Scheduled tasks"),
            "open-event-template": [...document.querySelectorAll(".schedule-template")]
              .find((button) => button.querySelector("strong")?.textContent.trim() === "Investigate failing tests"),
            "open-new-schedule": [...document.querySelectorAll(".schedule-heading-actions button")]
              .find((button) => button.textContent.trim().includes("New scheduled task")),
            "open-cadence-selector": document.querySelector('.schedule-dialog button[aria-label="Repeat"]'),
            "choose-event-cadence": [...document.querySelectorAll('.schedule-dialog [role="option"]')]
              .find((option) => option.textContent.trim() === "When an event occurs"),
            "fill-event-schedule": document.querySelector(".schedule-dialog #schedule-title"),
            "fill-github-event-schedule": document.querySelector(".schedule-dialog #schedule-title"),
            "open-trigger-selector": document.querySelector('.schedule-dialog button[aria-label="Trigger"]'),
            "open-source-chat-selector": document.querySelector('.schedule-dialog button[aria-label="Watch chat"], .schedule-dialog button[aria-label="Record events in chat"]'),
            "cancel-schedule": [...(document.querySelector(".schedule-dialog")?.querySelectorAll("button") || [])]
              .find((button) => button.textContent.trim() === "Cancel"),
            "choose-source-chat": [...document.querySelectorAll('.schedule-dialog [role="option"]')]
              .find((option) => option.textContent.trim() === mode && option.getAttribute("aria-disabled") !== "true"),
            "create-event-schedule": document.querySelector(".schedule-dialog button[type=submit]"),
            "pause-test-schedule": [...document.querySelectorAll(".command-run")]
              .find((item) => item.querySelector(".command-run-meta strong")?.textContent.trim() === "Investigate failing tests")
              ?.querySelector('button[aria-label="Pause schedule"]'),
            "resume-test-schedule": [...document.querySelectorAll(".command-run")]
              .find((item) => item.querySelector(".command-run-meta strong")?.textContent.trim() === "Investigate failing tests")
              ?.querySelector('button[aria-label="Resume schedule"]'),
            "cancel-test-schedule": [...document.querySelectorAll(".command-run")]
              .find((item) => item.querySelector(".command-run-meta strong")?.textContent.trim() === "Investigate failing tests")
              ?.querySelector('button[aria-label="Cancel schedule"]'),
            "open-design-systems": [...document.querySelectorAll(".nav-item")]
              .find((button) => button.textContent.trim() === "Design systems" || button.title === "Design systems"),
            "open-design-system-editor": [...document.querySelectorAll(".design-systems-heading-actions button")]
              .find((button) => button.textContent.trim() === "Create system"),
            "open-edit-design-system": [...(document.querySelector(".design-system-detail-heading")?.querySelectorAll("button") || [])]
              .find((button) => button.textContent.trim() === "Edit"),
            "export-design-system": [...(document.querySelector(".design-system-detail-heading")?.querySelectorAll("button") || [])]
              .find((button) => button.textContent.trim() === "Export"),
            "save-design-system": document.querySelector(".design-system-editor button[type=submit]"),
            "apply-design-system": document.querySelector(".design-system-apply button.button--primary"),
            "import-design-system": document.querySelector('.design-systems-heading input[type="file"]'),
            "cancel-design-system-editor": [...(document.querySelector(".design-system-editor")?.querySelectorAll("button") || [])]
              .find((button) => button.textContent.trim() === "Cancel"),
            "close-design-system-editor": document.querySelector('.design-system-editor button[aria-label="Close"]'),
            "edit-design-system-name": document.querySelector(".design-system-editor input"),
            "name-design-system-for-save": document.querySelector(".design-system-editor input"),
            "name-design-system-v2": document.querySelector(".design-system-editor input"),
            "choose-approval-mode": ["standard", "review_changes", "confirm_every_call"].includes(mode)
              ? document.querySelector('input[name="approval-mode"][value="' + mode + '"]') : null,
            "choose-event-trigger": ["A test run fails", "A repository file changes", "A chat completes", "An artifact is created", "A GitHub Actions run fails"].includes(mode)
              ? [...document.querySelectorAll('.schedule-dialog [role="option"]')]
                .find((option) => option.textContent.trim() === mode) : null,
          };
          const target = targets[operation];
          if (!target || target.disabled) return false;
          if (operation === "save-approval-mode") target.form?.requestSubmit();
          else if (operation === "edit-design-system-name") {
            const input = document.querySelector(".design-system-editor input");
            if (!input) return false;
            const previous = input.value;
            input.value = "Discarded draft";
            input._valueTracker?.setValue(previous);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          else if (operation === "name-design-system-for-save" || operation === "name-design-system-v2") {
            const input = document.querySelector(".design-system-editor input");
            if (!input) return false;
            const previous = input.value;
            input.value = operation === "name-design-system-v2" ? "Tribe Acceptance System v2" : "Tribe Acceptance System";
            input._valueTracker?.setValue(previous);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          else if (operation === "import-design-system") {
            const input = document.querySelector('.design-systems-heading input[type="file"]');
            if (!input || !data) return false;
            const file = new File([data], "tribe-acceptance-system.json", { type: "application/json" });
            Object.defineProperty(input, "files", { configurable: true, value: [file] });
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          else if (operation === "fill-event-schedule") {
            const title = document.querySelector(".schedule-dialog #schedule-title");
            const prompt = document.querySelector(".schedule-dialog textarea");
            if (!title || !prompt) return false;
            const update = (input, value) => {
              const previous = input.value;
              input.value = value;
              input._valueTracker?.setValue(previous);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            };
            update(title, "Local event delivery acceptance");
            update(prompt, "Investigate this synthetic failing test run.");
          }
          else if (operation === "fill-github-event-schedule") {
            const title = document.querySelector(".schedule-dialog #schedule-title");
            const prompt = document.querySelector(".schedule-dialog textarea");
            const repository = document.querySelector(".schedule-dialog #schedule-event-github-repository");
            if (!title || !prompt || !repository) return false;
            const update = (input, value) => {
              const previous = input.value;
              input.value = value;
              input._valueTracker?.setValue(previous);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            };
            update(title, "GitHub Actions delivery acceptance");
            update(prompt, "Review the failing public workflow run.");
            update(repository, "tribe-fixtures/sample");
          }
          else target.click();
          return true;
        })()`);
        if (!dispatched) {
          if (operation === "export-design-system") void exportDownload.catch(() => {});
          response.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "approval_ui_action_unavailable" }));
          return;
        }
        if (operation === "export-design-system") {
          try {
            exportedFile = await exportDownload;
          } catch (error) {
            response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            response.end(JSON.stringify({ error: error.message || "design_system_export_failed" }));
            return;
          }
        }
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: { dispatched: operation, exportedFile } }));
        return;
      }
      if (e2e && action === "agent-control") {
        const result = setBrowserAgentControlPaused(scope, payload.paused === true);
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result }));
        return;
      }
      if (e2e && action === "menu-state") {
        const ids = [
          "tribe-browser-new-tab", "tribe-browser-close-tab", "tribe-browser-back",
          "tribe-browser-forward", "tribe-browser-focus-address", "tribe-browser-show-downloads",
          "tribe-browser-reload", "tribe-browser-hard-reload", "tribe-browser-zoom-in",
          "tribe-browser-zoom-out", "tribe-browser-reset-zoom", "tribe-browser-show-tools",
        ];
        const menu = Menu.getApplicationMenu();
        const items = ids.map((id) => {
          const item = menu?.getMenuItemById(id);
          return item ? { id, label: item.label, accelerator: item.accelerator || "", enabled: item.enabled } : null;
        }).filter(Boolean);
        const result = { platform: process.platform, active: Boolean(browserBounds.get(scope)?.visible), items };
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result }));
        return;
      }
      if (e2e && action === "menu-command") {
        const id = String(payload.id ?? "");
        const item = id.startsWith("tribe-browser-") ? Menu.getApplicationMenu()?.getMenuItemById(id) : null;
        if (!item || !item.enabled) {
          response.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "browser_menu_item_unavailable" }));
          return;
        }
        item.click();
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: { dispatched: id } }));
        return;
      }
      if (e2e && action === "layout-state") {
        const renderer = await mainWindow.webContents.executeJavaScript(`(() => {
          const toolbar = document.querySelector(".tribe-browser-toolbar");
          const titlebar = document.querySelector(".topbar");
          const titlebarMain = document.querySelector(".topbar-main");
          const titlebarTabs = document.querySelector(".topbar-secondary-tabs");
          const workspaceBody = document.querySelector(".workspace-body--split");
          const chatPane = document.querySelector(".workspace-primary");
          const workspacePane = document.querySelector(".project-tool-pane");
          const emptyState = document.querySelector(".tribe-browser-empty");
          const rect = (element) => element ? element.getBoundingClientRect() : null;
          const mainRect = rect(titlebarMain);
          const tabsRect = rect(titlebarTabs);
          return {
            innerWidth: window.innerWidth,
            rootClientWidth: document.documentElement.clientWidth,
            rootScrollWidth: document.documentElement.scrollWidth,
            titlebarHeight: titlebar ? Math.round(titlebar.getBoundingClientRect().height) : null,
            browserToolbarClientWidth: toolbar?.clientWidth ?? null,
            browserToolbarScrollWidth: toolbar?.scrollWidth ?? null,
            browserAddressFocused: document.activeElement?.getAttribute("aria-label") === "Browser address",
            browserEmptyStateVisible: Boolean(emptyState && emptyState.getClientRects().length
              && getComputedStyle(emptyState).visibility !== "hidden"),
            splitWorkspace: Boolean(workspaceBody),
            splitTitlebar: Boolean(titlebar?.classList.contains("topbar--split-workspace")),
            splitTitlebarAligned: Boolean(mainRect && tabsRect
              && Math.abs((mainRect.top + mainRect.height / 2) - (tabsRect.top + tabsRect.height / 2)) <= 1),
            splitTitlebarMainTop: mainRect?.top ?? null,
            splitTitlebarTabsTop: tabsRect?.top ?? null,
            splitTitlebarMainHeight: mainRect?.height ?? null,
            splitTitlebarTabsHeight: tabsRect?.height ?? null,
            splitTitlebarOverflow: titlebar ? titlebar.scrollWidth > titlebar.clientWidth : null,
            chatPaneWidth: rect(chatPane)?.width ?? null,
            workspacePaneWidth: rect(workspacePane)?.width ?? null,
            splitPaneLayout: workspaceBody ? getComputedStyle(workspaceBody).display : null,
          };
        })()`);
        const host = browserHosts.get(viewKey("workspace", activeTabId("workspace")));
        const result = { windowWidth: mainWindow.getSize()[0], browserHostVisible: Boolean(host?.getVisible()), ...renderer };
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result }));
        return;
      }
      if (e2e && action === "hold") {
        await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.min(5000, Number(payload.durationMs) || 500))));
        assertAgentControl();
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: { completed: true } }));
        return;
      }
      if (e2e && action === "new-tab") {
        const created = await createBrowserTab(scope);
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: created.state }));
        if (e2e) console.log(`Browser E2E request completed: ${action}.`);
        return;
      }
      if (e2e && action === "select-tab") {
        activateBrowserTab(scope, String(payload.tabId || ""));
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: publicBrowserState(scope) }));
        if (e2e) console.log(`Browser E2E request completed: ${action}.`);
        return;
      }
      if (e2e && action === "close-tab") {
        const closed = closeBrowserTab(scope, String(payload.tabId || ""));
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: { closed, ...publicBrowserState(scope) } }));
        if (e2e) console.log(`Browser E2E request completed: ${action}.`);
        return;
      }
      if (e2e && action === "crash") {
        const contents = viewFor(scope)?.webContents;
        if (typeof contents?.forcefullyCrashRenderer !== "function") throw new Error("This Electron build cannot simulate a browser renderer crash.");
        setTimeout(() => { if (!contents.isDestroyed()) contents.forcefullyCrashRenderer(); }, 100);
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: { requested: true } }));
        if (e2e) console.log(`Browser E2E request completed: ${action}.`);
        return;
      }
      const tabId = payload.tabId || activeTabId(scope);
      if (action === "state" && !tabId && tabsFor(scope).size === 0) {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ result: publicBrowserState(scope) }));
        if (e2e) console.log(`Browser E2E request completed: ${action} (empty workspace).`);
        return;
      }
      agentRequest.tabId = tabId;
      if (payload.tabId && payload.tabId !== activeTabId(scope)) {
        throw Object.assign(new Error("The visible browser tab changed. Take a fresh snapshot before continuing."), { statusCode: 409 });
      }
      const view = viewFor(scope, tabId);
      const host = browserHosts.get(viewKey(scope, tabId));
      const tab = tabsFor(scope).get(tabId);
      const visibleBlankTab = Boolean(browserBounds.get(scope)?.visible && tab?.hasPage === false
        && (action === "state" || action === "navigate"));
      if (!view || view.webContents.isDestroyed()
          || (!browserHostIsVisible(host) && !stateFor(scope).pageStopped && !visibleBlankTab)) {
        throw Object.assign(new Error("Open the Browser workspace to let the agent use its visible tab."), { statusCode: 404 });
      }
      const contents = view.webContents;
      agentRequest.contents = contents;
      const allowedDomains = action === "state" ? [] : normaliseBrowserDomains(payload.allowedDomains);
      if (action === "navigate") {
        const target = safeUrl(payload.url);
        if (!domainAllowed(target, allowedDomains)) throw Object.assign(new Error("The website is outside the project's allowed websites."), { statusCode: 403 });
        setAgentRequestPolicy(scope, tabId, contents, allowedDomains);
      } else if (action !== "state") {
        if (!domainAllowed(contents.getURL(), allowedDomains)) throw Object.assign(new Error("The current website is outside the project's allowed websites."), { statusCode: 403 });
        setAgentRequestPolicy(scope, tabId, contents, allowedDomains);
      }
      let result;
      assertAgentControl();
      if (e2e && action === "shortcut") {
        const shortcutKeys = {
          "focus-address": "L",
          "new-tab": "T",
          "close-tab": "W",
        };
        const keyCode = shortcutKeys[payload.shortcut];
        if (!keyCode) throw Object.assign(new Error("Choose a supported browser shortcut."), { statusCode: 400 });
        const modifier = process.platform === "darwin" ? "meta" : "control";
        contents.focus();
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [modifier] });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: [modifier] });
        await new Promise((resolve) => setTimeout(resolve, 120));
        await mainWindow.webContents.executeJavaScript(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        ).catch(() => {});
        const focusedElement = await mainWindow.webContents.executeJavaScript(
          "document.activeElement?.getAttribute('aria-label') || ''",
        ).catch(() => "");
        result = { shortcut: payload.shortcut, shortcutHandled: tab.lastShortcut === payload.shortcut, focusedElement, state: publicBrowserState(scope) };
      } else if (action === "state") result = publicBrowserState(scope);
      else if (action === "navigate") {
        assertAgentControl();
        await contents.loadURL(safeUrl(payload.url));
        result = publicBrowserState(scope);
      } else if (action === "screenshot") {
        const image = await contents.capturePage();
        result = { mimeType: "image/jpeg", image: image.toJPEG(82).toString("base64"),
          viewport: { width: image.getSize().width, height: image.getSize().height } };
      } else if (action === "diagnostics") {
        result = { url: sanitisePageUrl(contents.getURL()), ...diagnosticsFor(scope, tabId, payload.limit) };
      } else if (action === "storage") {
        result = await siteStorageForTab(tab);
      } else if (action === "site-inventory") {
        const requestedOrigin = payload.origin === undefined ? undefined : normaliseSiteOrigin(payload.origin);
        if (payload.origin !== undefined && (!requestedOrigin || !domainAllowed(requestedOrigin, allowedDomains))) {
          throw Object.assign(new Error("The website is outside the project's allowed websites."), { statusCode: 403 });
        }
        const inventory = await siteStorageInventory(scope, requestedOrigin);
        result = requestedOrigin
          ? inventory
          : inventory.filter((site) => domainAllowed(site.origin, allowedDomains));
      } else if (action === "clear-site-data") {
        result = await clearBrowserSiteData(scope, payload.origin);
      } else if (action === "snapshot") {
        const prefix = crypto.randomBytes(8).toString("hex");
        result = await contents.executeJavaScript(`(${snapshotPage.toString()})(${JSON.stringify(prefix)})`, true);
        result.url = sanitisePageUrl(result.url);
      } else if (action === "click") {
        const ref = String(payload.ref || "");
        if (!/^[a-f0-9]{16}-\d{1,3}$/.test(ref)) throw new Error("Choose an element from the latest browser snapshot.");
        const target = await contents.executeJavaScript(`(${describeBrowserActionTarget.toString()})(${JSON.stringify(ref)},null,null,"click")`, true);
        if (target.fileInput) throw new Error("Use browser_upload to choose files for a page input.");
        const approvedTarget = await approveAgentBrowserAction({ scope, tabId, contents, host, origin: new URL(contents.getURL()).origin, target, intent: "click", ref });
        assertAgentControl();
        if (approvedTarget?.handoffRequired) result = { clicked: false, handoffRequired: true };
        else if (!approvedTarget) result = { clicked: false, cancelled: true, approvalRequired: true };
        else {
          const point = approvedTarget.point;
          if (!point) throw new Error("The page control has no clickable area. Take a fresh browser snapshot.");
          await showAgentPointer(contents, point.x, point.y);
          assertAgentControl();
          contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
          contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
          contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
          await settleBrowserAction(contents);
          markAgentAction(scope, "click");
          result = { clicked: true, approvalRequired: Boolean(classifyBrowserAction(target, "click")) };
        }
      } else if (action === "click-at") {
        const x = Number(payload.x);
        const y = Number(payload.y);
        const dimensions = await contents.executeJavaScript("({width:window.innerWidth,height:window.innerHeight})", true);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= dimensions.width || y >= dimensions.height) {
          throw new Error("Choose coordinates inside the current page viewport.");
        }
        const target = await contents.executeJavaScript(`(${describeBrowserActionTarget.toString()})("",${x},${y},"click")`, true);
        if (target.fileInput) throw new Error("Use browser_upload to choose files for a page input.");
        const approvedTarget = await approveAgentBrowserAction({ scope, tabId, contents, host, origin: new URL(contents.getURL()).origin, target, intent: "click", x, y });
        assertAgentControl();
        if (approvedTarget?.handoffRequired) result = { clicked: false, handoffRequired: true };
        else if (!approvedTarget) result = { clicked: false, cancelled: true, approvalRequired: true };
        else {
          await showAgentPointer(contents, x, y);
          assertAgentControl();
          contents.sendInputEvent({ type: "mouseMove", x, y });
          contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
          contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
          await settleBrowserAction(contents);
          markAgentAction(scope, "click");
          result = { clicked: true, approvalRequired: Boolean(classifyBrowserAction(target, "click")) };
        }
      } else if (action === "fill") {
        const ref = String(payload.ref || "");
        const value = payload.value;
        const validValue = typeof value === "string" && value.length <= 10000
          || Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === "string" && item.length <= 256);
        if (!/^[a-f0-9]{16}-\d{1,3}$/.test(ref) || !validValue) throw new Error("Choose a current field reference and a text value or up to 100 select options.");
        const target = await contents.executeJavaScript(`(${describeBrowserActionTarget.toString()})(${JSON.stringify(ref)},null,null,"fill")`, true);
        if (["password", "hidden", "file"].includes(target.type)) throw new Error("The agent cannot fill password, hidden, or file fields. Enter sensitive values yourself or use browser_upload for files.");
        const approvedTarget = await approveAgentBrowserAction({ scope, tabId, contents, host, origin: new URL(contents.getURL()).origin, target, intent: "fill", ref });
        assertAgentControl();
        if (approvedTarget?.handoffRequired) result = { filled: false, handoffRequired: true };
        else if (!approvedTarget) result = { filled: false, cancelled: true, approvalRequired: true };
        else {
          result = await contents.executeJavaScript(`(() => {
            const e=[...document.querySelectorAll('[data-tribe-browser-ref]')].find(x=>x.getAttribute('data-tribe-browser-ref')===${JSON.stringify(ref)});
            if (!e || !('value' in e) || /^(password|hidden|file)$/i.test(e.type||'')) throw new Error('field_not_available');
            const value=${JSON.stringify(value)};
            if (e instanceof HTMLSelectElement) {
              const options=[...e.options].filter((option) => !option.disabled && !option.parentElement?.disabled);
              const resolveOption=(selection) => {
                if (typeof selection !== 'string') return null;
                const byValue=options.filter((option) => option.value === selection);
                const byLabel=options.filter((option) => String(option.label || option.textContent || '').replace(/\\s+/g, ' ').trim() === selection.trim());
                return byValue.length === 1 ? byValue[0] : byValue.length > 1 ? null : byLabel.length === 1 ? byLabel[0] : null;
              };
              if (e.multiple) {
                if (!Array.isArray(value)) throw new Error('Choose an array of enabled options for this multi-select control.');
                const selected=value.map(resolveOption);
                if (selected.some((option) => !option) || new Set(selected).size !== selected.length) throw new Error('Choose distinct, unambiguous enabled options from the latest browser snapshot.');
                const selectedSet=new Set(selected);
                for (const option of e.options) option.selected=selectedSet.has(option);
                e.dispatchEvent(new Event('input',{bubbles:true}));
                e.dispatchEvent(new Event('change',{bubbles:true}));
                return {filled:true, selectedOptions:selected.map((option) => String(option.label || option.textContent || '').replace(/\\s+/g, ' ').trim().slice(0,180))};
              }
              if (Array.isArray(value)) throw new Error('Choose one option for this single-select control.');
              const option=resolveOption(value);
              if (!option) throw new Error('Choose one unambiguous enabled option from the latest browser snapshot.');
              const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
              setter.call(e,option.value);
              e.dispatchEvent(new Event('input',{bubbles:true}));
              e.dispatchEvent(new Event('change',{bubbles:true}));
              return {filled:true, selectedOption:String(option.label || option.textContent || '').replace(/\\s+/g, ' ').trim().slice(0,180)};
            }
            if (Array.isArray(value)) throw new Error('Use one text value for a text field.');
            const prototype=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
            const setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;
            if (!setter) throw new Error('field_not_available');
            setter.call(e,value);
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));
            return {filled:true};
          })()`, true);
          markAgentAction(scope, "fill");
          result.approvalRequired = Boolean(classifyBrowserAction(target, "fill"));
        }
      } else if (action === "upload") {
        const ref = String(payload.ref || "");
        const pageOrigin = new URL(contents.getURL()).origin;
        const e2eUploadPath = !app.isPackaged && process.env.TRIBE_BROWSER_E2E === "1"
          && process.env.TRIBE_BROWSER_E2E_AUTO_UPLOAD === "1"
          ? process.env.TRIBE_BROWSER_E2E_UPLOAD_FILE
          : "";
        const target = validateUploadTarget(
          await contents.executeJavaScript(`(${describeFileInput.toString()})(${JSON.stringify(ref)})`, true),
          ref,
          pageOrigin,
        );
        const confirmation = e2eUploadPath ? { response: 1 } : await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "Share files with this website?",
          message: `A page on ${target.origin} requested file access.`,
          detail: "Files you choose will be shared with this website. It may upload them as soon as you select them.",
          buttons: ["Cancel", "Choose files"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        assertAgentControl();
        if (confirmation.response !== 1) {
          result = { uploaded: false, cancelled: true };
        } else {
          if (activeTabId(scope) !== tabId || !browserHostIsVisible(host) || new URL(contents.getURL()).origin !== target.origin) {
            throw Object.assign(new Error("The visible browser page changed before file access was opened. Take a fresh snapshot before continuing."), { statusCode: 409 });
          }
          const fileInput = validateUploadTarget(
            await contents.executeJavaScript(`(${describeFileInput.toString()})(${JSON.stringify(ref)},true)`, true),
            ref,
            target.origin,
          );
          if (!fileInput.point || fileInput.point.x < 0 || fileInput.point.y < 0) {
            throw new Error("The page's file input has no visible control to open. Open its upload control, then try again.");
          }
          await contents.executeJavaScript(`(() => {
            const input = [...document.querySelectorAll("[data-tribe-browser-ref]")]
              .find((candidate) => candidate.getAttribute("data-tribe-browser-ref") === ${JSON.stringify(ref)});
            if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("The file input is no longer available.");
            input.value = "";
          })()`, true);
          const selectionPromise = e2eUploadPath ? null : contents.executeJavaScript(`(() => {
            const input = [...document.querySelectorAll("[data-tribe-browser-ref]")]
              .find((candidate) => candidate.getAttribute("data-tribe-browser-ref") === ${JSON.stringify(ref)});
            if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("The file input is no longer available.");
            return new Promise((resolve) => {
              let settled = false;
              let timer;
              const finish = (selection) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                input.removeEventListener("change", onChange);
                input.removeEventListener("cancel", onCancel);
                resolve(selection);
              };
              const onChange = () => finish({ selectedCount: input.files?.length || 0 });
              const onCancel = () => finish({ cancelled: true });
              input.addEventListener("change", onChange, { once: true });
              input.addEventListener("cancel", onCancel, { once: true });
              timer = setTimeout(() => finish({ timedOut: true }), 280000);
            });
          })()`, true);
          if (e2eUploadPath) {
            if (!fs.existsSync(e2eUploadPath)) throw new Error("The disposable browser upload fixture is unavailable.");
            const fixtureContent = fs.readFileSync(e2eUploadPath).toString("base64");
            const selectedCount = await contents.executeJavaScript(`(() => {
              const input = [...document.querySelectorAll("[data-tribe-browser-ref]")]
                .find((candidate) => candidate.getAttribute("data-tribe-browser-ref") === ${JSON.stringify(ref)});
              if (!(input instanceof HTMLInputElement) || input.type !== "file") {
                throw new Error("The disposable browser upload control is unavailable.");
              }
              const bytes = Uint8Array.from(atob(${JSON.stringify(fixtureContent)}), (value) => value.charCodeAt(0));
              const transfer = new DataTransfer();
              transfer.items.add(new File([bytes], ${JSON.stringify(path.basename(e2eUploadPath))}, { type: "text/plain" }));
              input.files = transfer.files;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              return input.files.length;
            })()`, true);
            assertAgentControl();
            if (process.env.TRIBE_BROWSER_E2E === "1") console.log(`Browser E2E fixture selection dispatched; selected files: ${selectedCount}.`);
            markAgentAction(scope, "upload");
            result = normaliseFileSelection({ selectedCount }, target.origin);
          } else {
            await showAgentPointer(contents, fileInput.point.x, fileInput.point.y);
            assertAgentControl();
            contents.sendInputEvent({ type: "mouseMove", x: fileInput.point.x, y: fileInput.point.y });
            contents.sendInputEvent({ type: "mouseDown", x: fileInput.point.x, y: fileInput.point.y, button: "left", clickCount: 1 });
            contents.sendInputEvent({ type: "mouseUp", x: fileInput.point.x, y: fileInput.point.y, button: "left", clickCount: 1 });
            markAgentAction(scope, "upload");
            result = normaliseFileSelection(await selectionPromise, target.origin);
          }
        }
      } else if (action === "type") {
        const value = String(payload.text ?? "");
        if (!value || value.length > 5000) throw new Error("Enter text under 5,000 characters.");
        const target = await contents.executeJavaScript(`(${describeBrowserActionTarget.toString()})("",null,null,"type")`, true);
        if (["password", "hidden", "file"].includes(target.type)) throw new Error("The agent cannot type into password, hidden, or file fields. Enter sensitive values yourself or use browser_upload for files.");
        const approvedTarget = await approveAgentBrowserAction({ scope, tabId, contents, host, origin: new URL(contents.getURL()).origin, target, intent: "type" });
          assertAgentControl();
        if (approvedTarget?.handoffRequired) result = { typed: false, handoffRequired: true };
        else if (!approvedTarget) result = { typed: false, cancelled: true, approvalRequired: true };
        else {
          contents.insertText(value);
          markAgentAction(scope, "type");
          result = { typed: true, approvalRequired: Boolean(classifyBrowserAction(target, "type")) };
        }
      } else if (action === "press") {
        const key = String(payload.key || "").toUpperCase();
        const allowed = new Set(["ENTER", "TAB", "ESC", "ESCAPE", "BACKSPACE", "DELETE", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "HOME", "END", "SPACE", "CTRL+A", "CMD+A"]);
        if (!allowed.has(key)) throw new Error("Choose a supported navigation or editing key.");
        let approvedTarget = null;
        let approvalTarget = null;
        const intent = key === "ENTER" ? "enter" : key === "SPACE" ? "space" : "click";
        if (key === "ENTER" || key === "SPACE") {
          approvalTarget = await contents.executeJavaScript(`(${describeBrowserActionTarget.toString()})("",null,null,${JSON.stringify(intent)})`, true);
          if (approvalTarget.fileInput) throw new Error("Use browser_upload to choose files for a page input.");
          approvedTarget = await approveAgentBrowserAction({ scope, tabId, contents, host, origin: new URL(contents.getURL()).origin, target: approvalTarget, intent });
          assertAgentControl();
          if (approvedTarget?.handoffRequired) {
            result = { pressed: false, handoffRequired: true };
          } else if (!approvedTarget) {
            result = { pressed: false, cancelled: true, approvalRequired: true };
          }
        }
        if ((key !== "ENTER" && key !== "SPACE") || (approvedTarget && !approvedTarget.handoffRequired)) {
        const keyCode = ({ ENTER: "ENTER", TAB: "TAB", ESC: "ESC", ESCAPE: "ESC", BACKSPACE: "BACKSPACE", DELETE: "DELETE", ARROWUP: "UP", ARROWDOWN: "DOWN", ARROWLEFT: "LEFT", ARROWRIGHT: "RIGHT", HOME: "HOME", END: "END", SPACE: " ", "CTRL+A": "A", "CMD+A": "A" })[key];
        if (key === "CTRL+A" || key === "CMD+A") contents.sendInputEvent({ type: "keyDown", keyCode: process.platform === "darwin" ? "META" : "CTRL" });
        contents.sendInputEvent({ type: "keyDown", keyCode });
        contents.sendInputEvent({ type: "keyUp", keyCode });
        if (key === "CTRL+A" || key === "CMD+A") contents.sendInputEvent({ type: "keyUp", keyCode: process.platform === "darwin" ? "META" : "CTRL" });
        markAgentAction(scope, "press");
        result = { pressed: key, approvalRequired: Boolean(approvalTarget && classifyBrowserAction(approvalTarget, intent)) };
        }
      } else if (action === "scroll") {
        const x = Math.max(-5000, Math.min(5000, Number(payload.x) || 0));
        const y = Math.max(-5000, Math.min(5000, Number(payload.y) || 0));
        await contents.executeJavaScript(`window.scrollBy(${x},${y})`, true);
        assertAgentControl();
        markAgentAction(scope, "scroll");
        result = { scrolled: true };
      } else if (action === "viewport") {
        const emulationRequest = payload.viewport && typeof payload.viewport === "object" && !Array.isArray(payload.viewport)
          ? { ...payload.viewport }
          : { viewport: payload.viewport };
        if (Object.hasOwn(payload, "locale")) emulationRequest.locale = payload.locale;
        if (Object.hasOwn(payload, "network")) emulationRequest.network = payload.network;
        if (Object.hasOwn(payload, "reducedMotion")) emulationRequest.reducedMotion = payload.reducedMotion;
        const { resolved, settings } = parseBrowserEmulationRequest(emulationRequest);
        assertAgentControl();
        await applyViewport(scope, tabId, resolved, settings);
        assertAgentControl();
        const viewportSize = await readBrowserViewportMetrics(contents);
        const tab = tabsFor(scope).get(tabId);
        tab.viewportSize = viewportSize;
        result = publish(scope, { viewport: tab.viewport, customViewport: tab.customViewport || null, locale: tab.locale, network: tab.network, reducedMotion: tab.reducedMotion, viewportSize });
      } else {
        if (action === "reload") reloadBrowserTab(scope, tabId);
        else if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        result = publicBrowserState(scope);
      }
      assertAgentControl();
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ result }));
      if (e2e) console.log(`Browser E2E request completed: ${action}.`);
    } catch (error) {
      response.writeHead(error.statusCode || 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: String(error.message || "browser_action_failed").slice(0, 300) }));
      if (e2e) console.log(`Browser E2E request rejected: ${error.statusCode || 400} ${String(error.message || "browser_action_failed").slice(0, 120)}.`);
    }
  });
}

function startBrowserAutomationServer() {
  const port = Number(browserApiPort || 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserApiToken) return;
  browserAutomationServer = http.createServer(browserAutomationRequest);
  browserAutomationServer.listen(port, "127.0.0.1", () => {
    if (process.env.TRIBE_BROWSER_E2E === "1") console.log(`Browser E2E service listening on ${JSON.stringify(browserAutomationServer.address())}.`);
  });
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function packagedRuntimePath() {
  const targets = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    win32: { x64: "x86_64-pc-windows-msvc" },
  };
  const target = targets[process.platform]?.[process.arch];
  if (!target) throw new Error(`Tribe's browser desktop build does not support ${process.platform}/${process.arch}.`);
  return path.join(process.resourcesPath, "runtime", `tribe-runtime-${target}${process.platform === "win32" ? ".exe" : ""}`);
}

function startPackagedUiServer(port) {
  const root = path.join(app.getAppPath(), "dist", "client");
  const types = {
    ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png",
    ".svg": "image/svg+xml", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm", ".webp": "image/webp", ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Allow": "GET, HEAD" }).end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
    catch { response.writeHead(400).end(); return; }
    let filename = path.resolve(root, `.${pathname}`);
    if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (fs.statSync(filename).isDirectory()) filename = path.join(filename, "index.html");
      if (!fs.statSync(filename).isFile()) throw new Error("not_file");
    } catch {
      if (path.extname(pathname)) { response.writeHead(404).end(); return; }
      filename = path.join(root, "index.html");
    }
    fs.readFile(filename, (error, content) => {
      if (error) { runtimeLog?.write(`UI file read failed: ${filename}: ${error.message}\n`); response.writeHead(404).end(); return; }
      runtimeLog?.write(`UI response: ${filename} (${content.length} bytes)\n`);
      response.writeHead(200, {
        "Content-Type": types[path.extname(filename).toLowerCase()] || "application/octet-stream",
        "Content-Length": content.length,
        "Connection": "close",
        "Cache-Control": filename.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
      });
      if (request.method === "HEAD") response.end();
      else response.end(content);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function waitForRuntime(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtimeChild?.exitCode !== null && runtimeChild?.exitCode !== undefined) {
      throw new Error("Tribe's local service stopped while starting. Check the runtime log in Tribe's app data folder.");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* Wait for the packaged runtime to bind its local port. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Tribe's local service did not become ready. Check the runtime log in Tribe's app data folder.");
}

async function startPackagedServices() {
  const browserE2E = process.env.TRIBE_BROWSER_E2E === "1";
  const dataDir = app.getPath("userData");
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  runtimeLog = fs.createWriteStream(path.join(logsDir, "runtime.log"), { flags: "a", mode: 0o600 });
  runtimePort = await reserveLocalPort();
  if (browserE2E) {
    if (!Number.isInteger(browserApiPort) || browserApiPort < 1 || browserApiPort > 65535) {
      throw new Error("The packaged browser test needs a reserved local API port.");
    }
    browserApiToken = await readBrowserApiToken();
    if (browserApiToken.length < 32) throw new Error("The packaged browser test needs its one-time local API token.");
  } else {
    browserApiPort = await reserveLocalPort();
    browserApiToken = crypto.randomBytes(32).toString("hex");
  }
  const uiPort = await reserveLocalPort();
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  packagedUiServer = await startPackagedUiServer(uiPort);
  process.env.TRIBE_PORT = String(runtimePort);
  const childEnv = {
    ...process.env,
    TRIBE_AGENT_DIR: path.join(process.resourcesPath, "agents"),
    TRIBE_BROWSER_API_PORT: String(browserApiPort),
    TRIBE_DATA_DIR: dataDir,
    TRIBE_DEV_ORIGIN: uiOrigin,
    TRIBE_PORT: String(runtimePort),
  };
  delete childEnv.TRIBE_BROWSER_API_TOKEN;
  runtimeChild = spawn(packagedRuntimePath(), [], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  runtimeChild.stdout.pipe(runtimeLog, { end: false });
  runtimeChild.stderr.pipe(runtimeLog, { end: false });
  runtimeChild.stdin.end(`${browserApiToken}\n`);
  runtimeChild.on("error", (error) => runtimeLog?.write(`Runtime launch failed: ${error.message}\n`));
  runtimeChild.on("exit", (code, signal) => {
    runtimeLog?.write(`Runtime exited: ${signal || code}\n`);
    if (!appIsQuitting) {
      appIsQuitting = true;
      dialog.showErrorBox("Tribe stopped", "Tribe's local service stopped unexpectedly. Reopen Tribe to continue.");
      app.quit();
    }
  });
  await waitForRuntime(runtimePort);
  packagedUiUrl = uiOrigin;
}

async function readBrowserApiToken() {
  if (!browserApiPort) return "";
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
    const newline = input.indexOf("\n");
    if (newline >= 0) return input.slice(0, newline).trim();
  }
  return input.trim();
}

function registerIpc() {
  ipcMain.handle("tribe:open-dialog", async (_event, options = {}) => {
    if (!mainWindow) return null;
    const properties = options.directory
      ? ["openDirectory"]
      : ["openFile", ...(options.multiple ? ["multiSelections"] : [])];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: String(options.title ?? "Choose a file").slice(0, 120),
      defaultPath: typeof options.defaultPath === "string" ? options.defaultPath : undefined,
      properties,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return options.multiple ? result.filePaths : result.filePaths[0];
  });
  ipcMain.handle("tribe:browser-open", async (_event, { scope, url } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    let view = viewFor(scope);
    if (!view) {
      let restore = browserSessionRestorePromises.get(scope);
      if (!restore) {
        restore = restoreBrowserSession(scope, url);
        browserSessionRestorePromises.set(scope, restore);
      }
      try { await restore; }
      finally {
        if (browserSessionRestorePromises.get(scope) === restore) browserSessionRestorePromises.delete(scope);
      }
      view = viewFor(scope);
    }
    const layout = browserBounds.get(scope);
    for (const tab of tabsFor(scope).values()) browserHosts.get(viewKey(scope, tab.id))?.setVisible(
      shouldShowBrowserHost(layout, tab, tab.id === activeTabId(scope)),
    );
    if (url && view && !view.webContents.getURL()) await view.webContents.loadURL(safeUrl(url));
    return publish(scope);
  });
  ipcMain.handle("tribe:browser-navigate", async (_event, { scope, url } = {}) => {
    const view = viewFor(scope);
    if (!view) throw new Error("Open the Browser workspace first.");
    clearAgentRequestPolicy(view.webContents);
    const tab = tabsFor(scope).get(activeTabId(scope));
    if (tab) tab.agentAllowedDomains = null;
    await view.webContents.loadURL(safeUrl(url));
    return publish(scope);
  });
  ipcMain.handle("tribe:browser-bounds", (_event, { scope, bounds, visible } = {}) => {
    const view = viewFor(scope);
    if (!view) return false;
    const safeBounds = {
      x: Math.round(Math.max(0, Number(bounds?.x) || 0)),
      y: Math.round(Math.max(0, Number(bounds?.y) || 0)),
      width: Math.round(Math.max(0, Number(bounds?.width) || 0)),
      height: Math.round(Math.max(0, Number(bounds?.height) || 0)),
    };
    browserBounds.set(scope, { bounds: safeBounds, visible: Boolean(visible) });
    updateBrowserMenuState();
    for (const tab of tabsFor(scope).values()) {
      const host = browserHosts.get(viewKey(scope, tab.id));
      host?.setBounds(safeBounds);
      fitBrowserView(scope, tab.id);
      host?.setVisible(shouldShowBrowserHost({ bounds: safeBounds, visible: Boolean(visible) }, tab, tab.id === activeTabId(scope)));
    }
    return true;
  });
  ipcMain.handle("tribe:browser-action", async (_event, { scope, action } = {}) => {
    const view = viewFor(scope);
    if (!view) throw new Error("Open the Browser workspace first.");
    if (["back", "forward", "reload"].includes(action)) {
      clearAgentRequestPolicy(view.webContents);
      const tab = tabsFor(scope).get(activeTabId(scope));
      if (tab) tab.agentAllowedDomains = null;
    }
    const history = view.webContents.navigationHistory;
    if (action === "back" && history.canGoBack()) history.goBack();
    else if (action === "forward" && history.canGoForward()) history.goForward();
    else if (action === "reload") reloadBrowserTab(scope, activeTabId(scope));
    else if (action === "stop") view.webContents.stop();
    return publish(scope);
  });
  ipcMain.handle("tribe:browser-new-tab", async (_event, { scope, url = "" } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    return (await createBrowserTab(scope, url)).state;
  });
  ipcMain.handle("tribe:browser-select-tab", (_event, { scope, tabId } = {}) => {
    activateBrowserTab(scope, tabId);
    return publicBrowserState(scope);
  });
  ipcMain.handle("tribe:browser-close-tab", (_event, { scope, tabId } = {}) => {
    closeBrowserTab(scope, tabId);
    return publicBrowserState(scope);
  });
  ipcMain.handle("tribe:browser-state", (_event, { scope } = {}) => publish(scope));
  ipcMain.handle("tribe:browser-extract-design-reference", (_event, { scope } = {}) =>
    extractActiveBrowserDesignReference(scope),
  );
  ipcMain.handle("tribe:browser-agent-control", (_event, { scope, paused } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    return setBrowserAgentControlPaused(scope, paused === true);
  });
  ipcMain.handle("tribe:browser-diagnostics", (_event, { scope, limit } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    const tabId = activeTabId(scope);
    const view = viewFor(scope, tabId);
    if (!view || view.webContents.isDestroyed()) throw new Error("Open a browser tab to inspect its diagnostics.");
    return { url: sanitisePageUrl(view.webContents.getURL()), ...diagnosticsFor(scope, tabId, limit) };
  });
  ipcMain.handle("tribe:browser-resolve-permission", (_event, { scope, id, decision } = {}) => {
    if (!["allow-once", "block-once", "allow-profile", "block-profile"].includes(decision)) {
      throw new Error("Choose whether to allow or block this website permission.");
    }
    const request = pendingBrowserPermissions.get(id);
    if (!request || request.scope !== scope) throw new Error("That website permission request is no longer available.");
    if (decision.endsWith("-profile") && !loadBrowserProfileStore().assignments[scope]) {
      throw new Error("Select a saved browser profile before remembering website permissions.");
    }
    resolveBrowserPermission(id, decision);
    return publicBrowserState(scope);
  });
  ipcMain.handle("tribe:browser-profiles", (_event, { scope } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    return publicProfileState(scope);
  });
  ipcMain.handle("tribe:browser-profile-usage", async () => {
    const profiles = loadBrowserProfileStore().profiles;
    return Promise.all(profiles.map(async (profile) => {
      try {
        const browserSession = session.fromPartition(`persist:tribe-profile-${profile.id}`);
        const usage = await estimateDirectoryBytes(browserSession.getStoragePath());
        return { profileId: profile.id, ...usage };
      } catch {
        return { profileId: profile.id, bytes: 0, complete: false };
      }
    }));
  });
  ipcMain.handle("tribe:browser-site-storage", async (_event, { scope } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    const tab = tabsFor(scope).get(activeTabId(scope));
    if (!tab) throw new Error("Open a browser tab to inspect site storage.");
    return siteStorageForTab(tab);
  });
  ipcMain.handle("tribe:browser-site-inventory", async (_event, { scope, origin } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    return siteStorageInventory(scope, origin);
  });
  ipcMain.handle("tribe:browser-clear-site-data", async (_event, { scope, origin } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    return clearBrowserSiteData(scope, origin);
  });
  ipcMain.handle("tribe:browser-create-profile", (_event, { name } = {}) => {
    const cleanName = String(name ?? "").trim();
    if (!cleanName || cleanName.length > 48) throw new Error("Profile names must be between 1 and 48 characters.");
    const store = loadBrowserProfileStore();
    if (store.profiles.some((profile) => profile.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      throw new Error("A browser profile with that name already exists.");
    }
    const profile = { id: crypto.randomUUID(), name: cleanName, createdAt: Date.now(), permissions: [] };
    store.profiles.push(profile);
    saveBrowserProfileStore();
    return {
      ...profile,
      profiles: store.profiles.map(({ id, name: profileName, createdAt, permissions }) => ({ id, name: profileName, createdAt, permissions })),
    };
  });
  ipcMain.handle("tribe:browser-select-profile", async (_event, { scope, profileId = "" } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    const store = loadBrowserProfileStore();
    if (profileId && !store.profiles.some((profile) => profile.id === profileId)) throw new Error("That browser profile is no longer available.");
    if ((store.assignments[scope] || "") === profileId) return publicBrowserState(scope);
    disposeBrowserScope(scope);
    if (profileId) store.assignments[scope] = profileId;
    else delete store.assignments[scope];
    saveBrowserProfileStore();
    await createBrowserTab(scope);
    return publish(scope);
  });
  ipcMain.handle("tribe:browser-delete-profile", async (_event, { profileId } = {}) => {
    const store = loadBrowserProfileStore();
    const profile = store.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("That browser profile is no longer available.");
    const affectedScopes = Object.entries(store.assignments).filter(([, assignedId]) => assignedId === profileId).map(([scope]) => scope);
    for (const scope of affectedScopes) disposeBrowserScope(scope);
    const sessions = loadBrowserSessionStore();
    for (const [scope, browserSession] of Object.entries(sessions.sessions)) {
      if (browserSession?.profileId === profileId) delete sessions.sessions[scope];
    }
    saveBrowserSessionStore();
    for (const scope of affectedScopes) delete store.assignments[scope];
    const browserSession = session.fromPartition(`persist:tribe-profile-${profileId}`);
    await browserSession.clearCache();
    await browserSession.clearStorageData();
    await browserSession.clearAuthCache();
    store.profiles = store.profiles.filter((item) => item.id !== profileId);
    saveBrowserProfileStore();
    for (const scope of affectedScopes) {
      await createBrowserTab(scope);
      publish(scope);
    }
    return { deletedProfileName: profile.name, affectedScopes };
  });
  ipcMain.handle("tribe:browser-remove-permission", (_event, { scope, profileId, origin, permission } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    const store = loadBrowserProfileStore();
    const profile = store.profiles.find((item) => item.id === profileId);
    if (!profile || store.assignments[scope] !== profileId) throw new Error("That browser profile is not selected for this chat.");
    profile.permissions = removePermissionRule(profile.permissions, origin, permission);
    saveBrowserProfileStore();
    return publish(scope);
  });
  ipcMain.handle("tribe:browser-clear-data", async (_event, { scope, cacheOnly = false } = {}) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 256) throw new Error("A browser workspace scope is required.");
    const browserSession = session.fromPartition(partitionFor(scope));
    const target = cacheOnly ? "cache" : "all";
    if (target === "cache" || target === "all") await browserSession.clearCache();
    if (target === "all") {
      await browserSession.clearStorageData();
      await browserSession.clearAuthCache();
      const profileId = loadBrowserProfileStore().assignments[scope];
      const profile = browserProfileStore.profiles.find((item) => item.id === profileId);
      if (profile) {
        profile.siteOrigins = [];
        saveBrowserProfileStore();
      } else {
        browserVisitedSites.delete(scope);
      }
    }
    const partition = partitionFor(scope);
    for (const [tabScope, tabs] of browserTabs) {
      if (partitionFor(tabScope) !== partition) continue;
      for (const tab of tabs.values()) {
        const contents = tab.view.webContents;
        if (!contents.isDestroyed() && contents.getURL() && contents.getURL() !== "about:blank") {
          if (target === "all") tab.suppressSiteOriginRecord = true;
          contents.reload();
        }
      }
    }
    return true;
  });
  ipcMain.handle("tribe:browser-viewport", async (_event, { scope, viewport } = {}) => {
    const view = viewFor(scope);
    if (!view) throw new Error("Open the Browser workspace first.");
    const { resolved, settings } = parseBrowserEmulationRequest(viewport);
    const tabId = activeTabId(scope);
    await applyViewport(scope, tabId, resolved, settings);
    const tab = tabsFor(scope).get(tabId);
    const viewportSize = await readBrowserViewportMetrics(view.webContents);
    tab.viewportSize = viewportSize;
    scheduleBrowserSessionSave(scope);
    return publish(scope, { viewport: tab.viewport, customViewport: tab.customViewport || null, locale: tab.locale, network: tab.network, reducedMotion: tab.reducedMotion, viewportSize });
  });
  ipcMain.handle("tribe:browser-zoom", (_event, { scope, delta = 0 } = {}) => {
    const view = viewFor(scope);
    if (!view) throw new Error("Open the Browser workspace first.");
    const tab = tabsFor(scope).get(activeTabId(scope));
    const level = Math.max(-5, Math.min(10, (tab?.userZoomLevel || 0) + Math.sign(Number(delta) || 0)));
    if (tab) tab.userZoomLevel = level;
    fitBrowserView(scope, activeTabId(scope));
    scheduleBrowserSessionSave(scope);
    return publish(scope, { zoomLevel: level });
  });
  ipcMain.handle("tribe:browser-reveal-download", (_event, { id } = {}) => {
    return revealManagedDownload(id);
  });
  ipcMain.handle("tribe:browser-downloads-menu", (_event, { projects = [], position = {} } = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const repositories = (Array.isArray(projects) ? projects : [])
      .filter((project) => project && typeof project.id === "string" && typeof project.name === "string" && typeof project.repository === "string")
      .map((project) => ({ id: project.id, name: project.name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 96).trim(), repository: project.repository }))
      .filter((project) => project.id && project.name.trim() && project.repository.trim());
    const items = loadBrowserDownloadStore().filter((download) => download.scope === "workspace").slice(-20);
    const menu = Menu.buildFromTemplate([
      { label: "Downloads", enabled: false },
      { type: "separator" },
      ...(items.length ? items.slice(-12).reverse().map((download) => {
        const filename = String(download?.filename || "Download").slice(0, 180);
        const status = download?.state === "completed"
          ? "Downloaded"
          : download?.state === "moved"
            ? `Moved to ${String(download.movedToRepositoryName || "repository").slice(0, 48)}`
          : download?.state === "progressing"
            ? `${Math.round((Number(download.receivedBytes) / Math.max(Number(download.totalBytes) || 1, 1)) * 100)}% downloaded`
            : String(download?.state || "Unavailable").slice(0, 40);
        const submenu = download?.state === "completed" ? [
          { label: "Show in folder", click: () => { try { revealManagedDownload(download.id); } catch (error) { console.error("Browser download could not be revealed:", error.message); } } },
          { type: "separator" },
          {
            label: "Move to repository",
            submenu: repositories.length
              ? repositories.map((project) => ({
                label: project.name,
                click: () => { void moveBrowserDownloadToRepository(download.id, project).catch((error) => {
                  const message = ["Choose a completed download.", "Choose a project with a Git repository.", "Choose an existing Git repository.", "Only downloads managed by Tribe can be moved.", "The download is no longer available."].includes(error.message)
                    ? error.message
                    : "The download could not be moved. Check that the repository is available and writable.";
                  publish(download.scope, { error: message });
                }); },
              }))
              : [{ label: "No Git repositories available", enabled: false }],
          },
        ] : undefined;
        return { label: `${filename} — ${status}`, enabled: download?.state === "completed", ...(submenu ? { submenu } : {}) };
      }) : [{ label: "No downloads yet", enabled: false }]),
    ]);
    menu.popup({
      window: mainWindow,
      x: Math.round(Math.max(0, Number(position.x) || 0)),
      y: Math.round(Math.max(0, Number(position.y) || 0)),
    });
    return true;
  });
  ipcMain.on("tribe:browser-subscribe", (event, scope) => {
    const current = stateFor(scope);
    const view = viewFor(scope);
    if (view && !view.webContents.isDestroyed()) publish(scope);
    else event.sender.send("tribe:browser-state", current);
  });
  ipcMain.on("tribe:browser-hide", (_event, scope) => {
    for (const tab of tabsFor(scope).values()) browserHosts.get(viewKey(scope, tab.id))?.setVisible(false);
  });
}

async function createMainWindow() {
  const requestedE2EWidth = Number(process.env.TRIBE_BROWSER_E2E_WINDOW_WIDTH);
  const initialWidth = process.env.TRIBE_BROWSER_E2E === "1" && Number.isInteger(requestedE2EWidth)
    ? Math.max(800, Math.min(2400, requestedE2EWidth))
    : 1440;
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: 960,
    minWidth: 800,
    minHeight: 700,
    title: "Tribe",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? {
// Centre the native traffic lights within the shared 58px titlebar row.
    trafficLightPosition: { x: 16, y: 22 },
    } : {
      titleBarOverlay: { color: "#0b1724", symbolColor: "#91a4bd", height: 58 },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("console-message", (details) => {
    runtimeLog?.write(`UI console ${details.level}: ${details.message}\n`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    runtimeLog?.write(`UI load failed: ${code} ${description} ${url} mainFrame=${isMainFrame}\n`);
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.TRIBE_DEV_URL || packagedUiUrl;
    if (!allowed || !url.startsWith(`${allowed}/`)) event.preventDefault();
  });
  await mainWindow.loadURL(process.env.TRIBE_DEV_URL || packagedUiUrl || "http://127.0.0.1:5173");
  if (process.env.TRIBE_BROWSER_E2E === "1") {
    const deadline = Date.now() + 15_000;
    let browserWorkspaceReady = false;
    let browserWorkspaceReadySince = 0;
    while (!browserWorkspaceReady && Date.now() < deadline) {
      const rendererReady = await mainWindow.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll("button")]
          .find((item) => item.textContent.trim() === "Browser");
        const standaloneBrowserReady = Boolean(document.querySelector(".main-area--browser-workspace"));
        const splitMode = ${process.env.TRIBE_BROWSER_E2E_SPLIT === "1" ? "true" : "false"};
        const missionReady = ${process.env.TRIBE_BROWSER_E2E_SPLIT === "1" ? "Boolean(document.querySelector('.main-area--conversation button[aria-label=\"Open chat views\"]'))" : "true"};
        const splitReady = ${process.env.TRIBE_BROWSER_E2E_SPLIT === "1" ? "Boolean(document.querySelector('.workspace-body--split') && document.querySelector('.topbar--split-workspace'))" : "true"};
        if (splitMode && missionReady && !splitReady && button) button.click();
        if (!splitMode && !standaloneBrowserReady && button) button.click();
        return Boolean(button && (splitMode ? missionReady && splitReady : standaloneBrowserReady));
      })()`);
      if (rendererReady && browserBounds.get("workspace")?.visible) {
        if (!browserWorkspaceReadySince) browserWorkspaceReadySince = Date.now();
        browserWorkspaceReady = Date.now() - browserWorkspaceReadySince >= 500;
      } else {
        browserWorkspaceReadySince = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!browserWorkspaceReady) {
      throw new Error("The browser end-to-end workspace could not be opened.");
    }
    console.log("Browser E2E workspace opened.");
  }
}

app.whenReady().then(async () => {
  if (app.isPackaged) await startPackagedServices();
  else browserApiToken = await readBrowserApiToken();
  installMacApplicationMenu();
  registerIpc();
  startBrowserAutomationServer();
  await createMainWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createMainWindow(); });
});

app.on("before-quit", (event) => {
  for (const scope of browserTabs.keys()) saveBrowserSession(scope);
  if (runtimeChild && runtimeChild.exitCode === null && !appIsQuitting) {
    event.preventDefault();
    appIsQuitting = true;
    runtimeChild.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (runtimeChild?.exitCode === null) runtimeChild.kill("SIGKILL");
    }, 5000);
    runtimeChild.once("exit", () => {
      clearTimeout(forceTimer);
      app.quit();
    });
    return;
  }
  browserAutomationServer?.close();
  packagedUiServer?.close();
  runtimeLog?.end();
  for (const view of browserViews.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
  browserViews.clear();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
