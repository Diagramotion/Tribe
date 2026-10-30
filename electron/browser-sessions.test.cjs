const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_RESTORED_TABS,
  normaliseBrowserSessionRecord,
  normaliseBrowserSessionStore,
  safeSessionUrl,
} = require("./browser-sessions.cjs");

test("session URLs keep navigable paths and remove credentials, secret query values and fragments", () => {
  assert.equal(
    safeSessionUrl("https://person:password@example.com/app?tab=design&access_token=secret#private"),
    "https://example.com/app?tab=design&access_token=%5Bredacted%5D",
  );
  assert.equal(safeSessionUrl("file:///Users/person/secret.txt"), "");
  assert.equal(safeSessionUrl("javascript:alert(1)"), "");
  assert.equal(safeSessionUrl("not a URL"), "");
});

test("session records bound restored tabs and validate per-tab browser settings", () => {
  const tabs = Array.from({ length: MAX_RESTORED_TABS + 2 }, (_, index) => ({
    url: `https://example.com/${index}`,
    viewport: index === 0 ? "custom" : (index === 1 ? "bad-viewport" : "iphone-15"),
    customViewport: { width: 900, height: 700 },
    locale: "en-au",
    network: "slow-3g",
    reducedMotion: "reduce",
    zoomLevel: 50,
  }));
  const session = normaliseBrowserSessionRecord({ profileId: "", tabs, activeIndex: 1 });
  assert.equal(session.tabs.length, MAX_RESTORED_TABS);
  assert.equal(session.tabs[0].url, "https://example.com/2");
  assert.equal(session.activeIndex, 0);
  assert.equal(session.tabs[0].viewport, "iphone-15");
  assert.equal(session.tabs[0].customViewport, null);
  assert.equal(session.tabs[0].locale, "en-AU");
  assert.equal(session.tabs[0].network, "slow-3g");
  assert.equal(session.tabs[0].reducedMotion, "reduce");
  assert.equal(session.tabs[0].zoomLevel, 8);
  assert.equal(normaliseBrowserSessionRecord({ profileId: "bad", tabs: [] }), null);
});

test("session store accepts only versioned scope entries", () => {
  assert.deepEqual(normaliseBrowserSessionStore({ version: 2, sessions: { workspace: { tabs: [] } } }), { version: 1, sessions: {} });
  const store = normaliseBrowserSessionStore({
    version: 1,
    sessions: { workspace: { profileId: "", tabs: [{ url: "https://example.com" }], activeIndex: 0 }, ["x".repeat(257)]: {} },
  });
  assert.equal(store.sessions.workspace.tabs[0].url, "https://example.com/");
  assert.equal(Object.keys(store.sessions).length, 1);
});
