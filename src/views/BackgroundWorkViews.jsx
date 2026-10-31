import { useEffect, useState } from "react";
import {
  ArrowClockwise, BellSimple, CheckCircle, CircleNotch, ClockCounterClockwise, Pause, PencilSimple, Play, Stop, TerminalWindow, WarningCircle, X,
} from "@phosphor-icons/react";
import { schedulePresentation } from "../domain/schedules.js";

const runStatusLabels = {
  queued: "Queued",
  running: "Running",
  paused: "Chat paused",
  blocked: "Waiting for you",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Needs attention",
};

export function RunsView({ mission, runs, agentRequests = [], onStop }) {
  return <section className="tab-panel detail-view command-view">
    {!mission && <div className="column-empty">Choose a chat to see its runs.</div>}
    {runs.length > 0 && <div className="command-list-heading"><h3>Run history</h3><span>{runs.length} {runs.length === 1 ? "run" : "runs"}</span></div>}
    <div className={`command-run-list ${runs.length === 0 ? "command-run-list--empty" : ""}`}>{runs.length === 0 && <div className="command-empty"><span><TerminalWindow size={20} /></span><div><strong>No runs yet</strong><p>Ask the team to run tests or another repository task in chat. Results will appear here.</p></div></div>}
      {runs.map((run) => <article className="command-run" key={run.id}>
        <div className={`command-run-status command-run-status--${run.status}`} aria-label={runStatusLabels[run.status] ?? "Status unavailable"}>{run.status === "running" ? <CircleNotch className="spin" size={17} /> : run.status === "completed" ? <CheckCircle size={17} /> : <WarningCircle size={17} />}</div>
        <div className="command-run-body"><div className="command-run-meta"><code>{run.argv.join(" ")}</code><span>{runStatusLabels[run.status] ?? "Status unavailable"}</span></div><small>Started {new Date(run.started_at).toLocaleString()}</small>{run.output && <details className="command-output" open={run.status === "running"}><summary>Show run output</summary><pre>{run.output}</pre></details>}</div>
        {run.status === "running" && <button aria-label="Stop run" className="icon-button" onClick={() => onStop(run.id)} title="Stop run" type="button"><Stop size={14} /></button>}
      </article>)}
    </div>
    {mission && <details className="command-output agent-request-diagnostics">
      <summary>Model requests · {agentRequests.length}</summary>
      <p>Input tokens add up across requests. Context messages show the history size sent for each request; they are not a token estimate.</p>
      {agentRequests.length > 0 && <div className="agent-request-list">{agentRequests.map((request) => <div className="agent-request-row" key={request.request_key}>
        <span>{request.agent_id}</span><code title={request.model ?? "Model unavailable"}>{request.model ?? "Model unavailable"}</code>
        <span>{request.context_message_count == null ? "Context unavailable" : `${new Intl.NumberFormat().format(request.context_message_count)} messages`}</span>
        {request.compaction_receipt_count > 0 && <span>{request.compaction_receipt_count} history {request.compaction_receipt_count === 1 ? "receipt" : "receipts"}</span>}
        <span>{new Intl.NumberFormat().format(request.input_tokens)} in · {new Intl.NumberFormat().format(request.output_tokens)} out</span>
        <small>{new Date(request.created_at).toLocaleString()}</small>
      </div>)}</div>}
    </details>}
  </section>;
}

function localDateTime(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function SchedulesView({ project, projects = [], schedules, agentsConfigured, workspace = false, desktopNotificationsOn = false, onEnableDesktopNotifications, onTestDesktopNotifications, onCreate, onEdit, onAction, onLoadMoreRuns }) {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [selectedProjectId, setSelectedProjectId] = useState(project?.id ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [deliveryTime, setDeliveryTime] = useState("09:00");
  const [cronExpression, setCronExpression] = useState("0 9 * * MON-FRI");
  const [targetMissionId, setTargetMissionId] = useState("");
  const [editingTargetUnavailable, setEditingTargetUnavailable] = useState(false);
  const [runAt, setRunAt] = useState(() => {
    const value = new Date(Date.now() + 60 * 60 * 1000);
    value.setMinutes(0, 0, 0);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  });
  const [editingId, setEditingId] = useState(null);
  const [editingProjectId, setEditingProjectId] = useState("");
  const [editingTimezone, setEditingTimezone] = useState("");
  const [pending, setPending] = useState(false);
  const [loadedRunPages, setLoadedRunPages] = useState({});
  const [loadingHistory, setLoadingHistory] = useState({});
  const [historyErrors, setHistoryErrors] = useState({});
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [testingNotifications, setTestingNotifications] = useState(false);
  const selectedProject = project?.id === selectedProjectId
    ? project
    : projects.find((item) => item.id === selectedProjectId);
  const targetChats = (selectedProject?.missions ?? []).filter((item) => !item.archived_at);

  useEffect(() => {
    if (project?.id) setSelectedProjectId(project.id);
    else if (workspace && !projects.some((item) => item.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? "");
    }
  }, [project?.id, workspace, projects, selectedProjectId]);

  async function loadMoreRuns(schedule, runs) {
    if (!onLoadMoreRuns || loadingHistory[schedule.id]) return;
    const cursor = runs.at(-1);
    if (!cursor) return;
    setLoadingHistory((current) => ({ ...current, [schedule.id]: true }));
    setHistoryErrors((current) => ({ ...current, [schedule.id]: "" }));
    try {
      const result = await onLoadMoreRuns(schedule.id, cursor.started_at, cursor.id, 10);
      setLoadedRunPages((current) => {
        const previous = current[schedule.id] ?? schedule.runs ?? [];
        const seen = new Set(previous.map((run) => run.id));
        return {
          ...current,
          [schedule.id]: [...previous, ...result.runs.filter((run) => !seen.has(run.id))],
        };
      });
    } catch (error) {
      setHistoryErrors((current) => ({ ...current, [schedule.id]: error.message || "Run history could not be loaded." }));
    } finally {
      setLoadingHistory((current) => ({ ...current, [schedule.id]: false }));
    }
  }
  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const result = editingId
      ? await onEdit(editingProjectId || selectedProjectId, editingId, title.trim(), prompt.trim(), cadence, editingTimezone, deliveryTime, cadence === "once" ? runAt : null, cronExpression.trim(), targetMissionId)
      : await onCreate(project?.id ?? selectedProjectId, title.trim(), prompt.trim(), cadence, deliveryTime, cadence === "once" ? runAt : null, cronExpression.trim(), targetMissionId);
    setPending(false);
    if (result) {
      setTitle(""); setPrompt(""); setEditingId(null); setEditingTimezone(""); setEditingProjectId(""); setTargetMissionId("");
      setEditingTargetUnavailable(false);
    }
  }
  async function enableNotifications() {
    if (!onEnableDesktopNotifications || requestingNotifications) return;
    setRequestingNotifications(true);
    try { await onEnableDesktopNotifications(); }
    finally { setRequestingNotifications(false); }
  }
  async function testNotifications() {
    if (!onTestDesktopNotifications || testingNotifications) return;
    setTestingNotifications(true);
    try { await onTestDesktopNotifications(); }
    finally { setTestingNotifications(false); }
  }
  function startEditing(schedule) {
    const scheduleProject = project?.id === schedule.project_id
      ? project
      : projects.find((item) => item.id === schedule.project_id);
    setEditingId(schedule.id);
    setEditingProjectId(schedule.project_id ?? project?.id ?? "");
    if (schedule.project_id) setSelectedProjectId(schedule.project_id);
    setEditingTimezone(schedule.timezone);
    setTitle(schedule.title);
    setPrompt(schedule.prompt);
    setCadence(schedule.cadence);
    setDeliveryTime(schedule.delivery_time);
    setCronExpression(schedule.cron_expression ?? "");
    setTargetMissionId(schedule.target_mission_id ?? "");
    setEditingTargetUnavailable(Boolean(schedule.target_mission_id
      && !(scheduleProject?.missions ?? []).some((item) => item.id === schedule.target_mission_id && !item.archived_at)));
    const suggestedRetryAt = new Date(Date.now() + 60 * 60 * 1000);
    suggestedRetryAt.setMinutes(0, 0, 0);
    setRunAt(localDateTime(
      schedule.status === "failed" && schedule.cadence === "once"
        ? suggestedRetryAt.toISOString() : schedule.next_run_at,
      schedule.timezone,
    ));
  }
  return <section className="tab-panel detail-view command-view schedule-view">
    <div className="detail-heading schedule-heading">
      <p>{workspace ? "Manage scheduled chats across your projects." : "Schedule a project chat to run once or repeat."} Tribe must be open with a connected model; paused chats and chats waiting for you hold their next run.</p>
      {workspace && typeof window !== "undefined" && window.__TAURI_INTERNALS__ && <div className="schedule-notification-control">
        {desktopNotificationsOn
          ? <><span>Desktop notifications enabled</span><button className="button button--quiet" disabled={testingNotifications} onClick={testNotifications} type="button">{testingNotifications ? "Sending…" : "Test notification"}</button></>
          : <button className="button button--quiet" disabled={requestingNotifications} onClick={enableNotifications} type="button"><BellSimple size={15} />{requestingNotifications ? "Requesting…" : "Enable desktop notifications"}</button>}
      </div>}
    </div>
    <form className="command-launcher" onSubmit={submit}>
      {workspace && <label htmlFor="schedule-project">Project<select disabled={Boolean(editingId) || projects.length === 0} id="schedule-project" onChange={(event) => setSelectedProjectId(event.target.value)} value={selectedProjectId}>{projects.length === 0 && <option value="">No projects available</option>}{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <label htmlFor="schedule-title">Goal</label>
      <input id="schedule-title" maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Review open issues" value={title} />
      <label htmlFor="schedule-prompt">What should the agents do?</label>
      <textarea id="schedule-prompt" maxLength={10000} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the agents investigate or do?" rows={3} value={prompt} />
      <label htmlFor="schedule-target">Run in<select id="schedule-target" onChange={(event) => { setTargetMissionId(event.target.value); setEditingTargetUnavailable(false); }} value={targetMissionId}>
        <option value="">A new chat</option>
        {editingTargetUnavailable && <option value={targetMissionId}>Selected chat unavailable · choose another</option>}
        {targetChats.map((item) => <option key={item.id} value={item.id}>{item.title}{item.status === "completed" ? " · completed" : item.status === "paused" ? " · paused" : ""}</option>)}
      </select></label>
      <div className={`command-launch-row${cadence === "cron" ? " command-launch-row--cron" : ""}`}>
        <select aria-label="Repeat" onChange={(event) => setCadence(event.target.value)} value={cadence}>
          <option value="once">Once</option><option value="hourly">Hourly</option>
          <option value="daily">Daily</option><option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
          <option value="cron">Custom (cron)</option>
        </select>
        {cadence === "once" && <label className="schedule-time-label">Run once at<input aria-label="Run once at" onChange={(event) => setRunAt(event.target.value)} type="datetime-local" value={runAt} /></label>}
        {cadence === "cron" && <label className="schedule-time-label">Cron expression<input aria-label="Cron expression" autoComplete="off" onChange={(event) => setCronExpression(event.target.value)} placeholder="0 9 * * MON-FRI" spellCheck="false" value={cronExpression} /></label>}
        {["daily", "weekdays", "weekly", "monthly"].includes(cadence) && <label className="schedule-time-label">
          {cadence === "weekly" ? "Monday at" : cadence === "monthly" ? "First day at" : "Run at"}
          <input aria-label="Run time" onChange={(event) => setDeliveryTime(event.target.value)} type="time" value={deliveryTime} />
        </label>}
        <button className="button button--primary" disabled={!(project?.id ?? selectedProjectId) || pending || !title.trim() || !prompt.trim() || (cadence === "once" && !runAt) || (cadence === "cron" && !cronExpression.trim())} type="submit">{pending ? "Saving…" : editingId ? "Save changes" : "Create schedule"}</button>
        {editingId && <button className="button button--quiet" onClick={() => { setEditingId(null); setEditingTimezone(""); setEditingProjectId(""); setTargetMissionId(""); setTitle(""); setPrompt(""); }} type="button">Cancel edit</button>}
      </div>
      <p>Times use your local time{localTimezone ? ` (${localTimezone})` : ""}. Weekly schedules run on Monday, monthly schedules on the first day, and hourly schedules start at the next hour.{cadence === "cron" ? " Custom schedules use five fields: minute, hour, day of month, month and weekday. Example: 0 9 * * MON-FRI." : ""}</p>
    </form>
    {schedules.length > 0 && <div className="command-list-heading"><h3>Your schedules</h3><span>{schedules.length} {schedules.length === 1 ? "schedule" : "schedules"}</span></div>}
    <div className={`command-run-list ${schedules.length === 0 ? "command-run-list--empty" : ""}`}>{schedules.length === 0 && <div className="command-empty"><span><ClockCounterClockwise size={20} /></span><div><strong>No scheduled chats</strong><p>Chats you schedule will appear here.</p></div></div>}
      {schedules.map((schedule) => {
        const { oneOffInProgress, statusLabel, nextRun } = schedulePresentation(schedule, agentsConfigured);
        const baseRuns = schedule.runs ?? [];
        const olderRuns = loadedRunPages[schedule.id] ?? baseRuns;
        const baseRunIds = new Set(baseRuns.map((run) => run.id));
        const runs = [...baseRuns, ...olderRuns.filter((run) => !baseRunIds.has(run.id))];
        const totalRuns = Math.max(schedule.runs_total ?? baseRuns.length, runs.length);
        return <article className="command-run" key={schedule.id}>
          <div className="command-run-status command-run-status--completed"><ClockCounterClockwise size={17} /></div>
          <div className="command-run-body">
            <div className="command-run-meta"><strong>{schedule.title}</strong><span>{statusLabel} · {schedule.cadence === "cron" ? "Custom" : schedule.cadence}</span></div>
            {schedule.cadence === "cron" && <small className="schedule-expression">{schedule.cron_expression}</small>}
            {workspace && <small>{schedule.project_name}</small>}
            {schedule.target_mission_id && <small>Chat · {schedule.target_mission_title ?? "Unavailable"}{schedule.target_mission_archived_at ? " · archived" : ""}</small>}
            <small>{nextRun}</small>
            <p>{schedule.prompt}</p>
            {totalRuns > 0 && <details className="schedule-history">
              <summary>Previous runs · {runs.length} of {totalRuns}</summary>
              {runs.map((run) => <div className="schedule-history-row" key={run.id}>
                <span>{runStatusLabels[run.status] ?? "Status unavailable"}</span>
                <span>{run.mission_title}</span>
                <small>{run.status === "queued" ? "Queued" : "Started"} {new Date(run.started_at).toLocaleString()}{run.finished_at ? ` · ended ${new Date(run.finished_at).toLocaleString()}` : run.status === "paused" ? " · paused" : run.status === "blocked" ? " · needs your input" : run.status === "queued" ? " · waiting for an agent" : run.status === "failed" ? " · failed" : run.status === "cancelled" ? " · stopped" : " · in progress"}</small>
                {run.status === "failed" && run.error && <small className="schedule-run-error">{run.error}</small>}
              </div>)}
              {historyErrors[schedule.id] && <p className="schedule-history-error" role="alert">{historyErrors[schedule.id]}</p>}
              {runs.length < totalRuns && <button className="button button--quiet schedule-history-more" disabled={loadingHistory[schedule.id]} onClick={() => loadMoreRuns(schedule, runs)} type="button">{loadingHistory[schedule.id] ? "Loading…" : "Load older runs"}</button>}
            </details>}
          </div>
          <div className="schedule-actions">
            <button aria-label={`Edit ${schedule.title}`} className="icon-button" disabled={schedule.runs?.some((run) => ["running", "paused", "blocked"].includes(run.status))} onClick={() => startEditing(schedule)} title="Edit schedule" type="button"><PencilSimple size={14} /></button>
            {!oneOffInProgress && <>
              {schedule.status === "active" && <button aria-label="Pause schedule" className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "pause")} title="Pause schedule" type="button"><Pause size={14} /></button>}
              {schedule.status === "paused" && <button aria-label="Resume schedule" className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "resume")} title="Resume schedule" type="button"><Play size={14} /></button>}
              {["active", "failed"].includes(schedule.status) && <button aria-label={schedule.status === "failed" ? "Retry schedule" : "Run schedule now"} className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "run-now")} title={schedule.status === "failed" ? "Retry now" : "Run now"} type="button"><ArrowClockwise size={14} /></button>}
              {["active", "paused"].includes(schedule.status) && <button aria-label="Cancel schedule" className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "cancel")} title="Cancel schedule" type="button"><X size={14} /></button>}
            </>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}

