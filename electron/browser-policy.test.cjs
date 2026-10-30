const test = require("node:test");
const assert = require("node:assert/strict");
const {
  browserRequestAllowed,
  browserRequestPolicy,
  normaliseBrowserDomains,
} = require("./browser-policy.cjs");

test("normalises exact hostnames and rejects broad or malformed grants", () => {
  assert.deepEqual(normaliseBrowserDomains(["Example.com", "example.com."]), ["example.com"]);
  for (const value of [[], ["*.example.com"], ["https://example.com"], ["example.com:8443"], ["user@example.com"]]) {
    assert.throws(() => normaliseBrowserDomains(value));
  }
});

test("agent request policy allows only HTTP(S) requests to explicitly granted hosts", () => {
  const policy = { domains: new Set(["example.com"]) };
  assert.equal(browserRequestAllowed(policy, "https://example.com/path"), true);
  assert.equal(browserRequestAllowed(policy, "http://example.com:8080/path"), true);
  assert.equal(browserRequestAllowed(policy, "https://sub.example.com/path"), false);
  assert.equal(browserRequestAllowed(policy, "https://other.test/path"), false);
  assert.equal(browserRequestAllowed(policy, "file:///etc/passwd"), false);
  assert.equal(browserRequestAllowed(null, "https://other.test/path"), true);
});

test("request policy resolves the originating WebContents", () => {
  const policy = { domains: new Set(["example.com"]) };
  const policies = new Map([[42, policy]]);
  assert.equal(browserRequestPolicy({ webContentsId: 42 }, policies), policy);
  assert.equal(browserRequestPolicy({ webContents: { id: 42 } }, policies), policy);
  assert.equal(browserRequestPolicy({ webContentsId: 7 }, policies), undefined);
});
