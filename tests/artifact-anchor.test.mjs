import assert from "node:assert/strict";
import test from "node:test";
import { imagePointAnchor, isImagePointAnchor } from "../src/domain/artifact-anchor.js";

test("image review pins use normalized coordinates in the rendered image", () => {
  const anchor = imagePointAnchor(75, 150, { left: 25, top: 50, width: 200, height: 200 });

  assert.deepEqual(anchor, { type: "image_point", x: 0.25, y: 0.5 });
  assert.equal(isImagePointAnchor(anchor), true);
});

test("image review pins reject out-of-bounds and invalid image geometry", () => {
  assert.equal(imagePointAnchor(0, 50, { left: 10, top: 10, width: 100, height: 100 }), null);
  assert.equal(imagePointAnchor(10, 10, { left: 10, top: 10, width: 0, height: 100 }), null);
  assert.equal(isImagePointAnchor({ type: "image_point", x: 1.2, y: 0.5 }), false);
  assert.equal(isImagePointAnchor({ type: "image_point", x: 0.5, y: NaN }), false);
});
