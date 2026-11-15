import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
const hmrPort = 40_000 + (process.pid % 5_000) * 3;
let AddRemoteServiceForm;
let normaliseServiceKey;
let credentialReference;
let formatAccessHeader;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" });
  ({ AddRemoteServiceForm, normaliseServiceKey, credentialReference, formatAccessHeader } = await vite.ssrLoadModule("/src/components/AddRemoteServiceForm.jsx"));
});

after(async () => {
  await vite?.close();
});

test("remote service identifiers are safe and unique", () => {
  assert.equal(normaliseServiceKey("Linear Cloud", []), "linear-cloud");
  assert.equal(normaliseServiceKey("Linear Cloud", ["linear-cloud"]), "linear-cloud-2");
  assert.equal(normaliseServiceKey("---", []), "remote-service");
});

test("credential references avoid collisions with existing MCP secrets", () => {
  assert.equal(credentialReference("linear-cloud", []), "TRIBE_MCP_LINEAR_CLOUD_TOKEN");
  assert.equal(credentialReference("linear-cloud", ["TRIBE_MCP_LINEAR_CLOUD_TOKEN"]), "TRIBE_MCP_LINEAR_CLOUD_TOKEN_2");
});

test("Authorization access tokens use Bearer without duplicating an explicit scheme", () => {
  assert.equal(formatAccessHeader("Authorization", "sonar-token"), "Bearer sonar-token");
  assert.equal(formatAccessHeader("authorization", "Bearer sonar-token"), "Bearer sonar-token");
  assert.equal(formatAccessHeader("Authorization", "Basic abc"), "Basic abc");
  assert.equal(formatAccessHeader("X-API-Key", "sonar-token"), "sonar-token");
});

test("remote service form starts with concise connection fields", () => {
  const html = renderToStaticMarkup(React.createElement(AddRemoteServiceForm, { onAdd: async () => true }));
  assert.match(html, /Add remote server/);
  assert.match(html, /Service address/);
  assert.match(html, /Sign-in/);
  assert.match(html, /No sign-in/);
});
