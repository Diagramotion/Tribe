import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let TabularArtifactPreview;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  ({ TabularArtifactPreview } = await vite.ssrLoadModule("/src/components/TabularArtifactPreview.jsx"));
});

after(async () => { await vite?.close(); });

test("tabular preview renders CSV values and supports a source view action", () => {
  const html = renderToStaticMarkup(React.createElement(TabularArtifactPreview, {
    delimiter: ",",
    fileName: "cities.csv",
    onViewSource() {},
    text: 'city,count,note\nSydney,5,"harbour, coast"\nMelbourne,4,"lanes"\n',
  }));

  assert.match(html, /aria-label="cities\.csv table"/);
  assert.match(html, /2 rows/);
  assert.match(html, /Sydney/);
  assert.match(html, /harbour, coast/);
  assert.match(html, /View source/);
  assert.match(html, /Search table values/);
  assert.match(html, /Column profile · 3 columns/);
  assert.match(html, /Distinct in preview/);
  assert.match(html, /4–5/);
});

test("tabular preview parses tab-separated values", () => {
  const html = renderToStaticMarkup(React.createElement(TabularArtifactPreview, {
    delimiter: "\t",
    fileName: "metrics.tsv",
    text: "epoch\tloss\n1\t0.42\n2\t0.18\n",
  }));

  assert.match(html, /2 rows/);
  assert.match(html, /0\.42/);
  assert.match(html, /0\.18/);
});

test("column profile reports missing values and text types", () => {
  const html = renderToStaticMarkup(React.createElement(TabularArtifactPreview, {
    delimiter: ",",
    fileName: "quality.csv",
    text: "id,label\n1,ready\n2,\n3,blocked\n",
  }));

  assert.match(html, /<th scope="row" title="id">id<\/th><td>Number<\/td><td>0<\/td><td>3<\/td>/);
  assert.match(html, /<th scope="row" title="label">label<\/th><td>Text<\/td><td>1<\/td><td>2<\/td>/);
});
