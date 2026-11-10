import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, ChartLine, CircleNotch } from "@phosphor-icons/react";
import { runtime } from "../api/runtime.js";

function numberLabel(value) {
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value);
}

function sizeLabel(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  if (value < 1024) return `${value} B`;
  const [unit, divisor] = value < 1024 * 1024
    ? ["KB", 1024]
    : value < 1024 * 1024 * 1024 ? ["MB", 1024 * 1024] : ["GB", 1024 * 1024 * 1024];
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / divisor)} ${unit}`;
}

function ModelArtifactLibrary({ artifacts }) {
  if (!artifacts.length) return null;
  return <section aria-label="Model artifact library" className="experiment-model-library">
    <header><div><h3>Model artifacts</h3><p>Project-file references grouped by content fingerprint when available. Tribe records metadata and keeps the files in your project.</p></div><span>{artifacts.length} version{artifacts.length === 1 ? "" : "s"}</span></header>
    <div className="experiment-model-list">{artifacts.map((artifact) => {
      const name = artifact.model_path.split("/").at(-1) || artifact.model_path;
      return <article className="experiment-model-item" key={`${artifact.model_path}:${artifact.artifact_version_key}`}>
        <header><div><strong>{name}</strong><code>{artifact.model_path}</code></div><span>{artifact.run_count} run{artifact.run_count === 1 ? "" : "s"}</span></header>
        <dl>
          <div><dt>File size</dt><dd>{sizeLabel(artifact.model_file_size_bytes)}</dd></div>
          <div><dt>First recorded</dt><dd><time dateTime={artifact.first_recorded_at}>{new Date(artifact.first_recorded_at).toLocaleString()}</time></dd></div>
          <div><dt>Latest run</dt><dd>{artifact.latest_experiment_name} · {artifact.latest_mission_title}</dd></div>
        </dl>
        {artifact.model_fingerprint_status === "captured" && artifact.model_sha256
          ? <details><summary>SHA-256 fingerprint captured at run time</summary><code className="experiment-model-fingerprint">{artifact.model_sha256}</code></details>
          : <p className="experiment-model-fingerprint-status">{artifact.model_fingerprint_status === "too_large" ? "Fingerprint skipped for a large file." : "No fingerprint was captured for this file reference."}</p>}
      </article>;
    })}</div>
  </section>;
}

function MetricTrend({ name, runs }) {
  const points = [...runs].reverse().filter((run) => typeof run.metrics?.[name] === "number");
  if (points.length < 2) return null;
  const values = points.map((run) => run.metrics[name]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const coords = values.map((value, index) => [
    points.length === 1 ? 140 : 12 + index * (256 / (points.length - 1)),
    54 - ((value - min) / spread) * 42,
  ]);
  return <div className="experiment-metric-trend">
    <div><strong>{name}</strong><span>{numberLabel(values[0])} → {numberLabel(values.at(-1))}</span></div>
    <svg aria-label={`${name} across ${points.length} runs`} role="img" viewBox="0 0 280 68">
      <polyline points={coords.map(([x, y]) => `${x},${y}`).join(" ")} />
      {coords.map(([x, y], index) => <circle cx={x} cy={y} key={`${x}-${index}`} r="3" />)}
    </svg>
  </div>;
}

export function ExperimentsView({ projectId, projectName }) {
  const [runs, setRuns] = useState([]);
  const [modelArtifacts, setModelArtifacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const result = await runtime.listProjectExperimentRuns(projectId);
      setRuns(result.runs || []);
      setModelArtifacts(result.modelArtifacts || []);
      setError("");
    } catch (cause) {
      setError(cause.message || "Experiment runs could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const groups = useMemo(() => {
    const grouped = new Map();
    for (const run of runs) {
      if (!grouped.has(run.experiment_name)) grouped.set(run.experiment_name, []);
      grouped.get(run.experiment_name).push(run);
    }
    return [...grouped.entries()];
  }, [runs]);

  return <section className="tab-panel detail-view experiments-view">
    <header className="detail-heading experiments-heading">
      <div><h2>Experiments</h2><p>Compare recorded metrics and parameters across chats in {projectName}.</p></div>
      <div className="experiments-actions"><span>{runs.length} run{runs.length === 1 ? "" : "s"}</span>
        <button aria-label="Refresh experiments" className="artifact-refresh" disabled={loading} onClick={() => { setLoading(true); void refresh(); }} type="button">
          {loading ? <CircleNotch className="spin" size={15} /> : <ArrowClockwise size={15} />}
        </button>
      </div>
    </header>
    {error && <p className="artifact-load-error" role="alert">{error}</p>}
    <ModelArtifactLibrary artifacts={modelArtifacts} />
    {loading && runs.length === 0
      ? <div className="artifact-search-empty" role="status"><strong>Loading experiment runs…</strong><span>Reading this project’s recorded results.</span></div>
      : groups.length === 0
        ? <div className="artifact-empty-state"><ChartLine aria-hidden="true" size={25} /><strong>No experiment runs yet</strong><span>Agents with Data analysis access can record metrics and model file references.</span></div>
        : <div className="experiment-groups">{groups.map(([name, groupRuns]) => {
          const metricNames = [...new Set(groupRuns.flatMap((run) => Object.keys(run.metrics || {})))].sort((a, b) => a.localeCompare(b));
          return <section className="experiment-group" key={name}>
            <header><div><h3>{name}</h3><span>{groupRuns.length} run{groupRuns.length === 1 ? "" : "s"}</span></div></header>
            {metricNames.length > 0 && <div aria-label={`${name} metric trends`} className="experiment-trends">{metricNames.map((metric) => <MetricTrend key={metric} name={metric} runs={groupRuns} />)}</div>}
            <div className="experiment-table-wrap"><table className="experiment-table">
              <thead><tr><th scope="col">Run</th>{metricNames.map((metric) => <th key={metric} scope="col">{metric}</th>)}<th scope="col">Details</th></tr></thead>
              <tbody>{groupRuns.map((run) => <tr key={run.id}>
                <th scope="row"><time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time><small>{run.mission_title} · {run.created_by}</small></th>
                {metricNames.map((metric) => <td key={metric}>{typeof run.metrics?.[metric] === "number" ? numberLabel(run.metrics[metric]) : "—"}</td>)}
                <td><details><summary>Parameters and files</summary>
                  {Object.keys(run.parameters || {}).length > 0 && <dl>{Object.entries(run.parameters).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}
                  {run.dataset_paths?.length > 0 && <p>Datasets: {run.dataset_paths.map((path) => <code key={path}>{path}</code>)}</p>}
                  {run.model_path && <p>Model file: <code>{run.model_path}</code></p>}
                  {run.notes && <p>{run.notes}</p>}
                </details></td>
              </tr>)}</tbody>
            </table></div>
          </section>;
        })}</div>}
  </section>;
}
