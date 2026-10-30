const { resolveViewport } = require("./browser-viewport.cjs");
const { normalizeLocale, normalizeNetworkProfile, normalizeReducedMotion } = require("./browser-device-emulation.cjs");

const MAX_RESTORED_TABS = 64;

function safeSessionUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|auth|code|key|session)/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.href.slice(0, 8192);
  } catch {
    return "";
  }
}

function normaliseBrowserSessionRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.profileId !== "string" || (raw.profileId !== "" && !/^[\da-f-]{36}$/i.test(raw.profileId))) return null;
  const profileId = raw.profileId;
  const sourceTabs = Array.isArray(raw.tabs) ? raw.tabs.slice(-MAX_RESTORED_TABS) : [];
  const offset = Math.max(0, (Array.isArray(raw.tabs) ? raw.tabs.length : 0) - sourceTabs.length);
  const tabs = sourceTabs.map((source) => {
    const tab = source && typeof source === "object" && !Array.isArray(source) ? source : {};
    let viewport = { name: "responsive", customViewport: null };
    try { viewport = resolveViewport(tab.viewport === "custom" ? tab.customViewport : (tab.viewport || "responsive")); } catch {}
    let locale = "";
    let network = "unthrottled";
    let reducedMotion = "system";
    try { locale = normalizeLocale(tab.locale); } catch {}
    try { network = normalizeNetworkProfile(tab.network); } catch {}
    try { reducedMotion = normalizeReducedMotion(tab.reducedMotion); } catch {}
    return {
      url: safeSessionUrl(tab.url),
      viewport: viewport.name,
      customViewport: viewport.customViewport,
      locale,
      network,
      reducedMotion,
      zoomLevel: Number.isInteger(tab.zoomLevel) ? Math.max(-8, Math.min(8, tab.zoomLevel)) : 0,
    };
  });
  return {
    profileId,
    tabs: tabs.length ? tabs : [{ url: "", viewport: "responsive", customViewport: null, locale: "", network: "unthrottled", reducedMotion: "system", zoomLevel: 0 }],
    activeIndex: Math.max(0, Math.min(tabs.length - 1, (Number.isInteger(raw.activeIndex) ? raw.activeIndex : 0) - offset)),
  };
}

function normaliseBrowserSessionStore(raw) {
  const sessions = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1
    || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) return { version: 1, sessions };
  for (const [scope, record] of Object.entries(raw.sessions)) {
    if (scope.length > 256) continue;
    const normalised = normaliseBrowserSessionRecord(record);
    if (normalised) sessions[scope] = normalised;
  }
  return { version: 1, sessions };
}

module.exports = { MAX_RESTORED_TABS, normaliseBrowserSessionRecord, normaliseBrowserSessionStore, safeSessionUrl };
