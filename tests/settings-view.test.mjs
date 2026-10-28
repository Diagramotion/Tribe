import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { isSupportedGitRemote } from "../src/domain/project-setup.js";

let vite;
const hmrPort = 40_000 + (process.pid % 5_000) * 3 + 2;
let SettingsView;
let ProjectCreateDialog;

before(async () => {
  globalThis.window = { __TAURI_INTERNALS__: {}, setTimeout };
  vite = await createServer({ server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" });
  ({ SettingsView } = await vite.ssrLoadModule("/src/views/SettingsView.jsx"));
  ({ ProjectCreateDialog } = await vite.ssrLoadModule("/src/components/ProjectCreateDialog.jsx"));
});

after(async () => {
  delete globalThis.window;
  await vite?.close();
});

test("every Workspace Settings category renders without missing UI components", () => {
  const categories = [
    ["workspace", "Local storage and app status"],
    ["models", "Models"],
    ["connections", "Connected services"],
    ["commands", "Project command tools"],
    ["desktop", "Desktop access"],
    ["data", "Usage limits"],
  ];
  const props = {
    project: { id: "project-1", name: "Example", repository: "/tmp/example" },
    runtimeStatus: "connected",
    agentRuntime: { configured: false },
    usage: { budget: { monthlyTokenLimit: null, maxRunCostUsd: null } },
    webAccess: { enabled: false, allowedDomains: [] },
    computerAccess: { enabled: false },
  };

  for (const [initialSection, expectedText] of categories) {
    const html = renderToStaticMarkup(React.createElement(SettingsView, { ...props, initialSection }));
    assert.match(html, new RegExp(expectedText));
    assert.match(html, /role="tabpanel"/);
  }
});

test("project creation stays limited to repository source and project name", () => {
  const html = renderToStaticMarkup(React.createElement(ProjectCreateDialog, {
    onClose() {},
    onCreate() {},
  }));

  assert.match(html, /Add a project/);
  assert.match(html, /Existing folder/);
  assert.match(html, /Clone repository/);
  assert.match(html, /Project name/);
  assert.match(html, /class="repository-picker-row"/);
  assert.doesNotMatch(html, /Project goal|First mission|Mission goal|Workflow/);
});

test("project cloning accepts supported HTTPS and SSH remotes only", () => {
  for (const remote of [
    "https://github.com/owner/repository.git",
    "ssh://git@github.com/owner/repository.git",
    "git@github.com:owner/repository.git",
  ]) assert.equal(isSupportedGitRemote(remote), true, remote);

  for (const remote of [
    "not-a-repository",
    "http://github.com/owner/repository.git",
    "https://user:password@github.com/owner/repository.git",
    "ssh://root@github.com/owner/repository.git",
  ]) assert.equal(isSupportedGitRemote(remote), false, remote);
});

test("usage settings show month-to-date spend and disclose unpriced runs", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsView, {
    project: { id: "project-1", name: "Example", repository: "/tmp/example" },
    runtimeStatus: "connected",
    agentRuntime: { configured: true },
    usage: {
      budget: { monthlyTokenLimit: 4000, maxRunCostUsd: null, usedTokens: 1200, remainingTokens: 2500 },
      monthToDate: {
        period: "2026-10", completedRuns: 3, pricedRuns: 2, unpricedRuns: 1,
        estimatedCostUsd: "0.045", tokens: 1200,
        byModel: [{ model: "openai:gpt-test", estimatedCostUsd: "0.045", pricedRuns: 2, unpricedRuns: 1 }],
        byAgent: [{ agent: "builder", estimatedCostUsd: "0.045", pricedRuns: 2, unpricedRuns: 1 }],
      },
    },
    webAccess: { enabled: false, allowedDomains: [] },
    computerAccess: { enabled: false },
    initialSection: "data",
  }));

  assert.match(html, /Estimated spend/);
  assert.match(html, /\$0\.045/);
  assert.match(html, /2,500/);
  assert.match(html, /1 run with no provider price data/);
  assert.match(html, /By model/);
  assert.match(html, /By role/);
  assert.match(html, /openai:gpt-test/);
  assert.match(html, /builder/);
  assert.match(html, /No cumulative limit by default/);
  assert.match(html, /placeholder="No limit"/);
});
