import assert from "node:assert/strict";
import test from "node:test";
import { inlineImagePreview } from "../src/domain/artifact-preview.js";

test("inline artifact previews accept bounded browser-safe image media types", () => {
  assert.equal(inlineImagePreview("image/png", "YWJj"), "data:image/png;base64,YWJj");
  assert.equal(inlineImagePreview("IMAGE/JPEG; charset=binary", "YWJj"), "data:image/jpeg;base64,YWJj");
  assert.equal(inlineImagePreview("image/svg+xml", "PHN2Zz4="), "data:image/svg+xml;base64,PHN2Zz4=");
  assert.equal(inlineImagePreview("text/html", "PGgxPkhlbGxvPC9oMT4="), null);
  assert.equal(inlineImagePreview("application/pdf", "JVBERi0="), null);
  assert.equal(inlineImagePreview("image/png", ""), null);
});
