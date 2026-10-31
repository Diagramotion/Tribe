import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, GlobeSimple } from "@phosphor-icons/react";
import { getLinkPreview } from "../domain/link-preview.js";

export function LinkPreviewPopover({ children, className = "", href }) {
  const [preview, setPreview] = useState(null);
  const [position, setPosition] = useState(null);
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const hideTimer = useRef(null);
  const previewHref = useRef("");
  const wrapperRef = useRef(null);
  const renderChildren = typeof children === "function"
    ? children({ faviconDataUrl: preview?.faviconDataUrl ?? null })
    : children;

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (!href) return undefined;
    let active = true;
    const load = () => getLinkPreview(href).then((result) => {
      if (active) {
        previewHref.current = href;
        setPreview(result);
      }
    });
    const element = wrapperRef.current;
    if (!element || !("IntersectionObserver" in window)) {
      void load();
      return () => { active = false; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    }, { rootMargin: "80px" });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [href]);

  function show(event) {
    if (!href) return;
    window.clearTimeout(hideTimer.current);
    const currentRequest = ++requestId.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 32);
    const left = Math.max(16, Math.min(window.innerWidth - width - 16, bounds.left));
    const below = bounds.bottom + 8;
    const top = below + 150 < window.innerHeight ? below : Math.max(8, bounds.top - 158);
    setPosition({ left, top, width });
    setOpen(true);
    if (previewHref.current !== href) {
      let domain = "Link preview";
      try { domain = new URL(href).hostname.replace(/^www\./, ""); } catch { /* The runtime will reject unsupported addresses. */ }
      setPreview({ domain, title: "Loading preview…", description: "" });
    }
    getLinkPreview(href).then((result) => {
      if (requestId.current === currentRequest) {
        previewHref.current = href;
        setPreview(result);
      }
    });
  }

  function keepOpen() {
    window.clearTimeout(hideTimer.current);
  }

  function hideSoon() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      requestId.current += 1;
      setOpen(false);
    }, 450);
  }

  return <>
    <span className={`message-link-preview-wrap ${className}`.trim()} onBlur={hideSoon} onFocus={show} onMouseEnter={show} onMouseLeave={hideSoon} ref={wrapperRef}>
      {renderChildren}
    </span>
    {open && position && preview && typeof document !== "undefined" && createPortal(<span className={`message-link-hover-preview${preview.title === "Loading preview…" ? " message-link-hover-preview--loading" : ""}`} onMouseEnter={keepOpen} onMouseLeave={hideSoon} role="tooltip" style={{ left: position.left, top: position.top, width: position.width }}>
      <span aria-hidden="true" className="message-link-preview-icon">{preview.faviconDataUrl ? <img alt="" src={preview.faviconDataUrl} /> : <GlobeSimple size={16} />}</span>
      <span className="message-link-preview-copy"><small>{preview.domain}</small>{preview.title && <strong>{preview.title}</strong>}{preview.description && <span>{preview.description}</span>}</span>
      <ArrowSquareOut aria-hidden="true" className="message-link-preview-open" size={14} />
    </span>, document.body)}
  </>;
}
