const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normaliseFileSelection, validateUploadTarget } = require("./browser-upload.cjs");

test("accepts only a current file input on an HTTP or HTTPS page", () => {
  const target = { ref: "0123456789abcdef-2", tagName: "INPUT", type: "file", multiple: true, accept: ".png,image/*" };
  assert.deepEqual(validateUploadTarget(target, target.ref, "https://example.test"), {
    ref: target.ref, origin: "https://example.test", multiple: true, accept: ".png,image/*",
  });
  assert.throws(() => validateUploadTarget({ ...target, type: "text" }, target.ref, "https://example.test"), /file input/);
  assert.throws(() => validateUploadTarget({ ...target, ref: "" }, target.ref, "https://example.test"), /fresh browser snapshot/);
  assert.throws(() => validateUploadTarget(target, "fedcba9876543210-2", "https://example.test"), /fresh browser snapshot/);
  assert.throws(() => validateUploadTarget(target, target.ref, "file:///tmp/page.html"), /HTTP or HTTPS/);
});

test("preserves only a finite, rounded click point from the page", () => {
  const target = { ref: "0123456789abcdef-2", tagName: "INPUT", type: "file", point: { x: 12.4, y: 38.8 } };
  assert.deepEqual(validateUploadTarget(target, target.ref, "https://example.test").point, { x: 12, y: 39 });
  assert.equal(validateUploadTarget({ ...target, point: { x: Number.NaN, y: 4 } }, target.ref, "https://example.test").point, undefined);
});

test("reports only the outcome and count after the user completes the native chooser", () => {
  assert.deepEqual(normaliseFileSelection({ selectedCount: 2, fileNames: ["private-name.pdf"] }, "https://example.test"), {
    uploaded: false, filesSelected: true, fileCount: 2, origin: "https://example.test",
  });
  assert.deepEqual(normaliseFileSelection({ cancelled: true }, "https://example.test"), {
    uploaded: false, cancelled: true, origin: "https://example.test",
  });
  assert.deepEqual(normaliseFileSelection({ timedOut: true }, "https://example.test"), {
    uploaded: false, timedOut: true, origin: "https://example.test",
  });
  assert.deepEqual(normaliseFileSelection({ selectedCount: Number.POSITIVE_INFINITY }, "https://example.test"), {
    uploaded: false, cancelled: true, origin: "https://example.test",
  });
});
