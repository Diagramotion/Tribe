import { useEffect, useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { runtime } from "../api/runtime.js";

const approvalModes = [
  {
    id: "standard",
    title: "Standard",
    description: "Routine project edits and commands can proceed. Tribe still asks before risky or external actions.",
  },
  {
    id: "review_changes",
    title: "Confirm changes",
    description: "Ask before agents edit project files or run commands. Existing safeguards still apply.",
  },
  {
    id: "confirm_every_call",
    title: "Confirm every tool call",
    description: "Ask before each agent tool call, including reads and team actions. Approvals apply once.",
  },
];

export function ApprovalSettingsView({ projectId }) {
  const [mode, setMode] = useState("standard");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setNotice("");
    runtime.getProjectApprovalPolicy(projectId).then(({ approvalPolicy }) => {
      if (current) setMode(approvalPolicy?.mode ?? "standard");
    }).catch((loadError) => {
      if (current) setError(loadError.message || "Approval settings could not be loaded.");
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [projectId]);

  async function save(event) {
    event.preventDefault();
    if (saving || loading) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const { approvalPolicy } = await runtime.setProjectApprovalPolicy(projectId, mode);
      setMode(approvalPolicy.mode);
      setNotice("Approval mode saved.");
    } catch (saveError) {
      setError(saveError.message || "Approval mode could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <form className="approval-settings-form" onSubmit={save}>
    <section className="settings-card">
      <div className="settings-card-heading">
        <span className="settings-symbol"><ShieldCheck size={17} /></span>
        <div><h3>How agents ask before acting</h3><p>Choose how much review this project needs. This setting cannot grant tools or access that a role does not already have.</p></div>
      </div>
      <div aria-label="Approval mode" className="approval-mode-list" role="radiogroup">
        {approvalModes.map((option) => <label className={`approval-mode-option${mode === option.id ? " approval-mode-option--selected" : ""}`} key={option.id}>
          <input aria-label={option.title} checked={mode === option.id} disabled={loading || saving} name="approval-mode" onChange={() => { setMode(option.id); setNotice(""); }} type="radio" value={option.id} />
          <span aria-hidden="true" className="approval-mode-indicator" /><span className="approval-mode-copy"><strong>{option.title}</strong><small>{option.description}</small></span>
        </label>)}
      </div>
      <p className="settings-note">Exact approvals for destructive changes and external actions remain in place in every mode.</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {notice && <p className="settings-note" role="status">{notice}</p>}
      <div className="approval-settings-footer"><span>Applies to new agent runs in this project.</span><button className="button button--primary" disabled={loading || saving} type="submit">{loading ? "Loading…" : saving ? "Saving…" : "Save approval mode"}</button></div>
    </section>
  </form>;
}
