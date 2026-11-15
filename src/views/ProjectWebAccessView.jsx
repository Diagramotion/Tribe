import { useEffect, useState } from "react";
import { Globe } from "@phosphor-icons/react";

export function ProjectWebAccessView({ projectName, policy, onSave }) {
  const [enabled, setEnabled] = useState(Boolean(policy?.enabled));
  const [domains, setDomains] = useState((policy?.allowedDomains ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setEnabled(Boolean(policy?.enabled));
    setDomains((policy?.allowedDomains ?? []).join("\n"));
  }, [projectName, policy]);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave(enabled, domains.split(/[\n,]/).map((item) => item.trim()).filter(Boolean));
    } catch (saveError) {
      setError(saveError.message || "Website access could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <form className="interactive-access-form" onSubmit={save}>
    <section className="settings-card">
      <div className="settings-card-heading"><span className="settings-symbol"><Globe size={18} /></span><div><h3>Project websites</h3><p>Let agents browse specific websites needed for this project.</p></div></div>
      <label className="web-access-toggle">
        <button aria-checked={enabled} className="web-access-switch" onClick={() => setEnabled((value) => !value)} role="switch" type="button"><span /></button>
        <span>Allow website access in {projectName || "this project"}</span>
      </label>
      <label>Allowed hostnames<textarea autoComplete="off" disabled={!enabled} onChange={(event) => setDomains(event.target.value)} placeholder={"sonar.example.com\nlocalhost"} rows={4} value={domains} /></label>
      <p className="settings-note">Add one exact hostname per line. Website access applies to the listed hostnames; role grants and approvals still control what agents can do. It does not grant access to project files or commands.</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button button--primary" disabled={saving || !projectName} type="submit">{saving ? "Saving…" : "Save website access"}</button></div>
    </section>
  </form>;
}
