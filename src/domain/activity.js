import { initialAgents } from "../data/workspace.js";

export function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Not available";
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6,
  }).format(Number(value));
}

export function formatDay(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayOffset = Math.round((todayDay - targetDay) / 86_400_000);
  if (dayOffset === 0) return "Today";
  if (dayOffset === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

export function timelineMessage(event, agentDefinitions = initialAgents) {
  const actorType = event.actorId === "user" ? "human" : "agent";
  const actor = actorType === "human"
    ? "You"
    : agentDefinitions.find((agent) => agent.id === event.actorId)?.name ?? event.actorId;
  if (event.type === "message.created" || event.type === "agent.message.created") {
    const recipientId = event.payload.recipient;
    const recipient = recipientId
      ? agentDefinitions.find((agent) => agent.id === recipientId || agent.role === recipientId)?.name ?? recipientId
      : null;
    return { id: event.id, kind: "message", actor, actorId: event.actorId, actorType, recipient, recipientId,
      workItemId: event.payload.workItemId, triggerSequence: event.payload.triggerSequence,
      durationMs: event.payload.durationMs,
      inputTokens: event.payload.inputTokens,
      outputTokens: event.payload.outputTokens,
      canvasDocument: event.payload.canvasDocument ?? null,
      attachments: event.payload.attachments ?? [],
      interactiveArtifactIds: event.payload.interactiveArtifactIds ?? [],
      time: formatTime(event.createdAt), text: event.payload.text };
  }
  if (event.type === "interactive_artifact.action.created") {
    const recipient = agentDefinitions.find((item) => item.id === event.payload.recipient)?.name
      ?? event.payload.recipient;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt),
      text: `You shared an app result with ${recipient} · ${event.payload.artifactName}`,
      detail: `${event.payload.action}: ${JSON.stringify(event.payload.data)}` };
  }
  if (event.type.startsWith("interaction.") && event.type.endsWith(".resolved")) {
    const item = event.payload.interaction;
    const resolution = { "Approved once": "approved this action once", Denied: "declined this action" }[item.resolution] ?? item.resolution.toLowerCase();
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `You ${resolution} · ${item.title}` };
  }
  if (event.type.startsWith("plan.item.")) {
    const item = event.payload.workItem;
    const action = event.type.endsWith("claimed") ? "started" : event.type.endsWith("completed") ? "completed" : event.type.endsWith("updated") ? "updated" : "added";
    return { id: event.id, kind: "change", actor, actorId: event.actorId, groupable: true, workItemId: item.id,
      time: formatTime(event.createdAt), text: `${actor} ${action} task · ${item.title}` };
  }
  if (event.type === "plan.finalized") {
    const planCriteria = (event.payload.acceptanceCriteria ?? []).map((item) =>
      typeof item === "string" ? { criterion: item, workItems: [] } : item);
    const count = planCriteria.length;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      planCriteria,
      time: formatTime(event.createdAt), text: `${actor} finalised the plan · ${count} acceptance criteria` };
  }
  if (event.type === "sdlc.discovery.completed") {
    const count = (event.payload.evidence ?? []).length;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt), text: `${actor} completed repository discovery · ${count} source ${count === 1 ? "file" : "files"}` };
  }
  if (event.type === "agent.run.retrying") {
    const attempt = Number.isInteger(event.payload.attempt) ? event.payload.attempt : 2;
    const maxAttempts = Number.isInteger(event.payload.maxAttempts) ? event.payload.maxAttempts : 3;
    const delay = Number.isFinite(Number(event.payload.retryDelaySeconds))
      ? Math.max(1, Math.ceil(Number(event.payload.retryDelaySeconds))) : 1;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt),
      text: `${actor} will retry after a temporary model issue · attempt ${attempt} of ${maxAttempts} in ${delay}s` };
  }
  if (event.type === "agent.run.failed") {
    const error = String(event.payload.error ?? "");
    const tokenLimitMatch = error.match(/(?:input|total)_tokens_limit\s+(?:of\s+)?([\d,]+)/i);
    const runTokenLimit = tokenLimitMatch ? Number(tokenLimitMatch[1].replaceAll(",", "")) : null;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt),
      text: runTokenLimit ? `${actor} reached the ${new Intl.NumberFormat().format(runTokenLimit)}-token run limit` : `${actor} couldn’t finish this response`,
      detail: event.payload.error, runTokenLimit, canContinue: true };
  }
  if (event.type === "agent.run.interrupted") {
    const text = event.payload.cancelledByUser
      ? `You stopped ${actor} · review recent changes before continuing`
      : `${actor} stopped unexpectedly · review recent changes before continuing`;
    return { id: event.id, kind: "change", actor, actorId: event.actorId, time: formatTime(event.createdAt), text, detail: event.payload.error, canContinue: true };
  }
  if (event.type === "agent.run.cancellation.requested") {
    const stoppedAgent = agentDefinitions.find((agent) => agent.id === event.payload.agentId)?.name ?? event.payload.agentId;
    return { id: event.id, kind: "change", actor: "You", time: formatTime(event.createdAt), text: `You asked ${stoppedAgent} to stop the current run` };
  }
  if (event.type === "repo.test_run.started" || event.type === "repo.test_run.completed") {
    const command = Array.isArray(event.payload.argv) ? event.payload.argv.join(" ") : "Repository checks";
    const outcome = event.type === "repo.test_run.started" ? "started"
      : event.payload.cancelled ? "stopped"
        : event.payload.timedOut ? "timed out"
          : event.payload.exitCode === 0 ? "passed" : "failed";
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      text: `Verification ${outcome} · ${command}` };
  }
  if (["agent.tool.started", "agent.tool.waiting_for_user", "agent.tool.completed", "agent.tool.interrupted"].includes(event.type)) {
    const tool = event.payload.toolName;
    const actionLabels = {
      write_file: { working: "writing a file", finished: "wrote a file" },
      edit_file: { working: "editing a file", finished: "edited a file" },
      create_directory: { working: "creating a folder", finished: "created a folder" },
      run_command: { working: "running a command", finished: "ran a command" },
      start_command: { working: "starting a command", finished: "started a command" },
    };
    const labels = actionLabels[tool] ?? event.payload.activityLabels
      ?? (event.type === "agent.tool.interrupted" || event.type === "agent.tool.waiting_for_user"
        ? { working: "using a tool" } : null);
    if (!labels) return null;
    const toolState = event.type === "agent.tool.started" ? "working"
      : event.type === "agent.tool.waiting_for_user" ? "waiting"
        : event.type === "agent.tool.interrupted" ? "unknown"
          : event.payload.outcome === "denied" ? "denied" : "finished";
    const detail = event.payload.summary ? ` · ${event.payload.summary}` : "";
    const text = toolState === "unknown"
      ? `${actor} was interrupted while ${labels.working}${detail} · outcome unknown`
      : toolState === "waiting"
        ? `${actor} is waiting for your approval · ${labels.working}${detail}`
        : toolState === "denied"
          ? `${actor} did not run this action${detail} · approval declined`
        : `${actor} ${labels[toolState]}${detail}`;
    return { id: event.id, kind: "change", actor, workItemId: event.payload.workItemId,
      actorId: event.actorId, groupable: Boolean(event.payload.workItemId),
      toolCallId: event.payload.toolCallId, toolState,
      time: formatTime(event.createdAt), text };
  }
  if (event.type === "repo.file.changed") {
    const change = event.payload.change === "integrated" ? "Integrated"
      : event.payload.kind === "directory" ? "Created folder"
      : event.payload.change === "created" ? "Created" : "Changed";
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      groupable: Boolean(event.payload.workItemId), workItemId: event.payload.workItemId,
      time: formatTime(event.createdAt), text: `${change} ${event.payload.path}` };
  }
  if (event.type === "repo.file.deleted") {
    const diffNote = {
      file_too_large: " · diff not attached (file too large)",
      diff_too_large: " · diff not attached (diff too large)",
      binary_file: " · diff not attached (binary file)",
    }[event.payload.diffUnavailableReason] ?? "";
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt), text: `Deleted ${event.payload.path}${diffNote}` };
  }
  if (event.type === "repo.file.delete.aborted") {
    const reason = event.payload.reason === "file_changed_after_approval"
      ? "the file changed after approval" : "the deletion could not be completed";
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt), text: `Did not delete ${event.payload.path} · ${reason}` };
  }
  if (event.type === "repo.file.delete.recovered") {
    const outcome = event.payload.outcome;
    const text = outcome === "deleted"
      ? `Confirmed deletion after restart · ${event.payload.path}`
      : outcome === "not_deleted"
        ? `Deletion did not finish · ${event.payload.path}; request approval again`
        : `Deletion outcome needs review · ${event.payload.path}`;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt), text };
  }
  if (event.type === "repo.worktree.started") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: "Started work in a separate workspace" };
  }
  if (event.type === "repo.worktree.integrated") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Integrated approved changes · ${event.payload.paths.length} files` };
  }
  if (event.type === "repo.worktree.discarded") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: "Discarded separate workspace changes" };
  }
  if (event.type === "artifact.created") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Shared artifact · ${event.payload.artifact.name}` };
  }
  if (event.type === "canvas.document.linked") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Linked a shared document · ${event.payload.title}`,
      canvasDocument: { artifactId: event.payload.artifactId, title: event.payload.title,
        revision: event.payload.revision } };
  }
  if (event.type === "canvas.document.unlinked") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Removed a shared document · ${event.payload.title}` };
  }
  if (event.type === "artifact.review.comment.created") {
    const body = event.payload.comment.body;
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Commented on an artifact · ${body.length > 220 ? `${body.slice(0, 220)}…` : body}`, artifactId: event.payload.artifactId,
      threadId: event.payload.threadId };
  }
  if (event.type === "artifact.review.thread.resolved") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `${actor} resolved an artifact review thread`, artifactId: event.payload.artifactId,
      threadId: event.payload.threadId };
  }
  if (event.type === "artifact.review.thread.reopened") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `${actor} reopened an artifact review thread`, artifactId: event.payload.artifactId,
      threadId: event.payload.threadId };
  }
  if (event.type === "canvas.document.created") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Created a shared document · ${event.payload.title}`, canvasId: event.payload.artifactId };
  }
  if (event.type === "canvas.proposal.created") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Proposed changes to · ${event.payload.title}`, canvasId: event.payload.artifactId };
  }
  if (event.type === "canvas.version.saved" || event.type === "canvas.proposal.accepted") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `${actor} saved document revision ${event.payload.revision} · ${event.payload.title ?? "Updated document"}`,
      canvasId: event.payload.artifactId };
  }
  if (event.type === "canvas.proposal.dismissed" || event.type === "canvas.proposal.stale") {
    const action = event.type.endsWith("dismissed") ? "dismissed" : "marked as out of date";
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `${actor} ${action} a document proposal`, canvasId: event.payload.artifactId };
  }
  if (event.type === "canvas.comment.created") {
    const body = event.payload.comment.body;
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Commented on a shared document · ${body.length > 220 ? `${body.slice(0, 220)}…` : body}`,
      canvasId: event.payload.artifactId, threadId: event.payload.threadId };
  }
  if (event.type === "canvas.comment.resolved") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `${actor} resolved a document comment`, canvasId: event.payload.artifactId,
      threadId: event.payload.threadId };
  }
  if (event.type === "knowledge.entry.saved") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Updated project knowledge · ${event.payload.entry.title}` };
  }
  if (event.type === "knowledge.proposed") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Suggested project knowledge · ${event.payload.proposal.title}` };
  }
  if (event.type === "knowledge.proposal.reviewed") {
    const action = event.payload.decision === "accept" ? "accepted" : "dismissed";
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `${actor} ${action} project knowledge · ${event.payload.proposal.title}` };
  }
  if (event.type === "knowledge.entry.archived") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `${actor} archived project knowledge · ${event.payload.entry.title}` };
  }
  if (event.type === "knowledge.entry.restored") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `${actor} restored project knowledge · ${event.payload.entry.title}` };
  }
  if (event.type === "repo.command.started") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Started command · ${event.payload.argv.join(" ")}` };
  }
  if (event.type === "repo.command.completed") {
    const outcome = event.payload.status === "completed" ? "Command completed" : event.payload.status === "cancelled" ? "Command stopped" : "Command failed";
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: outcome };
  }
  if (event.type === "mission.created") {
    return { id: event.id, kind: "change", actor: "Tribe", time: formatTime(event.createdAt), text: "Chat started" };
  }
  if (event.type === "mission.paused") {
    const text = event.payload.reason === "another mission was resumed"
      ? "Paused · another chat resumed"
      : "Chat paused";
    return { id: event.id, kind: "change", presentation: "divider", actor: "You", time: formatTime(event.createdAt), text };
  }
  if (event.type === "mission.resumed") {
    return { id: event.id, kind: "change", presentation: "divider", actor: "You", time: formatTime(event.createdAt), text: "Chat resumed" };
  }
  if (event.type === "mission.blocked") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Chat blocked · ${event.payload.reason}` };
  }
  if (event.type === "review.checkpoint.recorded") {
    const approved = event.payload.disposition === "approved";
    return {
      id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `${approved ? "Independent review passed" : "Review requested changes"} · ${event.payload.summary}`,
      reviewFindings: event.payload.findings ?? [],
      verificationEventId: event.payload.verificationEventId,
    };
  }
  if (event.type === "mission.unblocked") {
    return { id: event.id, kind: "change", actor: "You", time: formatTime(event.createdAt), text: "All questions and approvals resolved · team resumed" };
  }
  if (event.type === "mission.completed") {
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `Chat completed · ${event.payload.summary}`, acceptanceEvidence: event.payload.acceptanceEvidence ?? [], acceptanceChecks: event.payload.acceptanceChecks ?? [], evidenceRefs: event.payload.evidenceRefs ?? [] };
  }
  if (event.type === "mission.outcome.reviewed") {
    const outcome = { accepted: "accepted", follow_up: "needs follow-up", rejected: "rejected" }[event.payload.outcome] ?? event.payload.outcome;
    return { id: event.id, kind: "change", actor: "You", time: formatTime(event.createdAt), text: `Outcome marked ${outcome}${event.payload.notes ? ` · ${event.payload.notes}` : ""}` };
  }
  if (event.type === "project.goal.updated") {
    return { id: event.id, kind: "change", actor: "You", time: formatTime(event.createdAt), text: "You updated the project goal" };
  }
  if (event.type === "project.usage_budget.updated") {
    const limit = event.payload.monthlyTokensLimit;
    return { id: event.id, kind: "change", actor: "You", time: formatTime(event.createdAt), text: limit == null ? "You removed the monthly model budget" : `You set the monthly model budget to ${Number(limit).toLocaleString()} tokens` };
  }
  return null;
}

export function timelineEntry(event, agentDefinitions = initialAgents) {
  const message = timelineMessage(event, agentDefinitions);
  if (!message) return null;
  const date = new Date(event.createdAt);
  return {
    ...message,
    eventType: event.type,
    testSucceeded: event.type === "repo.test_run.completed" && event.payload.exitCode === 0,
    reviewDisposition: event.type === "review.checkpoint.recorded" ? event.payload.disposition : undefined,
    reviewVerificationEventId: event.type === "review.checkpoint.recorded"
      ? event.payload.verificationEventId : undefined,
    reviewChangeEventId: event.type === "review.checkpoint.recorded" ? event.payload.changeEventId : undefined,
    sequence: event.sequence,
    timestamp: date.getTime(),
    dayKey: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    dayLabel: formatDay(event.createdAt),
  };
}

export function mergeTimelineMessages(current, incoming) {
  const merged = [...current];
  for (const message of incoming) {
    if (merged.some((item) => item.id === message.id)) continue;
    if (message.kind === "message" && message.actorType === "agent" && Number.isInteger(message.triggerSequence)
      && merged.some((item) => item.kind === "message" && item.actorType === "agent"
        && item.actorId === message.actorId && item.text.trim() === message.text.trim()
        && (item.triggerSequence === message.triggerSequence
          || (!Number.isInteger(item.triggerSequence) && Math.abs(item.timestamp - message.timestamp) <= 10_000)))) continue;
    const pairedIndex = message.toolCallId
      ? merged.findIndex((item) => item.toolCallId === message.toolCallId)
      : -1;
    if (pairedIndex < 0) {
      merged.push(message);
      continue;
    }
    const previous = merged[pairedIndex];
    const start = previous.toolState === "working" ? previous : message.toolState === "working" ? message : previous;
    const latest = [previous, message]
      .filter((item) => ["finished", "unknown", "denied"].includes(item.toolState))
      .concat([previous, message].filter((item) => item.toolState === "waiting"))
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .at(-1);
    merged[pairedIndex] = latest ? {
      ...start,
      ...latest,
      id: start.id,
      sequence: latest.sequence,
      workItemId: start.workItemId ?? latest.workItemId,
    } : start;
  }
  return merged.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
}

export function timelineEntries(events, agentDefinitions = initialAgents) {
  const runKey = (event) => Number.isInteger(event.payload?.triggerSequence)
    ? `${event.actorId}:${event.payload.triggerSequence}` : null;
  const runMetrics = new Map();
  for (const event of events) {
    const key = runKey(event);
    if (!key) continue;
    const metrics = runMetrics.get(key) ?? {};
    if (event.type === "agent.usage.recorded") {
      metrics.inputTokens = event.payload.input_tokens;
      metrics.outputTokens = event.payload.output_tokens;
    } else if (event.type === "agent.activity") {
      if (event.payload.status === "Working") metrics.startedAt ??= new Date(event.createdAt).getTime();
      if (event.payload.status === "Ready") metrics.finishedAt = new Date(event.createdAt).getTime();
    }
    runMetrics.set(key, metrics);
  }
  return events.reduce((messages, event) => {
    const entry = timelineEntry(event, agentDefinitions);
    if (!entry) return messages;
    if (entry.kind === "message" && entry.actorType === "agent" && Number.isInteger(entry.triggerSequence)) {
      const metrics = runMetrics.get(`${event.actorId}:${entry.triggerSequence}`) ?? {};
      entry.inputTokens ??= metrics.inputTokens;
      entry.outputTokens ??= metrics.outputTokens;
      if (!Number.isFinite(entry.durationMs) && Number.isFinite(metrics.startedAt) && Number.isFinite(metrics.finishedAt)) {
        entry.durationMs = Math.max(0, metrics.finishedAt - metrics.startedAt);
      }
    }
    return mergeTimelineMessages(messages, [entry]);
  }, []);
}

export function restoreAgentActivity(agents, events, pendingAgentIds = new Set(), missionStatus = "active") {
  const restored = new Map(agents.map((agent) => [agent.id, { ...agent }]));
  for (const event of events) {
    const agent = restored.get(event.actorId);
    if (!agent) continue;
    // Historical readiness belongs to the runtime state at the time of the
    // event. It must not make an agent look available when the current
    // bootstrap says its provider is missing or has failed to initialise.
    if (agent.status === "Not configured" || agent.status === "Provider setup failed") continue;
    const payload = event.payload ?? {};
    if (event.type === "agent.activity") {
      agent.status = payload.status;
      agent.next = payload.status === "Working" ? "Working on this chat"
        : payload.status === "Waiting for budget" ? "Monthly usage limit reached. Review the limit in Settings."
          : payload.status === "Needs attention" ? "Review the activity for details"
            : payload.status === "Paused" ? "Mission paused by you" : "Ready for the next task";
    } else if (event.type === "agent.tool.started") {
      const tool = String(payload.toolName ?? "Working").replaceAll("_", " ");
      const detail = payload.summary ? ` · ${payload.summary}` : "";
      agent.status = "Working";
      agent.activity = `${tool}${detail}`;
      agent.next = `Using ${tool}`;
    } else if (event.type === "agent.tool.waiting_for_user") {
      agent.status = "Waiting for you";
      agent.next = "Waiting for your response";
    } else if (event.type === "agent.run.failed") {
      agent.status = "Needs attention";
      agent.next = "Review the activity for details";
    } else if (event.type === "agent.provider.failed") {
      agent.status = "Provider setup failed";
      agent.next = payload.error ?? "Check the model connection in Settings";
    } else if (event.type === "agent.provider.ready") {
      agent.status = "Ready";
      agent.next = `Using ${payload.model}`;
    }
  }
  for (const agent of restored.values()) {
    if (pendingAgentIds.has(agent.id)) {
      agent.status = "Waiting for you";
      agent.next = "Waiting for your response";
    } else if (missionStatus === "completed") {
      agent.status = "Complete";
      agent.next = "Mission completed";
    } else if (missionStatus === "paused") {
      agent.status = "Paused";
      agent.next = "Mission paused by you";
    }
  }
  return agents.map((agent) => restored.get(agent.id));
}

export function groupActivityMessages(messages, groupWindowMs = 180_000) {
  const rows = [];
  for (const message of messages) {
    const previous = rows.at(-1);
    const isStatusDivider = message.kind === "change" && message.presentation === "divider";
    if (isStatusDivider && previous?.kind === "mission-state-group" && previous.dayKey === message.dayKey) {
      previous.messages.push(message);
      continue;
    }
    if (isStatusDivider) {
      rows.push({ kind: "mission-state-group", firstSequence: message.sequence,
        dayKey: message.dayKey, dayLabel: message.dayLabel, messages: [message] });
      continue;
    }
    const canJoin = message.groupable && message.workItemId && message.actorId
      && previous?.kind === "activity-group"
      && previous.actorId === message.actorId
      && previous.workItemId === message.workItemId
      && previous.dayKey === message.dayKey
      && message.timestamp >= previous.lastTimestamp
      && message.timestamp - previous.lastTimestamp <= groupWindowMs;
    if (canJoin) {
      previous.messages.push(message);
      previous.lastTimestamp = message.timestamp;
      continue;
    }
    rows.push(message.groupable && message.workItemId && message.actorId
      ? { kind: "activity-group", actorId: message.actorId, actor: message.actor,
        workItemId: message.workItemId, workItemTitle: message.workItemTitle,
        dayKey: message.dayKey, dayLabel: message.dayLabel, firstSequence: message.sequence,
        lastTimestamp: message.timestamp, messages: [message] }
      : { kind: "timeline-entry", message });
  }
  return rows.flatMap((row) => {
    if (row.kind === "activity-group" && row.messages.length < 3) {
      return row.messages.map((message) => ({ kind: "timeline-entry", message }));
    }
    if (row.kind === "mission-state-group" && row.messages.length < 3) {
      return row.messages.map((message) => ({ kind: "timeline-entry", message }));
    }
    return [row];
  });
}

export function filterTimelineMessages(messages, { agentId = "", workItemId = "", query = "" } = {}) {
  const normalized = query.toLowerCase();
  return messages.filter((message) =>
    (!normalized || `${message.actor} ${message.text}`.toLowerCase().includes(normalized))
    && (!workItemId || !message.workItemId || message.workItemId === workItemId)
    && (!agentId || message.actorId === agentId || message.recipientId === agentId));
}

export function mapInteraction(item) {
  return { id: item.id, type: item.interaction_type, title: item.title,
    target: item.target, reason: item.details, detail: item.details, agent: item.requested_by,
    missionId: item.mission_id, missionTitle: item.mission_title,
    missionGoal: item.mission_goal, missionStatus: item.mission_status,
    projectId: item.project_id, projectName: item.project_name };
}

export function mapWorkItem(item) {
  const status = item.status === "blocked" ? "Blocked" : item.status === "claimed" ? "In progress" : item.status === "review" ? "In review" : item.status === "done" ? "Done" : "Ready";
  return { id: item.id.slice(0, 8), workItemId: item.id, title: item.title, detail: item.detail,
    status, owner: item.owner ?? "Unclaimed", tag: "mission", dependsOn: item.depends_on ?? [], blockedBy: item.blocked_by ?? [], dependencies: item.dependencies ?? [] };
}

export function updateWorkItems(current, item) {
  const next = current.some((existing) => existing.workItemId === item.workItemId)
    ? current.map((existing) => existing.workItemId === item.workItemId ? item : existing)
    : [...current, item];
  return next.map((work) => {
    const blockedBy = work.dependsOn.filter((dependencyId) =>
      next.find((candidate) => candidate.workItemId === dependencyId)?.status !== "Done");
    return { ...work, blockedBy, status: work.status === "Blocked" && blockedBy.length === 0 ? "Ready" : work.status };
  });
}

export function mapArtifact(item) {
  return { id: item.id, missionId: item.mission_id, missionTitle: item.mission_title,
    name: item.name, type: item.media_type,
    size: "Local file", owner: item.created_by === "user" ? "You" : item.created_by,
    time: formatTime(item.created_at), icon: item.media_type.includes("text") ? "document" : "code" };
}

export function mapTestRun(event) {
  const result = event.payload;
  const completed = event.type === "repo.test_run.completed";
  const status = !completed ? "Running" : result.cancelled ? "Stopped" : result.timedOut ? "Timed out" : result.exitCode === 0 ? "Passed" : "Failed";
  return {
    id: result.runId ?? event.id,
    name: (result.argv ?? []).join(" "),
    status,
    actor: event.actorId,
    exitCode: result.exitCode,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  };
}

