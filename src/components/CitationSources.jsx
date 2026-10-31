import { ArrowSquareOut, GlobeSimple } from "@phosphor-icons/react";
import { LinkPreviewPopover } from "./LinkPreviewPopover.jsx";

export function CitationSources({ sources }) {
  if (!sources?.length) return null;
  return <aside aria-label={`Sources, ${sources.length} ${sources.length === 1 ? "page" : "pages"}`} className="general-chat-sources">
    <div className="general-chat-sources-heading"><span>Sources</span><small>{sources.length} {sources.length === 1 ? "page" : "pages"}</small></div>
    <div className="general-chat-source-list">
      {sources.map((source, index) => <LinkPreviewPopover className="message-link-preview-wrap--block" href={source.url} key={`${source.url}-${index}`}>
        {({ faviconDataUrl }) => <a className="general-chat-source" href={source.url} rel="noreferrer" target="_blank">
        <span aria-hidden="true" className="general-chat-source-icon">{faviconDataUrl ? <img alt="" src={faviconDataUrl} /> : <GlobeSimple size={15} />}</span>
        <span className="general-chat-source-copy"><strong>{source.title}</strong><small>{source.domain}</small></span>
        <ArrowSquareOut aria-hidden="true" className="general-chat-source-open" size={14} />
        </a>}
      </LinkPreviewPopover>)}
    </div>
  </aside>;
}
