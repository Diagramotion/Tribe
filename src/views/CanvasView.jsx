import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CaretLeft, CaretRight, ChatCircleDots, DownloadSimple, X } from "@phosphor-icons/react";
import { canvasFilename, downloadCanvasDocument, downloadCanvasSvg, renderCanvasDiagramSvg } from "../domain/canvas-export.js";
import { applySelectedHunks, reviewDiff } from "../domain/canvas-diff.js";
import { selectedCanvasText } from "../domain/canvas-selection.js";
import { findTextQuoteRange, rangeAtTextOffsets, textSelectionOffsets } from "../domain/artifact-anchor.js";
import { runtime } from "../api/runtime.js";
import { DiagramPreview } from "../components/DiagramPreview.jsx";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { SelectControl } from "../components/SelectControl.jsx";
import { MarkdownContent } from "../components/MarkdownContent.jsx";
import { ReadOnlyCodeEditor } from "../components/ReadOnlyCodeEditor.jsx";

function CanvasPreview({ document, pageId, onTextSelection }) {
  function captureSelection(event) {
    const selected = window.getSelection();
    const quote = selectedCanvasText(event.currentTarget, selected);
    const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
    if (quote && range) onTextSelection?.(quote, { ...textSelectionOffsets(event.currentTarget, range), rect: range.getBoundingClientRect(), range: range.cloneRange() });
  }

  if (document.kind === "markdown") return <article id={pageId} className={`canvas-markdown${document.body.trim() ? "" : " canvas-markdown--empty"}`} onKeyUp={captureSelection} onMouseUp={captureSelection}>{document.body.trim() ? <MarkdownContent>{document.body}</MarkdownContent> : <p className="canvas-empty">Nothing to preview yet.</p>}</article>;
  if (document.kind === "diagram") return <div id={pageId} className="canvas-diagram" onKeyUp={captureSelection} onMouseUp={captureSelection}><DiagramPreview source={document.body} /></div>;
  return <pre id={pageId} className={`canvas-preview canvas-preview--${document.kind}`} onKeyUp={captureSelection} onMouseUp={captureSelection}>{document.body}</pre>;
}

function CommentThread({ missionId, documentId, thread, onRefresh }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submitReply(event) {
    event.preventDefault();
    if (!reply.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await runtime.addCanvasComment(missionId, documentId, { threadId: thread.id, body: reply });
      setReply("");
      await onRefresh();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve() {
    setBusy(true);
    setError("");
    try {
      await runtime.resolveCanvasComment(missionId, thread.id);
      await onRefresh();
    } catch (resolveError) {
      setError(resolveError.message);
    } finally {
      setBusy(false);
    }
  }
  return <article className="canvas-thread">
    <header><span>{thread.resolved_at ? "Resolved" : thread.assignee ? `Assigned to @${thread.assignee}` : "Open comment"}</span><small>Revision {thread.base_revision}</small></header>
    {thread.quote && <blockquote>{thread.quote}</blockquote>}
    {thread.comments.map((comment) => <div className="canvas-comment" key={comment.id}>
      <strong>{comment.author === "user" ? "You" : comment.author}</strong>
      <time>{new Date(comment.created_at).toLocaleString()}</time>
      <p>{comment.body}</p>
    </div>)}
    {error && <p className="canvas-error" role="alert">{error}</p>}
    {!thread.resolved_at && <div className="canvas-thread-actions">
      <form onSubmit={(event) => void submitReply(event)}><input aria-label="Reply to comment" maxLength={8192} onChange={(event) => setReply(event.target.value)} placeholder="Reply to this thread…" value={reply} /><button className="button button--quiet" disabled={busy || !reply.trim()} type="submit">Reply</button></form>
      <button className="button button--quiet" disabled={busy} onClick={() => void resolve()} type="button">Resolve</button>
    </div>}
  </article>;
}

export function CanvasView({ document: summary, refreshKey = 0, onBack, backLabel = "Back to artifacts", onDiscuss, requestConfirmation = async () => false }) {
  const accessMissionId = summary?.access_mission_id ?? summary?.mission_id;
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftBaseRevision, setDraftBaseRevision] = useState(null);
  const [recoveredDraft, setRecoveredDraft] = useState(null);
  const [viewRevision, setViewRevision] = useState(null);
  const [historyContent, setHistoryContent] = useState(null);
  const [mode, setMode] = useState("preview");
  const [selection, setSelection] = useState({ quote: "", startOffset: null, endOffset: null });
  const [commentBody, setCommentBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [commentNavigatorOpen, setCommentNavigatorOpen] = useState(false);
  const [activeThreadIndex, setActiveThreadIndex] = useState(0);
  const [commentDrafts, setCommentDrafts] = useState([]);
  const [commentPopover, setCommentPopover] = useState(null);
  const [commentNavigatorPosition, setCommentNavigatorPosition] = useState(null);
  const [postingCommentDrafts, setPostingCommentDrafts] = useState(false);
  const [pendingNavigationThreadId, setPendingNavigationThreadId] = useState(null);
  const [reviewingProposalId, setReviewingProposalId] = useState(null);
  const [selectedHunks, setSelectedHunks] = useState([]);
  const [saving, setSaving] = useState(false);
  const [svgExporting, setSvgExporting] = useState(false);
  const [error, setError] = useState("");
  const dirtyRef = useRef(false);
  const selectionRangeRef = useRef(null);
  const commentNavigatorRef = useRef(null);
  const commentToggleRef = useRef(null);
  const draftStorageKey = summary?.id && accessMissionId
    ? `tribe.canvas.draft:${summary.project_id ?? summary.mission_id}:${summary.id}` : "";

  async function loadDetail({ preserveDraft = true } = {}) {
    if (!summary?.id || !accessMissionId) return;
    const { document } = await runtime.getCanvasDocument(accessMissionId, summary.id);
    setDetail(document);
    if (!preserveDraft || !dirtyRef.current) {
      setDraft(document.current);
      setDraftBaseRevision(document.revision);
      setRecoveredDraft(null);
      dirtyRef.current = false;
      try { if (draftStorageKey) window.sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be unavailable. */ }
      try { window.sessionStorage.removeItem(`tribe.canvas.draft:${summary.mission_id}:${summary.id}`); } catch { /* Storage may be unavailable. */ }
    }
  }

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDraft(null);
    setViewRevision(null);
    setHistoryContent(null);
    setRecoveredDraft(null);
    setError("");
    setCommentNavigatorOpen(false);
    setActiveThreadIndex(0);
    setCommentDrafts([]);
    setCommentPopover(null);
    selectionRangeRef.current = null;
    dirtyRef.current = false;
    if (summary?.id && accessMissionId) {
      runtime.getCanvasDocument(accessMissionId, summary.id).then(({ document }) => {
        if (!alive) return;
        setDetail(document);
        const requestedRevision = summary.revision;
        if (Number.isInteger(requestedRevision) && requestedRevision > 0
            && requestedRevision !== document.revision) {
          runtime.getCanvasVersion(accessMissionId, document.id, requestedRevision).then(({ version }) => {
            if (!alive) return;
            setViewRevision(requestedRevision);
            setHistoryContent(version);
            setMode("preview");
          }).catch((versionError) => {
            if (alive) setError(versionError.message);
          });
        }
        try {
          const legacyDraftKey = `tribe.canvas.draft:${summary.mission_id}:${summary.id}`;
          const cached = window.sessionStorage.getItem(draftStorageKey)
            ?? window.sessionStorage.getItem(legacyDraftKey);
          const restored = cached ? JSON.parse(cached) : null;
          if (restored?.draft && typeof restored.draft.body === "string"
              && typeof restored.draft.title === "string") {
            const baseRevision = Number.isInteger(restored.baseRevision) && restored.baseRevision > 0
              ? restored.baseRevision : document.revision;
            setDraft(restored.draft);
            setDraftBaseRevision(baseRevision);
            setRecoveredDraft({ baseRevision, currentRevision: document.revision });
            dirtyRef.current = true;
          } else {
            setDraft(document.current);
            setDraftBaseRevision(document.revision);
          }
        } catch {
          setDraft(document.current);
          setDraftBaseRevision(document.revision);
        }
      }).catch((loadError) => {
        if (alive) setError(loadError.message);
      });
    }
    return () => { alive = false; };
  }, [summary?.id, accessMissionId, summary?.revision]);

  useEffect(() => {
    if (!draft || !dirtyRef.current || !draftStorageKey) return;
    try {
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify({ draft, baseRevision: draftBaseRevision ?? detail?.revision }));
    } catch { /* The in-memory draft remains editable if browser storage is unavailable. */ }
  }, [draft, draftBaseRevision, draftStorageKey]);

  useEffect(() => {
    if (refreshKey && detail) void loadDetail({ preserveDraft: true }).catch((loadError) => setError(loadError.message));
  }, [refreshKey]);

  function placeCommentPopover(rect, details) {
    const width = Math.min(340, window.innerWidth - 24);
    const height = 278;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + 10;
    const top = below + height < window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 10);
    setCommentPopover({ ...details, left, top });
  }

  function selectPreviewText(quote, details = {}) {
    if (viewRevision !== null) return;
    if (dirtyRef.current) {
      setError("Save your edits before commenting on this document revision.");
      return;
    }
    setSelection({ quote, startOffset: details.startOffset ?? null, endOffset: details.endOffset ?? null });
    if (details.range) {
      selectionRangeRef.current = details.range;
      setCommentNavigatorOpen(false);
      setCommentBody("");
      setAssignee("");
      placeCommentPopover(details.rect, {
        quote,
        startOffset: details.startOffset ?? null,
        endOffset: details.endOffset ?? null,
        baseRevision: detail?.revision,
      });
    }
  }

  function closeCommentPopover() {
    setCommentPopover(null);
    selectionRangeRef.current = null;
  }

  function openCommentNavigator() {
    const trigger = commentToggleRef.current;
    const scope = trigger?.closest(".project-tool-pane") ?? trigger?.closest(".canvas-view");
    const bounds = scope?.getBoundingClientRect();
    if (bounds) {
      const width = Math.max(260, Math.min(380, bounds.width - 24));
      setCommentNavigatorPosition({ left: Math.max(12, bounds.right - width - 12), top: Math.max(68, bounds.top + 8), width });
    }
    setCommentNavigatorOpen(true);
  }

  function openGeneralComment() {
    const trigger = commentToggleRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    setSelection({ quote: "", startOffset: null, endOffset: null });
    setAssignee("");
    setCommentBody("");
    setCommentNavigatorOpen(false);
    placeCommentPopover(rect, { quote: "", startOffset: null, endOffset: null, baseRevision: viewRevision ?? detail?.revision });
  }

  useEffect(() => {
    if (!commentPopover || !selectionRangeRef.current) return undefined;
    const reposition = () => {
      const range = selectionRangeRef.current;
      if (range) placeCommentPopover(range.getBoundingClientRect(), commentPopover);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [commentPopover?.quote]);

  useEffect(() => {
    if (!commentNavigatorOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!commentNavigatorRef.current?.contains(event.target) && !commentToggleRef.current?.contains(event.target)) setCommentNavigatorOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [commentNavigatorOpen]);

  useEffect(() => {
    if (!pendingNavigationThreadId || !detail) return;
    const thread = detail.threads.find((item) => item.id === pendingNavigationThreadId);
    if (!thread) { setPendingNavigationThreadId(null); return; }
    if (thread.base_revision !== (viewRevision ?? detail.revision)) {
      if (viewRevision !== thread.base_revision) {
        setSaving(true);
        runtime.getCanvasVersion(accessMissionId, detail.id, thread.base_revision).then(({ version }) => {
          setViewRevision(thread.base_revision);
          setHistoryContent(version);
          setMode("preview");
        }).catch((loadError) => setError(loadError.message)).finally(() => setSaving(false));
      }
      return;
    }
    if (mode !== "preview") { setMode("preview"); return; }
    const page = document.getElementById(`canvas-preview-${detail.id}`);
    const range = thread.start_offset !== null && thread.end_offset !== null
      ? rangeAtTextOffsets(page, thread.start_offset, thread.end_offset)
      : findTextQuoteRange(page, { type: "text_quote", quote: thread.quote });
    if (range) {
      const selected = window.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(range);
      range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else page?.scrollIntoView({ behavior: "smooth", block: "center" });
    setPendingNavigationThreadId(null);
  }, [pendingNavigationThreadId, detail, viewRevision, mode, historyContent, draft]);

  function navigateComment(index) {
    if (index < 0 || index >= (detail?.threads.length ?? 0)) return;
    setActiveThreadIndex(index);
    setPendingNavigationThreadId(detail.threads[index].id);
  }

  function queueCommentDraft(event) {
    event.preventDefault();
    if (!detail || !commentBody.trim() || dirtyRef.current || saving || !commentPopover) return;
    setCommentDrafts((current) => [...current, {
      id: crypto.randomUUID(), body: commentBody.trim(), quote: commentPopover.quote,
      startOffset: commentPopover.startOffset, endOffset: commentPopover.endOffset,
      baseRevision: commentPopover.baseRevision ?? detail.revision, assignee: assignee.trim() || null,
    }]);
    setCommentBody("");
    setAssignee("");
    closeCommentPopover();
    openCommentNavigator();
  }

  function updateCommentDraft(id, body) {
    setCommentDrafts((current) => current.map((item) => item.id === id ? { ...item, body } : item));
  }

  async function postCommentDrafts() {
    if (postingCommentDrafts || !commentDrafts.length || !detail) return;
    setPostingCommentDrafts(true);
    setError("");
    const failed = [];
    for (const draftComment of commentDrafts) {
      try {
        await runtime.addCanvasComment(accessMissionId, detail.id, {
          body: draftComment.body, baseRevision: draftComment.baseRevision,
          quote: draftComment.quote, startOffset: draftComment.startOffset,
          endOffset: draftComment.endOffset, assignee: draftComment.assignee,
        });
      } catch (postError) { failed.push({ ...draftComment, error: postError.message }); }
    }
    setCommentDrafts(failed);
    await loadDetail({ preserveDraft: true });
    if (failed.length) setError(`${failed.length} comment${failed.length === 1 ? "" : "s"} could not be posted. Your drafts are still here.`);
    setPostingCommentDrafts(false);
  }

  async function save(content = draft) {
    if (!detail || !content || saving) return;
    setSaving(true);
    setError("");
    try {
      await runtime.saveCanvasDocument(accessMissionId, detail.id, content, draftBaseRevision ?? detail.revision);
      dirtyRef.current = false;
      setRecoveredDraft(null);
      try { window.sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be unavailable. */ }
      try { window.sessionStorage.removeItem(`tribe.canvas.draft:${summary.mission_id}:${summary.id}`); } catch { /* Storage may be unavailable. */ }
      setViewRevision(null);
      setHistoryContent(null);
      await loadDetail({ preserveDraft: false });
    } catch (saveError) {
      setError(saveError.message === "canvas_revision_conflict"
        ? "This document changed elsewhere. Your draft is preserved; reload the latest revision before saving again."
        : saveError.message);
      if (saveError.message === "canvas_revision_conflict") {
        try {
          const { document: latest } = await runtime.getCanvasDocument(accessMissionId, detail.id);
          setDetail(latest);
          setRecoveredDraft({ baseRevision: draftBaseRevision ?? detail.revision, currentRevision: latest.revision });
        } catch { /* The original draft and its base revision remain available. */ }
      }
    } finally {
      setSaving(false);
    }
  }

  async function reviewProposal(proposalId, decision, acceptedContent = null) {
    setSaving(true);
    setError("");
    try {
      await runtime.reviewCanvasProposal(accessMissionId, proposalId, decision, acceptedContent);
      setReviewingProposalId(null);
      await loadDetail({ preserveDraft: true });
    } catch (reviewError) {
      setError(reviewError.message === "canvas_proposal_stale"
        ? "This proposal is based on an older revision and must be reviewed against the latest document."
        : reviewError.message);
      await loadDetail({ preserveDraft: true });
    } finally {
      setSaving(false);
    }
  }

  function toggleProposalReview(proposal) {
    if (reviewingProposalId === proposal.id) {
      setReviewingProposalId(null);
      return;
    }
    const diff = reviewDiff(detail.current.body, proposal.body);
    setSelectedHunks(diff.hunks.map((hunk) => hunk.id));
    setReviewingProposalId(proposal.id);
  }

  function acceptProposal(proposal) {
    const diff = reviewDiff(detail.current.body, proposal.body);
    const reviewing = reviewingProposalId === proposal.id;
    const metadataChanged = proposal.title !== detail.current.title
      || proposal.kind !== detail.current.kind || proposal.language !== detail.current.language;
    if (reviewing && !diff.truncated && diff.hunks.length > 0 && selectedHunks.length === 0 && !metadataChanged) {
      setError("Select at least one change to apply, or dismiss this proposal.");
      return;
    }
    let body = proposal.body;
    if (reviewing && !diff.truncated) {
      try {
        body = applySelectedHunks(detail.current.body, proposal.body, selectedHunks);
      } catch (applyError) {
        setError(applyError.message);
        return;
      }
    }
    void reviewProposal(proposal.id, "accept", {
      title: proposal.title, kind: proposal.kind, language: proposal.language, body,
    });
  }

  function discussDocument() {
    if (dirtyRef.current) {
      setError("Save your changes before starting a discussion about this revision.");
      return;
    }
    if (new TextEncoder().encode(selection.quote).length > 4096) {
      setError("Select a shorter passage before starting a discussion. The attached passage can be up to 4 KB.");
      return;
    }
    onDiscuss?.({
      artifactId: detail.id, title: detail.title, revision: detail.revision,
      selectedText: selection.quote,
    });
  }

  async function loadVersion(revision) {
    if (!revision || revision === detail.revision) {
      setViewRevision(null);
      setHistoryContent(null);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { version } = await runtime.getCanvasVersion(accessMissionId, detail.id, revision);
      setViewRevision(revision);
      setHistoryContent(version);
    } catch (versionError) {
      setError(versionError.message);
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (dirtyRef.current && !(await requestConfirmation({
      eyebrow: "Reload document",
      title: "Replace your unsaved edits?",
      message: "Loading the latest revision will discard your unsaved document changes.",
      confirmLabel: "Load latest revision",
      tone: "danger",
    }))) return;
    await loadDetail({ preserveDraft: false });
    setViewRevision(null);
    setHistoryContent(null);
    setError("");
  }

  async function discardDraft() {
    if (!detail || !(await requestConfirmation({
      eyebrow: "Discard draft",
      title: "Discard your unsaved changes?",
      message: "Your latest saved revision will stay unchanged.",
      confirmLabel: "Discard changes",
      tone: "danger",
    }))) return;
    setDraft(detail.current);
    setDraftBaseRevision(detail.revision);
    setRecoveredDraft(null);
    setError("");
    dirtyRef.current = false;
    try { window.sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be unavailable. */ }
    try { window.sessionStorage.removeItem(`tribe.canvas.draft:${summary.mission_id}:${summary.id}`); } catch { /* Storage may be unavailable. */ }
  }

  async function exportDiagramSvg(document, filename) {
    if (svgExporting) return;
    setSvgExporting(true);
    setError("");
    try {
      const svg = await renderCanvasDiagramSvg(document);
      downloadCanvasSvg(svg, filename);
    } catch (exportError) {
      setError(exportError.message || "The diagram could not be exported as SVG.");
    } finally {
      setSvgExporting(false);
    }
  }

  if (!detail || !draft) return <section className="tab-panel detail-view canvas-view"><IconButton label={backLabel} onClick={onBack}><ArrowLeft size={16} /></IconButton>{error ? <p className="canvas-error">{error}</p> : <div className="column-empty">Loading document…</div>}</section>;
  const historical = viewRevision !== null;
  const shown = historical ? historyContent : draft;
  const pending = detail.proposals.filter((proposal) => proposal.status === "pending");
  const exportDocument = (historical ? shown : draft) ?? detail.current;
  const exportFilename = canvasFilename(exportDocument, {
    revision: historical ? viewRevision : detail.revision,
    draft: !historical && dirtyRef.current,
  });
  return <section className="tab-panel detail-view canvas-view">
    <div className="canvas-topbar"><IconButton label={backLabel} onClick={onBack}><ArrowLeft size={16} /></IconButton>
      <div className="canvas-document-meta"><span>Shared document</span><small>{detail.kind} · Revision {viewRevision ?? detail.revision}</small></div>
      <div className="canvas-toolbar-actions">
        <label>History <SelectControl aria-label="Document revision history" onChange={(value) => void loadVersion(Number(value))} options={detail.versions.map((version) => ({ value: version.revision, label: `Revision ${version.revision} · ${version.author}` }))} size="regular" value={viewRevision ?? detail.revision} /></label>
        <button aria-expanded={commentNavigatorOpen} className="canvas-comments-toggle" disabled={mode === "edit" && !historical} onClick={() => commentNavigatorOpen ? setCommentNavigatorOpen(false) : openCommentNavigator()} ref={commentToggleRef} type="button"><ChatCircleDots size={15} /> Comments <span>{detail.threads.length + commentDrafts.length}</span></button>
        <IconButton disabled={!onDiscuss} label="Discuss in chat" onClick={discussDocument}><ChatCircleDots size={16} /></IconButton>
        {exportDocument.kind === "diagram" && <IconButton disabled={svgExporting} label={svgExporting ? "Preparing SVG" : "Download SVG"} onClick={() => void exportDiagramSvg(exportDocument, canvasFilename(exportDocument, { revision: historical ? viewRevision : detail.revision, draft: !historical && dirtyRef.current, format: "svg" }))}><DownloadSimple size={16} /></IconButton>}
        <IconButton label={`Download ${dirtyRef.current && !historical ? "draft" : "document"}`} onClick={() => downloadCanvasDocument(exportDocument, exportFilename)}><DownloadSimple size={16} /></IconButton>
        {historical ? <button className="button button--primary" disabled={saving} onClick={() => { setDraft(historyContent); dirtyRef.current = true; setViewRevision(null); setHistoryContent(null); setMode("edit"); }} type="button">Restore as new revision</button>
          : mode === "edit" ? <><button className="button button--quiet" onClick={() => setMode("preview")} type="button">Preview</button><button className="button button--primary" disabled={saving || !dirtyRef.current} onClick={() => void save()} type="button">{saving ? "Saving…" : "Save changes"}</button></>
            : <button className="button button--quiet" onClick={() => setMode("edit")} type="button">Edit</button>}
      </div>
    </div>
    <div className="canvas-title-row"><div>{mode === "edit" && !historical
      ? <input aria-label="Document title" maxLength={240} onChange={(event) => { setDraft({ ...draft, title: event.target.value }); dirtyRef.current = true; }} value={draft.title} />
      : <h1>{shown.title}</h1>}</div></div>
    {recoveredDraft && <div className={`canvas-draft-recovery ${recoveredDraft.baseRevision !== recoveredDraft.currentRevision ? "canvas-draft-recovery--stale" : ""}`} role="status">
      <div><strong>Unsaved changes recovered</strong><span>{recoveredDraft.baseRevision === recoveredDraft.currentRevision
        ? `Restored from revision ${recoveredDraft.baseRevision}.`
        : `Based on revision ${recoveredDraft.baseRevision}; the current document is revision ${recoveredDraft.currentRevision}. Saving will be rejected until you reload the latest revision.`}</span></div>
      <button className="button button--quiet" onClick={() => setRecoveredDraft(null)} type="button">Keep draft</button>
      {historical && <button className="button button--quiet" onClick={() => { setViewRevision(null); setHistoryContent(null); setMode("edit"); }} type="button">View recovered draft</button>}
      {recoveredDraft.baseRevision !== recoveredDraft.currentRevision && <button className="button button--quiet" onClick={() => downloadCanvasDocument(draft, canvasFilename(draft, { draft: true }))} type="button">Download draft</button>}
      <button className="button button--quiet" onClick={() => void discardDraft()} type="button">Discard draft</button>
    </div>}
    {error && <div className="canvas-error" role="alert">{error} {error.includes("draft is preserved") && <button className="button button--quiet" onClick={() => void reloadLatest()} type="button">Reload latest</button>}</div>}
    {mode === "edit" && !historical
      ? <div className="canvas-editor-surface"><ReadOnlyCodeEditor
        ariaLabel="Document source editor"
        content={draft.body}
        editable
        key={`${detail.id}:${draft.kind}:${draft.language ?? ""}`}
        maxLength={256 * 1024}
        onChange={(body) => { setDraft((current) => ({ ...current, body })); dirtyRef.current = true; }}
        onSelectionChange={({ from, to, text }) => setSelection(text ? { quote: text, startOffset: from, endOffset: to } : { quote: "", startOffset: null, endOffset: null })}
        path={`document.${draft.language || (draft.kind === "markdown" ? "md" : "txt")}`}
        wrapLines
      /></div>
      : <CanvasPreview document={shown} pageId={`canvas-preview-${detail.id}`} onTextSelection={selectPreviewText} />}
    {pending.length > 0 && <section className="canvas-proposals"><div className="canvas-section-heading"><div><h3>Proposed changes</h3><p>Agent edits need your review before becoming the current version.</p></div><span>{pending.length} pending</span></div>
      {pending.map((proposal) => {
        const diff = reviewingProposalId === proposal.id ? reviewDiff(detail.current.body, proposal.body) : null;
        const metadataChanged = proposal.title !== detail.current.title
          || proposal.kind !== detail.current.kind || proposal.language !== detail.current.language;
        return <article className="canvas-proposal" key={proposal.id}>
          <header><strong>{proposal.title}</strong><span>{proposal.author} · Based on revision {proposal.base_revision}</span></header>
          <div className="canvas-proposal-actions">
            <button className="button button--quiet" onClick={() => toggleProposalReview(proposal)} type="button">{diff ? "Hide changes" : "Review changes"}</button>
            <button className="button button--quiet" disabled={saving} onClick={() => void reviewProposal(proposal.id, "dismiss")} type="button">Dismiss</button>
            <button className="button button--primary" disabled={saving || proposal.base_revision !== detail.revision || Boolean(diff && !diff.truncated && diff.hunks.length > 0 && selectedHunks.length === 0 && !metadataChanged)} onClick={() => acceptProposal(proposal)} type="button">{proposal.base_revision !== detail.revision ? "Out of date" : diff && !diff.truncated ? "Apply selected changes" : "Accept full revision"}</button>
          </div>
          {diff && <div aria-label="Proposed document changes" className="canvas-proposal-diff">
            <div className="canvas-proposal-diff-heading"><strong>{diff.added} additions</strong><strong>{diff.removed} removals</strong>{diff.hunks.length > 0 && <span>{diff.hunks.length} change groups</span>}</div>
            {diff.hunks.map((hunk) => <section className="canvas-diff-hunk" key={hunk.id}>
              <label><input checked={selectedHunks.includes(hunk.id)} disabled={diff.truncated || proposal.base_revision !== detail.revision} onChange={(event) => setSelectedHunks((current) => event.target.checked ? [...current, hunk.id] : current.filter((id) => id !== hunk.id))} type="checkbox" /><span>Change {hunk.id + 1}</span><small>{hunk.added} added · {hunk.removed} removed</small></label>
              <pre>{hunk.visibleLines.map((line, index) => <code className={`canvas-diff-line canvas-diff-line--${line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context"}`} key={`${index}-${line}`}>{line || " "}{"\n"}</code>)}</pre>
            </section>)}
            {diff.truncated && <div className="canvas-diff-truncated">This change is too large for selective review. Check the full documents below before accepting the complete revision.</div>}
            {diff.hunks.length === 0 && <p className="canvas-diff-empty">No text changes in this proposal.</p>}
            <details className="canvas-proposal-full"><summary>Compare full documents</summary><div><section><small>Current revision {detail.revision}</small><pre>{detail.current.body}</pre></section><section><small>Proposed revision</small><pre>{proposal.body}</pre></section></div></details>
          </div>}
        </article>;
      })}
    </section>}
    {commentPopover && <form className="artifact-selection-composer artifact-selection-composer--canvas" onSubmit={(event) => queueCommentDraft(event)} style={{ left: commentPopover.left, top: commentPopover.top }}>
      <header><strong>{commentPopover.quote ? "Comment on selection" : "New comment"}</strong><IconButton label="Close comment composer" onClick={closeCommentPopover}><X size={14} /></IconButton></header>
      {commentPopover.quote && <blockquote className="artifact-selection-quote">“{commentPopover.quote}”</blockquote>}
      {dirtyRef.current && <p className="canvas-comment-note">Save your edits before commenting on this revision.</p>}
      <textarea autoFocus aria-label="Add a document comment" maxLength={8192} onChange={(event) => setCommentBody(event.target.value)} placeholder="Write a comment…" value={commentBody} />
      <input aria-label="Assign comment to an agent" maxLength={80} onChange={(event) => setAssignee(event.target.value)} placeholder="Assign to an agent (optional)" value={assignee} />
      <div><button className="button button--quiet" onClick={closeCommentPopover} type="button">Cancel</button><button className="button button--primary" disabled={saving || dirtyRef.current || !commentBody.trim()} type="submit">Add to review</button></div>
    </form>}
    {commentNavigatorOpen && <aside aria-label="Document comments" className="artifact-review-navigator canvas-comment-navigator" ref={commentNavigatorRef} role="dialog" style={commentNavigatorPosition}>
      <header><strong>Comments <span>{detail.threads.length + commentDrafts.length}</span></strong><button className="button button--quiet" disabled={mode === "edit" && !historical} onClick={openGeneralComment} type="button">New</button><IconButton disabled={!detail.threads.length} label="Previous comment" onClick={() => navigateComment((activeThreadIndex - 1 + detail.threads.length) % detail.threads.length)}><CaretLeft size={14} /></IconButton><IconButton disabled={!detail.threads.length} label="Next comment" onClick={() => navigateComment((activeThreadIndex + 1) % detail.threads.length)}><CaretRight size={14} /></IconButton><IconButton label="Close comments" onClick={() => setCommentNavigatorOpen(false)}><X size={14} /></IconButton></header>
      {detail.threads.length > 0 ? <div className="artifact-review-navigator-list" aria-label="Comment threads">{detail.threads.map((thread, index) => <button aria-current={activeThreadIndex === index ? "true" : undefined} key={thread.id} onClick={() => navigateComment(index)} type="button"><span>{thread.quote || thread.comments[0]?.body || "Comment"}</span><small>{thread.resolved_at ? "Resolved" : "Open"} · Rev {thread.base_revision}</small></button>)}</div> : <p className="artifact-review-navigator-empty">No comments yet. Select text or add a general comment.</p>}
      {detail.threads[activeThreadIndex] && <CommentThread documentId={detail.id} key={detail.threads[activeThreadIndex].id} missionId={accessMissionId} onRefresh={() => loadDetail({ preserveDraft: true })} thread={detail.threads[activeThreadIndex]} />}
      {commentDrafts.length > 0 && <section className="artifact-review-drafts"><strong>Ready to post · {commentDrafts.length}</strong>{commentDrafts.map((item) => <div className="artifact-review-draft" key={item.id}>{item.quote && <blockquote>“{item.quote}”</blockquote>}<textarea aria-label="Edit pending comment" maxLength={8192} onChange={(event) => updateCommentDraft(item.id, event.target.value)} value={item.body} /><button className="button button--quiet" onClick={() => setCommentDrafts((current) => current.filter((draftItem) => draftItem.id !== item.id))} type="button">Remove</button>{item.error && <small role="alert">{item.error}</small>}</div>)}<button className="button button--primary artifact-review-post-all" disabled={postingCommentDrafts || !commentDrafts.some((item) => item.body.trim())} onClick={() => void postCommentDrafts()} type="button">{postingCommentDrafts ? "Posting…" : `Post ${commentDrafts.length} comment${commentDrafts.length === 1 ? "" : "s"}`}</button></section>}
    </aside>}
  </section>;
}
