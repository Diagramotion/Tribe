import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateAgentActivityMessages, filterConversationMessages, filterTimelineMessages, groupActivityMessages, mapTestRun, mapTestRuns, mergeTimelineMessages, restoreAgentActivity, timelineEntries, timelineEntry, timelineMessage } from "../src/domain/activity.js";

function event(sequence, type, payload, actorId = "builder") {
  return {
    id: `event-${sequence}`,
    sequence,
    missionId: "mission-1",
    type,
    actorId,
    payload,
    createdAt: `2026-10-25T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

test("agent chat copy hides internal run and tool identifiers", () => {
  const message = timelineMessage(event(1, "agent.message.created", {
    text: "The tests pass (run `7a8d9474-e130-42fe-afdd-9914ee3789a4`) after call_abcdefghijklmnop.",
  }), []);
  assert.equal(message.text, "The tests pass (run) after.");
  assert.doesNotMatch(message.text, /7a8d9474|call_abcdefghijklmnop/);
});

test("shared chat keeps user posts and final agent replies out of the execution trace", () => {
  const human = timelineEntry(event(1, "message.created", { text: "Please add CSV export." }, "user"));
  const finalReply = timelineEntry(event(2, "agent.message.created", {
    text: "CSV export is ready.", triggerSequence: 1, channelAudience: "conversation",
  }));
  const teammateDm = timelineEntry(event(3, "agent.message.created", {
    text: "Please review the parser.", recipient: "reviewer", toolCallId: "call_123456789012",
    channelAudience: "conversation",
  }));
  const activityDm = timelineEntry(event(9, "agent.message.created", {
    text: "Internal coordination detail.", recipient: "reviewer", channelAudience: "activity",
  }));
  const progressPost = timelineEntry(event(4, "agent.message.created", {
    text: "I am checking the parser.", toolCallId: "call_abcdefghijklmnop",
  }));
  const unclassifiedLegacyPost = timelineEntry(event(7, "agent.message.created", {
    text: "I am still checking the parser.",
  }));
  const agentTriggeredReply = timelineEntry(event(8, "agent.message.created", {
    text: "I found the parser issue.", triggerSequence: 3,
  }));
  const testEvent = timelineEntry(event(5, "repo.test_run.completed", { argv: ["npm", "test"], exitCode: 0 }));
  const failedRun = timelineEntry(event(6, "agent.run.failed", { error: "Provider unavailable" }));

  assert.deepEqual(filterConversationMessages([
    human, finalReply, teammateDm, activityDm, progressPost, testEvent, failedRun,
    unclassifiedLegacyPost, agentTriggeredReply,
  ]).map((message) => message.id), [human.id, finalReply.id, teammateDm.id, failedRun.id]);
  assert.equal(timelineEntry(event(3, "agent.message.created", {
    text: "Please review the parser.", recipient: "reviewer", toolCallId: "call_123456789012",
    triggerSequence: 1,
  })).triggerSequence, 1);
});

test("scheduled prompts appear as scheduled tasks in the shared chat", () => {
  const message = timelineMessage(event(1, "message.created", {
    text: "Review recent changes", source: "schedule", scheduleId: "schedule-1",
  }, "scheduler"));
  assert.equal(message.actor, "Scheduled task");
  assert.equal(message.actorType, "human");
  assert.equal(message.isScheduled, true);
});

test("mission completion appears as a final chat reply instead of a status card", () => {
  const checks = [{
    criterion: "The export is downloadable",
    planItems: [{ id: "task-1", title: "Create the export" }],
    evidence: [{ id: "artifact-1", type: "artifact", label: "export.md", actor: "reviewer" }],
  }];
  const message = timelineMessage(event(1, "mission.completed", {
    summary: "Export is ready",
    acceptanceEvidence: [checks[0].criterion],
    acceptanceChecks: checks,
    evidenceRefs: checks[0].evidence,
  }, "reviewer"), []);

  assert.equal(message.kind, "message");
  assert.equal(message.finalSummary, true);
  assert.equal(message.actorType, "agent");
  assert.equal(message.text, "Export is ready");
  assert.deepEqual(filterConversationMessages([message]), [message]);

  const human = timelineEntry(event(1, "message.created", { text: "Add export support." }, "user"));
  const completion = timelineEntry(event(3, "mission.completed", { summary: "Export support is ready." }, "planner"));
  const response = timelineEntry(event(4, "agent.message.created", {
    text: "Export support is ready.", triggerSequence: 1, channelAudience: "conversation",
  }, "planner"));
  assert.deepEqual(filterConversationMessages([human, completion, response]), [human, response]);
  assert.deepEqual(filterConversationMessages([human, completion]), [human, completion]);

  const planActivity = timelineEntry(event(2, "plan.item.created", {
    workItem: { id: "task-1", title: "Implement export" },
  }, "planner"));
  const intakeAck = timelineEntry(event(3, "agent.message.created", {
    text: "I created a plan for this work.", triggerSequence: 1, channelAudience: "conversation",
  }, "planner"));
  const taskReply = timelineEntry(event(4, "agent.message.created", {
    text: "Export support is implemented.", triggerSequence: 2, channelAudience: "conversation",
  }, "builder"));
  const taskCompletion = timelineEntry(event(5, "mission.completed", { summary: "Export support is ready." }, "planner"));
  assert.deepEqual(filterConversationMessages([human, planActivity, intakeAck, taskReply, taskCompletion]),
    [human, intakeAck, taskReply, taskCompletion]);
});

test("review checkpoints show outcome and findings in mission activity", () => {
  const message = timelineMessage(event(2, "review.checkpoint.recorded", {
    disposition: "changes_requested",
    summary: "The retry path still loses the original error.",
    verificationEventId: "test-event-4",
    findings: [{ severity: "high", file: "src/retry.py", issue: "Preserve the first failure before retrying." }],
  }, "reviewer"), []);

  assert.equal(message.text, "Review requested changes · The retry path still loses the original error.");
  assert.equal(message.reviewFindings[0].file, "src/retry.py");
  assert.equal(message.verificationEventId, "test-event-4");
});

test("finalised plan checkpoint is visible in mission activity", () => {
  const message = timelineMessage(event(3, "plan.finalized", {
    acceptanceCriteria: [
      { criterion: "Feature works", workItems: [{ id: "task-1", title: "Implement the feature" }] },
      { criterion: "Checks pass", workItems: [{ id: "task-2", title: "Run the checks" }] },
    ],
  }, "planner"), []);

  assert.equal(message.text, "planner finalised the plan · 2 acceptance criteria");
  assert.equal(message.planCriteria[0].workItems[0].title, "Implement the feature");
});

test("verification runs appear in mission activity and expose phase evidence", () => {
  const started = event(4, "repo.test_run.started", { argv: ["pytest", "tests/"], runId: "run-4" });
  const completed = event(5, "repo.test_run.completed", { argv: ["pytest", "tests/"], exitCode: 0 });

  assert.equal(timelineMessage(started).text, "Verification started · pytest tests/");
  const entry = timelineEntry(completed);
  assert.equal(entry.text, "Verification passed · pytest tests/");
  assert.equal(entry.eventType, "repo.test_run.completed");
  assert.equal(entry.testSucceeded, true);
});

test("provider retry status is readable in mission activity", () => {
  const message = timelineMessage(event(3, "agent.run.retrying", {
    attempt: 2,
    maxAttempts: 3,
    retryDelaySeconds: 2.2,
  }));

  assert.equal(message.text, "Builder will retry after a temporary model issue · attempt 2 of 3 in 3s");
  assert.equal(message.actorId, "builder");

  const scheduled = timelineMessage(event(4, "agent.run.retrying", {
    attempt: 4,
    maxAttempts: 24,
    retryDelaySeconds: 120,
  }));
  assert.equal(scheduled.text, "Builder will retry after a temporary model issue · attempt 4 of 24 in 2m");

  const [builder] = restoreAgentActivity([{ id: "builder", status: "Ready" }], [
    event(5, "agent.activity", {
      status: "Retry scheduled", detail: "Temporary provider issue. Tribe will retry automatically.",
    }, "builder"),
  ]);
  assert.equal(builder.status, "Retrying");
  assert.equal(builder.next, "Temporary provider issue. Tribe will retry automatically.");
});

test("agent lanes restore in-progress work from the loaded mission events", () => {
  const agents = [{ id: "planner", status: "Ready", activity: "Planning", next: "Ready" }];
  const restored = restoreAgentActivity(agents, [
    event(1, "agent.activity", { status: "Working" }, "planner"),
    event(2, "agent.tool.started", {
      toolName: "read_repository_file", summary: "README.md",
    }, "planner"),
  ]);

  assert.equal(restored[0].status, "Working");
  assert.equal(restored[0].activity, "read repository file · README.md");
  assert.equal(restored[0].next, "Using read repository file");
});

test("failed agent activity uses product language and keeps diagnostics expandable", () => {
  const [message] = timelineEntries([
    event(3, "agent.run.failed", { error: "input token limit exceeded" }, "planner"),
  ]);

  assert.equal(message.text, "Planner couldn’t finish this response");
  assert.equal(message.detail, "input token limit exceeded");
  assert.equal(message.canContinue, true);
});

test("failed agent activity explains the durable recovery category", () => {
  const cases = [
    ["transient_provider", "Builder couldn’t reach the model after retries"],
    ["invalid_request", "Builder sent a request the model could not accept"],
    ["usage_limit", "Builder reached a usage limit"],
    ["tool_failure", "Builder hit a tool error"],
    ["policy_denial", "Builder was blocked by a permission or policy check"],
    ["unknown_side_effect", "Builder stopped with a tool effect that needs review"],
  ];
  for (const [failureKind, expected] of cases) {
    const message = timelineMessage(event(3, "agent.run.failed", { failureKind }, "builder"));
    assert.equal(message.failureKind, failureKind);
    assert.equal(message.text, expected);
  }
});

test("provider policy refusals are clear and do not offer a futile agent recovery action", () => {
  const [message] = timelineEntries([
    event(4, "agent.run.failed", {
      error: "Invalid prompt: prompt was flagged as potentially violating our usage policy",
    }, "planner"),
  ]);

  assert.equal(message.failureKind, "policy_denial");
  assert.equal(message.text, "Planner's model refused this request under its usage policy");
  assert.equal(message.canContinue, false);
  assert.equal(message.recoveryGuidance, "Review the request wording and send a revised prompt to continue.");
});

test("mission activity distinguishes a user stop from an unexpected interruption", () => {
  const [stopped] = timelineEntries([
    event(20, "agent.run.interrupted", { cancelledByUser: true, error: "Stopped by you" }, "builder"),
  ]);
  const [interrupted] = timelineEntries([
    event(21, "agent.run.interrupted", { cancelledByUser: false, error: "Runtime exited", failureKind: "unknown" }, "builder"),
  ]);
  const [unknownEffect] = timelineEntries([
    event(22, "agent.run.interrupted", { cancelledByUser: false, error: "Tool stopped", failureKind: "unknown_side_effect" }, "builder"),
  ]);

  assert.match(stopped.text, /You stopped Builder/);
  assert.doesNotMatch(stopped.text, /unexpectedly/);
  assert.match(interrupted.text, /Builder stopped unexpectedly/);
  assert.match(unknownEffect.text, /stopped during an action/);
  assert.equal(unknownEffect.failureKind, "unknown_side_effect");
});

test("agent test runs distinguish cancellation and timeout from failures", () => {
  const cancelled = mapTestRun(event(4, "repo.test_run.completed", {
    argv: ["pytest", "-q"], exitCode: 130, cancelled: true,
  }));
  const timedOut = mapTestRun(event(5, "repo.test_run.completed", {
    argv: ["npm", "test"], exitCode: 124, timedOut: true,
  }));

  assert.equal(cancelled.status, "Stopped");
  assert.equal(timedOut.status, "Timed out");
});

test("loaded test history merges start and completion events for one run", () => {
  const started = event(1, "repo.test_run.started", { runId: "run-1", argv: ["pnpm", "test"] });
  const completed = event(2, "repo.test_run.completed", {
    runId: "run-1", argv: ["pnpm", "test"], exitCode: 1, stdout: "", stderr: "No package.json",
  });

  assert.deepEqual(mapTestRuns([started, completed]), [{
    id: "run-1", name: "pnpm test", status: "Failed", actor: "builder", exitCode: 1,
    output: "No package.json",
  }]);
});

test("live tool start and finish update one timeline row in completion order", () => {
  const messages = timelineEntries([
    event(5, "agent.tool.started", {
      toolCallId: "call-1", toolName: "write_file", summary: "src/app.py", workItemId: "work-1",
    }),
    event(6, "message.created", { text: "Keep the public API stable." }, "user"),
    event(7, "agent.tool.completed", {
      toolCallId: "call-1", toolName: "write_file", summary: "src/app.py", workItemId: "work-1",
    }),
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "Keep the public API stable.");
  assert.equal(messages[0].actor, "You");
  assert.match(messages[1].text, /wrote a file/);
  assert.equal(messages[1].toolState, "finished");
  assert.equal(messages[1].sequence, 7);
});

test("agent activity keeps a direct message and removes its duplicate messaging tool row", () => {
  const entries = timelineEntries([
    event(5, "agent.tool.started", {
      toolCallId: "tool-start", toolName: "message_agent", triggerSequence: 2,
    }, "planner"),
    event(6, "agent.message.created", {
      text: "Can you implement the settings view?", recipient: "builder", triggerSequence: 2,
      toolCallId: "message-event-call",
    }, "planner"),
    event(7, "agent.tool.completed", {
      toolCallId: "tool-finish", toolName: "message_agent", triggerSequence: 2,
    }, "planner"),
  ]);

  const visible = deduplicateAgentActivityMessages(entries);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].recipient, "Builder");
  assert.equal(visible[0].text, "Can you implement the settings view?");
});

test("an unfinished or unsuccessful teammate message stays visible until the DM exists", () => {
  const entries = timelineEntries([
    event(8, "agent.tool.started", {
      toolCallId: "tool-pending", toolName: "message_agent", triggerSequence: 3,
    }, "planner"),
  ]);

  assert.deepEqual(deduplicateAgentActivityMessages(entries), entries);
});

test("activity loaded across history pages merges into the original tool row", () => {
  const started = event(12, "agent.tool.started", { toolCallId: "call-2", toolName: "run_command" });
  const finished = event(18, "agent.tool.completed", { toolCallId: "call-2", toolName: "run_command" });
  const latestPage = timelineEntries([finished]);
  const merged = mergeTimelineMessages(latestPage, timelineEntries([started]));

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "event-12");
  assert.equal(merged[0].sequence, 18);
  assert.equal(merged[0].toolState, "finished");
});

test("an unfinished tool call remains visible as in progress", () => {
  const [message] = timelineEntries([
    event(3, "agent.tool.started", { toolCallId: "call-3", toolName: "edit_file" }),
  ]);

  assert.equal(message.toolState, "working");
  assert.match(message.text, /editing a file/);
});

test("approval pauses update the same tool activity row and resume on completion", () => {
  const toolCallId = "call-needs-approval";
  const started = event(30, "agent.tool.started", {
    toolCallId, toolName: "run_command", summary: "pytest tests",
  });
  const waiting = event(31, "agent.tool.waiting_for_user", {
    toolCallId, toolName: "run_command", summary: "pytest tests",
  });
  const completed = event(35, "agent.tool.completed", {
    toolCallId, toolName: "run_command", summary: "pytest tests",
  });
  const pending = timelineEntries([started, waiting]);
  const resumed = mergeTimelineMessages(pending, timelineEntries([completed]));

  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolState, "waiting");
  assert.match(pending[0].text, /waiting for your approval · running a command · pytest tests/);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].toolState, "finished");
  assert.match(resumed[0].text, /ran a command/);
});

test("declined tool approvals do not appear as successful actions", () => {
  const toolCallId = "call-declined";
  const messages = timelineEntries([
    event(40, "agent.tool.started", {
      toolCallId, toolName: "run_command", summary: "rm temp.txt",
    }),
    event(41, "agent.tool.waiting_for_user", {
      toolCallId, toolName: "run_command", summary: "rm temp.txt",
    }),
    event(43, "agent.tool.completed", {
      toolCallId, toolName: "run_command", summary: "rm temp.txt", outcome: "denied",
    }),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].toolState, "denied");
  assert.match(messages[0].text, /did not run this action · rm temp\.txt · approval declined/);
  assert.doesNotMatch(messages[0].text, /ran a command/);
});

test("interrupted tool calls replace the in-progress row with an unknown outcome", () => {
  const messages = timelineEntries([
    event(3, "agent.tool.started", {
      toolCallId: "call-unknown", toolName: "edit_file", summary: "src/app.py",
      activityLabels: { working: "editing a file", finished: "edited a file" },
    }),
    event(4, "agent.tool.interrupted", {
      toolCallId: "call-unknown", toolName: "edit_file", summary: "src/app.py",
      activityLabels: { working: "editing a file", finished: "edited a file" },
      outcome: "unknown",
    }),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].toolState, "unknown");
  assert.match(messages[0].text, /interrupted while editing a file/);
  assert.match(messages[0].text, /outcome unknown/);
});

test("browser actions appear as concise, task-linked mission activity", () => {
  const messages = timelineEntries([
    event(20, "agent.tool.started", {
      toolCallId: "browser-1", toolName: "playwright_browser_navigate", summary: "example.com",
      activityLabels: { working: "opening a page", finished: "opened a page" }, workItemId: "work-3",
    }),
    event(21, "agent.tool.completed", {
      toolCallId: "browser-1", toolName: "playwright_browser_navigate", summary: "example.com",
      activityLabels: { working: "opening a page", finished: "opened a page" }, workItemId: "work-3",
    }),
  ]);

  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Builder opened a page · example\.com/);
  assert.equal(messages[0].workItemId, "work-3");
  assert.equal(messages[0].toolState, "finished");
});

test("artifact review comments link mission activity back to the reviewed artifact", () => {
  const [message] = timelineEntries([event(4, "artifact.review.comment.created", {
    artifactId: "artifact-1", threadId: "thread-1", comment: { body: "Please label this diagram" },
  }, "reviewer")]);

  assert.equal(message.actor, "Reviewer");
  assert.match(message.text, /Please label this diagram/);
  assert.equal(message.artifactId, "artifact-1");
  assert.equal(message.threadId, "thread-1");
});

test("reopening an artifact review thread creates navigable mission activity", () => {
  const [message] = timelineEntries([event(5, "artifact.review.thread.reopened", {
    artifactId: "artifact-1", threadId: "thread-1",
  }, "user")]);

  assert.match(message.text, /You reopened an artifact review thread/);
  assert.equal(message.artifactId, "artifact-1");
  assert.equal(message.threadId, "thread-1");
});

test("document discussion messages retain their revision and selected passage", () => {
  const [message] = timelineEntries([event(8, "message.created", {
    text: "Please clarify this paragraph.",
    canvasDocument: {
      artifactId: "document-1", revision: 3, title: "Architecture notes",
      selectedText: "The event stream is authoritative.",
    },
  }, "user")]);

  assert.equal(message.canvasDocument.artifactId, "document-1");
  assert.equal(message.canvasDocument.revision, 3);
  assert.equal(message.canvasDocument.selectedText, "The event stream is authoritative.");
});

test("linking a project document to a mission creates a navigable channel event", () => {
  const [message] = timelineEntries([event(9, "canvas.document.linked", {
    artifactId: "document-2", title: "Release plan", revision: 5,
  }, "user")]);

  assert.match(message.text, /Release plan/);
  assert.equal(message.canvasDocument.artifactId, "document-2");
  assert.equal(message.canvasDocument.revision, 5);
});

test("consecutive updates from one agent collapse under their claimed task", () => {
  const events = [
    { ...event(10, "plan.item.claimed", { workItem: { id: "work-1", title: "Implement API" } }),
      createdAt: "2026-10-25T10:00:00.000Z" },
    { ...event(11, "agent.tool.started", { toolCallId: "call-1", toolName: "write_file", workItemId: "work-1" }),
      createdAt: "2026-10-25T10:00:20.000Z" },
    { ...event(12, "agent.tool.completed", { toolCallId: "call-1", toolName: "write_file", workItemId: "work-1" }),
      createdAt: "2026-10-25T10:00:30.000Z" },
    { ...event(13, "repo.file.changed", { path: "src/api.py", workItemId: "work-1" }),
      createdAt: "2026-10-25T10:00:40.000Z" },
    { ...event(14, "message.created", { text: "Keep the response shape stable." }, "user"),
      createdAt: "2026-10-25T10:00:45.000Z" },
  ];
  const messages = timelineEntries(events).map((message) => ({ ...message, workItemTitle: "Implement API" }));
  const rows = groupActivityMessages(messages);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "activity-group");
  assert.equal(rows[0].actor, "Builder");
  assert.equal(rows[0].workItemTitle, "Implement API");
  assert.equal(rows[0].messages.length, 3);
  assert.equal(rows[1].kind, "timeline-entry");
  assert.equal(rows[1].message.actor, "You");
});

test("agent run metadata appears only on the last message from that run", () => {
  const entries = timelineEntries([
    event(1, "agent.activity", { status: "Working", triggerSequence: 40 }, "planner"),
    event(2, "agent.message.created", {
      text: "I am assigning the implementation work.", recipient: "builder", triggerSequence: 40,
    }, "planner"),
    event(3, "agent.message.created", {
      text: "The plan is ready.", triggerSequence: 40,
    }, "planner"),
    event(4, "agent.usage.recorded", {
      triggerSequence: 40, input_tokens: 12_000, output_tokens: 300,
    }, "planner"),
    event(5, "agent.activity", { status: "Ready", triggerSequence: 40 }, "planner"),
  ]).filter((entry) => entry.kind === "message");

  assert.equal(entries[0].showRunMetrics, false);
  assert.equal(entries[0].inputTokens, undefined);
  assert.equal(entries[1].showRunMetrics, true);
  assert.equal(entries[1].inputTokens, 12_000);
  assert.equal(entries[1].outputTokens, 300);
});

test("plan activity keeps the task title separate from the action copy", () => {
  const [entry] = timelineEntries([
    event(6, "plan.item.created", {
      workItem: { id: "work-3", title: "Implement the shopping list" },
    }, "planner"),
  ]);

  assert.equal(entry.text, "Planner added task");
  assert.equal(entry.workItemTitle, "Implement the shopping list");
});

test("a released work claim is shown as a release, not a new task", () => {
  const [message] = timelineEntries([
    event(20, "plan.item.released", {
      workItem: { id: "work-2", title: "Independent review" },
      reason: "This task belongs to the reviewer",
    }, "builder"),
  ]);

  assert.equal(message.text, "Builder released task");
  assert.equal(message.workItemTitle, "Independent review");
});

test("repository activity distinguishes created files and folders from edits", () => {
  const entries = timelineEntries([
    event(30, "repo.file.changed", { path: "src/new.ts", change: "created" }),
    event(31, "repo.file.changed", { path: "src/legacy.ts", change: "updated" }),
    event(32, "repo.file.changed", { path: "src/generated", change: "created", kind: "directory" }),
  ]);

  assert.deepEqual(entries.map((entry) => entry.text), [
    "Created src/new.ts",
    "Changed src/legacy.ts",
    "Created folder src/generated",
  ]);
});

test("repository deletion recovery is visible and distinguishes safe outcomes", () => {
  const entries = timelineEntries([
    event(33, "repo.file.deleted", { path: "src/old.ts", approvalId: "approval-1" }),
    event(34, "repo.file.delete.aborted", {
      path: "src/changed.ts", reason: "file_changed_after_approval",
    }),
    event(35, "repo.file.delete.recovered", { path: "src/old.ts", outcome: "deleted" }),
    event(36, "repo.file.delete.recovered", { path: "src/kept.ts", outcome: "not_deleted" }),
    event(37, "repo.file.delete.recovered", { path: "src/unknown.ts", outcome: "needs_attention" }),
    event(38, "repo.file.deleted", {
      path: "assets/archive.bin", diffUnavailableReason: "file_too_large",
    }),
  ]);

  assert.deepEqual(entries.map((entry) => entry.text), [
    "Deleted src/old.ts",
    "Did not delete src/changed.ts · the file changed after approval",
    "Confirmed deletion after restart · src/old.ts",
    "Deletion did not finish · src/kept.ts; request approval again",
    "Deletion outcome needs review · src/unknown.ts",
    "Deleted assets/archive.bin · diff not attached (file too large)",
  ]);
});

test("agent lane filtering keeps that agent's activity and user replies addressed to them", () => {
  const messages = [
    { id: "agent", actor: "Builder", actorId: "builder", text: "I found the failing test." },
    { id: "reply", actor: "You", actorId: "user", recipientId: "builder", text: "Please fix the regression." },
    { id: "other", actor: "Reviewer", actorId: "reviewer", text: "I will review the patch." },
    { id: "broadcast", actor: "You", actorId: "user", text: "The release is tomorrow." },
  ];

  assert.deepEqual(
    filterTimelineMessages(messages, { agentId: "builder" }).map((message) => message.id),
    ["agent", "reply"],
  );
});
