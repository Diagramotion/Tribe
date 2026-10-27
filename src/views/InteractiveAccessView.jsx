import { useEffect, useState } from "react";

export function InteractiveAccessView({ projectName, policy, onSave }) {
  const [enabled, setEnabled] = useState(Boolean(policy?.enabled));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setEnabled(Boolean(policy?.enabled)), [projectName, policy?.enabled]);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try { await onSave(enabled); }
    catch (saveError) { setError(saveError.message || "Interactive app settings could not be saved."); }
    finally { setSaving(false); }
  }

  return <form className="interactive-access-form" onSubmit={save}>
    <section className="settings-card">
      <div className="settings-card-heading"><div><h3>Interactive apps in replies</h3><p>Let agents create self-contained HTML tools such as calculators, planners and simulations. They appear inline in chat.</p></div></div>
      <label className="web-access-toggle">
        <button aria-checked={enabled} className="web-access-switch" onClick={() => setEnabled((value) => !value)} role="switch" type="button"><span /></button>
        <span>Allow interactive apps in {projectName || "this project"}</span>
      </label>
      <p className="settings-note">Apps run in an isolated frame. Remote scripts and app network requests, browser storage and direct access to Tribe are blocked. A script can still navigate its own frame to another site, so do not put sensitive information in an app. Choose when to share a result with the agent. Turning this off stops apps from running; existing app files remain in chat.</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button button--primary" disabled={saving || !projectName} type="submit">{saving ? "Saving…" : "Save changes"}</button></div>
    </section>
  </form>;
}
