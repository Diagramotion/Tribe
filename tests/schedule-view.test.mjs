import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

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
