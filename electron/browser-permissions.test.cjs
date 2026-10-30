const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getPermissionRule,
  normalisePermissionOrigin,
  removePermissionRule,
  setPermissionRule,
} = require("./browser-permissions.cjs");

test("permission rules are scoped to canonical HTTP origins and exact permissions", () => {
  const rules = setPermissionRule([], "https://example.com/path", "geolocation", "allow");
  assert.equal(getPermissionRule(rules, "https://example.com/other", "geolocation"), "allow");
  assert.equal(getPermissionRule(rules, "https://sub.example.com", "geolocation"), "");
  assert.equal(getPermissionRule(rules, "https://example.com", "notifications"), "");
  assert.equal(normalisePermissionOrigin("file:///tmp/page.html"), "");
  assert.equal(normalisePermissionOrigin("https://user:pass@example.com"), "https://example.com");
});

test("a website permission decision replaces and can remove an earlier rule", () => {
  const allowed = setPermissionRule([], "https://example.com", "camera", "allow");
  const blocked = setPermissionRule(allowed, "https://example.com", "camera", "block");
  assert.equal(blocked.length, 1);
  assert.equal(getPermissionRule(blocked, "https://example.com", "camera"), "block");
  assert.deepEqual(removePermissionRule(blocked, "https://example.com", "camera"), []);
});

test("invalid permission decisions are rejected", () => {
  assert.throws(() => setPermissionRule([], "https://example.com", "camera", "allow-once"));
  assert.throws(() => setPermissionRule([], "javascript:alert(1)", "camera", "allow"));
});
