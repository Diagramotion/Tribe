import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { scheduleRunNotifications } from "../src/domain/schedules.js";

let vite;
const hmrPort = 40_000 + (process.pid % 5_000) * 3 + 1;
let SchedulesView;
let EventTriggerFailureQueue;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" });
  ({ SchedulesView, EventTriggerFailureQueue } = await vite.ssrLoadModule("/src/views/BackgroundWorkViews.jsx"));
});

after(async () => {
  await vite?.close();
});

test("schedule history shows the loaded range and offers older pages", () => {
  const runs = Array.from({ length: 10 }, (_, index) => ({
    id: `run-${index}`,
    status: "completed",
    mission_title: `Review ${index}`,
    started_at: "2026-10-25T00:00:00Z",
    finished_at: "2026-10-25T00:01:00Z",
  }));
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example" },
    schedules: [{
      id: "schedule-1",
      title: "Daily review",
      prompt: "Review repository health",
      cadence: "daily",
      status: "active",
      next_run_at: "2026-10-27T09:00:00Z",
      runs_total: 12,
      runs,
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onAction() {},
    onLoadMoreRuns: async () => ({ runs: [], total: 12, has_more: false }),
  }));

  assert.match(html, /Previous runs · 10 of 12/);
  assert.match(html, /Load older runs/);
});

test("workspace scheduler labels project ownership without opening the create dialog", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    projects: [{ id: "project-1", name: "Greenfield", missions: [{ id: "chat-1", title: "Design system", status: "active" }] }, { id: "project-2", name: "Website" }],
    schedules: [{
      id: "schedule-1",
      project_id: "project-2",
      project_name: "Website",
      title: "Daily review",
      prompt: "Review repository health",
      cadence: "daily",
      status: "active",
      next_run_at: "2026-10-27T09:00:00Z",
      runs_total: 0,
      runs: [],
    }],
    agentsConfigured: true,
    workspace: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
    onLoadMoreRuns: async () => ({ runs: [], total: 0, has_more: false }),
  }));

  assert.match(html, /Manage scheduled chats across your projects/);
  assert.match(html, /Project · Website/);
  assert.doesNotMatch(html, /Run in|A new chat|Design system/);
  assert.doesNotMatch(html, /Enable desktop notifications/);
});

test("event schedule cards show the repository path filter", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example", missions: [{ id: "chat-1", title: "Build" }] },
    schedules: [{
      id: "schedule-1", project_id: "project-1", title: "Review Python changes",
      prompt: "Review changed Python files", cadence: "event", status: "active",
      trigger_event_type: "repo.file.changed", event_source_mission_id: "chat-1",
      event_source_mission_title: "Build", event_path_pattern: "src/*.py", event_auto_retry_limit: 2,
      next_run_at: "", runs_total: 0, runs: [],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
    onLoadMoreRuns: async () => ({ runs: [], total: 0, has_more: false }),
  }));

  assert.match(html, /A repository file changes · Build · src\/\*\.py/);
  assert.match(html, /Up to 2 automatic retries before work starts/);
});

test("GitHub Actions schedules identify the public repository and report access errors", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example", missions: [{ id: "chat-1", title: "Build" }] },
    schedules: [{
      id: "schedule-1", project_id: "project-1", title: "Review CI failures",
      prompt: "Investigate failed builds", cadence: "event", status: "active",
      trigger_event_type: "github.workflow_run.failed", event_external_repository: "tribe-fixtures/sample",
      event_external_error: "github_actions_requires_project_web_access",
      event_source_mission_id: "chat-1", event_source_mission_title: "Build",
      next_run_at: "", runs_total: 0, runs: [],
    }, {
      id: "schedule-2", project_id: "project-1", title: "Check another repository",
      prompt: "Review failures", cadence: "event", status: "active",
      trigger_event_type: "github.workflow_run.failed", event_external_repository: "tribe-fixtures/second",
      event_external_error: "github_actions_local_rate_budget",
      event_source_mission_id: "chat-1", event_source_mission_title: "Build",
      next_run_at: "", runs_total: 0, runs: [],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
  }));

  assert.match(html, /A GitHub Actions run fails · tribe-fixtures\/sample · recorded in Build/);
  assert.match(html, /Enable project web access for api\.github\.com to resume checks/);
  assert.match(html, /spacing checks across repositories to stay within GitHub’s shared request limit/);
});

test("queued automatic retries keep schedule settings read-only until they run", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example" },
    schedules: [{
      id: "schedule-1", project_id: "project-1", title: "Investigate failures",
      prompt: "Find the cause", cadence: "event", status: "active",
      event_auto_retry_limit: 1, runs_total: 1,
      runs: [{ id: "retry-1", status: "queued", retry_kind: "automatic", mission_title: "Investigation" }],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
  }));

  assert.match(html, /disabled=""[^>]*aria-label="Edit Investigate failures"|aria-label="Edit Investigate failures"[^>]*disabled=""/);
});

test("failed event runs are routed to the shared review queue", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example" },
    schedules: [{
      id: "schedule-1", project_id: "project-1", title: "Investigate test failures",
      prompt: "Find the cause", cadence: "event", status: "active",
      trigger_event_type: "repo.test_run.completed", event_source_mission_title: "Test run",
      runs_total: 1, runs: [{ id: "run-1", status: "failed", source_event_sequence: 19,
        mission_title: "Failure investigation", started_at: "2026-10-25T00:00:00Z",
        finished_at: "2026-10-25T00:01:00Z", error: "Agent run failed", has_retry: false }],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
    onRetryEventRun: async () => true,
  }));

  assert.match(html, /Needs review in Event runs\./);
  assert.doesNotMatch(html, /Retry this event|Latest event run failed/);
});

test("retried event failures remain in history without duplicate actions", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example" },
    schedules: [{
      id: "schedule-1", project_id: "project-1", title: "Investigate test failures",
      prompt: "Find the cause", cadence: "event", status: "active",
      trigger_event_type: "repo.test_run.completed", event_source_mission_title: "Test run",
      runs_total: 1, runs: [{ id: "run-1", status: "failed", source_event_sequence: 19,
        mission_title: "Failure investigation", started_at: "2026-10-25T00:00:00Z",
        finished_at: "2026-10-25T00:01:00Z", error: "Agent run failed", has_retry: true }],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
    onRetryEventRun: async () => true,
  }));

  assert.match(html, /This failed run already has a retry\./);
  assert.doesNotMatch(html, /Retry this event|Latest event run failed/);
});

test("older failed event runs remain visible in history for central review", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example" },
    schedules: [{
      id: "schedule-1", project_id: "project-1", title: "Investigate test failures",
      prompt: "Find the cause", cadence: "event", status: "active",
      trigger_event_type: "repo.test_run.completed", event_source_mission_title: "Test run",
      runs_total: 2, runs: [
        { id: "run-new", status: "failed", source_event_sequence: 20, mission_title: "Latest failure",
          started_at: "2026-10-26T00:00:00Z", finished_at: "2026-10-26T00:01:00Z", has_retry: true },
        { id: "run-old", status: "failed", source_event_sequence: 19, mission_title: "Older failure",
          started_at: "2026-10-25T00:00:00Z", finished_at: "2026-10-25T00:01:00Z", has_retry: false },
      ],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
    onRetryEventRun: async () => true,
  }));

  assert.match(html, /Latest failure/);
  assert.match(html, /Older failure/);
  assert.match(html, /This failed run already has a retry\./);
  assert.equal((html.match(/Needs review in Event runs\./g) ?? []).length, 1);
  assert.doesNotMatch(html, /Retry this event|Latest event run failed/);
});

test("event failure queue shows cross-project context and review actions", () => {
  const html = renderToStaticMarkup(React.createElement(EventTriggerFailureQueue, {
    workspace: true,
    failures: [{
      id: "run-1", schedule_id: "schedule-1", project_id: "project-1",
      schedule_title: "Investigate failures", project_name: "Research",
      trigger_event_type: "repo.test_run.completed", event_source_mission_title: "Test run",
      mission_title: "Failure investigation", started_at: "2026-10-25T00:00:00Z",
      error: "Agent run failed", can_retry: true,
    }],
    total: 1, hasMore: false, loading: false, loadingMore: false, error: "", actionId: "",
    onRefresh() {}, onLoadMore() {}, onRetry() {}, onDismiss() {},
  }));

  assert.match(html, /Event runs needing review/);
  assert.match(html, /Research · A test run fails · Test run/);
  assert.match(html, /Run in Failure investigation/);
  assert.match(html, /Agent run failed/);
  assert.match(html, />Retry</);
  assert.match(html, />Dismiss</);
  assert.doesNotMatch(html, /run-1|schedule-1|project-1/);
});

test("desktop scheduler offers explicit operating-system notification opt-in", () => {
  const originalWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  try {
    const html = renderToStaticMarkup(React.createElement(SchedulesView, {
      projects: [{ id: "project-1", name: "Greenfield" }],
      schedules: [],
      agentsConfigured: true,
      workspace: true,
      onEnableDesktopNotifications: async () => true,
      onCreate: async () => true,
      onEdit: async () => true,
      onAction() {},
    }));

    assert.match(html, /Enable desktop notifications/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("desktop scheduler offers a notification check after permission is enabled", () => {
  const originalWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  try {
    const html = renderToStaticMarkup(React.createElement(SchedulesView, {
      projects: [{ id: "project-1", name: "Greenfield" }],
      schedules: [],
      agentsConfigured: true,
      workspace: true,
      desktopNotificationsOn: true,
      onTestDesktopNotifications: async () => true,
      onCreate: async () => true,
      onEdit: async () => true,
      onAction() {},
    }));

    assert.match(html, /Desktop notifications enabled/);
    assert.match(html, /Test notification/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("scheduler accepts and displays a custom five-field recurrence", () => {
  const html = renderToStaticMarkup(React.createElement(SchedulesView, {
    project: { id: "project-1", name: "Example" },
    schedules: [{
      id: "schedule-1",
      project_id: "project-1",
      title: "Weekday review",
      prompt: "Review recent work",
      cadence: "cron",
      cron_expression: "0 9 * * MON-FRI",
      status: "active",
      next_run_at: "2026-11-02T08:00:00Z",
      runs: [],
    }],
    agentsConfigured: true,
    onCreate: async () => true,
    onEdit: async () => true,
    onAction() {},
  }));

  assert.match(html, /Active · Custom/);
  assert.match(html, /0 9 \* \* MON-FRI/);
  assert.match(html, /Custom/);
});

test("scheduled chat outcomes notify after the initial workspace snapshot", () => {
  const schedules = [{
    project_name: "Greenfield",
    runs: [
      { id: "run-1", status: "completed", mission_title: "Build the scaffold" },
      { id: "run-2", status: "blocked", mission_title: "Review deployment" },
    ],
  }];
  const initial = scheduleRunNotifications(null, schedules);
  assert.deepEqual(initial.notifications, []);

  const updated = scheduleRunNotifications(new Map([
    ["run-1", "running"], ["run-2", "running"],
  ]), schedules);
  assert.deepEqual(updated.notifications, [
    { status: "completed", missionTitle: "Build the scaffold", projectName: "Greenfield" },
    { status: "blocked", missionTitle: "Review deployment", projectName: "Greenfield" },
  ]);
});

test("repeated scheduler polls do not duplicate outcome notifications", () => {
  const schedules = [{ runs: [{ id: "run-1", status: "completed", mission_title: "Review" }] }];
  const first = scheduleRunNotifications(new Map([["run-1", "running"]]), schedules);
  const second = scheduleRunNotifications(first.nextStatuses, schedules);
  assert.equal(first.notifications.length, 1);
  assert.deepEqual(second.notifications, []);
});

test("scheduler notifies when a run starts and finishes between polls", () => {
  const schedules = [{ runs: [{ id: "run-2", status: "completed", mission_title: "Quick review" }] }];
  const first = scheduleRunNotifications(new Map([["run-1", "running"]]), schedules);
  assert.deepEqual(first.notifications, [
    { status: "completed", missionTitle: "Quick review", projectName: undefined },
  ]);
  const second = scheduleRunNotifications(first.nextStatuses, schedules);
  assert.deepEqual(second.notifications, []);
});
