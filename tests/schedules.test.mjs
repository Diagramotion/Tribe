import assert from "node:assert/strict";
import test from "node:test";
import { schedulePresentation } from "../src/domain/schedules.js";

test("one-time schedule stays attached to its live mission until completion", () => {
  const schedule = {
    status: "active",
    cadence: "once",
    next_run_at: "2026-10-25T00:00:00+00:00",
    runs: [{ status: "running", mission_title: "Nightly review" }],
  };

  const result = schedulePresentation(schedule, true, Date.parse("2026-10-25T00:01:00Z"));

  assert.equal(result.oneOffInProgress, true);
  assert.equal(result.statusLabel, "Running");
  assert.equal(result.nextRun, "Nightly review · Running");
});

test("one-time schedule distinguishes queued delivery from an active agent run", () => {
  const schedule = {
    status: "active",
    cadence: "once",
    next_run_at: "2026-10-25T00:00:00+00:00",
    runs: [{ status: "queued", mission_title: "Nightly review" }],
  };

  const result = schedulePresentation(schedule, true, Date.parse("2026-10-25T00:01:00Z"));

  assert.equal(result.oneOffInProgress, true);
  assert.equal(result.statusLabel, "Queued");
  assert.equal(result.nextRun, "Nightly review · Queued");
});

test("one-time mission waiting on the user is not shown as a completed schedule", () => {
  const schedule = {
    status: "active",
    cadence: "once",
    next_run_at: "2026-10-25T00:00:00+00:00",
    runs: [{ status: "blocked", mission_title: "Nightly review" }],
  };

  const result = schedulePresentation(schedule, true, Date.parse("2026-10-25T00:01:00Z"));

  assert.equal(result.oneOffInProgress, true);
  assert.equal(result.statusLabel, "Waiting for you");
  assert.equal(result.nextRun, "Nightly review · Waiting for you");
});

test("an overdue schedule with no configured agents explains when it will run", () => {
  const schedule = {
    status: "active",
    cadence: "daily",
    next_run_at: "2026-10-25T00:00:00+00:00",
    runs: [],
  };

  const result = schedulePresentation(schedule, false, Date.parse("2026-10-25T00:01:00Z"));

  assert.equal(result.statusLabel, "Waiting for agents");
  assert.equal(result.nextRun, "Next run when agents are ready");
});
