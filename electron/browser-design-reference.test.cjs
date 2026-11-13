const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  DESIGN_REFERENCE_SCRIPT,
  readDesignReference,
  safeReferenceUrl,
} = require("./browser-design-reference.cjs");

const raw = {
  backgrounds: [{ value: "rgb(255, 255, 255)", count: 5 }],
  foregrounds: [{ value: "rgb(30, 30, 30)", count: 5 }],
  links: [{ value: "rgb(20, 80, 140)", count: 2 }],
  controls: [],
  borders: [],
  fonts: [{ value: "Inter, sans-serif", count: 5 }],
  fontSizes: [{ value: "16px", count: 5 }],
  weights: [],
  lineHeights: [],
  spacing: [],
  radii: [],
  buttons: [],
  inputs: [],
  sampleCount: 12,
};

test("design reference capture keeps the active page URL and excludes page content", async () => {
  let script;
  const contents = {
    isDestroyed: () => false,
    getURL: () => "https://example.com/products?token=secret#details",
    executeJavaScript: async (source, userGesture) => {
      assert.equal(userGesture, true);
      if (source.includes("getComputedStyle")) script = source;
      return raw;
    },
    capturePage: async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1600, height: 900 }),
      toJPEG: (quality) => Buffer.from(`jpeg-${quality}`),
    }),
  };
  const result = await readDesignReference(contents);

  assert.equal(result.reference.url, "https://example.com/products");
  assert.deepEqual(result.screenshot, {
    mimeType: "image/jpeg", data: Buffer.from("jpeg-68").toString("base64"), width: 1600, height: 900,
  });
  assert.deepEqual(Object.keys(result.reference).sort(), [
    "backgrounds", "borders", "buttons", "controls", "fontSizes", "fonts",
    "foregrounds", "inputs", "lineHeights", "links", "radii", "sampleCount",
    "spacing", "url", "weights",
  ]);
  assert.match(script, /getComputedStyle/);
  assert.doesNotMatch(script, /innerText|textContent|\.value\b/);
  assert.doesNotThrow(() => new Function(script));
});

test("design reference capture rejects a tab switch or navigation during the read", async () => {
  const contents = {
    isDestroyed: () => false,
    getURL: () => "https://example.com",
    executeJavaScript: async () => raw,
  };
  await assert.rejects(readDesignReference(contents, () => false), /page changed/);

  let currentUrl = "https://example.com";
  await assert.rejects(readDesignReference({
    isDestroyed: () => false,
    getURL: () => currentUrl,
    executeJavaScript: async () => {
      currentUrl = "https://example.com/other";
      return raw;
    },
  }), /page changed/);

  let queryUrl = "https://example.com/page?state=one";
  await assert.rejects(readDesignReference({
    isDestroyed: () => false,
    getURL: () => queryUrl,
    executeJavaScript: async () => {
      queryUrl = "https://example.com/page?state=two";
      return raw;
    },
  }), /page changed/);
});

test("keeps visual styles when the native page screenshot is temporarily unavailable", async () => {
  const result = await readDesignReference({
    isDestroyed: () => false,
    getURL: () => "https://example.com",
    executeJavaScript: async () => raw,
    capturePage: async () => { throw new Error("UnknownVizError"); },
  });

  assert.equal(result.reference.url, "https://example.com/");
  assert.equal(result.reference.sampleCount, raw.sampleCount);
  assert.equal("screenshot" in result, false);
});

test("reference URLs omit credentials, query strings and fragments", () => {
  assert.equal(
    safeReferenceUrl("https://user:pass@example.com/design?user=deepak#preview"),
    "https://example.com/design",
  );
  assert.throws(() => safeReferenceUrl("file:///private/data"), /HTTP or HTTPS/);
});

test("page sampler collects pixel values without mistaking unitless line heights for pixels", () => {
  const button = {
    tagName: "BUTTON",
    getBoundingClientRect: () => ({ width: 80, height: 32 }),
  };
  const style = {
    display: "block", visibility: "visible", opacity: "1",
    backgroundColor: "rgb(20, 30, 40)", color: "rgb(240, 240, 240)",
    fontFamily: "Inter, sans-serif", fontSize: "16px", fontWeight: "400",
    lineHeight: "1.5", paddingTop: "8px", paddingRight: "8px",
    paddingBottom: "8px", paddingLeft: "8px", gap: "1.5",
    rowGap: "normal", columnGap: "0px", borderTopStyle: "solid",
    borderTopWidth: "1px", borderTopColor: "rgb(60, 70, 80)",
    borderTopLeftRadius: "50%",
  };
  const result = vm.runInNewContext(DESIGN_REFERENCE_SCRIPT, {
    URL,
    location: { href: "https://example.com/" },
    document: { querySelectorAll: () => [button] },
    getComputedStyle: () => style,
  });

  assert.equal(result.sampleCount, 1);
  assert.equal(result.fontSizes[0].value, "16px");
  assert.equal(result.spacing.some(({ value }) => value === "1px"), false);
  assert.equal(result.lineHeights.length, 0);
  assert.equal(result.radii.length, 0);
});
