import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
const hmrPort = 40_000 + (process.pid % 5_000) * 3 + 2;
let ProjectKnowledgeView;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" });
  ({ ProjectKnowledgeView } = await vite.ssrLoadModule("/src/views/ProjectKnowledgeView.jsx"));
});

after(async () => {
  await vite?.close();
});

function render(conflict) {
  return renderToStaticMarkup(React.createElement(ProjectKnowledgeView, {
    entries: [], proposals: [], migration: { conflicts: [conflict], missing: [], reviewed: [] },
    onResolveMigration() {}, onSave() {}, onReview() {}, onArchive() {}, onRestore() {},
  }));
}

test("migration review presents both versions and the available choices", () => {
  const html = render({
    project_id: "project-1", entry_id: "memory-1", title: "Build command", fields: ["content"],
    legacy: { content: "Previously saved command." },
    smriti: { content: "Current command.", unavailable_reason: null },
  });

  assert.match(html, /Review saved versions/);
  assert.match(html, /Current command\./);
  assert.match(html, /Previously saved command\./);
  assert.match(html, /Keep current/);
  assert.match(html, /Use previously saved/);
});

test("migration review hides another project's content and offers a safe scoped copy", () => {
  const html = render({
    project_id: "project-1", entry_id: "memory-1", title: "Build command", fields: ["scope", "content"],
    legacy: { content: "Project one wording." },
    smriti: { content: null, unavailable_reason: "This memory is scoped to another project." },
  });

  assert.match(html, /This memory is scoped to another project\./);
  assert.doesNotMatch(html, /another project's private text/);
  assert.match(html, /Copy saved version into this project/);
  assert.match(html, /This memory belongs to another project\. You can copy the previously saved version into this project/);
  assert.doesNotMatch(html, /Keep current|Use previously saved/);
});
