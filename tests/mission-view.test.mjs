import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import react from "@vitejs/plugin-react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { timelineMessage } from "../src/domain/activity.js";

let vite;
let MissionView;
let insertAgentMention;
let mentionedAgentIds;
let resolveMentionedAgentIds;
let updateSelectedMentionAnchors;
let handleMentionKeyDown;
const originalWindow = globalThis.window;

before(async () => {
  globalThis.window = { setTimeout };
  vite = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ MissionView, insertAgentMention, mentionedAgentIds, resolveMentionedAgentIds, updateSelectedMentionAnchors, handleMentionKeyDown } = await vite.ssrLoadModule("/src/views/MissionView.jsx"));
});

after(async () => {
  await vite?.close();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

function renderChat({ mentions = [], recipient = null, activeInteraction = null, queuedInteractions = [], team = null, roster = team, leadAgentId = null, composerDraft = null, participantPickerOpen = false, messages: providedMessages = null, hasOlderEvents = false, status = "active", archivedAt = null, query = "", isolatedWorkspaces = [] } = {}) {
  const agents = team ?? [{ id: "security_auditor", name: "Security Auditor", role: "Review code security", status: "Ready" }];
  const rosterAgents = roster ?? agents;
  const event = {
    id: "user-message-1",
    sequence: 1,
    type: "message.created",
    actorId: "user",
    payload: { text: "Explain this project", mentions, recipient },
    createdAt: "2026-11-14T00:00:00.000Z",
  };
  const message = { ...timelineMessage(event, agents), sequence: event.sequence };
  const html = renderToStaticMarkup(React.createElement(MissionView, {
    mission: { id: "chat-no-planner", title: "Security review", status, archived_at: archivedAt, agentIds: agents.map((agent) => agent.id), leadAgentId },
    composerDraft,
    initialTeamMenuOpen: participantPickerOpen,
    agents,
    teamAgents: rosterAgents,
    agentDefinitions: agents,
    messages: providedMessages ?? [message],
    artifacts: [],
    hasOlderEvents,
    loadingOlderEvents: false,
    onLoadOlderEvents: async () => {},
    workItems: [],
    isolatedWorkspaces,
    query,
    activeInteraction,
    queuedInteractions,
    runtimeStatus: "connected",
    workspaceModel: null,
    onSend: async () => {},
    onResolve: async () => {},
    onRecoverAgent: async () => {},
    onStopAgentRun: async () => {},
    onSelectArtifact: () => {},
    onOpenCanvas: () => {},
    onActivateInteraction: () => {},
    onAttach: async () => {},
    onDiscardIsolation: () => {},
    onConnectModel: () => {},
    onManageModelMetadata: () => {},
    onManageTeam: () => {},
    onUpdateMissionTeam: async () => {},
    onOpenUsageSettings: () => {},
    onSaveModelPreferences: async () => {},
  }));
  return html;
}

test("a user message renders with a selected team that has no Planner or lead", () => {
  const html = renderChat();

  assert.match(html, /Waiting for Security Auditor…/);
  assert.doesNotMatch(html, /Planner/);
});

test("an unaddressed message waits for one available role in a multi-role team", () => {
  const html = renderChat({ team: [
    { id: "builder", name: "Builder", role: "Implement work", status: "Ready" },
    { id: "researcher", name: "Researcher", role: "Investigate evidence", status: "Ready" },
  ] });

  assert.match(html, /Waiting for Builder…/);
  assert.doesNotMatch(html, /Waiting for the team…/);
});

test("an available configured lead receives the unaddressed-message indicator", () => {
  const html = renderChat({
    team: [
      { id: "builder", name: "Builder", role: "Implement work", status: "Ready" },
      { id: "researcher", name: "Researcher", role: "Investigate evidence", status: "Ready" },
    ],
    leadAgentId: "researcher",
  });

  assert.match(html, /Waiting for Researcher…/);
});

test("chat empty states distinguish search, history loading and active work", () => {
  const filtered = renderChat({ messages: [], query: "unmatched" });
  const loading = renderChat({ messages: [], hasOlderEvents: true });
  const working = renderChat({
    messages: [],
    team: [{ id: "builder", name: "Builder", role: "Implement work", status: "Working" }],
  });

  assert.match(filtered, /No messages found/);
  assert.match(loading, /Loading the conversation/);
  assert.match(working, /The team is working/);
});

test("archived chats retain context while hiding the composer", () => {
  const html = renderChat({
    status: "completed",
    archivedAt: "2026-11-14T00:00:00Z",
    isolatedWorkspaces: [{ agent_id: "security_auditor", state: "needs_review", path: "/tmp/work" }],
  });

  assert.match(html, /This chat is archived/);
  assert.match(html, /Isolated work/);
  assert.match(html, /Discard work/);
  assert.doesNotMatch(html, /Message the team/);
});

test("a direct @mention renders the addressed role while it replies", () => {
  const html = renderChat({ mentions: ["security_auditor"] });

  assert.match(html, /Waiting for Security Auditor…/);
});

test("choosing a suggestion inserts an explicit mention and resolves its chat-team recipient", () => {
  const draft = insertAgentMention("Please check @Rev", "Reviewer");
  assert.equal(draft, "Please check @Reviewer ");
  const roster = [
    { id: "builder", name: "Builder", role: "Implement work" },
    { id: "reviewer", name: "Reviewer", role: "Quality review" },
  ];
  assert.deepEqual(mentionedAgentIds(draft, roster), ["reviewer"]);
  assert.deepEqual(mentionedAgentIds("@Quality review?", roster), ["reviewer"]);
});

test("a selected suggestion preserves its identity when roster labels collide", () => {
  const roster = [
    { id: "reviewer-a", name: "Reviewer", role: "Security review" },
    { id: "reviewer-b", name: "Reviewer", role: "Quality review" },
  ];
  const draft = insertAgentMention("Please check @Rev", "Reviewer");

  assert.deepEqual(mentionedAgentIds(draft, roster), []);
  assert.deepEqual(resolveMentionedAgentIds(draft, roster, [{ id: "reviewer-b", name: "Reviewer", start: 13, end: 22 }]), ["reviewer-b"]);
});

test("editing before a selected mention keeps its recipient attached to that token", () => {
  const roster = [{ id: "reviewer", name: "Reviewer", role: "Quality review" }];
  const previous = "hi @Reviewer ";
  const next = "Please hi @Reviewer ";
  const selected = [{ id: "reviewer", name: "Reviewer", start: 3, end: 12 }];
  const updated = updateSelectedMentionAnchors(previous, next, selected);

  assert.deepEqual(updated, [{ id: "reviewer", name: "Reviewer", start: 10, end: 19 }]);
  assert.deepEqual(resolveMentionedAgentIds(next, roster, updated), ["reviewer"]);
});

test("deleting a selected duplicate-name mention does not keep its stale recipient", () => {
  const roster = [
    { id: "reviewer-a", name: "Reviewer", role: "Security review" },
    { id: "reviewer-b", name: "Reviewer", role: "Quality review" },
  ];
  const previous = "@Reviewer and @Reviewer";
  const next = "Please @Reviewer";
  const selected = [{ id: "reviewer-a", name: "Reviewer", start: 0, end: 9 }];
  const updated = updateSelectedMentionAnchors(previous, next, selected);

  assert.deepEqual(updated, []);
  assert.deepEqual(resolveMentionedAgentIds(next, roster, updated), []);
});

test("deleting one identical mention preserves only the other occurrence's selection", () => {
  const roster = [
    { id: "reviewer-a", name: "Reviewer", role: "Security review" },
    { id: "reviewer-b", name: "Reviewer", role: "Quality review" },
  ];
  const previous = "@Reviewer and @Reviewer";
  const next = "@Reviewer";
  const removedSelection = [{ id: "reviewer-a", name: "Reviewer", start: 0, end: 9 }];
  const remainingSelection = [{ id: "reviewer-b", name: "Reviewer", start: 14, end: 23 }];
  const editRange = { start: 0, end: 14 };
  const afterRemovingFirst = updateSelectedMentionAnchors(previous, next, removedSelection, editRange);
  const afterRemovingFirstWithSecondSelected = updateSelectedMentionAnchors(previous, next, remainingSelection, editRange);

  assert.deepEqual(afterRemovingFirst, []);
  assert.deepEqual(resolveMentionedAgentIds(next, roster, afterRemovingFirst), []);
  assert.deepEqual(afterRemovingFirstWithSecondSelected, [{ id: "reviewer-b", name: "Reviewer", start: 0, end: 9 }]);
  assert.deepEqual(resolveMentionedAgentIds(next, roster, afterRemovingFirstWithSecondSelected), ["reviewer-b"]);
  assert.deepEqual(updateSelectedMentionAnchors(previous, next, remainingSelection, { invalidateAll: true }), []);
});

test("selecting one of two agents with the same role label preserves the chosen ID", () => {
  const roster = [
    { id: "reviewer-a", name: "Security Reviewer", role: "Reviewer" },
    { id: "reviewer-b", name: "Accessibility Reviewer", role: "Reviewer" },
  ];
  const draft = insertAgentMention("Please check @Rev", "Accessibility Reviewer");
  const start = draft.indexOf("@Accessibility Reviewer");
  const selected = [{ id: "reviewer-b", name: "Accessibility Reviewer", start, end: start + "@Accessibility Reviewer".length }];

  assert.deepEqual(resolveMentionedAgentIds(draft, roster, selected), ["reviewer-b"]);
});

test("free-typed labels are ambiguous when roster entries differ only by case", () => {
  const roster = [
    { id: "reviewer", name: "Security Reviewer", role: "Reviewer" },
    { id: "reviewer-lowercase", name: "Accessibility reviewer", role: "reviewer" },
  ];

  assert.deepEqual(mentionedAgentIds("Please ask @Reviewer", roster), []);
});

test("composer arrow keys, Enter and Escape operate the active mention suggestion", () => {
  const roster = [
    { id: "builder", name: "Builder", role: "Implementation" },
    { id: "reviewer", name: "Reviewer", role: "Quality review" },
  ];
  const options = roster;
  let active = 0;
  let draft = "@Rev";
  let dismissed = false;
  const selected = [];
  const onChoose = (agent) => {
    selected.push(agent.id);
    draft = insertAgentMention(draft, agent.name);
  };
  const key = (keyName, shiftKey = false) => {
    let prevented = false;
    const event = { key: keyName, shiftKey, preventDefault: () => { prevented = true; } };
    const handled = handleMentionKeyDown(event, options, active, (update) => { active = update(active); }, onChoose, () => { dismissed = true; });
    return { handled, prevented };
  };

  assert.deepEqual(key("ArrowDown"), { handled: true, prevented: true });
  assert.equal(active, 1);
  assert.deepEqual(key("ArrowUp"), { handled: true, prevented: true });
  assert.equal(active, 0);
  assert.deepEqual(key("ArrowDown"), { handled: true, prevented: true });
  assert.deepEqual(key("Enter"), { handled: true, prevented: true });
  assert.deepEqual(selected, ["reviewer"]);
  assert.equal(draft, "@Reviewer ");
  assert.deepEqual(mentionedAgentIds(draft, roster), ["reviewer"]);

  draft = "@Review";
  assert.deepEqual(key("Escape"), { handled: true, prevented: true });
  assert.equal(dismissed, true);
  assert.equal(draft, "@Review");
  assert.equal(key("Enter", true).handled, false);
});

test("@Reviewer is not suggested until the role joins the chat team", () => {
  const html = renderChat({
    team: [{ id: "builder", name: "Builder", role: "Implement work", status: "Ready" }],
    roster: [
      { id: "builder", name: "Builder", role: "Implement work", status: "Ready" },
      { id: "reviewer", name: "Reviewer", role: "Quality review", status: "Ready" },
    ],
    composerDraft: { text: "@Rev", token: "mention-suggestions-roster" },
    participantPickerOpen: true,
  });
  assert.doesNotMatch(html, /aria-label="Mention an agent"/);
  assert.match(html, /aria-pressed="false"[^>]*><i[^>]*><\/i><span><strong>Reviewer/);
  assert.match(html, /aria-pressed="true"[^>]*><i[^>]*><\/i><span><strong>Builder/);
});

test("the accessible mention menu offers selected chat roles", () => {
  const html = renderChat({
    team: [
      { id: "builder", name: "Builder", role: "Implement work", status: "Ready" },
      { id: "reviewer", name: "Reviewer", role: "Quality review", status: "Ready" },
    ],
    roster: [
      { id: "builder", name: "Builder", role: "Implement work", status: "Ready" },
      { id: "reviewer", name: "Reviewer", role: "Quality review", status: "Ready" },
    ],
    composerDraft: { text: "@Rev", token: "selected-mention-suggestion" },
  });
  assert.match(html, /role="listbox"[\s\S]*<button[^>]*role="option"[^>]*>[\s\S]*<strong>Reviewer<\/strong>/);
  assert.deepEqual(mentionedAgentIds(insertAgentMention("@Rev", "Reviewer"), [
    { id: "builder", name: "Builder", role: "Implement work" },
    { id: "reviewer", name: "Reviewer", role: "Quality review" },
  ]), ["reviewer"]);
});

test("the mention composer exposes its active roster suggestions through an accessible listbox", () => {
  const html = renderChat({ composerDraft: { text: "@", token: "mention-suggestions" } });
  const listboxId = html.match(/<div aria-label="Mention an agent"[^>]*id="([^"]+)"/)?.[1];
  const activeOptionId = html.match(/aria-activedescendant="([^"]+)"/)?.[1];

  assert.ok(listboxId);
  assert.match(html, new RegExp(`aria-autocomplete="list"[^>]*aria-controls="${listboxId}"`));
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="true"/);
  assert.equal(activeOptionId, `${listboxId}-option-0`);
  assert.match(html, new RegExp(`<div[^>]*id="${listboxId}"[^>]*role="listbox"`));
  assert.match(html, new RegExp(`<button[^>]*id="${activeOptionId}"[^>]*role="option"`));
  assert.match(html, /Security Auditor/);
  assert.match(html, /Choose agents for this chat/);
});

test("a direct recipient renders the addressed role while it replies", () => {
  const html = renderChat({ recipient: "security_auditor" });

  assert.match(html, /Waiting for Security Auditor…/);
});

test("a mention outside the chat team is not shown as awaiting a reply", () => {
  const html = renderChat({
    mentions: ["reviewer"],
    team: [{ id: "builder", name: "Builder", role: "Implement work", status: "Ready" }],
    roster: [
      { id: "builder", name: "Builder", role: "Implement work", status: "Ready" },
      { id: "reviewer", name: "Reviewer", role: "Quality review", status: "Ready" },
    ],
  });

  assert.doesNotMatch(html, /Waiting for Reviewer…/);
});

test("a remembered repository edit explains its chat and project scope", () => {
  const html = renderChat({
    activeInteraction: {
      id: "approval-file-edit",
      type: "approval",
      agent: "Builder",
      title: "Review project change",
      target: "src/feature.js",
      reason: "Requested change: edit_file\n\nFile: src/feature.js\n\nBefore:\nconst value = 1;\n\nAfter:\nconst value = 2;",
      toolName: "edit_file",
      persistentAccessAvailable: true,
    },
  });

  assert.match(html, /future in-project file changes/);
  assert.match(html, /interaction-reason--approval/);
  assert.match(html, /Before:.*After:/s);
  assert.match(html, /Allow file changes for this chat/);
  assert.match(html, /Allow file changes for this project/);
  assert.match(html, /Deletions and external actions still require approval/);
});

test("an exact approval offers once, chat and project scopes", () => {
  const html = renderChat({
    activeInteraction: {
      id: "approval-1",
      type: "approval",
      agent: "Security Auditor",
      title: "Run a command",
      target: "git status --short",
      reason: "This project asks for confirmation before command runs.",
      toolName: "run_command",
      persistentAccessAvailable: true,
    },
  });

  assert.match(html, /Approve once/);
  assert.match(html, /Allow this command for this chat/);
  assert.match(html, /Allow this command for this project/);
});

test("external or destructive approvals do not expose persistent scopes", () => {
  const html = renderChat({
    activeInteraction: {
      id: "approval-2",
      type: "approval",
      agent: "Security Auditor",
      title: "Delete a project file",
      target: "src/old-file.js",
      reason: "The file deletion needs approval.",
      toolName: "delete_repository_file",
      persistentAccessAvailable: false,
    },
  });

  assert.match(html, /Approve once/);
  assert.doesNotMatch(html, /More approval options/);
  assert.doesNotMatch(html, /Allow this .* for this project/);
});
