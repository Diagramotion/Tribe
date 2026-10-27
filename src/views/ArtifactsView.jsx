import { ArrowClockwise, ArrowSquareOut, CircleNotch, FileText, LinkBreak, LinkSimple, MagnifyingGlass, X } from "@phosphor-icons/react";
import { ArtifactList } from "./MissionView.jsx";

export function ArtifactsView({ artifacts, total, query, loading, loadingMore, hasMore, error,
  canvasDocuments = [], missionId, linkedCanvasDocumentIds = [], linkingCanvasDocumentId, onToggleCanvasLink,
  onQueryChange, onLoadMore, onRefresh, onSelectArtifact, onSelectCanvas, onCreateCanvas, projectName }) {
  const linkedDocuments = new Set(linkedCanvasDocumentIds);
  const hasContent = artifacts.length > 0 || canvasDocuments.length > 0;
  const showSearch = hasContent || Boolean(query.trim()) || loading;
  return (
    <section className={`tab-panel detail-view artifacts-view ${artifacts.length === 0 && canvasDocuments.length === 0 ? "artifacts-view--empty" : ""}`}>
      <div className="detail-heading artifacts-heading">
        <div><p>Documents, files and results shared across chats in {projectName}.</p></div>
        <div className="artifact-heading-actions">
          <button className="button button--primary" disabled={!onCreateCanvas} onClick={onCreateCanvas} type="button">New document</button>
          {total > 0 && <span className="artifact-count">Showing {artifacts.length} of {total}</span>}
          <button aria-label="Refresh artifacts" className="artifact-refresh" disabled={loading} onClick={onRefresh} type="button"><ArrowClockwise size={16} /></button>
        </div>
      </div>
      {showSearch && <label className="artifact-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          aria-label="Search artifacts"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search by name, type or author"
          type="search"
          value={query}
        />
        {query && <button aria-label="Clear artifact search" onClick={() => onQueryChange("")} type="button"><X size={15} /></button>}
      </label>}
      {error && <div className="artifact-load-error" role="alert">Couldn’t load artifacts: {error}</div>}
      {canvasDocuments.length > 0 && <section className="canvas-document-list" aria-label="Shared documents">
        <div className="canvas-document-list-heading"><h3>Shared documents</h3><span>{canvasDocuments.length}</span></div>
        {canvasDocuments.map((document) => {
          const linked = linkedDocuments.has(document.id);
          const ownedHere = document.mission_id === missionId;
          return <div className="canvas-document-row" key={document.id}>
            <button aria-label={`Open ${document.title}`} className="canvas-document-main-action" onClick={() => onSelectCanvas(document)} title={`Open ${document.title}`} type="button">
              <span className="canvas-document-icon">{document.kind === "diagram" ? "◇" : document.kind === "code" ? "{ }" : "T"}</span>
              <span className="canvas-document-main"><strong>{document.title}</strong><small>{document.mission_title} · {document.kind} · Revision {document.revision}</small></span>
              {(document.pending_proposals > 0 || document.open_comments > 0) && <span className="canvas-document-badges">{document.pending_proposals > 0 && <em>{document.pending_proposals} proposal{document.pending_proposals === 1 ? "" : "s"}</em>}{document.open_comments > 0 && <em>{document.open_comments} comment{document.open_comments === 1 ? "" : "s"}</em>}</span>}
              <span aria-hidden="true" className="canvas-document-open"><ArrowSquareOut size={15} /></span>
            </button>
            {missionId && !ownedHere && <button aria-label={linked ? `Remove ${document.title} from this chat` : `Link ${document.title} to this chat`} aria-pressed={linked} className="canvas-link-action" disabled={!onToggleCanvasLink || linkingCanvasDocumentId === document.id} onClick={() => onToggleCanvasLink(document, linked)} title={linkingCanvasDocumentId === document.id ? "Updating link" : linked ? "Remove link from chat" : "Link to chat"} type="button">
              {linkingCanvasDocumentId === document.id ? <CircleNotch className="spin" size={15} /> : linked ? <LinkBreak size={15} /> : <LinkSimple size={15} />}
            </button>}
          </div>;
        })}
      </section>}
      {loading && artifacts.length === 0
        ? <div className="artifact-search-empty" role="status"><strong>Loading artifacts…</strong><span>Looking across this project’s chats.</span></div>
        : error && artifacts.length === 0
          ? null
        : artifacts.length > 0
          ? <ArtifactList artifacts={artifacts} onSelect={onSelectArtifact} />
          : query.trim()
            ? <div className="artifact-search-empty"><strong>No matching artifacts</strong><span>Try a different search.</span></div>
            : !hasContent && <div className="artifact-empty-state"><FileText aria-hidden="true" size={25} /><strong>No shared artifacts yet</strong><span>Documents and files shared in chats will appear here.</span></div>}
      {hasMore && <button className="artifact-load-more" disabled={loadingMore} onClick={onLoadMore} type="button">{loadingMore ? "Loading…" : "Show more"}</button>}
    </section>
  );
}

