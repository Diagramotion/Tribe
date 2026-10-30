const SENSITIVE_PATH_SEGMENT = /^(?:[a-f0-9]{24,}|[a-f0-9]{8}-[a-f0-9-]{27,}|\d{8,}|[a-z0-9_-]{32,})$/i;
const SECRET_ASSIGNMENT = /\b(token|secret|password|passwd|authorization|auth|api[_-]?key|session)\b\s*([=:])\s*(["']?)[^\s,"']+/ig;
const URL_IN_MESSAGE = /https?:\/\/[^\s"'<>]+/ig;

function sanitiseDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/");
    let redactNext = false;
    const safePath = segments.map((segment) => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* Keep malformed escapes redacted below. */ }
      if (redactNext) {
        redactNext = false;
        return "[redacted]";
      }
      if (/^(?:token|secret|password|auth|session|key)$/i.test(decoded)) {
        redactNext = true;
        return decoded;
      }
      if (SENSITIVE_PATH_SEGMENT.test(decoded) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(decoded)) return "[redacted]";
      return segment.slice(0, 120);
    }).join("/");
    return `${url.origin}${safePath}`.slice(0, 1_000);
  } catch {
    return "";
  }
}

function sanitiseDiagnosticMessage(value) {
  return String(value || "")
    .slice(0, 4_000)
    .replace(URL_IN_MESSAGE, (url) => sanitiseDiagnosticUrl(url))
    .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, "$1$2[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/ig, "[email]")
    .replace(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, "[phone]");
}

function boundedDiagnosticLimit(value, fallback = 50) {
  const limit = Number(value);
  if (!Number.isInteger(limit)) return fallback;
  return Math.min(100, Math.max(1, limit));
}

module.exports = { boundedDiagnosticLimit, sanitiseDiagnosticMessage, sanitiseDiagnosticUrl };
