const test = require("node:test");
const assert = require("node:assert/strict");
const { faviconDataUrl, normaliseFaviconUrl } = require("./browser-favicons.cjs");

test("normalises only credential-free HTTP and HTTPS favicon URLs within the agent host grant", () => {
  const allowed = ["example.com", "cdn.example.com"];
  assert.equal(normaliseFaviconUrl("https://cdn.example.com/icon.png", allowed), "https://cdn.example.com/icon.png");
  assert.equal(normaliseFaviconUrl("https://elsewhere.test/icon.png", allowed), "");
  assert.equal(normaliseFaviconUrl("data:image/png;base64,abc", allowed), "");
  assert.equal(normaliseFaviconUrl("https://user:pass@example.com/icon.png", allowed), "");
});

test("exposes only small raster favicon payloads as data URLs", () => {
  const bytes = Buffer.from([137, 80, 78, 71]);
  assert.equal(faviconDataUrl("image/png; charset=binary", bytes), `data:image/png;base64,${bytes.toString("base64")}`);
  assert.equal(faviconDataUrl("image/svg+xml", bytes), "");
  assert.equal(faviconDataUrl("image/png", Buffer.alloc(128 * 1024 + 1)), "");
});
