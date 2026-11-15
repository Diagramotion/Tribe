import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import react from "@vitejs/plugin-react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let ProjectWebAccessView;
let ApprovalSettingsView;
let AgentRolesView;
let SkillsView;
let ProjectHomeView;
let EventTriggerFailureQueue;
let AppErrorBoundary;
let App;
let ProjectMcpAccess;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

before(async () => {
  globalThis.document = {
    documentElement: { style: {} },
    body: { style: {} },
    activeElement: null,
    createElement: () => ({ style: {} }),
  };
  globalThis.window = {
    setTimeout,
    innerWidth: 1440,
    localStorage: { getItem: () => null, setItem: () => {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    location: { reload() {} },
    __TAURI_INTERNALS__: undefined,
  };
  vite = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ ProjectWebAccessView } = await vite.ssrLoadModule("/src/views/ProjectWebAccessView.jsx"));
  ({ ApprovalSettingsView } = await vite.ssrLoadModule("/src/views/ApprovalSettingsView.jsx"));
  ({ AgentRolesView, SkillsView } = await vite.ssrLoadModule("/src/views/TeamViews.jsx"));
  ({ ProjectHomeView } = await vite.ssrLoadModule("/src/views/ProjectHomeView.jsx"));
  ({ EventTriggerFailureQueue } = await vite.ssrLoadModule("/src/views/BackgroundWorkViews.jsx"));
  ({ AppErrorBoundary } = await vite.ssrLoadModule("/src/components/AppErrorBoundary.jsx"));
  ({ App, ProjectMcpAccess } = await vite.ssrLoadModule("/src/App.jsx"));
});

after(async () => {
  await vite?.close();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function render(Component, props = {}) {
  return renderToStaticMarkup(React.createElement(Component, props));
}

test("project website access renders disabled and enabled policy states", () => {
  const disabled = render(ProjectWebAccessView, {
    projectName: "Tribe",
    policy: { enabled: false, allowedDomains: ["sonar.example.com"] },
    onSave: async () => {},
  });
  const enabled = render(ProjectWebAccessView, {
    projectName: "Tribe",
    policy: { enabled: true, allowedDomains: ["localhost", "sonar.example.com"] },
    onSave: async () => {},
  });

  assert.match(disabled, /aria-checked="false"/);
  assert.match(disabled, /disabled=""/);
  assert.match(enabled, /aria-checked="true"/);
  assert.match(enabled, /localhost/);
  assert.match(enabled, /sonar\.example\.com/);
});

test("approval settings explain the initial loading state without granting capabilities", () => {
  const html = render(ApprovalSettingsView, { projectId: "project-one" });

  assert.match(html, /How agents ask before acting/);
  assert.match(html, /cannot grant tools or access/);
  assert.match(html, /disabled=""/);
});

test("agent roles explain empty workspace and project teams", () => {
  const common = {
    agents: [],
    capabilityCatalog: [],
    agentConfigured: false,
    onCreate: async () => true,
    onUpdate: async () => true,
    onArchive: async () => {},
    onUpdateProjectTeam: async () => {},
    onConnectModel: () => {},
    onManageModels: () => {},
  };
  const workspace = render(AgentRolesView, common);
  const project = render(AgentRolesView, { ...common, projectAgentIds: [] });

  assert.match(workspace, /Agent roles/);
  assert.match(workspace, /Connect model/);
  assert.match(project, /Project team/);
  assert.match(project, /0 of 0 in team/);
});

test("skills and project home render their empty and unconfigured states", () => {
  const skills = render(SkillsView, { skills: [] });
  const home = render(ProjectHomeView, {
    project: { id: "project-one", name: "Tribe" },
    missions: [],
    skills: [],
    recipes: [],
    agents: [],
    agentConfigured: false,
    workspaceModel: null,
    onCreateMission: async () => false,
    onSelectMission: () => {},
    onConnectModel: () => {},
    onManageModelMetadata: () => {},
    onManageTeam: () => {},
  });

  assert.match(skills, /Skills/);
  assert.match(home, /Ask a question or describe a task/);
  assert.match(home, /Deep Research/);
  assert.match(home, /aria-label="Start chat"[^>]*disabled=""/);
});

test("event failure queue renders loading, empty and actionable retry states", () => {
  const common = {
    workspace: true,
    total: 0,
    hasMore: false,
    loadingMore: false,
    actionId: null,
    onRefresh: () => {},
    onLoadMore: () => {},
    onRetry: () => {},
    onDismiss: () => {},
  };
  const loading = render(EventTriggerFailureQueue, { ...common, failures: [], loading: true });
  const empty = render(EventTriggerFailureQueue, { ...common, failures: [], loading: false });
  const actionable = render(EventTriggerFailureQueue, {
    ...common,
    total: 1,
    loading: false,
    failures: [{
      id: "run-one",
      schedule_title: "Review test failures",
      project_name: "Tribe",
      trigger_event_type: "repo.test_run.failed",
      event_source_mission_title: "Release check",
      mission_title: "Investigate failure",
      started_at: "2026-11-15T02:00:00Z",
      can_retry: true,
      error: "Tests failed",
    }],
  });

  assert.match(loading, /Loading event failures/);
  assert.match(empty, /No failed event runs need review/);
  assert.match(actionable, /Review test failures/);
  assert.match(actionable, /Retry/);
  assert.match(actionable, /Dismiss/);
});

test("error boundary renders children and a bounded diagnostic screen", () => {
  const healthy = render(AppErrorBoundary, { children: React.createElement("p", null, "Workspace ready") });
  const boundary = new AppErrorBoundary({ children: null });
  boundary.state = { error: new Error("Renderer failed") };
  const failed = renderToStaticMarkup(boundary.render());

  assert.match(healthy, /Workspace ready/);
  assert.match(failed, /Tribe hit an unexpected error/);
  assert.match(failed, /Renderer failed/);
  assert.match(failed, /Reload Tribe/);
});

test("workspace root renders the project home and new-chat controls", () => {
  const html = render(App);

  assert.match(html, /class="app-shell/);
  assert.match(html, /New chat/);
});

test("project MCP access renders an explicit loading state and workspace scope", () => {
  const html = render(ProjectMcpAccess, { projectId: "project-one", onManage: () => {} });

  assert.match(html, /Loading connections/);
  assert.match(html, /Exclusions apply to every agent in this project/);
});
