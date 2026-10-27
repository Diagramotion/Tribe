import assert from "node:assert/strict";
import test from "node:test";
import { canvasFilename } from "../src/domain/canvas-export.js";

test("canvas exports use a readable extension and preserve revision identity", () => {
  assert.equal(canvasFilename({ title: "Architecture Notes", kind: "markdown" }, { revision: 4 }), "architecture-notes-revision-4.md");
  assert.equal(canvasFilename({ title: "Agent Flow", kind: "diagram" }, { revision: 2 }), "agent-flow-revision-2.mmd");
  assert.equal(canvasFilename({ title: "Agent Flow", kind: "diagram" }, { revision: 2, format: "svg" }), "agent-flow-revision-2.svg");
});

test("canvas draft exports have a safe title and do not claim a saved revision", () => {
  assert.equal(canvasFilename({ title: "Éxport / Draft?", kind: "code", language: "TypeScript" }, { draft: true }), "export-draft-draft.ts");
  assert.equal(canvasFilename({ title: "---", kind: "code", language: "malicious/ext" }), "shared-document.txt");
});
