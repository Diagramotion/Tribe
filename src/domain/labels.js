const agentStatusLabels = {
  "Provider setup failed": "Model setup failed",
  "Not configured": "Not set up",
  "Waiting for budget": "Monthly limit reached",
  "Waiting for you": "Needs you",
  "Pausing": "Stopping",
  "Complete": "Completed",
};

export function agentStatusLabel(status) {
  return agentStatusLabels[status] ?? status;
}

const missionStatusLabels = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  blocked: "Needs attention",
};

export function missionStatusLabel(status) {
  return missionStatusLabels[status] ?? "Status unavailable";
}
