const assert = require("node:assert/strict");
const { shouldShowBrowserHost } = require("./browser-visibility.cjs");

const visibleLayout = { visible: true, bounds: { width: 900, height: 640 } };
const readyTab = { pageStopped: false, viewportTransitionCount: 0 };

assert.equal(shouldShowBrowserHost(visibleLayout, readyTab, true), true);
assert.equal(shouldShowBrowserHost(visibleLayout, { ...readyTab, hasPage: false }, true), false);
assert.equal(shouldShowBrowserHost(visibleLayout, { ...readyTab, hasPage: true }, true), true);
assert.equal(shouldShowBrowserHost({ ...visibleLayout, visible: false }, readyTab, true), false);
assert.equal(shouldShowBrowserHost(visibleLayout, readyTab, false), false);
assert.equal(shouldShowBrowserHost({ ...visibleLayout, bounds: { width: 0, height: 640 } }, readyTab, true), false);
assert.equal(shouldShowBrowserHost(visibleLayout, { ...readyTab, pageStopped: true }, true), false);
assert.equal(shouldShowBrowserHost(visibleLayout, { ...readyTab, viewportTransitionCount: 1 }, true), false);

console.log("Browser host visibility invariants passed.");
