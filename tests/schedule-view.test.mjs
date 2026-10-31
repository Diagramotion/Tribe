import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { scheduleRunNotifications } from "../src/domain/schedules.js";

let vite;
const hmrPort = 40_000 + (process.pid % 5_000) * 3 + 1;
let SchedulesView;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" });
  ({ SchedulesView } = await vite.ssrLoadModule("/src/views/BackgroundWorkViews.jsx"));
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

test("workspace scheduler lists project ownership and offers a project target", () => {
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
  assert.match(html, /Project/);
  assert.match(html, /Greenfield/);
  assert.match(html, /Website/);
  assert.match(html, /Run in/);
  assert.match(html, /A new chat/);
  assert.match(html, /Design system/);
  assert.doesNotMatch(html, /Enable desktop notifications/);
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

  assert.match(html, /Custom \(cron\)/);
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
