const assert = require("node:assert/strict");
const { test } = require("node:test");
const { waitForBrowserPaint } = require("./browser-paint.cjs");

test("waits for the browser to paint two frames after viewport changes", async () => {
  let painted = false;
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: async (script) => {
      assert.match(script, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      painted = true;
    },
  };

  await waitForBrowserPaint(contents, 100);
  assert.equal(painted, true);
});

test("uses a bounded fallback when a hidden browser cannot paint", async () => {
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: () => new Promise(() => {}),
  };
  const started = Date.now();

  await waitForBrowserPaint(contents, 20);
  assert.ok(Date.now() - started < 100);
});

test("does not request paint from a destroyed browser page", async () => {
  const contents = {
    isDestroyed: () => true,
    executeJavaScript: () => { throw new Error("must not run"); },
  };

  await waitForBrowserPaint(contents, 20);
});
