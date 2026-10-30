const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveViewport, viewportBounds } = require("./browser-viewport.cjs");

test("phone and tablet presets enable mobile screen emulation at their CSS dimensions", () => {
  const phone = resolveViewport("iphone-15");
  const tablet = resolveViewport("ipad-mini");

  assert.deepEqual(phone.config, { width: 393, height: 852, screenPosition: "mobile", deviceScaleFactor: 3 });
  assert.deepEqual(tablet.config, { width: 768, height: 1024, screenPosition: "mobile", deviceScaleFactor: 2 });
  assert.equal(phone.customViewport, null);
});

test("responsive mode disables device emulation and custom sizes use desktop mode", () => {
  assert.equal(resolveViewport("responsive").config, null);
  assert.deepEqual(resolveViewport({ width: 1200, height: 800 }).config, {
    width: 1200, height: 800, screenPosition: "desktop", deviceScaleFactor: 1,
  });
  assert.throws(() => resolveViewport({ width: 239, height: 800 }), /between 240 and 3840/);
});

test("centres fixed viewports in the available browser surface", () => {
  assert.deepEqual(viewportBounds(resolveViewport("iphone-15").config, { width: 1190, height: 825 }), {
    x: 404, y: 0, width: 381, height: 825,
  });
  assert.deepEqual(viewportBounds(null, { width: 1190, height: 825 }), {
    x: 0, y: 0, width: 1190, height: 825,
  });
});
