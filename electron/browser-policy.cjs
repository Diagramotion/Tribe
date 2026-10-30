function normaliseBrowserDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0 || domains.length > 100) {
    throw new Error("The project's allowed website list is unavailable.");
  }
  return [...new Set(domains.map((domain) => {
    if (typeof domain !== "string" || !domain.trim() || domain.includes("*") || domain.includes("/")) {
      throw new Error("The project's allowed website list is invalid.");
    }
    try {
      const parsed = new URL(`https://${domain}`);
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/"
          || parsed.search || parsed.hash || hostname !== domain.toLowerCase().replace(/\.$/, "")) {
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
  if (!policy) return true;
  try {
    const url = new URL(address);
    return ["http:", "https:"].includes(url.protocol)
      && policy.domains.has(url.hostname.toLowerCase().replace(/\.$/, ""));
  } catch {
    return false;
  }
}

module.exports = { browserRequestAllowed, browserRequestPolicy, normaliseBrowserDomains };
