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

function userFacingAgentText(value) {
  return String(value ?? "")
    .replace(/(?<![A-Za-z0-9_-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|call_[A-Za-z0-9_-]{12,})(?![A-Za-z0-9_-])/gi, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/(`)\s*\1|(``)\s*\2|(```)\s*\3/g, "")
    .replace(/\s+\)/g, ")")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function timelineMessage(event, agentDefinitions = initialAgents) {
  const isScheduled = event.type === "message.created" && event.payload.source === "schedule";
  const actorType = event.actorId === "user" || isScheduled ? "human" : "agent";
  const actor = isScheduled ? "Scheduled task" : actorType === "human"
    ? "You"
    : agentDefinitions.find((agent) => agent.id === event.actorId)?.name ?? event.actorId;
  if (event.type === "message.created" || event.type === "agent.message.created") {
    const recipientId = event.payload.recipient;
    const recipient = recipientId
      ? agentDefinitions.find((agent) => agent.id === recipientId || agent.role === recipientId)?.name ?? recipientId
      : null;
    return { id: event.id, kind: "message", actor, actorId: event.actorId, actorType, isScheduled, recipient, recipientId,
      channelAudience: event.payload.channelAudience,
      researchMode: event.payload.researchMode ?? null,
      workItemId: event.payload.workItemId, triggerSequence: event.payload.triggerSequence,
      toolCallId: event.payload.toolCallId,
      durationMs: event.payload.durationMs,
      inputTokens: event.payload.inputTokens,
      outputTokens: event.payload.outputTokens,
      canvasDocument: event.payload.canvasDocument ?? null,
      attachments: event.payload.attachments ?? [],
      interactiveArtifactIds: event.payload.interactiveArtifactIds ?? [],
      imageArtifactIds: event.payload.imageArtifactIds ?? [],
      time: formatTime(event.createdAt), text: actorType === "agent"
        ? userFacingAgentText(event.payload.text) || "Update available."
        : event.payload.text };
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
    if (item.access_grant?.capability === "public_web_read") {
      const scope = { chat: "this chat", project: "this project", workspace: "the workspace" }[item.access_grant.scope];
      return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
        text: `You allowed read-only public web access for ${scope} · ${item.title}` };
    }
    const resolution = { "Approved once": "approved this action once", Denied: "declined this action" }[item.resolution] ?? item.resolution.toLowerCase();
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt), text: `You ${resolution} · ${item.title}` };
  }
  if (event.type.startsWith("plan.item.")) {
    const item = event.payload.workItem;
    const action = event.type.endsWith("claimed") ? "started" : event.type.endsWith("completed") ? "completed" : event.type.endsWith("updated") ? "updated" : event.type.endsWith("released") ? "released" : "added";
    return { id: event.id, kind: "change", actor, actorId: event.actorId, groupable: true,
      workItemId: item.id, workItemTitle: item.title,
      researchMode: /research context:\s*deep research investigation/i.test(item.detail ?? "") ? "deep_research" : null,
      time: formatTime(event.createdAt), text: `${actor} ${action} task` };
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
    const maxAttempts = Number.isInteger(event.payload.maxAttempts) ? event.payload.maxAttempts : null;
    const delay = Number.isFinite(Number(event.payload.retryDelaySeconds))
      ? Math.max(1, Math.ceil(Number(event.payload.retryDelaySeconds))) : 1;
    const delayLabel = delay >= 60 ? `${Math.ceil(delay / 60)}m` : `${delay}s`;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt),
      text: `${actor} will retry after a temporary model issue · attempt ${attempt}${maxAttempts ? ` of ${maxAttempts}` : ""} in ${delayLabel}` };
  }
  if (event.type === "agent.run.failed") {
    const error = String(event.payload.error ?? "");
    const providerPolicyRefusal = /prompt was flagged|usage policy|potentially violating|content filter|safety policy/i.test(error);
    const failureKind = String(event.payload.failureKind ?? (providerPolicyRefusal ? "policy_denial" : "unknown"));
    const tokenLimitMatch = error.match(/(?:input|total)_tokens_limit\s+(?:of\s+)?([\d,]+)/i);
    const runTokenLimit = tokenLimitMatch ? Number(tokenLimitMatch[1].replaceAll(",", "")) : null;
    const failureText = {
      transient_provider: `${actor} couldn’t reach the model after retries`,
      invalid_request: `${actor} sent a request the model could not accept`,
      usage_limit: `${actor} reached a usage limit`,
      tool_failure: `${actor} hit a tool error`,
      policy_denial: providerPolicyRefusal
        ? `${actor}'s model refused this request under its usage policy`
        : `${actor} was blocked by a permission or policy check`,
      unknown_side_effect: `${actor} stopped with a tool effect that needs review`,
    };
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      time: formatTime(event.createdAt),
      text: runTokenLimit ? `${actor} reached the ${new Intl.NumberFormat().format(runTokenLimit)}-token run limit`
        : failureText[failureKind] ?? `${actor} couldn’t finish this response`,
      detail: event.payload.error, failureKind, runTokenLimit,
      canContinue: failureKind !== "policy_denial",
      recoveryGuidance: failureKind === "policy_denial"
        ? "Review the request wording and send a revised prompt to continue."
        : null };
  }
  if (event.type === "agent.run.interrupted") {
    const failureKind = String(event.payload.failureKind ?? "unknown");
    const text = event.payload.cancelledByUser
      ? `You stopped ${actor} · review recent changes before continuing`
      : failureKind === "unknown_side_effect"
        ? `${actor} stopped during an action · review its outcome before continuing`
        : `${actor} stopped unexpectedly · review recent changes before continuing`;
    return { id: event.id, kind: "change", actor, actorId: event.actorId, time: formatTime(event.createdAt), text, detail: event.payload.error, failureKind, canContinue: true };
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
      read_repository_file: { working: "Reading project file", finished: "Read project file" },
      search_repository: { working: "Searching project files", finished: "Searched project files" },
      record_review_checkpoint: { working: "Reviewing changes", finished: "Recorded review" },
      claim_work: { working: "Taking on a task", finished: "Took on a task" },
      complete_work: { working: "Finishing a task", finished: "Completed a task" },
      release_work_claim: { working: "Releasing a task", finished: "Released a task" },
      list_plan_items: { working: "Checking the task plan", finished: "Checked the task plan" },
      message_agent: { working: "Messaging a teammate", finished: "Messaged a teammate" },
      reply_to_agent: { working: "Replying to a teammate", finished: "Replied to a teammate" },
      post_update: { working: "Sharing a progress update", finished: "Shared a progress update" },
      analyze_tabular_artifact: { working: "Profiling attached data", finished: "Profiled attached data" },
      aggregate_tabular_artifact: { working: "Summarising attached data", finished: "Summarised attached data" },
      extract_pdf_pages: { working: "Reading PDF pages", finished: "Read PDF pages" },
      extract_pdf_tables: { working: "Extracting PDF tables", finished: "Extracted PDF tables" },
    };
    const genericTool = String(tool ?? "tool").replaceAll("_", " ");
    const normalizedTool = String(tool ?? "").toLowerCase().replaceAll(".", "_");
    const knownLabels = actionLabels[tool]
      ?? Object.entries(actionLabels).find(([name]) => normalizedTool.endsWith(name))?.[1];
    const labels = knownLabels ?? event.payload.activityLabels
      ?? { working: `Using ${genericTool}`, finished: `Finished ${genericTool}` };
    const toolState = event.type === "agent.tool.started" ? "working"
      : event.type === "agent.tool.waiting_for_user" ? "waiting"
        : event.type === "agent.tool.interrupted" ? "unknown"
          : event.payload.outcome === "denied" ? "denied" : "finished";
    const activityTitle = toolState === "unknown" ? `Interrupted · ${labels.working}`
      : toolState === "waiting" ? `Waiting for approval · ${labels.working}`
        : toolState === "denied" ? `Declined · ${labels.working}` : labels[toolState];
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
      activityTitle: activityTitle.replace(/^./, (first) => first.toLocaleUpperCase()),
      activityDetail: userFacingAgentText(event.payload.summary),
      time: formatTime(event.createdAt), text };
  }
  if (event.type === "agent.activity") {
    const status = String(event.payload.status ?? "");
    const text = {
      "Retry scheduled": `${actor} will retry · ${event.payload.detail ?? "temporary model issue"}`,
      "Waiting for budget": `${actor} is waiting for the usage budget`,
      "Waiting for you": `${actor} is waiting for your response`,
      "Needs attention": `${actor} needs attention`,
      Paused: `${actor} paused`,
    }[status];
    if (!text) return null;
    return { id: event.id, kind: "change", actor, actorId: event.actorId,
      triggerSequence: event.payload.triggerSequence ?? null, time: formatTime(event.createdAt), text };
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
  if (event.type === "mission.workflow.selected") {
    const workflow = event.payload?.workflow;
    return { id: event.id, kind: "change", actor, time: formatTime(event.createdAt),
      text: `Workflow selected · ${workflow?.title ?? workflow?.id ?? "Workflow"}` };
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
    return { id: event.id, kind: "message", actor, actorId: event.actorId, actorType: "agent",
      channelAudience: "conversation", finalSummary: true, time: formatTime(event.createdAt),
      text: userFacingAgentText(event.payload.summary) || "The work is complete." };
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
    triggerSequence: message.triggerSequence ?? event.payload?.triggerSequence ?? null,
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

const ACTIONABLE_CHANNEL_EVENTS = new Set([
  "agent.run.failed",
  "agent.run.interrupted",
]);

export function filterConversationMessages(messages, triggerContext = messages) {
  const userTriggerSequences = new Set(triggerContext
    .filter((message) => message.actorType === "human" || message.actorId === "user")
    .map((message) => message.sequence)
    .filter(Number.isInteger));
  return messages.filter((message) => {
    if (message.kind === "message") {
      if (message.actorType === "human") return true;
      if (message.finalSummary) return !messages.some((entry) =>
        entry.kind === "message" && entry.actorType === "agent" && !entry.finalSummary
        && entry.actorId === message.actorId && entry.sequence > message.sequence
        && entry.channelAudience === "conversation" && !entry.recipientId && !entry.toolCallId);
      // New events declare their audience. Legacy events are accepted only when
      // their run was triggered by a user-authored event in this history page.
      if (message.channelAudience) return message.channelAudience === "conversation";
      if (message.recipientId || message.toolCallId
          || !userTriggerSequences.has(message.triggerSequence)) return false;
      return true;
    }
    return message.eventType === "interactive_artifact.action.created"
      || ACTIONABLE_CHANNEL_EVENTS.has(message.eventType);
  });
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
    // Pair only lifecycle updates. A DM may share the tool call ID that sent
    // it; merging that message into the tool row would discard its content.
    const pairedIndex = message.kind === "change" && message.toolState && message.toolCallId
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
  const lastMessageByRun = new Map();
  for (const event of events) {
    const key = runKey(event);
    if (!key) continue;
    if ((event.type === "message.created" || event.type === "agent.message.created")
      && event.actorId !== "user") {
      lastMessageByRun.set(key, event.id);
    }
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
      const key = `${event.actorId}:${entry.triggerSequence}`;
      entry.showRunMetrics = lastMessageByRun.get(key) === event.id;
      if (entry.showRunMetrics) {
        const metrics = runMetrics.get(key) ?? {};
        entry.inputTokens ??= metrics.inputTokens;
        entry.outputTokens ??= metrics.outputTokens;
        if (!Number.isFinite(entry.durationMs) && Number.isFinite(metrics.startedAt) && Number.isFinite(metrics.finishedAt)) {
          entry.durationMs = Math.max(0, metrics.finishedAt - metrics.startedAt);
        }
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
      agent.status = payload.status === "Retry scheduled" ? "Retrying" : payload.status;
      agent.next = payload.status === "Working" ? "Working on this chat"
        : payload.status === "Waiting for budget" ? "Monthly usage limit reached. Review the limit in Settings."
          : payload.status === "Retry scheduled" ? payload.detail ?? "Waiting to retry a temporary model issue"
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

export function deduplicateAgentActivityMessages(entries) {
  const messageCalls = new Set(entries
    .filter((entry) => entry.kind === "message" && entry.toolCallId)
    .map((entry) => entry.toolCallId));
  const directMessagesByTurn = new Set(entries
    .filter((entry) => entry.kind === "message" && entry.recipientId && Number.isInteger(entry.triggerSequence))
    .map((entry) => `${entry.actorId}:${entry.triggerSequence}`));
  return entries.filter((entry) => {
    if (!entry.eventType?.startsWith("agent.tool.") || !/messag|repl/i.test(entry.activityTitle ?? "")) return true;
    // A direct message is the meaningful result of these tools. Their
    // lifecycle row repeats that result, especially when legacy events did
    // not persist the same toolCallId on both records.
    const sameTurnHasMessage = Number.isInteger(entry.triggerSequence)
      && directMessagesByTurn.has(`${entry.actorId}:${entry.triggerSequence}`);
    return !messageCalls.has(entry.toolCallId) && !sameTurnHasMessage;
  });
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
  const toolName = item.tool_name ?? item.toolName;
  const publicWebRead = ["duckduckgo_search", "web_fetch"].includes(toolName);
  return { id: item.id, type: item.interaction_type, title: item.title,
    target: item.target,
    reason: publicWebRead
      ? "Read-only public web request. Ongoing access still follows this project’s website settings and the selected role’s permissions."
      : item.details,
    detail: item.details, agent: item.requested_by,
    missionId: item.mission_id, missionTitle: item.mission_title,
    missionGoal: item.mission_goal, missionStatus: item.mission_status, toolName,
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

export function mapTestRuns(events) {
  const runsById = new Map();
  for (const event of events) {
    if (event.type !== "repo.test_run.started" && event.type !== "repo.test_run.completed") continue;
    const run = mapTestRun(event);
    const previous = runsById.get(run.id);
    if (!previous || previous.status === "Running" || run.status !== "Running") runsById.set(run.id, run);
  }
  return [...runsById.values()].reverse();
}

