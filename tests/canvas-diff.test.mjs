import test from "node:test";
import assert from "node:assert/strict";
import { applySelectedHunks, reviewDiff } from "../src/domain/canvas-diff.js";

test("proposal diff shows additions, removals and unchanged context", () => {
  const diff = reviewDiff("alpha\nold\nomega\n", "alpha\nnew\nomega\n");
  const lines = diff.hunks.flatMap((hunk) => hunk.visibleLines);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.ok(lines.includes(" alpha"));
  assert.ok(lines.includes("-old"));
  assert.ok(lines.includes("+new"));
  assert.equal(diff.truncated, false);
});

test("large proposal diffs are bounded for the review view", () => {
  const diff = reviewDiff("", Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n"));
  assert.equal(diff.hunks.reduce((count, hunk) => count + hunk.visibleLines.length, 0), 2_000);
  assert.equal(diff.added, 2_100);
  assert.equal(diff.truncated, true);
});

test("users can accept one change group while retaining other proposal edits", () => {
  const context = Array.from({ length: 10 }, (_, index) => `keep ${index}`).join("\n");
  const current = `start\nold first\n${context}\nold second\nend\n`;
  const proposed = `start\nnew first\n${context}\nnew second\nend\n`;
  const diff = reviewDiff(current, proposed);
  assert.equal(diff.hunks.length, 2);
  const partial = applySelectedHunks(current, proposed, [diff.hunks[0].id]);
  assert.ok(partial.includes("new first"));
  assert.ok(partial.includes("old second"));
  assert.equal(applySelectedHunks(current, proposed, diff.hunks.map((hunk) => hunk.id)), proposed);
});
