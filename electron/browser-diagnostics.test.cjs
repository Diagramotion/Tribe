const test = require("node:test");
const assert = require("node:assert/strict");
const {
  boundedDiagnosticLimit,
  sanitiseDiagnosticMessage,
  sanitiseDiagnosticUrl,
} = require("./browser-diagnostics.cjs");

test("diagnostic URLs omit query strings, fragments and embedded credentials", () => {
  assert.equal(
    sanitiseDiagnosticUrl("https://user:pass@example.test/api/items?token=private#private"),
    "https://example.test/api/items",
  );
});

test("diagnostic URLs redact secret and high-entropy path segments", () => {
  assert.equal(
    sanitiseDiagnosticUrl("https://example.test/reset/token/very-secret-value-012345678901234567890/path"),
    "https://example.test/reset/token/[redacted]/path",
  );
});

test("diagnostic messages redact common credentials, email addresses and phone numbers", () => {
  const message = sanitiseDiagnosticMessage(
    "Bearer abc123 api_key=hidden user@example.com called +1 212 555 0199 at https://example.test/path?code=private",
  );
  assert.equal(message.includes("abc123"), false);
  assert.equal(message.includes("hidden"), false);
  assert.equal(message.includes("user@example.com"), false);
  assert.equal(message.includes("212 555 0199"), false);
  assert.equal(message.includes("?code=private"), false);
});

test("diagnostic limits stay between one and one hundred entries", () => {
  assert.equal(boundedDiagnosticLimit(undefined), 50);
  assert.equal(boundedDiagnosticLimit(0), 1);
  assert.equal(boundedDiagnosticLimit(500), 100);
  assert.equal(boundedDiagnosticLimit("many"), 50);
});
