export function citationsFromMarkdown(markdown, limit = 12) {
  const sources = [];
  const seen = new Set();
  for (const [, title, rawUrl] of String(markdown ?? "").matchAll(/\[([^\]]{1,160})\]\((https?:\/\/[^\s)]+)\)/g)) {
    try {
      const url = new URL(rawUrl);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || seen.has(url.href)) continue;
      seen.add(url.href);
      sources.push({ title: title.trim(), url: url.href, domain: url.hostname.replace(/^www\./, "") });
      if (sources.length >= limit) break;
    } catch { /* Ignore malformed or non-web links. */ }
  }
  return sources;
}
