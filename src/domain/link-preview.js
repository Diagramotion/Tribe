import { runtime } from "../api/runtime.js";

const previewCache = new Map();
const PREVIEW_CACHE_LIMIT = 128;

export function getLinkPreview(url) {
  if (previewCache.has(url)) return previewCache.get(url);
  const pending = runtime.getLinkPreviews([url])
    .then(({ previews = [] }) => previews.find((preview) => preview.url === url) ?? null)
    .catch(() => null);
  previewCache.set(url, pending);
  if (previewCache.size > PREVIEW_CACHE_LIMIT) previewCache.delete(previewCache.keys().next().value);
  return pending;
}
