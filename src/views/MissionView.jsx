import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  ArrowDownRight, ArrowSquareOut, BellSimple, CaretDown, CaretRight, ChatCircleDots, CheckCircle, Code,
  Check, CircleNotch, Copy, CornersIn, FileText, GitDiff, ListChecks,
  Gear, MagnifyingGlass, Paperclip, PaperPlaneRight, ShieldCheck, Sparkle, Stop, Trash, WarningCircle, Wrench, X,
  UsersThree,
} from "@phosphor-icons/react";
import { initialAgents } from "../data/workspace.js";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { MessageMarkdown } from "../components/MarkdownContent.jsx";
import { filterTimelineMessages, groupActivityMessages, mergeTimelineMessages } from "../domain/activity.js";
import { secureInteractiveDocument } from "../domain/interactive-artifact.js";
import { agentStatusLabel } from "../domain/labels.js";
import { modelDisplayName, sortModelCatalog } from "../domain/model-catalog.js";
import { runtime } from "../api/runtime.js";

export { MessageMarkdown };

const agentColours = { planner: "violet", builder: "blue", reviewer: "teal" };

export function AgentIcon({ agent, size = 18 }) {
  if (agent.id === "builder") return <Wrench size={size} weight="duotone" />;
  if (agent.id === "reviewer") return <ShieldCheck size={size} weight="duotone" />;
  return <ListChecks size={size} weight="duotone" />;
}

export function AgentLanes({ agents, selectedAgentFilter, onSelect, onStop, className = "" }) {
  const [stopping, setStopping] = useState(() => new Set());
  async function stopAgent(agent) {
    setStopping((current) => new Set(current).add(agent.id));
    try { await onStop(agent); }
    finally { setStopping((current) => { const next = new Set(current); next.delete(agent.id); return next; }); }
  }
  return (
    <section className={`agent-lanes ${className}`.trim()} aria-label="Current agent activity">
      {agents.map((agent) => {
        const showNextDetail = !["Paused", "Not configured", "Ready"].includes(agent.status);
        const activity = agent.activity?.trim();
        const showActivity = activity && activity.toLocaleLowerCase() !== agent.name?.trim().toLocaleLowerCase();
        return (
        <div
          className={`agent-lane agent-lane--${agent.color} ${showNextDetail ? "" : "agent-lane--compact"} ${selectedAgentFilter === agent.id ? "agent-lane--selected" : ""}`}
          key={agent.id}
        >
          <div className="agent-lane-top">
            <button aria-pressed={selectedAgentFilter === agent.id} className="agent-lane-select" onClick={() => onSelect(agent)} type="button">
              <span className="agent-icon"><AgentIcon agent={agent} /></span>
              <span className="agent-name">{agent.name}</span>
            </button>
            <span className={`agent-live ${["Not configured", "Provider setup failed", "Needs attention", "Waiting for you", "Waiting for budget", "Stopping"].includes(agent.status) ? "agent-live--attention" : agent.status === "Paused" ? "agent-live--paused" : ""}`}><i />{agentStatusLabel(agent.status)}</span>
            {["Working", "Waiting for budget", "Stopping"].includes(agent.status) && <IconButton
              className="agent-stop-button"
              disabled={stopping.has(agent.id) || agent.status === "Stopping"}
              label={stopping.has(agent.id) || agent.status === "Stopping" ? `Stopping ${agent.name}` : `Stop ${agent.name}'s current run`}
              onClick={() => stopAgent(agent)}
            >{stopping.has(agent.id) || agent.status === "Stopping" ? <CircleNotch className="spin" size={15} /> : <Stop size={15} weight="fill" />}</IconButton>}
          </div>
          {(showActivity || showNextDetail) && <button className="agent-lane-details" onClick={() => onSelect(agent)} type="button">
            {showActivity && <div className="agent-activity">{activity}</div>}
            {showNextDetail && agent.next && <div className="agent-next"><FileText size={14} /><span>{agent.next}</span></div>}
          </button>}
        </div>
        );
      })}
    </section>
  );
}

function MessageAvatar({ actorId, actorType, agentDefinitions }) {
  if (actorType === "human") {
    return <span aria-label="You" className="message-avatar message-avatar--human">Y</span>;
  }
  const agent = agentDefinitions.find((item) => item.id === actorId) ?? initialAgents[0];
  return (
    <span className={`message-avatar message-avatar--${agent.color}`}>
      <AgentIcon agent={agent} size={17} />
    </span>
  );
}

function decodeArtifactText(base64) {
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function InteractiveArtifact({ artifactId, missionId, recipient, recipientLabel, enabled, onShare }) {
  const frameRef = useRef(null);
  const [documentHtml, setDocumentHtml] = useState("");
  const [title, setTitle] = useState("Interactive app");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [shared, setShared] = useState(false);
  const [frameHeight, setFrameHeight] = useState(280);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setFrameHeight(280);
    runtime.getArtifact(artifactId).then(({ artifact, contentBase64 }) => {
      if (!active) return;
      if (artifact.media_type !== "application/vnd.tribe.interactive+html") throw new Error("This artifact is not an interactive app.");
      setTitle(artifact.name.replace(/\.html$/i, ""));
      setDocumentHtml(secureInteractiveDocument(decodeArtifactText(contentBase64)));
    }).catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifactId]);

  useEffect(() => {
    function receiveAction(event) {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow || event.origin !== "null") return;
      const candidate = event.data;
      if (!candidate || candidate.__tribeInteractive !== true) return;
      if (candidate.type === "resize") {
        if (!Number.isFinite(candidate.height) || candidate.height <= 0) return;
        setFrameHeight(Math.min(680, Math.max(220, Math.round(candidate.height))));
        return;
      }
      if (candidate.type !== "action" || typeof candidate.name !== "string"
        || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(candidate.name)) return;
      try {
        const encoded = JSON.stringify(candidate.data);
        if (encoded.length > 12_000) return;
        setPendingAction({ name: candidate.name, data: candidate.data });
        setShared(false);
      } catch { /* Ignore values that cannot be represented as bounded JSON. */ }
    }
    window.addEventListener("message", receiveAction);
    return () => window.removeEventListener("message", receiveAction);
  }, []);

  async function shareAction() {
    if (!pendingAction || sharing) return;
    setSharing(true);
    setError("");
    try {
      await onShare(artifactId, recipient, pendingAction.name, pendingAction.data);
      setPendingAction(null);
      setShared(true);
    } catch (shareError) { setError(shareError.message || "Could not share this result."); }
    finally { setSharing(false); }
  }

  return <section className="interactive-artifact" aria-label={title}>
    <div className="interactive-artifact-heading"><strong>{title}</strong>
      <div><button aria-pressed={paused} className="interactive-artifact-control" onClick={() => setPaused((value) => !value)} type="button">{paused ? "Resume app" : "Pause app"}</button></div>
    </div>
    {!enabled
      ? <p className="interactive-artifact-disabled">Interactive apps are off for this project. Turn them on in Project settings to run this app.</p>
      : paused
        ? <p className="interactive-artifact-disabled">This app is paused. Resume it when you’re ready.</p>
        : loading
          ? <p className="interactive-artifact-status" role="status">Loading interactive app…</p>
          : error && !documentHtml
            ? <p className="interactive-artifact-error" role="alert">App unavailable · {error}</p>
            : <iframe loading="lazy" ref={frameRef} referrerPolicy="no-referrer" sandbox="allow-scripts" srcDoc={documentHtml} style={{ height: frameHeight }} title={title} />}
    {pendingAction && enabled && !paused && <div className="interactive-artifact-share"><span>App result is ready to share with {recipientLabel}.</span><button className="button button--quiet" disabled={sharing} onClick={shareAction} type="button">{sharing ? "Sharing…" : "Share with agent"}</button></div>}
    {shared && <span className="interactive-artifact-status" role="status">Shared with {recipientLabel}.</span>}
    {error && documentHtml && <p className="interactive-artifact-error" role="alert">{error}</p>}
  </section>;
}

function formatRunDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function ChangeEvent({ message, onOpenArtifact, onRecoverAgent, onOpenUsageSettings }) {
  const [continuing, setContinuing] = useState(false);
  async function continueAgent() {
    if (continuing) return;
    setContinuing(true);
    try { await onRecoverAgent(message.actorId); }
    finally { setContinuing(false); }
  }
  if (message.presentation === "divider") return <div className="timeline-divider" role="status">
    <span aria-hidden="true" className="timeline-divider-line" />
    <span className="timeline-divider-label">{message.text}</span>
    <time>{message.time}</time>
    <span aria-hidden="true" className="timeline-divider-line" />
  </div>;
  return (
    <div className={`change-event${message.runTokenLimit ? " change-event--budget" : ""}`} role="status">
      <span className="change-icon"><ArrowDownRight size={16} /></span>
      <span className="change-event-title">{message.text}</span>
      {message.runTokenLimit && <p className="change-event-budget-note">Increase the project limit in Usage &amp; data, then retry.</p>}
      {message.detail && <details className="completion-evidence"><summary>Technical details</summary><p>{message.detail}</p></details>}
      {message.runTokenLimit && <div className="change-event-budget-actions">
        {onOpenUsageSettings && <button className="timeline-action" onClick={onOpenUsageSettings} type="button">Review usage limits</button>}
        {message.canContinue && onRecoverAgent && <button className="timeline-action" disabled={continuing} onClick={continueAgent} type="button">{continuing ? "Sending…" : "Ask agent to recover"}</button>}
      </div>}
      {message.artifactId && <button className="timeline-action" onClick={() => onOpenArtifact(message.artifactId)} type="button">Open artifact review</button>}
      {message.toolState === "working" && <span className="timeline-tool-status">In progress</span>}
      {message.toolState === "waiting" && <span className="timeline-tool-status timeline-tool-status--waiting">Waiting for approval</span>}
      {message.toolState === "unknown" && <span className="timeline-tool-status timeline-tool-status--unknown">Outcome unknown</span>}
      {message.toolState === "denied" && <span className="timeline-tool-status timeline-tool-status--denied">Not run</span>}
      {message.canContinue && !message.runTokenLimit && onRecoverAgent && <button className="timeline-action" disabled={continuing} onClick={continueAgent} type="button">{continuing ? "Sending…" : "Ask agent to recover"}</button>}
      {message.workItemTitle && <span className="timeline-task-tag">{message.workItemTitle}</span>}
      {message.planCriteria?.length > 0 && <details className="completion-evidence"><summary>Criteria and plan tasks</summary><ol>{message.planCriteria.map((item, index) => <li key={`${index}-${item.criterion}`}><strong>{item.criterion}</strong>{item.workItems?.length > 0 && <ul>{item.workItems.map((workItem) => <li key={workItem.id}>{workItem.title}</li>)}</ul>}</li>)}</ol></details>}
      {message.reviewFindings?.length > 0 && <details className="completion-evidence"><summary>{message.reviewFindings.length} review findings</summary><ul>{message.reviewFindings.map((finding, index) => <li key={`${finding.file}-${index}`}><strong>{finding.severity} · {finding.file}</strong><br />{finding.issue}</li>)}</ul></details>}
      {message.acceptanceChecks?.length > 0 ? <details className="completion-evidence"><summary>{message.acceptanceChecks.length} verified acceptance checks</summary><ol>{message.acceptanceChecks.map((check, index) => <li key={`${index}-${check.criterion}`}><strong>{check.criterion}</strong>{check.planItems?.length > 0 && <ul><li>Plan tasks: {check.planItems.map((item) => item.title).join(", ")}</li></ul>}<ul>{check.evidence.map((item) => <li key={item.id}>{item.type === "artifact" ? <button className="evidence-link" onClick={() => onOpenArtifact(item.id)} type="button">Open artifact · {item.label}</button> : <span>{item.type === "test_run" ? "Passed" : "Completed"} · {item.label}</span>}</li>)}</ul></li>)}</ol></details>
        : message.acceptanceEvidence?.length > 0 && <details className="completion-evidence"><summary>{message.acceptanceEvidence.length} acceptance checks</summary><ul>{message.acceptanceEvidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></details>}
      {!message.acceptanceChecks?.length && message.evidenceRefs?.length > 0 && <details className="completion-evidence"><summary>{message.evidenceRefs.length} linked evidence sources</summary><ul>{message.evidenceRefs.map((item) => <li key={item.id}>{item.type === "artifact" ? <button className="evidence-link" onClick={() => onOpenArtifact(item.id)} type="button">Open artifact · {item.label}</button> : <span>{item.type === "test_run" ? "Passed" : "Completed"} · {item.label}</span>}</li>)}</ul></details>}
      <time>{message.time}</time>
    </div>
  );
}

function ChannelMessage({ message, agents, artifacts, onOpenArtifact, onOpenCanvas, onRecoverAgent, onOpenUsageSettings, interactiveResponsesEnabled, onShareInteractiveAction, missionId }) {
  const [copied, setCopied] = useState(false);
  if (message.kind === "change") return <ChangeEvent message={message} onOpenArtifact={onOpenArtifact} onRecoverAgent={onRecoverAgent} onOpenUsageSettings={onOpenUsageSettings} />;
  const attachedArtifact = artifacts.find((artifact) => artifact.id === message.artifactId);
  const runDuration = formatRunDuration(message.durationMs);
  const hasInputTokens = Number.isFinite(message.inputTokens);
  const hasOutputTokens = Number.isFinite(message.outputTokens);
  const hasTokenUsage = hasInputTokens && hasOutputTokens;
  const hasPartialTokenUsage = hasInputTokens || hasOutputTokens;
  const tokenUsageLabel = hasTokenUsage
    ? `${new Intl.NumberFormat().format(message.inputTokens + message.outputTokens)} tokens`
    : null;
  const visibleTokenUsage = hasTokenUsage
    ? tokenUsageLabel
    : hasPartialTokenUsage
      ? `${hasInputTokens ? `${new Intl.NumberFormat().format(message.inputTokens)} in` : "— in"} · ${hasOutputTokens ? `${new Intl.NumberFormat().format(message.outputTokens)} out` : "— out"}`
      : runDuration ? "tokens not recorded" : null;
  const tokenUsageStatus = hasTokenUsage
    ? `Provider-reported usage: ${tokenUsageLabel}`
    : hasPartialTokenUsage
      ? `Partial provider-reported usage: ${hasInputTokens ? `${new Intl.NumberFormat().format(message.inputTokens)} input tokens` : "input tokens not recorded"}; ${hasOutputTokens ? `${new Intl.NumberFormat().format(message.outputTokens)} output tokens` : "output tokens not recorded"}.`
      : "Token usage was not recorded for this response.";
  const usageLabel = [runDuration && `${runDuration} response time`, tokenUsageStatus].filter(Boolean).join(". ");
  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* Clipboard access can be unavailable in restricted browser contexts. */ }
  }

  return (
    <article className={`channel-message ${message.actorType === "human" ? "channel-message--human" : ""}`}>
      <MessageAvatar actorId={message.actorId} actorType={message.actorType} agentDefinitions={agents} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.actor}</strong>
          {message.recipient && (
            <>
              <span className="message-arrow">→</span>
              <span className="message-recipient">{message.recipient}</span>
            </>
          )}
          <time>{message.time}</time>
          {message.actorType === "agent" && <span className="agent-tag">Agent</span>}
          {message.actorType === "agent" && (runDuration || hasPartialTokenUsage) && <span aria-label={usageLabel} className={`message-run-usage${hasTokenUsage ? "" : " message-run-usage--incomplete"}`} title={usageLabel}>
            {[runDuration, visibleTokenUsage].filter(Boolean).join(" · ")}
          </span>}
          <button aria-live="polite" aria-label={copied ? "Message copied" : "Copy message"} className="message-copy-button" onClick={copyMessage} type="button">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </div>
        <div className="message-markdown">
        <MessageMarkdown>{message.text}</MessageMarkdown>
        </div>
        {message.interactiveArtifactIds?.map((artifactId) => <InteractiveArtifact
          artifactId={artifactId}
          enabled={interactiveResponsesEnabled}
          key={artifactId}
          missionId={missionId}
          onShare={onShareInteractiveAction}
          recipient={message.actorId}
          recipientLabel={agents.find((agent) => agent.id === message.actorId)?.name ?? message.actor}
        />)}
        {message.workItemTitle && <span className="timeline-task-tag">{message.workItemTitle}</span>}
        {message.canvasDocument && <button className="message-canvas-context" onClick={() => onOpenCanvas(message.canvasDocument)} type="button"><FileText size={15} /><span>{message.canvasDocument.title}</span><small>Revision {message.canvasDocument.revision}</small></button>}
        {message.attachments?.length > 0 && <div aria-label="Attached files" className="message-attachments">{message.attachments.map((attachment) => <button className="message-attachment" key={attachment.id} onClick={() => onOpenArtifact(attachment.id)} title={attachment.name} type="button"><FileText size={14} /><span>{attachment.name}</span><ArrowSquareOut size={12} /></button>)}</div>}
        {message.artifactId && (
          <button className="message-artifact" onClick={() => onOpenArtifact(message.artifactId)} type="button">
            <GitDiff size={17} />
            <span>{attachedArtifact?.name ?? "Open artifact"}</span>
            <span className="diff-added">+48</span>
            <span className="diff-removed">−6</span>
            <ArrowSquareOut size={14} className="artifact-open-icon" />
          </button>
        )}
      </div>
    </article>
  );
}

function ActivityGroup({ group, agents, onOpenArtifact, onRecoverAgent, onOpenUsageSettings }) {
  const agent = agents.find((item) => item.id === group.actorId) ?? initialAgents[0];
  const latest = group.messages.at(-1);
  return (
    <details className="activity-group">
      <summary>
        <span className={`activity-group-icon message-avatar--${agent.color}`}><AgentIcon agent={agent} size={15} /></span>
        <span className="activity-group-copy"><strong>{group.actor} · {group.messages.length} updates</strong><small>{group.workItemTitle}</small></span>
        <span className="activity-group-latest">{latest.text}</span>
        <time>{latest.time}</time>
      </summary>
      <div className="activity-group-details">
        {group.messages.map((message) => <ChangeEvent
          key={message.id}
          message={{ ...message, workItemTitle: undefined }}
          onOpenArtifact={onOpenArtifact}
          onRecoverAgent={onRecoverAgent}
          onOpenUsageSettings={onOpenUsageSettings}
        />)}
      </div>
    </details>
  );
}

function MissionStateGroup({ messages, onExpand }) {
  const first = messages[0];
  const latest = messages.at(-1);
  const groupRef = useRef(null);
  function revealExpandedEvents() {
    requestAnimationFrame(() => {
      const group = groupRef.current;
      const scroller = group?.closest(".channel-scroll");
      if (!group || !scroller) return;
      const overflow = group.getBoundingClientRect().bottom - (scroller.getBoundingClientRect().bottom - 12);
      if (overflow > 0) scroller.scrollTo({ top: scroller.scrollTop + overflow, behavior: "auto" });
    });
  }
  return <details className="mission-state-group" onToggle={(event) => { if (event.currentTarget.open) revealExpandedEvents(); }} ref={groupRef}>
    <summary aria-label={`Chat status · ${messages.length} updates from ${first.time} to ${latest.time}`} className="timeline-divider">
      <span aria-hidden="true" className="timeline-divider-line" />
      <CaretRight aria-hidden="true" className="mission-state-group-chevron" size={11} />
      <span className="timeline-divider-label">Chat status · {messages.length} updates</span>
      <time>{first.time}–{latest.time}</time>
      <span aria-hidden="true" className="timeline-divider-line" />
    </summary>
    <div className="mission-state-group-details">
      {messages.map((message) => <ChangeEvent key={message.id} message={message} />)}
    </div>
  </details>;
}

function ChannelHistoryHeader({ context }) {
  if (!context.hasOlderEvents) return null;
  return <div className="channel-history-header"><button className="load-older-events" disabled={context.loadingOlderEvents} onClick={() => void context.onLoadOlderEvents()} type="button">
    {context.loadingOlderEvents ? "Loading earlier activity…" : "Load earlier activity"}
  </button></div>;
}

const channelVirtuosoComponents = {
  Header: ChannelHistoryHeader,
  Footer: () => <div aria-hidden="true" className="channel-list-footer" />,
};
const channelAtBottomThreshold = 24;

function InteractionCard({ interaction, onResolve }) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { setAnswer(""); setSubmitting(false); }, [interaction?.id]);
  if (!interaction) return null;

  async function sendAnswer() {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    try { await onResolve(answer.trim()); }
    finally { setSubmitting(false); }
  }

  if (interaction.type === "approval") {
    return (
      <section className="interaction-card interaction-card--approval" aria-label="Tool approval request">
        <div className="interaction-symbol"><WarningCircle size={23} weight="duotone" /></div>
        <div className="interaction-copy">
          <strong>Approval required</strong>
          <span className="interaction-action">{interaction.title}</span>
          <code>{interaction.target}</code>
          <span className="interaction-reason">{interaction.reason}</span>
          <span className="interaction-resume">Only {interaction.agent} will continue after your decision.</span>
        </div>
        <div className="interaction-actions">
          <button className="button button--quiet" onClick={() => onResolve("Denied")} type="button">Deny</button>
          <button className="button button--primary" onClick={() => onResolve("Approved once")} type="button">Approve once</button>
        </div>
      </section>
    );
  }

  return (
    <section className="interaction-card interaction-card--question" aria-label="Agent clarification request">
      <div className="interaction-symbol"><ChatQuestionIcon /></div>
      <div className="interaction-copy">
        <strong>Decision needed <span>from {interaction.agent}</span></strong>
        <span className="interaction-action">{interaction.title}</span>
        <span className="interaction-reason">{interaction.detail}</span>
        <span className="interaction-resume">Your answer lets {interaction.agent} continue.</span>
        <textarea
          aria-label={`Answer ${interaction.agent}`}
          className="interaction-answer"
          maxLength={5000}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && answer.trim()) {
              event.preventDefault();
              sendAnswer();
            }
          }}
          placeholder="Write your answer…"
          rows={2}
          value={answer}
        />
      </div>
      <div className="interaction-actions">
        <button className="button button--primary" disabled={!answer.trim() || submitting} onClick={sendAnswer} type="button">{submitting ? "Sending…" : "Send answer"}</button>
      </div>
    </section>
  );
}

function ChatQuestionIcon() {
  return <WarningCircle size={23} weight="duotone" />;
}

function MessageComposer({ agents, mission, workspaceModel, onSend, onAttach, initialDraft, onDraftConsumed, onConnectModel, onManageModelMetadata, onManageTeam, onSaveModelPreferences }) {
  const [value, setValue] = useState("");
  const [recipient, setRecipient] = useState(null);
  const [canvasContext, setCanvasContext] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [modelCatalog, setModelCatalog] = useState([]);
  const [defaultModel, setDefaultModel] = useState(null);
  const [modelPreference, setModelPreference] = useState("");
  const [effortPreference, setEffortPreference] = useState("");
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [modelListSearch, setModelListSearch] = useState("");
  const inputRef = useRef(null);
  const modelMenuRef = useRef(null);
  const modelListSearchRef = useRef(null);
  const effortPreferenceRef = useRef("");
  const modelCatalogRequestRef = useRef(0);

  const refreshModelCatalog = useCallback(async () => {
    const requestId = ++modelCatalogRequestRef.current;
    try {
      const { models = [], defaultModel: workspaceDefault = null } = await runtime.getModelCatalog();
      if (requestId !== modelCatalogRequestRef.current) return;
      setModelCatalog(models.filter((model) => model.allowed));
      setDefaultModel(workspaceDefault);
    } catch {
      if (requestId === modelCatalogRequestRef.current) { setModelCatalog([]); setDefaultModel(null); }
    }
  }, []);

  useEffect(() => {
    void refreshModelCatalog();
    return () => { modelCatalogRequestRef.current += 1; };
  }, [workspaceModel, refreshModelCatalog]);

  useEffect(() => {
    setModelPreference(mission?.model_preference ?? "");
    setEffortPreference(mission?.effort_preference ?? "");
    effortPreferenceRef.current = mission?.effort_preference ?? "";
  }, [mission?.id, mission?.model_preference, mission?.effort_preference]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    function dismiss(event) {
      if (event.key === "Escape") {
        if (modelListOpen) setModelListOpen(false);
        else setModelMenuOpen(false);
      } else if (!modelMenuRef.current?.contains(event.target)) {
        setModelMenuOpen(false);
        setModelListOpen(false);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [modelMenuOpen, modelListOpen]);

  useEffect(() => {
    if (modelListOpen && modelCatalog.length > 8) modelListSearchRef.current?.focus();
  }, [modelListOpen, modelCatalog.length]);

  useEffect(() => {
    if (!initialDraft) return;
    setValue(initialDraft.text);
    setCanvasContext(initialDraft.canvasDocument ?? null);
    inputRef.current?.focus();
    onDraftConsumed(initialDraft.token);
  }, [initialDraft?.token]);

  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "42px";
    field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
  }, [value]);

  async function submit(event) {
    event.preventDefault();
    if ((!value.trim() && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      const saved = await onSend(value.trim() || "Please review the attached files.", recipient?.id ?? null, canvasContext, attachments);
      if (saved === false) return;
      setValue("");
      setRecipient(null);
      setCanvasContext(null);
      setAttachments([]);
    } finally {
      setSending(false);
    }
  }

  function chooseRecipient(agent) {
    setRecipient(agent);
    inputRef.current?.focus();
  }

  async function savePreferences(nextModel, nextEffort) {
    if (!onSaveModelPreferences || preferenceSaving) return;
    setPreferenceSaving(true);
    try {
      await onSaveModelPreferences(nextModel || null, nextEffort || null);
    } catch {
      setModelPreference(mission?.model_preference ?? "");
      setEffortPreference(mission?.effort_preference ?? "");
    } finally {
      setPreferenceSaving(false);
    }
  }

  const effectiveModel = modelPreference || defaultModel;
  const selectedModelMetadata = modelCatalog.find((model) => model.id === effectiveModel);
  const availableModelCatalog = sortModelCatalog(modelCatalog.filter((model) => model.allowed !== false && model.providerEnabled !== false), defaultModel);
  const visibleModelChoices = modelListSearch.trim()
    ? availableModelCatalog.filter((model) => `${modelDisplayName(model)} ${model.name} ${model.id} ${model.provider}`.toLocaleLowerCase().includes(modelListSearch.trim().toLocaleLowerCase()))
    : availableModelCatalog;
  const receivingAgent = recipient ?? agents.find((agent) => agent.id === "planner" || agent.name?.toLowerCase() === "planner" || agent.role?.toLowerCase() === "planner") ?? null;
  const receivingModel = receivingAgent?.model || effectiveModel;
  const receivingModelMetadata = modelCatalog.find((model) => model.id === receivingModel);
  const attachedModalities = [...new Set(attachments.map((attachment) => String(attachment.mediaType ?? "").toLowerCase().split(";", 1)[0].split("/", 1)[0]).filter((modality) => ["image", "audio", "video"].includes(modality)))];
  const unsupportedAttachedModalities = Array.isArray(receivingModelMetadata?.inputModalities)
    ? attachedModalities.filter((modality) => !receivingModelMetadata.inputModalities.some((supported) => String(supported).toLowerCase() === modality))
    : [];
  const hasPinnedReceivingModel = Boolean(receivingAgent?.model);
  const supportedEfforts = Array.isArray(receivingModelMetadata?.reasoningEfforts)
    ? [...receivingModelMetadata.reasoningEfforts]
    : [];
  if (receivingAgent?.effort && !supportedEfforts.includes(receivingAgent.effort)) supportedEfforts.push(receivingAgent.effort);
  const effectiveEffortPreference = receivingAgent?.effort || effortPreference;
  const effortSliderValue = effectiveEffortPreference ? Math.max(0, supportedEfforts.indexOf(effectiveEffortPreference) + 1) : 0;
  const effortLabel = effortSliderValue === 0 ? "Auto" : supportedEfforts[effortSliderValue - 1] === "xhigh"
    ? "Extra high" : supportedEfforts[effortSliderValue - 1]?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Auto";
  const defaultModelMetadata = modelCatalog.find((model) => model.id === defaultModel);
  const currentModelLabel = (selectedModelMetadata && modelDisplayName(selectedModelMetadata))
    ?? (defaultModelMetadata && modelDisplayName(defaultModelMetadata))
    ?? defaultModel?.split(":").slice(1).join(":")
    ?? "Auto";
  const triggerModelLabel = receivingAgent?.model
    ? receivingModelMetadata ? modelDisplayName(receivingModelMetadata) : receivingAgent.model.split(":").slice(1).join(":")
    : currentModelLabel;
  const providerLabel = (provider) => ({ openai: "OpenAI", anthropic: "Anthropic", google: "Google", azure: "Azure", ollama: "Ollama", xai: "xAI", mistral: "Mistral", meta: "Meta", cohere: "Cohere" }[provider?.toLowerCase()] ?? provider?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Model");
  function modelCapabilitySummary(model) {
    const details = [];
    if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
      details.push(`${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(model.contextWindow)} context`);
    }
    if (Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0) {
      details.push(`${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(model.maxOutputTokens)} max output`);
    }
    const inputMedia = Array.isArray(model.inputModalities) ? model.inputModalities.filter((item) => item !== "text") : [];
    if (inputMedia.length) details.push(`${inputMedia.map((item) => item.replace(/^./, (letter) => letter.toUpperCase())).join("/")} input`);
    const outputMedia = Array.isArray(model.outputModalities) ? model.outputModalities.filter((item) => item !== "text") : [];
    if (outputMedia.length) details.push(`${outputMedia.map((item) => item.replace(/^./, (letter) => letter.toUpperCase())).join("/")} output`);
    if (model.toolCalling === true) details.push("Agent tools");
    else if (model.toolCalling === false) details.push("No agent tools");
    if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length) details.push(`${model.reasoningEfforts.length} effort levels`);
    return details.join(" · ") || "Capabilities not reported";
  }
  function changeEffort(value) {
    const nextEffort = value === 0 ? "" : supportedEfforts[value - 1] ?? "";
    effortPreferenceRef.current = nextEffort;
    setEffortPreference(nextEffort);
  }
  function commitEffort() {
    void savePreferences(modelPreference, effortPreferenceRef.current);
  }

  function resolveMediaWarning() {
    if (hasPinnedReceivingModel) {
      onManageTeam?.();
      return;
    }
    setModelMenuOpen(true);
    setModelListOpen(true);
    setModelListSearch("");
    void refreshModelCatalog();
  }

  const recipientName = recipient?.name;
  const composerLabel = recipientName ? `Message ${recipientName}` : "Message the team";
  const composerPlaceholder = recipientName ? `Message ${recipientName}…` : "Message the team…";

  return (
    <form className="composer" onSubmit={submit}>
      {agents.length > 0 && agents.every((agent) => agent.status === "Not configured" || agent.status === "Provider setup failed") && <div className="composer-connect-hint"><WarningCircle size={15} /><span>No team replies until a model is connected.</span><button onClick={onConnectModel} type="button">Connect model</button></div>}
      {canvasContext && <div className="composer-canvas-context"><FileText size={15} /><span>{canvasContext.title} · Revision {canvasContext.revision}</span><button aria-label="Remove document context" onClick={() => setCanvasContext(null)} type="button">×</button></div>}
      {attachments.length > 0 && <div aria-label="Attached files" className="composer-attachments">{attachments.map((attachment) => <span className="composer-attachment" key={attachment.id}><FileText size={13} /><span title={attachment.name}>{attachment.name}</span><button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} type="button"><X size={13} /></button></span>)}</div>}
      {unsupportedAttachedModalities.length > 0 && <div className="composer-media-warning" role="alert"><WarningCircle aria-hidden="true" size={15} /><span>{receivingAgent?.name ?? "The selected model"}’s model doesn’t list support for {unsupportedAttachedModalities.join(", ")} input.</span><button onClick={resolveMediaWarning} type="button">{hasPinnedReceivingModel ? "Manage role" : "Choose model"}</button></div>}
      {agents.length > 0 && <div aria-label="Choose who receives this message" className="composer-team-chips" role="group">
        <button aria-pressed={!recipient} className={`composer-team-chip ${!recipient ? "composer-team-chip--selected" : ""}`} onClick={() => chooseRecipient(null)} title="Send to the team" type="button"><UsersThree size={14} />Team</button>
        {agents.map((agent) => <button aria-pressed={recipient?.id === agent.id} className={`composer-team-chip ${recipient?.id === agent.id ? "composer-team-chip--selected" : ""}`} key={agent.id} onClick={() => chooseRecipient(recipient?.id === agent.id ? null : agent)} title={`${agent.name} · ${agent.role} · ${agentStatusLabel(agent.status)}`} type="button"><i className={`composer-team-dot ${["Not configured", "Provider setup failed", "Needs attention"].includes(agent.status) ? "composer-team-dot--attention" : ""}`} />{agent.name}</button>)}
        <IconButton className="composer-team-manage" label="Manage project team" onClick={onManageTeam}><Gear size={14} /></IconButton>
      </div>}
      <textarea
        ref={inputRef}
        aria-label={composerLabel}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if ((value.trim() || attachments.length > 0) && !sending) event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={composerPlaceholder}
        rows={2}
        value={value}
      />
      <div className="composer-tools">
        <IconButton label="Attach a file" onClick={() => onAttach((attachment) => setAttachments((current) => current.some((item) => item.id === attachment.id) ? current : [...current, attachment]))}><Paperclip size={19} /></IconButton>
        <div className="composer-model-menu-wrap" ref={modelMenuRef}>
          <button aria-expanded={modelMenuOpen} aria-haspopup="dialog" aria-label={`Model ${triggerModelLabel}${receivingAgent?.model ? `, pinned for ${receivingAgent.name}` : ""}, effort ${effortLabel}`} className={`composer-model-trigger${modelMenuOpen ? " composer-model-trigger--open" : ""}`} disabled={preferenceSaving} onClick={() => { setModelListOpen(false); setModelListSearch(""); if (!modelMenuOpen) void refreshModelCatalog(); setModelMenuOpen((open) => !open); }} type="button">
            <Sparkle aria-hidden="true" className="composer-model-trigger-icon" size={15} weight="fill" />
            <span className="composer-model-trigger-copy"><strong>{triggerModelLabel}</strong><span className="composer-model-trigger-divider" /><small>{effortLabel}</small></span>
            <CaretDown aria-hidden="true" size={12} />
          </button>
          {modelMenuOpen && <section aria-label="Model and effort settings" className="composer-model-popover" role="dialog">
            <div className="composer-model-picker">
              <span className="composer-model-field-label">{receivingAgent?.model ? "Chat model" : "Model"}</span>
              <button aria-expanded={modelListOpen} aria-haspopup="listbox" className="composer-model-select" disabled={modelCatalog.length === 0} onClick={() => { setModelListSearch(""); setModelListOpen((open) => !open); }} type="button">
                <Sparkle aria-hidden="true" size={15} weight="fill" />
                <span><strong>{currentModelLabel}</strong><small>{modelPreference ? providerLabel(selectedModelMetadata?.provider) : "Workspace default"}</small></span>
                <CaretDown aria-hidden="true" size={14} />
              </button>
              {modelListOpen && <div className="composer-model-listbox">
              {modelCatalog.length > 8 && <label className="composer-model-search"><MagnifyingGlass aria-hidden="true" size={14} /><input aria-label="Search available models" autoComplete="off" onChange={(event) => setModelListSearch(event.target.value)} placeholder="Find a model" ref={modelListSearchRef} type="search" value={modelListSearch} /></label>}
              <div aria-label="Available models" className="composer-model-options" role="listbox">
                <button aria-selected={!modelPreference} className={`composer-model-option${!modelPreference ? " composer-model-option--selected" : ""}`} onClick={() => {
                  setModelPreference("");
                  setModelListOpen(false);
                  setModelListSearch("");
                  void savePreferences("", effortPreference);
                }} role="option" type="button"><span><strong>Auto</strong><small>Use the workspace default</small></span>{!modelPreference && <Check size={16} />}</button>
                {visibleModelChoices.map((model) => <button aria-selected={modelPreference === model.id} className={`composer-model-option${modelPreference === model.id ? " composer-model-option--selected" : ""}`} disabled={model.toolCalling === false} key={model.id} onClick={() => {
                  const nextEffort = model.id === modelPreference || (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.includes(effortPreference)) ? effortPreference : "";
                  setModelPreference(model.id);
                  setEffortPreference(nextEffort);
                  effortPreferenceRef.current = nextEffort;
                  setModelListOpen(false);
                  setModelListSearch("");
                  void savePreferences(model.id, nextEffort);
                }} role="option" title={model.id} type="button"><span><strong>{modelDisplayName(model)}</strong><small className="composer-model-option-details">{providerLabel(model.provider)} <i aria-hidden="true">·</i> {modelCapabilitySummary(model)}</small></span>{modelPreference === model.id && <Check size={16} />}</button>)}
              </div>
              {visibleModelChoices.length === 0 && modelListSearch.trim() && <p className="composer-model-no-results">No models match “{modelListSearch.trim()}”.</p>}
              </div>}
              {modelCatalog.length === 0 && <div className="composer-model-empty"><span>No models enabled.</span><button onClick={() => { setModelMenuOpen(false); onConnectModel(); }} type="button">Open model settings <CaretRight size={12} /></button></div>}
              {receivingAgent?.model && <p className="composer-model-override-note">{receivingAgent.name} is pinned to {triggerModelLabel}. This chat choice applies to other roles.</p>}
            </div>
            <div className={`composer-model-effort${supportedEfforts.length === 0 ? " composer-model-effort--unavailable" : ""}`}>
              <div className="composer-model-effort-heading"><span>Reasoning effort</span><strong>{effortLabel}</strong></div>
              <div className="composer-model-slider-wrap">
                <input aria-label="Reasoning effort" aria-valuetext={effortLabel} disabled={preferenceSaving || Boolean(receivingAgent?.effort) || !receivingModel || supportedEfforts.length === 0} max={supportedEfforts.length} min="0" onChange={(event) => changeEffort(Number(event.target.value))} onKeyUp={commitEffort} onPointerUp={commitEffort} step="1" style={{ "--effort-progress": `${supportedEfforts.length ? (effortSliderValue / supportedEfforts.length) * 100 : 0}%` }} type="range" value={effortSliderValue} />
                {supportedEfforts.length > 0 && <div aria-hidden="true" className="composer-model-slider-marks">{Array.from({ length: supportedEfforts.length + 1 }, (_, index) => <i key={index} style={{ left: `${(index / supportedEfforts.length) * 100}%` }} />)}</div>}
              </div>
              {supportedEfforts.length === 0 && <div className="composer-model-effort-unset"><span>{receivingModelMetadata ? "Effort levels not set for this model" : "Effort capabilities unavailable"}</span>{receivingModel && <button onClick={() => { setModelMenuOpen(false); onManageModelMetadata?.(receivingModel); }} type="button">Set options <CaretRight size={12} /></button>}</div>}
            </div>
          </section>}
        </div>
        <button aria-label="Send message" className="send-button" disabled={(!value.trim() && attachments.length === 0) || sending || unsupportedAttachedModalities.length > 0} type="submit">
          <PaperPlaneRight size={19} weight="fill" />
        </button>
      </div>
    </form>
  );
}

function MissionOutcomeReview({ messages, onReview }) {
  const [outcome, setOutcome] = useState("accepted");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const latest = [...messages].reverse().find((message) => message.text?.startsWith("Outcome marked "));
  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await onReview(outcome, notes.trim());
      if (saved) setNotes("");
    } finally { setSaving(false); }
  }
  return (
    <section className="mission-outcome" aria-label="Chat outcome review">
      <div className="mission-outcome-heading">
        <strong>Review outcome</strong>
        <span>{latest ? latest.text : "Record whether this result met the goal."}</span>
      </div>
      <form onSubmit={submit}>
        <select aria-label="Chat outcome" onChange={(event) => setOutcome(event.target.value)} value={outcome}>
          <option value="accepted">Accepted</option>
          <option value="follow_up">Needs follow-up</option>
          <option value="rejected">Rejected</option>
        </select>
        <input aria-label="Outcome notes" maxLength={5000} onChange={(event) => setNotes(event.target.value)} placeholder="Optional note" value={notes} />
        <button className="button button--subtle" disabled={saving} type="submit">{saving ? "Saving…" : latest ? "Update review" : "Save review"}</button>
      </form>
    </section>
  );
}

export function ArtifactList({ artifacts, onSelect, compact = false }) {
  return (
    <div className={`artifact-list ${compact ? "artifact-list--compact" : ""}`}>
      {artifacts.map((artifact) => (
        <button className="artifact-row" key={artifact.id} onClick={() => onSelect(artifact)} type="button">
          <span className={`artifact-icon artifact-icon--${artifact.icon}`}>
            {artifact.icon === "code" ? <Code size={18} /> : <FileText size={18} />}
          </span>
          <span className="artifact-details">
            <strong>{artifact.name}</strong>
            <span>{compact ? `${artifact.owner} · ${artifact.time}` : `${artifact.missionTitle ? `${artifact.missionTitle} · ` : ""}${artifact.type} · ${artifact.size} · ${artifact.owner}`}</span>
          </span>
          <ArrowSquareOut className="artifact-row-arrow" size={16} />
        </button>
      ))}
    </div>
  );
}

function RightRail({ artifacts, activeInteraction, queuedInteractions, onSelectArtifact, onActivateInteraction }) {
  const needsCount = queuedInteractions.length + (activeInteraction ? 1 : 0);
  if (artifacts.length === 0 && needsCount === 0) return null;
  return (
    <aside className="right-rail">
      {artifacts.length > 0 && <section className="rail-section">
        <div className="rail-heading">
          <h2>Artifacts <span>{artifacts.length}</span></h2>
          <button className="text-button" onClick={() => onSelectArtifact(null)} type="button">View all <ArrowSquareOut size={14} /></button>
        </div>
        <ArtifactList artifacts={artifacts} compact onSelect={onSelectArtifact} />
      </section>}

      {needsCount > 0 && <section className="rail-section rail-section--needs">
        <div className="rail-heading">
          <h2><span className="needs-indicator" />Needs you <span>{needsCount}</span></h2>
          <BellSimple size={16} />
        </div>
        {queuedInteractions.map((interaction) => (
          <button
            className="queued-request"
            key={interaction.id}
            onClick={() => onActivateInteraction(interaction.id)}
            type="button"
          >
            <span className={interaction.type === "approval" ? "request-icon request-icon--approval" : "request-icon"}>
              {interaction.type === "approval" ? <Trash size={16} /> : <WarningCircle size={17} />}
            </span>
            <span className="request-copy">
              <strong>{interaction.type === "approval" ? "Approval needed" : "Clarification needed"}</strong>
              <span>{interaction.title}</span>
              {interaction.type === "approval" && <code>{interaction.target}</code>}
              <small>From {interaction.agent}</small>
            </span>
            <CaretRight size={15} />
          </button>
        ))}
        {queuedInteractions.length === 0 && !activeInteraction && <p className="empty-rail">No requests are waiting.</p>}
        {queuedInteractions.length === 0 && activeInteraction && <p className="empty-rail">No other requests are waiting.</p>}
      </section>}

    </aside>
  );
}

export function MissionView({ mission, agents, agentDefinitions = agents, messages, artifacts, hasOlderEvents, loadingOlderEvents, onLoadOlderEvents, workItems, selectedWorkFilter, onSelectWorkFilter, query = "", isolatedWorkspaces, activeInteraction, queuedInteractions, runtimeStatus, workspaceModel, onSend, onRecoverAgent, onStopAgentRun, onResolve, onSelectArtifact, onOpenCanvas, composerDraft, onComposerDraftConsumed, onActivateInteraction, onAttach, onDiscardIsolation, onReviewOutcome, onConnectModel, onManageModelMetadata, onManageTeam, onOpenUsageSettings, onSaveModelPreferences, interactiveResponsesEnabled = false, onShareInteractiveAction }) {
  const activityRows = useMemo(() => groupActivityMessages(messages), [messages]);
  const workingAgents = agents.filter((agent) => agent.status === "Working");
  let latestHumanMessage = null;
  let latestAgentMessage = null;
  for (const message of messages) {
    if (message.kind !== "message") continue;
    if (message.actorType === "human") latestHumanMessage = message;
    else if (message.actorType === "agent") latestAgentMessage = message;
  }
  const requestedAgent = latestHumanMessage?.recipientId
    ? agents.find((agent) => agent.id === latestHumanMessage.recipientId || agent.role === latestHumanMessage.recipientId)
    : agents.find((agent) => agent.id === "planner" || agent.role === "planner");
  const awaitingAgentResponse = mission?.status === "active" && !mission.archived_at
    && runtimeStatus === "connected" && latestHumanMessage
    && latestHumanMessage.sequence > (latestAgentMessage?.sequence ?? -1)
    && requestedAgent?.status === "Ready" && workingAgents.length === 0;
  const channelListRef = useRef(null);
  const channelFrameRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const observedScopeRef = useRef("");
  const observedSequenceRef = useRef(null);
  const observedLatestTextRef = useRef("");
  const firstItemIndexRef = useRef(1_000_000);
  const [firstItemIndex, setFirstItemIndex] = useState(firstItemIndexRef.current);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const latestSequence = messages.at(-1)?.sequence ?? null;
  const latestMessageText = messages.at(-1)?.text ?? "";
  const scrollToLatest = useCallback((force = false) => {
    const scroll = (allowWhenAway = false) => {
      if (!allowWhenAway && !isAtBottomRef.current) return;
      const list = channelListRef.current;
      if (list?.scrollToIndex) {
        list.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      }
      const scroller = channelFrameRef.current?.querySelector(".channel-scroll");
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    };
    requestAnimationFrame(() => {
      scroll(force);
      requestAnimationFrame(() => scroll());
      window.setTimeout(() => requestAnimationFrame(() => scroll()), 80);
    });
  }, []);

  useEffect(() => {
    const frame = channelFrameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return undefined;
    let width = frame.clientWidth;
    let height = frame.clientHeight;
    let scrollFrame = 0;
    const observer = new ResizeObserver(() => {
      const resized = width !== frame.clientWidth || height !== frame.clientHeight;
      width = frame.clientWidth;
      height = frame.clientHeight;
      if (!resized) return;
      const scroller = frame.querySelector(".channel-scroll");
      const isAtBottomNow = scroller
        && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= channelAtBottomThreshold;
      if (!isAtBottomNow && !isAtBottomRef.current) return;
      if (isAtBottomNow) {
        isAtBottomRef.current = true;
        setIsAtBottom(true);
        setNewMessageCount(0);
      }
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(scrollToLatest);
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scrollFrame);
    };
  }, [scrollToLatest]);

  useLayoutEffect(() => {
    const scope = `${mission?.id ?? ""}:${selectedWorkFilter}:${query}`;
    if (observedScopeRef.current !== scope) {
      observedScopeRef.current = scope;
      observedSequenceRef.current = latestSequence;
      observedLatestTextRef.current = latestMessageText;
      isAtBottomRef.current = true;
      firstItemIndexRef.current = 1_000_000;
      setFirstItemIndex(firstItemIndexRef.current);
      setNewMessageCount(0);
      setIsAtBottom(true);
      if (activityRows.length > 0) {
        scrollToLatest(true);
      }
      return;
    }
    const previousSequence = observedSequenceRef.current;
    const previousLatestText = observedLatestTextRef.current;
    observedSequenceRef.current = latestSequence;
    observedLatestTextRef.current = latestMessageText;
    if (latestSequence == null) return;
    if (previousSequence == null) {
      if (activityRows.length > 0) {
        isAtBottomRef.current = true;
        scrollToLatest(true);
      }
      return;
    }
    if (latestSequence < previousSequence) return;
    if (latestSequence === previousSequence) {
      if (latestMessageText !== previousLatestText) {
        if (isAtBottomRef.current) scrollToLatest();
        else setNewMessageCount((count) => Math.max(1, count));
      }
      return;
    }
    if (isAtBottomRef.current) {
      scrollToLatest();
      setNewMessageCount(0);
    } else {
      const addedMessages = messages.filter((message) => message.sequence > previousSequence && message.kind === "message").length;
      if (addedMessages > 0) setNewMessageCount((count) => count + addedMessages);
    }
  }, [mission?.id, selectedWorkFilter, query, latestSequence, latestMessageText, activityRows, messages, scrollToLatest]);

  function handleAtBottomChange(atBottom) {
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    if (atBottom) setNewMessageCount(0);
  }

  async function loadEarlierActivity() {
    if (!hasOlderEvents || loadingOlderEvents) return;
    await onLoadOlderEvents((earlierMessages) => {
      const visibleEarlierMessages = filterTimelineMessages(earlierMessages, {
        workItemId: selectedWorkFilter, query,
      });
      const updatedRows = groupActivityMessages(mergeTimelineMessages(messages, visibleEarlierMessages));
      const addedRows = Math.max(0, updatedRows.length - activityRows.length);
      if (addedRows === 0) return;
      firstItemIndexRef.current = Math.max(1, firstItemIndexRef.current - addedRows);
      setFirstItemIndex(firstItemIndexRef.current);
    });
  }

  function jumpToLatest() {
    if (activityRows.length === 0) return;
    isAtBottomRef.current = true;
    setNewMessageCount(0);
    setIsAtBottom(true);
    scrollToLatest(true);
  }

  return (
    <>
      {isolatedWorkspaces.length > 0 && <section className="isolation-strip" aria-label="Isolated agent work">
        <div className="isolation-intro"><strong>Isolated work</strong><span>Review or discard work kept outside the project checkout.</span></div>
        {isolatedWorkspaces.map((workspace) => <div className="isolation-item" key={workspace.agent_id}>
          <span><b>{agents.find((agent) => agent.id === workspace.agent_id)?.name ?? workspace.agent_id}</b><small>{workspace.state.replaceAll("_", " ")} · {workspace.path}</small></span>
          <button className="button button--subtle" onClick={() => onDiscardIsolation(workspace)} type="button">Discard work</button>
        </div>)}
      </section>}
      <div className={`workspace-columns ${artifacts.length === 0 && queuedInteractions.length === 0 && !activeInteraction ? "workspace-columns--channel-only" : ""}`}>
        <section className="channel-panel">
          <div className="channel-presence">
            {workingAgents.length > 0
              ? <span aria-live="polite" className="channel-live channel-live--working" role="status"><CircleNotch className="spin" size={12} />{workingAgents.length === 1 ? `${workingAgents[0].name} is working…` : `${workingAgents.length} agents are working…`}</span>
              : awaitingAgentResponse
                ? <span aria-label={`Waiting for ${requestedAgent.name} to reply`} aria-live="polite" className="channel-live channel-live--waiting" role="status"><CircleNotch className="spin" size={12} />Waiting for {requestedAgent.name}…</span>
              : <span className={`channel-live ${runtimeStatus === "offline" ? "channel-live--offline" : ""}`}><i /> {runtimeStatus === "connected" ? "Live" : runtimeStatus === "offline" ? "Offline" : "Reconnecting…"}</span>}
          </div>
          {workItems.length > 0 && <nav className="channel-task-filters" aria-label="Filter chat activity">
            <button className={!selectedWorkFilter ? "channel-task-filter channel-task-filter--selected" : "channel-task-filter"} onClick={() => onSelectWorkFilter("")} type="button">All activity</button>
            {workItems.map((item) => <button
              className={selectedWorkFilter === item.workItemId ? "channel-task-filter channel-task-filter--selected" : "channel-task-filter"}
              key={item.workItemId}
              onClick={() => onSelectWorkFilter(item.workItemId)}
              title={`${item.status} · ${item.title}`}
              type="button"
            >{item.title}</button>)}
          </nav>}
          <div className="channel-scroll-frame" ref={channelFrameRef}>
            {activityRows.length === 0 ? <div className={`channel-empty ${query || selectedWorkFilter ? "channel-empty--filtered" : ""}`}>
              {query || selectedWorkFilter
                ? <><strong>No messages found</strong><span>Try another search or clear the current filter.</span></>
                : <><span className="channel-empty-icon"><ChatCircleDots size={25} /></span><strong>What would you like to work on?</strong><span>Ask a question or describe a change to this project.</span></>}
            </div> : <Virtuoso
              alignToBottom
              atBottomStateChange={handleAtBottomChange}
              atBottomThreshold={channelAtBottomThreshold}
              className="channel-scroll"
              components={channelVirtuosoComponents}
              computeItemKey={(index, row) => row.kind === "activity-group" || row.kind === "mission-state-group" ? `${row.kind}-${row.firstSequence}` : row.message.id}
              context={{ hasOlderEvents, loadingOlderEvents, onLoadOlderEvents: loadEarlierActivity }}
              data={activityRows}
              firstItemIndex={firstItemIndex}
              followOutput={(atBottom) => atBottom ? "auto" : false}
              initialTopMostItemIndex={Math.max(0, activityRows.length - 1)}
              itemContent={(index, row) => {
              const relativeIndex = index - firstItemIndex;
              const isGroup = row.kind === "activity-group" || row.kind === "mission-state-group";
              const dayKey = isGroup ? row.dayKey : row.message.dayKey;
              const dayLabel = isGroup ? row.dayLabel : row.message.dayLabel;
              const previousRow = activityRows[relativeIndex - 1];
              const previousDayKey = relativeIndex === 0 || !previousRow ? null : previousRow.kind === "activity-group" || previousRow.kind === "mission-state-group"
                ? previousRow.dayKey : previousRow.message.dayKey;
              return <div key={row.kind === "activity-group" || row.kind === "mission-state-group" ? `${row.kind}-${row.firstSequence}` : row.message.id}>
                {relativeIndex === 0 || previousDayKey !== dayKey ? <div className="channel-day">{dayLabel}</div> : null}
                {row.kind === "activity-group"
                  ? <ActivityGroup group={row} agents={agentDefinitions} onOpenArtifact={onSelectArtifact} onRecoverAgent={mission?.archived_at ? null : onRecoverAgent} onOpenUsageSettings={onOpenUsageSettings} />
                  : row.kind === "mission-state-group"
                    ? <MissionStateGroup messages={row.messages} />
                    : <ChannelMessage message={row.message} agents={agentDefinitions} artifacts={artifacts} onOpenArtifact={onSelectArtifact} onOpenCanvas={onOpenCanvas} onRecoverAgent={mission?.archived_at ? null : onRecoverAgent} onOpenUsageSettings={onOpenUsageSettings} interactiveResponsesEnabled={interactiveResponsesEnabled && !mission?.archived_at && mission?.status !== "completed"} onShareInteractiveAction={onShareInteractiveAction} missionId={mission?.id} />}
              </div>;
            }}
              ref={channelListRef}
              style={{ flex: 1, minHeight: 0 }}
            />}
          {!isAtBottom && newMessageCount > 0 && <button aria-label={`Jump to ${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}`} aria-live="polite" className="channel-latest-button" onClick={jumpToLatest} title="Jump to latest" type="button">
            <ArrowDownRight size={15} /><span>{newMessageCount > 99 ? "99+" : newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}</span>
          </button>}
          </div>
          <div className="channel-compose-area">
            {mission?.archived_at && <div className="archived-mission-note" role="status">This chat is archived. Restore it to continue the conversation.</div>}
            {mission?.status === "completed" && <MissionOutcomeReview messages={messages} onReview={onReviewOutcome} />}
            <InteractionCard interaction={activeInteraction} onResolve={onResolve} />
            {!mission?.archived_at && <MessageComposer agents={agents} mission={mission} workspaceModel={workspaceModel} onSend={onSend} onAttach={onAttach} initialDraft={composerDraft} onDraftConsumed={onComposerDraftConsumed} onConnectModel={onConnectModel} onManageModelMetadata={onManageModelMetadata} onManageTeam={onManageTeam} onSaveModelPreferences={onSaveModelPreferences} />}
          </div>
        </section>
        <RightRail
          artifacts={artifacts}
          activeInteraction={activeInteraction}
          queuedInteractions={queuedInteractions}
          onSelectArtifact={onSelectArtifact}
          onActivateInteraction={onActivateInteraction}
        />
      </div>
    </>
  );
}

