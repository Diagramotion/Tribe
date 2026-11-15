const URL_IN_MESSAGE = /https?:\/\/[^\s"'<>]+/ig;
const SECRET_KEYS = ["authorization", "password", "passwd", "session", "secret", "token", "auth", "api_key", "api-key", "apikey"];

function isWordCharacter(character) {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122) || code === 95;
}

function isWhitespace(character) {
  return character === " " || character === "\t" || character === "\n" || character === "\r"
    || character === "\f" || character === "\v";
}

function emailRanges(value) {
  const ranges = [];
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const at = value.indexOf("@", searchFrom);
    if (at < 0) break;
    let start = at;
    while (start > 0 && value[start - 1] !== "@" && !isWhitespace(value[start - 1])) start -= 1;
    let cursor = at + 1;
    let labels = 0;
    while (cursor < value.length && value[cursor] !== "@" && !isWhitespace(value[cursor])) {
      const labelStart = cursor;
      while (cursor < value.length && value[cursor] !== "." && value[cursor] !== "@"
        && !isWhitespace(value[cursor])) cursor += 1;
      if (cursor === labelStart) break;
      if (value[cursor] !== ".") break;
      labels += 1;
      cursor += 1;
    }
    if (start < at && labels > 0 && cursor > at + 1 && value[cursor - 1] !== ".") {
      ranges.push([start, cursor]);
      searchFrom = cursor;
    } else {
      searchFrom = at + 1;
    }
  }
  return ranges;
}

function redactEmailAddresses(value) {
  const ranges = emailRanges(value);
  if (ranges.length === 0) return value;
  let result = "";
  let copiedThrough = 0;
  for (const [start, end] of ranges) {
    result += value.slice(copiedThrough, start) + "[email]";
    copiedThrough = end;
  }
  return result + value.slice(copiedThrough);
}

function isSensitivePathSegment(value) {
  const hasOnly = (allowed) => {
    if (!value) return false;
    for (const character of value.toLowerCase()) {
      if (!allowed(character)) return false;
    }
    return true;
  };
  const hex = (character) => (character >= "0" && character <= "9")
    || (character >= "a" && character <= "f");
  if (value.length >= 24 && hasOnly(hex)) return true;
  if (value.length >= 36 && value[8] === "-" && hasOnly((character) => hex(character) || character === "-")) return true;
  if (value.length >= 8 && hasOnly((character) => character >= "0" && character <= "9")) return true;
  return value.length >= 32 && hasOnly((character) => hex(character)
    || (character >= "g" && character <= "z") || character === "_" || character === "-");
}

function redactSecretAssignments(value) {
  let output = "";
  let copiedThrough = 0;
  let index = 0;
  while (index < value.length) {
    if (index > 0 && isWordCharacter(value[index - 1])) {
      index += 1;
      continue;
    }
    const key = SECRET_KEYS.find((candidate) => value.slice(index, index + candidate.length).toLowerCase() === candidate
      && !isWordCharacter(value[index + candidate.length]));
    if (!key) {
      index += 1;
      continue;
    }
    let cursor = index + key.length;
    while (isWhitespace(value[cursor])) cursor += 1;
    const separator = value[cursor];
    if (separator !== "=" && separator !== ":") {
      index = cursor;
      continue;
    }
    cursor += 1;
    while (isWhitespace(value[cursor])) cursor += 1;
    if (value[cursor] === "\"" || value[cursor] === "'") cursor += 1;
    const valueStart = cursor;
    while (cursor < value.length && !isWhitespace(value[cursor])
      && value[cursor] !== "," && value[cursor] !== "\"" && value[cursor] !== "'") cursor += 1;
    if (cursor === valueStart) {
      index = cursor;
      continue;
    }
    output += value.slice(copiedThrough, index) + value.slice(index, index + key.length)
      + separator + "[redacted]";
    index = cursor;
    copiedThrough = cursor;
  }
  return copiedThrough ? output + value.slice(copiedThrough) : value;
}

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
      if (isSensitivePathSegment(decoded) || emailRanges(decoded).length > 0) return "[redacted]";
      return segment.slice(0, 120);
    }).join("/");
    return `${url.origin}${safePath}`.slice(0, 1_000);
  } catch {
    return "";
  }
}

function sanitiseDiagnosticMessage(value) {
  const message = String(value || "")
    .slice(0, 4_000)
    .replace(URL_IN_MESSAGE, (url) => sanitiseDiagnosticUrl(url))
    .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
    .replace(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, "[phone]");
  return redactEmailAddresses(redactSecretAssignments(message));
}

function boundedDiagnosticLimit(value, fallback = 50) {
  const limit = Number(value);
  if (!Number.isInteger(limit)) return fallback;
  return Math.min(100, Math.max(1, limit));
}

module.exports = { boundedDiagnosticLimit, sanitiseDiagnosticMessage, sanitiseDiagnosticUrl };
