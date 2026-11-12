import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { secureInteractiveDocument } from "../src/domain/interactive-artifact.js";

let vite;
let InteractiveAccessView;

before(async () => {
  globalThis.window = { setTimeout };
  vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  ({ InteractiveAccessView } = await vite.ssrLoadModule("/src/views/InteractiveAccessView.jsx"));
});

after(async () => {
  delete globalThis.window;
  await vite?.close();
});

test("interactive HTML receives a restrictive policy and the explicit result bridge", () => {
  const source = "<!doctype html><html><head><title>Planner</title></head><body><button>Calculate</button></body></html>";
  const secured = secureInteractiveDocument(source);

  assert.match(secured, /default-src 'none'/);
  assert.match(secured, /script-src 'unsafe-inline'/);
  assert.match(secured, /connect-src 'none'/);
  assert.match(secured, /form-action 'none'/);
  assert.match(secured, /frame-src 'none'/);
  assert.match(secured, /--tribe-ui-accent/);
  assert.match(secured, /\.tribe-ui-button-primary/);
  assert.match(secured, /:focus-visible/);
  assert.match(secured, /Object\.freeze/);
  assert.match(secured, /window\.parent\.postMessage/);
  assert.match(secured, /ResizeObserver/);
  assert.match(secured, /type: "resize"/);
  assert.match(secured, /getBoundingClientRect\(\)\.height/);
  assert.match(secured, /type: "action"/);
  assert.ok(secured.indexOf("Content-Security-Policy") < secured.indexOf("<title>Planner</title>"));
});

test("interactive HTML drops refresh, base and embedded browsing elements", () => {
  const source = "<!doctype html><html><head><base href='https://example.com'><meta http-equiv='refresh' content='0;url=https://example.com'></head><body><iframe src='https://example.com'></iframe><object data='x'></object><embed src='x'></body></html>";
  const secured = secureInteractiveDocument(source);

  assert.doesNotMatch(secured, /<base\b/i);
  assert.doesNotMatch(secured, /http-equiv\s*=\s*['\"]?refresh/i);
  assert.doesNotMatch(secured, /<(?:iframe|object|embed)\b/i);
});

test("interactive HTML parses markup before removing event handlers and navigation", () => {
  const secured = secureInteractiveDocument('<svg><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(2)">x</a></svg><img src=x onerror=alert(3)><iframe srcdoc="<script>alert(4)</script>"></iframe>');
  assert.match(secured, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(secured, /javascript:|onclick=|onerror=|srcdoc=|<iframe\b|alert\(4\)/i);
});

test("interactive app settings start off and disclose the frame-navigation limit", () => {
  const html = renderToStaticMarkup(React.createElement(InteractiveAccessView, {
    projectName: "Example",
    policy: { enabled: false },
    onSave() {},
  }));

  assert.match(html, /aria-checked="false"[^>]*role="switch"/);
  assert.match(html, /navigate its own frame to another site/);
  assert.match(html, /Choose when to share a result with the agent/);
});
