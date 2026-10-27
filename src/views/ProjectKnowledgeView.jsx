import { useState } from "react";
import { Check, FileText, Plus, X } from "@phosphor-icons/react";
import { formatTime } from "../domain/activity.js";

export function ProjectKnowledgeView({ entries, proposals, onSave, onReview, onArchive, onRestore }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await onSave(title.trim(), content.trim());
      if (saved) {
        setTitle("");
        setContent("");
        setFormOpen(false);
      }
    } finally { setSaving(false); }
  }
  const pendingProposals = proposals.filter((proposal) => proposal.status === "pending");
  const activeEntries = entries.filter((entry) => entry.status === "active");

  return (
    <section className="tab-panel detail-view knowledge-view">
      <div className="detail-heading knowledge-heading"><div className="knowledge-heading-actions">{(activeEntries.length > 0 || pendingProposals.length > 0) && <span className="artifact-count">{activeEntries.length} saved · {pendingProposals.length} to review</span>}<button aria-label={formOpen ? "Cancel adding note" : "Add project note"} className="icon-button knowledge-add-button" onClick={() => setFormOpen((current) => !current)} title={formOpen ? "Cancel adding note" : "Add note"} type="button">{formOpen ? <X size={15} /> : <Plus size={15} />}</button></div></div>
      {formOpen && <form className="knowledge-form" onSubmit={submit}>
        <input aria-label="Knowledge title" maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Short title" value={title} />
        <textarea aria-label="Knowledge content" maxLength={20000} onChange={(event) => setContent(event.target.value)} placeholder="Stable project facts, conventions or decisions" rows={3} value={content} />
        <div><button className="button button--primary" disabled={!title.trim() || !content.trim() || saving} type="submit">{saving ? "Saving…" : "Save note"}</button></div>
      </form>}
      {pendingProposals.length > 0 && <div className="knowledge-proposals"><div className="command-list-heading"><h3>Agent suggestions</h3><span>Review before saving</span></div>
        {pendingProposals.map((proposal) => <article className="knowledge-proposal" key={proposal.id}><div className="knowledge-proposal-heading"><strong>{proposal.title}</strong><small>{proposal.proposed_by} · from {proposal.source_mission_title} · {formatTime(proposal.created_at)}</small></div><p>{proposal.content}</p><div className="knowledge-proposal-actions"><button className="button button--quiet" onClick={() => onReview(proposal.id, "dismiss")} type="button">Dismiss</button><button className="button button--primary" onClick={() => onReview(proposal.id, "accept")} type="button"><Check size={14} /> Save to project knowledge</button></div></article>)}
      </div>}
      <div className={`knowledge-list ${entries.length === 0 && pendingProposals.length === 0 && !formOpen ? "knowledge-list--empty" : ""}`}>
        {entries.map((entry) => <article className={`knowledge-entry ${entry.status === "archived" ? "knowledge-entry--archived" : ""}`} key={entry.id}><div><strong>{entry.title}</strong><small>{entry.status === "archived" ? "Archived" : `Added by ${entry.created_by}`} · {entry.source_mission_title ? `from ${entry.source_mission_title} · ` : ""}Updated {formatTime(entry.updated_at)}</small>{entry.status === "active" ? <button className="text-button knowledge-archive-button" onClick={() => onArchive(entry.id)} type="button">Archive</button> : <button className="text-button knowledge-archive-button" onClick={() => onRestore(entry.id)} type="button">Restore</button>}</div><p>{entry.content}</p></article>)}
        {entries.length === 0 && pendingProposals.length === 0 && !formOpen && <div className="knowledge-empty"><span className="knowledge-empty-icon"><FileText size={20} /></span><strong>No notes yet</strong><p>Add a convention or decision to give every chat the same project context.</p></div>}
      </div>
    </section>
  );
}
