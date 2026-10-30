const fs = require("node:fs/promises");
const path = require("node:path");

const SITE_STORAGE_TYPES = new Set([
  "appcache", "cache_storage", "file_systems", "indexeddb", "local_storage",
  "other", "service_workers", "storage_buckets", "websql",
]);
const MAX_RECORDED_SITE_ORIGINS = 500;
const SITE_ORIGIN_RESOURCE_TYPES = new Set(["mainFrame", "subFrame", "xhr", "eventSource", "webSocket"]);

function normaliseSiteOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function normaliseSiteOrigins(value) {
  if (!Array.isArray(value)) return [];
  const byOrigin = new Map();
  for (const item of value) {
    const origin = normaliseSiteOrigin(item?.origin);
    if (!origin) continue;
    const lastVisitedAt = Math.max(0, Math.floor(Number(item.lastVisitedAt) || 0));
    const previous = byOrigin.get(origin);
    byOrigin.set(origin, {
      origin,
      lastVisitedAt: Math.max(lastVisitedAt, previous?.lastVisitedAt || 0),
    });
  }
  return [...byOrigin.values()]
    .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt || left.origin.localeCompare(right.origin))
    .slice(0, MAX_RECORDED_SITE_ORIGINS);
}

function rememberSiteOrigin(sites, origin, lastVisitedAt = Date.now()) {
  const safeOrigin = normaliseSiteOrigin(origin);
  if (!safeOrigin) return normaliseSiteOrigins(sites);
  return normaliseSiteOrigins([
    { origin: safeOrigin, lastVisitedAt },
    ...(Array.isArray(sites) ? sites : []),
  ]);
}

function shouldTrackSiteOriginResourceType(resourceType) {
  return SITE_ORIGIN_RESOURCE_TYPES.has(String(resourceType || ""));
}

function forgetSiteOrigin(sites, origin) {
  const safeOrigin = normaliseSiteOrigin(origin);
  if (!safeOrigin) return normaliseSiteOrigins(sites);
  return normaliseSiteOrigins(sites).filter((site) => site.origin !== safeOrigin);
}

function normaliseSiteStorage(origin, usage = {}) {
  const parsed = new URL(String(origin || ""));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error("Site storage needs a valid website origin.");
  }
  const breakdown = Array.isArray(usage.usageBreakdown)
    ? usage.usageBreakdown
      .filter((item) => item && SITE_STORAGE_TYPES.has(item.storageType))
      .map((item) => ({ type: item.storageType, bytes: Math.max(0, Math.floor(Number(item.usage) || 0)) }))
      .sort((left, right) => right.bytes - left.bytes || left.type.localeCompare(right.type))
    : [];
  return {
    origin: parsed.origin,
    bytes: Math.max(0, Math.floor(Number(usage.usage) || 0)),
    quotaBytes: Math.max(0, Math.floor(Number(usage.quota) || 0)),
    breakdown,
  };
}

async function estimateDirectoryBytes(root, maxEntries = 10_000) {
  if (typeof root !== "string" || !root.trim()) return { bytes: 0, complete: false };
  const resolvedRoot = path.resolve(root);
  const limit = Math.max(100, Math.min(50_000, Math.floor(Number(maxEntries) || 10_000)));
  const directories = [resolvedRoot];
  let bytes = 0;
  let visited = 0;
  let complete = true;

  for (let index = 0; index < directories.length; index += 1) {
    let entries;
    try {
      entries = await fs.readdir(directories[index], { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return { bytes, complete: false };
    }

    for (const entry of entries) {
      if (visited >= limit) {
        complete = false;
        break;
      }
      visited += 1;
      const entryPath = path.join(directories[index], entry.name);
      if (entry.isDirectory()) directories.push(entryPath);
      else if (entry.isFile()) {
        try {
          bytes += (await fs.stat(entryPath)).size;
        } catch (error) {
          if (error.code !== "ENOENT") complete = false;
        }
      }
    }
    if (!complete) break;
  }

  if (directories.length > 0 && visited >= limit) complete = false;
  return { bytes, complete };
}

module.exports = { estimateDirectoryBytes, forgetSiteOrigin, normaliseSiteOrigin, normaliseSiteOrigins, normaliseSiteStorage, rememberSiteOrigin, shouldTrackSiteOriginResourceType };
