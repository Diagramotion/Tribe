const runStatusLabels = {
  queued: "Queued",
  running: "Running",
  paused: "Mission paused",
  blocked: "Waiting for you",
};

const scheduleStatusLabels = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Needs attention",
};

const notifiedRunStatuses = new Set(["completed", "blocked", "failed"]);

export function scheduleRunNotifications(previousStatuses, schedules) {
  const nextStatuses = new Map();
  const notifications = [];
  for (const schedule of schedules) {
    for (const run of schedule.runs ?? []) {
      nextStatuses.set(run.id, run.status);
      const previous = previousStatuses?.get(run.id);
      if (!previousStatuses || previous === run.status || !notifiedRunStatuses.has(run.status)) continue;
      // A short run can start and finish between 15-second UI polls. Notify
      // when a new terminal outcome appears as well as on observed transitions.
      if (previous === undefined || ["queued", "running", "paused", "blocked"].includes(previous)) {
        notifications.push({
          status: run.status,
          missionTitle: run.mission_title,
          projectName: schedule.project_name,
        });
      }
    }
  }
  return { nextStatuses, notifications };
}

export function schedulePresentation(schedule, agentsConfigured, now = Date.now()) {
  const dueAt = Date.parse(schedule.next_run_at);
  const overdue = Number.isFinite(dueAt) && dueAt <= now;
  const activeRun = schedule.runs?.find((run) => Object.hasOwn(runStatusLabels, run.status));
  const oneOffInProgress = schedule.cadence === "once" && Boolean(activeRun);
  const waiting = schedule.status === "active" && overdue && !agentsConfigured;
  const statusLabel = activeRun ? runStatusLabels[activeRun.status]
    : waiting ? "Waiting for agents" : scheduleStatusLabels[schedule.status] ?? "Needs attention";
  const nextRun = ["completed", "cancelled", "failed"].includes(schedule.status)
    ? "No upcoming run"
    : oneOffInProgress ? `${activeRun.mission_title} · ${runStatusLabels[activeRun.status]}`
      : waiting ? "Next run when agents are ready"
        : schedule.status === "paused" ? "Paused · resume to continue"
          : `Next run ${new Date(dueAt).toLocaleString()}`;

  return { activeRun, oneOffInProgress, statusLabel, nextRun };
}
