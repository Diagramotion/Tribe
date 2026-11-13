import { useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, GlobeSimple } from "@phosphor-icons/react";
import { getLinkPreview } from "../domain/link-preview.js";

const rawLinkPattern = /https?:\/\/[^\s<>"']+/gi;

function extractPreviewUrls(source) {
  const withoutCode = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ");
  const urls = [];
  for (const match of withoutCode.matchAll(rawLinkPattern)) {
    const preceding = withoutCode.slice(Math.max(0, match.index - 2), match.index);
    if (preceding.endsWith("](")) continue;
    const url = match[0].replace(/[.,!?;:)}\]]+$/, "");
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 2) break;
  }
  return urls;
}

export function LinkPreviews({ source }) {
  const urls = useMemo(() => extractPreviewUrls(source ?? ""), [source]);
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setPreviews([]);
    if (!urls.length) { setLoading(false); return () => { active = false; }; }
    setLoading(true);
    Promise.all(urls.map(getLinkPreview))
      .then((result) => { if (active) setPreviews(result.filter(Boolean)); })
      .catch(() => { if (active) setPreviews([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [urls]);

  if (!urls.length || (!loading && !previews.length)) return null;
  return <div aria-label="Link previews" className="message-link-previews">
    {loading && previews.length === 0 && urls.map((url) => {
      let domain = "Link preview";
      try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* URL is already rendered as a link in the message. */ }
      return <div aria-hidden="true" className="message-link-preview message-link-preview--loading" key={url}><GlobeSimple size={15} /><span>{domain}</span></div>;
    })}
    {previews.map((preview) => <a className="message-link-preview" href={preview.url} key={preview.url} rel="noopener noreferrer" target="_blank">
      <span aria-hidden="true" className="message-link-preview-icon">{preview.faviconDataUrl ? <img alt="" src={preview.faviconDataUrl} /> : <GlobeSimple size={16} />}</span>
      <span className="message-link-preview-copy"><small>{preview.domain}</small>{preview.title && <strong>{preview.title}</strong>}{preview.description && <span>{preview.description}</span>}</span>
      <ArrowSquareOut aria-hidden="true" className="message-link-preview-open" size={14} />
    </a>)}
  </div>;
}
