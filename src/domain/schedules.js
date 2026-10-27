const runStatusLabels = {
  running: "Running",
  paused: "Mission paused",
  blocked: "Waiting for you",
};

const scheduleStatusLabels = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function schedulePresentation(schedule, agentsConfigured, now = Date.now()) {
  const dueAt = Date.parse(schedule.next_run_at);
  const overdue = Number.isFinite(dueAt) && dueAt <= now;
  const activeRun = schedule.runs?.find((run) => Object.hasOwn(runStatusLabels, run.status));
  const oneOffInProgress = schedule.cadence === "once" && Boolean(activeRun);
  const waiting = schedule.status === "active" && overdue && !agentsConfigured;
  const statusLabel = activeRun ? runStatusLabels[activeRun.status]
    : waiting ? "Waiting for agents" : scheduleStatusLabels[schedule.status] ?? "Needs attention";
  const nextRun = ["completed", "cancelled"].includes(schedule.status)
    ? "No upcoming run"
    : oneOffInProgress ? `${activeRun.mission_title} · ${runStatusLabels[activeRun.status]}`
      : waiting ? "Next run when agents are ready"
        : schedule.status === "paused" ? "Paused · resume to continue"
          : `Next run ${new Date(dueAt).toLocaleString()}`;

  return { activeRun, oneOffInProgress, statusLabel, nextRun };
}
