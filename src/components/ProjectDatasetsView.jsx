import { useEffect, useState } from "react";

export function ProjectDatasetsView({ projectId }) {
  const [paths, setPaths] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/projects/${projectId}/datasets`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load project datasets");
      if (active) {
        setPaths(body.datasets || []);
        setDraft((body.datasets || []).join("\n"));
      }
    }).catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const datasets = [...new Set(draft.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))];
      const response = await fetch(`/api/projects/${projectId}/datasets`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasets }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save project datasets");
      setPaths(body.datasets || []);
      setDraft((body.datasets || []).join("\n"));
    } catch (cause) {
      setError(cause.message.replaceAll("_", " "));
    } finally {
      setSaving(false);
    }
  }

  return <form className="project-settings-guidance" onSubmit={save}>
    <p>Register CSV or TSV files for analysis. Only agents with the Data analysis capability can inspect these files; this does not grant general repository access.</p>
    {loading ? <p className="muted">Loading datasets…</p> : <>
      <label htmlFor="project-dataset-paths">Repository paths<small>One path per line. Files must be UTF-8 and no larger than 12 MB each.</small></label>
      <textarea className="project-reference-files" id="project-dataset-paths" onChange={(event) => setDraft(event.target.value)} placeholder={"data/customers.csv\ndata/experiments.tsv"} rows={5} value={draft} />
      {paths.length > 0 && <p className="muted">{paths.length} registered {paths.length === 1 ? "dataset" : "datasets"}</p>}
      <p className="muted">Files stay in the project folder. Analysis results, which can include sample values and aggregates, are sent to the selected model provider.</p>
    </>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="button button--primary" disabled={loading || saving} type="submit">{saving ? "Saving…" : "Save datasets"}</button></div>
  </form>;
}
