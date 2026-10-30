const FAVICON_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const MAX_FAVICON_BYTES = 128 * 1024;

function normaliseFaviconUrl(value, allowedDomains = null) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    if (Array.isArray(allowedDomains) && !allowedDomains.includes(url.hostname.toLowerCase().replace(/\.$/, ""))) return "";
    return url.href;
  } catch {
    return "";
  }
}

function faviconDataUrl(contentType, bytes) {
  const mimeType = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!FAVICON_TYPES.has(mimeType) || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return "";
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

module.exports = { faviconDataUrl, normaliseFaviconUrl };
