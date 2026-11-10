import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { editedNotebookName, notebookCellDiff, notebookSourceLines, notebookSourceText, serializeNotebook, updateNotebookCell } from "../src/domain/notebook.js";

let vite;
let NotebookPreview;

before(async () => {
  globalThis.window = { setTimeout };
  vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  ({ NotebookPreview } = await vite.ssrLoadModule("/src/components/NotebookPreview.jsx"));
});

after(async () => { delete globalThis.window; await vite?.close(); });

test("notebook preview renders markdown, code, plain text, errors and embedded plots as cells", () => {
  const content = JSON.stringify({
    metadata: { kernelspec: { display_name: "Python 3", name: "python3" } },
    cells: [
      { cell_type: "markdown", source: ["# Analysis\n", "A small report."] },
      { cell_type: "code", execution_count: 1, source: ["print('ready')"], outputs: [
        { output_type: "stream", text: ["stream output sentinel\n"] },
        { output_type: "error", ename: "ValueError", evalue: "bad value" },
        { output_type: "display_data", data: { "image/png": "aGVsbG8=" } },
      ] },
    ],
  });
  const html = renderToStaticMarkup(React.createElement(NotebookPreview, { content, path: "analysis.ipynb" }));

  assert.match(html, /Notebook preview: analysis\.ipynb/);
  assert.match(html, /2 cells/);
  assert.match(html, /Python 3/);
  assert.match(html, /Analysis/);
  assert.match(html, /print\(&#x27;ready&#x27;\)/);
  assert.match(html, /stream output sentinel/);
  assert.match(html, /ValueError: bad value/);
  assert.match(html, /data:image\/png;base64,aGVsbG8=/);
  assert.doesNotMatch(html, /Run all cells/);
  assert.match(html, /Edit cells/);
});

test("editing a code cell invalidates its and later code outputs while preserving unrelated cells", () => {
  const notebook = {
    cells: [
      { cell_type: "markdown", source: ["Intro"] },
      { cell_type: "code", source: ["x = 1"], execution_count: 1, outputs: [{ output_type: "stream", text: ["1"] }] },
      { cell_type: "markdown", source: ["Results"] },
      { cell_type: "code", source: ["print(x)"], execution_count: 2, outputs: [{ output_type: "stream", text: ["1"] }] },
    ],
  };
  const updated = updateNotebookCell(notebook, 1, "x = 2\n");
  assert.deepEqual(updated.cells[1].source, ["x = 2\n"]);
  assert.deepEqual(updated.cells[1].outputs, []);
  assert.equal(updated.cells[1].execution_count, null);
  assert.deepEqual(updated.cells[3].outputs, []);
  assert.equal(updated.cells[3].execution_count, null);
  assert.deepEqual(updated.cells[0], notebook.cells[0]);
  assert.deepEqual(updated.cells[2], notebook.cells[2]);
  assert.deepEqual(notebook.cells[1].outputs, [{ output_type: "stream", text: ["1"] }]);
});

test("notebook source and edited-copy serialization preserve cell content", () => {
  const source = "first line\nsecond line";
  assert.deepEqual(notebookSourceLines(source), ["first line\n", "second line"]);
  assert.equal(notebookSourceText(notebookSourceLines(source)), source);
  assert.equal(editedNotebookName("analysis.ipynb"), "analysis (edited).ipynb");
  const serialised = serializeNotebook({ nbformat: 4, cells: [{ cell_type: "code", source: notebookSourceLines(source) }] });
  assert.equal(JSON.parse(serialised).cells[0].source.join(""), source);
  assert.ok(serialised.endsWith("\n"));
});

test("notebook review groups source, output, added and removed changes by cell", () => {
  const before = JSON.stringify({ cells: [
    { id: "kept", cell_type: "markdown", source: ["Intro"] },
    { id: "changed", cell_type: "code", source: ["value = 1"], outputs: [] },
    { id: "removed", cell_type: "code", source: ["old_cell()"], outputs: [] },
  ] });
  const after = JSON.stringify({ cells: [
    { id: "kept", cell_type: "markdown", source: ["Intro"] },
    { id: "changed", cell_type: "code", source: ["value = 2"], outputs: [{ output_type: "stream", text: ["2"] }] },
    { id: "added", cell_type: "markdown", source: ["## Results"] },
  ] });

  const changes = notebookCellDiff(before, after);
  assert.deepEqual(changes.map(({ key, status, outputsChanged }) => ({ key, status, outputsChanged })), [
    { key: "changed", status: "modified", outputsChanged: true },
    { key: "added", status: "added", outputsChanged: false },
    { key: "removed", status: "removed", outputsChanged: false },
  ]);
  assert.ok(changes[0].lines.some((line) => line.kind === "removed" && line.text === "value = 1"));
  assert.ok(changes[0].lines.some((line) => line.kind === "added" && line.text === "value = 2"));
});

test("notebook preview fails closed on invalid notebook JSON", () => {
  const html = renderToStaticMarkup(React.createElement(NotebookPreview, { content: "{broken", path: "bad.ipynb" }));
  assert.match(html, /role="alert"/);
  assert.match(html, /invalid JSON/);
  assert.doesNotMatch(html, /notebook-cells/);
});
