import assert from "node:assert/strict";
import test from "node:test";
import { selectedCanvasText } from "../src/domain/canvas-selection.js";

test("canvas preview selection returns trimmed text anchored inside the preview", () => {
  const anchor = {};
  const focus = {};
  const root = { contains: (node) => node === anchor || node === focus };
  const selection = { anchorNode: anchor, focusNode: focus, toString: () => "  selected passage\n" };

  assert.equal(selectedCanvasText(root, selection), "selected passage");
});

test("canvas preview selection ignores missing or out-of-preview selections", () => {
  const inside = {};
  const outside = {};
  const root = { contains: (node) => node === inside };

  assert.equal(selectedCanvasText(root, null), "");
  assert.equal(selectedCanvasText(root, { anchorNode: outside, focusNode: inside, toString: () => "outside" }), "");
  assert.equal(selectedCanvasText(root, { anchorNode: inside, focusNode: inside, toString: () => "  " }), "");
});
