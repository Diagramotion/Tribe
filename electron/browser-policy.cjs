const { isIP } = require("node:net");

function normaliseHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname) {
  const host = normaliseHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family === 4) return Number(host.split(".", 1)[0]) === 127;
  return family === 6 && host === "::1";
}

function normaliseBrowserDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0 || domains.length > 100) {
    throw new Error("The project's allowed website list is unavailable.");
  }
  return [...new Set(domains.map((domain) => {
    if (typeof domain !== "string" || !domain.trim() || domain.includes("*") || domain.includes("/")) {
      throw new Error("The project's allowed website list is invalid.");
    }
    try {
      const input = domain.trim().toLowerCase().replace(/\.$/, "");
      const urlHost = input.includes(":") && !input.startsWith("[") ? `[${input}]` : input;
      const parsed = new URL(`https://${urlHost}`);
      const hostname = normaliseHostname(parsed.hostname);
      if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/"
          || parsed.search || parsed.hash || hostname !== normaliseHostname(input)) {
        throw new Error("invalid_hostname");
      }
      return hostname;
    } catch {
      throw new Error("The project's allowed website list is invalid.");
    }
  }))];
}

function browserRequestPolicy(details, policies) {
  return policies.get(details.webContentsId ?? details.webContents?.id);
}

function browserRequestAllowed(policy, address) {
  try {
    const url = new URL(address);
    const hostname = normaliseHostname(url.hostname);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.protocol === "http:" && !isLoopbackHostname(hostname)) return false;
    return !policy || policy.domains.has(hostname);
  } catch {
    return false;
  }
}

module.exports = { browserRequestAllowed, browserRequestPolicy, isLoopbackHostname, normaliseBrowserDomains };
