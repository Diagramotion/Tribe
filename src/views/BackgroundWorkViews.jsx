import { useState } from "react";
import {
  ArrowClockwise, CheckCircle, CircleNotch, ClockCounterClockwise, Pause, Play, Stop, TerminalWindow, WarningCircle, X,
} from "@phosphor-icons/react";
import { schedulePresentation } from "../domain/schedules.js";

const runStatusLabels = {
  running: "Running",
  paused: "Chat paused",
  blocked: "Waiting for you",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Failed",
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

export function SchedulesView({ project, schedules, agentsConfigured, onCreate, onAction, onLoadMoreRuns }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [deliveryTime, setDeliveryTime] = useState("09:00");
  const [pending, setPending] = useState(false);
  const [loadedRunPages, setLoadedRunPages] = useState({});
  const [loadingHistory, setLoadingHistory] = useState({});
  const [historyErrors, setHistoryErrors] = useState({});

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
    const result = await onCreate(title.trim(), prompt.trim(), cadence, deliveryTime);
    setPending(false);
    if (result) { setTitle(""); setPrompt(""); }
  }
  return <section className="tab-panel detail-view command-view schedule-view">
    <div className="detail-heading schedule-heading"><p>Create a chat that starts once or on a recurring schedule. Tribe must be open with a connected model; paused chats and chats waiting for you hold their next run.</p></div>
    <form className="command-launcher" onSubmit={submit}>
      <label htmlFor="schedule-title">Goal</label>
      <input id="schedule-title" maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Review open issues" value={title} />
      <label htmlFor="schedule-prompt">What should the agents do?</label>
      <textarea id="schedule-prompt" maxLength={10000} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the agents investigate or do?" rows={3} value={prompt} />
      <div className="command-launch-row"><select aria-label="Repeat" onChange={(event) => setCadence(event.target.value)} value={cadence}><option value="once">Once</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select>{["daily", "weekly"].includes(cadence) && <label className="schedule-time-label">{cadence === "weekly" ? "Monday at" : "Run at"}<input aria-label="Run time" onChange={(event) => setDeliveryTime(event.target.value)} type="time" value={deliveryTime} /></label>}<button className="button button--primary" disabled={!project.id || pending || !title.trim() || !prompt.trim()} type="submit">{pending ? "Saving…" : "Create schedule"}</button></div>
      <p>Daily and weekly schedules use your local time. Weekly schedules run on Monday; hourly schedules start at the next hour.</p>
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
            <div className="command-run-meta"><strong>{schedule.title}</strong><span>{statusLabel} · {schedule.cadence}</span></div>
            <small>{nextRun}</small>
            <p>{schedule.prompt}</p>
            {totalRuns > 0 && <details className="schedule-history">
              <summary>Previous runs · {runs.length} of {totalRuns}</summary>
              {runs.map((run) => <div className="schedule-history-row" key={run.id}>
                <span>{runStatusLabels[run.status] ?? "Status unavailable"}</span>
                <span>{run.mission_title}</span>
                <small>{new Date(run.started_at).toLocaleString()}{run.finished_at ? ` · ended ${new Date(run.finished_at).toLocaleString()}` : run.status === "paused" ? " · paused" : run.status === "blocked" ? " · needs your input" : " · in progress"}</small>
              </div>)}
              {historyErrors[schedule.id] && <p className="schedule-history-error" role="alert">{historyErrors[schedule.id]}</p>}
              {runs.length < totalRuns && <button className="button button--quiet schedule-history-more" disabled={loadingHistory[schedule.id]} onClick={() => loadMoreRuns(schedule, runs)} type="button">{loadingHistory[schedule.id] ? "Loading…" : "Load older runs"}</button>}
            </details>}
          </div>
          <div className="schedule-actions">
            {!oneOffInProgress && <>
              {schedule.status === "active" && <button aria-label="Pause schedule" className="icon-button" onClick={() => onAction(schedule.id, "pause")} title="Pause schedule" type="button"><Pause size={14} /></button>}
              {schedule.status === "paused" && <button aria-label="Resume schedule" className="icon-button" onClick={() => onAction(schedule.id, "resume")} title="Resume schedule" type="button"><Play size={14} /></button>}
              {schedule.status === "active" && <button aria-label="Run schedule now" className="icon-button" onClick={() => onAction(schedule.id, "run-now")} title="Run now" type="button"><ArrowClockwise size={14} /></button>}
              {["active", "paused"].includes(schedule.status) && <button aria-label="Cancel schedule" className="icon-button" onClick={() => onAction(schedule.id, "cancel")} title="Cancel schedule" type="button"><X size={14} /></button>}
            </>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}

