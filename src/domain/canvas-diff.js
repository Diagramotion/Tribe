import { applyPatch, structuredPatch } from "diff";

const MAX_REVIEW_LINES = 2000;

export function reviewDiff(current, proposed) {
  const patch = structuredPatch("current", "proposed", current, proposed, "", "", { context: 3 });
  const hunks = patch.hunks.map((hunk, index) => ({
    id: index,
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.lines,
    added: hunk.lines.filter((line) => line.startsWith("+")).length,
    removed: hunk.lines.filter((line) => line.startsWith("-")).length,
  }));
  let remaining = MAX_REVIEW_LINES;
  const visibleHunks = hunks.map((hunk) => {
    const lines = hunk.lines.slice(0, remaining);
    remaining = Math.max(0, remaining - lines.length);
    return { ...hunk, visibleLines: lines };
  }).filter((hunk) => hunk.visibleLines.length > 0);
  const lineCount = hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
  return {
    hunks: visibleHunks,
    added: hunks.reduce((count, hunk) => count + hunk.added, 0),
    removed: hunks.reduce((count, hunk) => count + hunk.removed, 0),
    truncated: lineCount > MAX_REVIEW_LINES,
    lineLimit: MAX_REVIEW_LINES,
  };
}

export function applySelectedHunks(current, proposed, selectedHunks) {
  const patch = structuredPatch("current", "proposed", current, proposed, "", "", { context: 3 });
  const selected = new Set(selectedHunks);
  const result = applyPatch(current, {
    ...patch,
    hunks: patch.hunks.filter((_, index) => selected.has(index)),
  });
  if (result === false) throw new Error("proposal_diff_conflict");
  return result;
}
