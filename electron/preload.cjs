const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tribeDesktop", {
  runtimeBaseUrl: `http://127.0.0.1:${process.env.TRIBE_PORT || "4317"}`,
  platform: process.platform,
  openDialog: (options) => ipcRenderer.invoke("tribe:open-dialog", options),
});

contextBridge.exposeInMainWorld("tribeDesktopBrowser", {
  open: (scope, url = "") => ipcRenderer.invoke("tribe:browser-open", { scope, url }),
  navigate: (scope, url) => ipcRenderer.invoke("tribe:browser-navigate", { scope, url }),
  newTab: (scope, url = "") => ipcRenderer.invoke("tribe:browser-new-tab", { scope, url }),
  selectTab: (scope, tabId) => ipcRenderer.invoke("tribe:browser-select-tab", { scope, tabId }),
  closeTab: (scope, tabId) => ipcRenderer.invoke("tribe:browser-close-tab", { scope, tabId }),
  setBounds: (scope, bounds, visible) => ipcRenderer.invoke("tribe:browser-bounds", { scope, bounds, visible }),
  action: (scope, action) => ipcRenderer.invoke("tribe:browser-action", { scope, action }),
  state: (scope) => ipcRenderer.invoke("tribe:browser-state", { scope }),
  setAgentControlPaused: (scope, paused) => ipcRenderer.invoke("tribe:browser-agent-control", { scope, paused }),
  diagnostics: (scope, limit = 50) => ipcRenderer.invoke("tribe:browser-diagnostics", { scope, limit }),
  resolvePermission: (scope, id, decision) => ipcRenderer.invoke("tribe:browser-resolve-permission", { scope, id, decision }),
  clearData: (scope, cacheOnly = false) => ipcRenderer.invoke("tribe:browser-clear-data", { scope, cacheOnly }),
  profiles: (scope) => ipcRenderer.invoke("tribe:browser-profiles", { scope }),
  profileUsage: () => ipcRenderer.invoke("tribe:browser-profile-usage"),
  siteStorage: (scope) => ipcRenderer.invoke("tribe:browser-site-storage", { scope }),
  siteInventory: (scope, origin) => ipcRenderer.invoke("tribe:browser-site-inventory", { scope, origin }),
  clearSiteData: (scope, origin) => ipcRenderer.invoke("tribe:browser-clear-site-data", { scope, origin }),
  createProfile: (name) => ipcRenderer.invoke("tribe:browser-create-profile", { name }),
  selectProfile: (scope, profileId = "") => ipcRenderer.invoke("tribe:browser-select-profile", { scope, profileId }),
  deleteProfile: (profileId) => ipcRenderer.invoke("tribe:browser-delete-profile", { profileId }),
  removePermission: (scope, profileId, origin, permission) => ipcRenderer.invoke("tribe:browser-remove-permission", { scope, profileId, origin, permission }),
  setViewport: (scope, viewport) => ipcRenderer.invoke("tribe:browser-viewport", { scope, viewport }),
  setZoom: (scope, delta) => ipcRenderer.invoke("tribe:browser-zoom", { scope, delta }),
  revealDownload: (id) => ipcRenderer.invoke("tribe:browser-reveal-download", { id }),
  showDownloads: (projects, position) => ipcRenderer.invoke("tribe:browser-downloads-menu", { projects, position }),
  subscribe: (scope, listener) => {
    const handler = (_event, state) => { if (state.scope === scope) listener(state); };
    ipcRenderer.on("tribe:browser-state", handler);
    ipcRenderer.send("tribe:browser-subscribe", scope);
    return () => ipcRenderer.removeListener("tribe:browser-state", handler);
  },
  hide: (scope) => ipcRenderer.send("tribe:browser-hide", scope),
  onPopup: (listener) => {
    const handler = (_event, popup) => listener(popup);
    ipcRenderer.on("tribe:browser-popup", handler);
    return () => ipcRenderer.removeListener("tribe:browser-popup", handler);
  },
  onCommand: (listener) => {
    const handler = (_event, command) => listener(command);
    ipcRenderer.on("tribe:browser-command", handler);
    return () => ipcRenderer.removeListener("tribe:browser-command", handler);
  },
});
