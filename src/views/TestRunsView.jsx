import { CheckCircle, CircleNotch, Flask, WarningCircle } from "@phosphor-icons/react";

export function TestRunsView({ runs }) {
  return (
    <section className={`tab-panel detail-view test-runs-view ${runs.length === 0 ? "test-runs-view--empty" : ""}`}>
      {runs.length > 0 && <div className="test-list-heading"><h3>Test history</h3><span>{runs.length} {runs.length === 1 ? "test" : "tests"}</span></div>}
      <div className="test-list">
        {runs.length === 0 && <div className="test-empty">
          <span className="test-empty-icon"><Flask size={19} /></span>
          <div><strong>No test runs yet</strong><p>Results from agent-run repository tests appear here.</p></div>
        </div>}
        {runs.map((run) => (
          <div className="test-row" key={run.id}>
            <span className={`test-status test-status--${run.status.toLowerCase().replaceAll(/\s+/g, "-")}`}>
              {run.status === "Passed" ? <CheckCircle size={19} /> : run.status === "Running" ? <CircleNotch size={19} className="spin" /> : <WarningCircle size={19} />}
            </span>
            <div className="test-main"><strong>{run.name || "Test command"}</strong><span>{run.actor} · {run.status}{run.status === "Failed" && run.exitCode !== undefined ? ` · exit ${run.exitCode}` : ""}</span></div>
            {run.output && <details className="test-output"><summary>View output</summary><pre>{run.output}</pre></details>}
          </div>
        ))}
      </div>
    </section>
  );
}
