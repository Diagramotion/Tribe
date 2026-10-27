import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise, ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  ArrowsOutSimple, MagnifyingGlassMinus, MagnifyingGlassPlus, X,
} from "@phosphor-icons/react";
import { renderCanvasDiagramSvg } from "../domain/canvas-export.js";

function DiagramViewport({ svg, loading, hasEnteredViewport, zoom, pan, onPanChange, viewportRef }) {
  const dragRef = useRef(null);

  function beginPan(event) {
    if (event.button !== 0 || zoom <= 1 || !svg || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
  }

  function movePan(event) {
    if (!dragRef.current || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    onPanChange({ x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y });
  }

  function endPan(event) {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function panWithArrow(event) {
    if (zoom <= 1) return;
    const direction = {
      ArrowLeft: [-48, 0],
      ArrowRight: [48, 0],
      ArrowUp: [0, -48],
      ArrowDown: [0, 48],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    onPanChange({ x: pan.x + direction[0], y: pan.y + direction[1] });
  }

  const isRendering = hasEnteredViewport && loading;
  return <div aria-busy={isRendering} aria-label={isRendering ? "Rendering Mermaid diagram" : svg ? "Rendered Mermaid diagram. Drag or use the arrow keys to pan when zoomed in." : "Diagram preview loads when visible"} className={`message-diagram-preview ${zoom > 1 ? "message-diagram-preview--zoomed" : ""}`} onKeyDown={panWithArrow} onPointerCancel={endPan} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} ref={viewportRef} role="img" tabIndex={zoom > 1 ? 0 : -1} title={zoom > 1 ? "Drag to pan the diagram; use arrow keys when focused" : "Zoom in to pan the diagram"}>
    {!svg && <span className="message-diagram-loading" role={isRendering ? "status" : undefined}>{isRendering ? "Rendering diagram…" : "Diagram preview loads when visible…"}</span>}
    <div aria-hidden="true" className="message-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }} />
  </div>;
}

function DiagramControls({ zoom, pan, setZoom, setPan, constrainPan, onPan, onReset, canReset, onExpand, expanded, onClose, expandRef }) {
  const button = (label, icon, onClick, disabled = false, autoFocus = false, ref = undefined) => <button aria-label={label} autoFocus={autoFocus} className="diagram-control-button" disabled={disabled} onClick={onClick} ref={ref} title={label} type="button">{icon}</button>;
  const zoomBy = (delta) => {
    const next = Math.min(3, Math.max(.5, zoom + delta));
    setZoom(next);
    setPan(next <= 1 ? { x: 0, y: 0 } : constrainPan(pan, next));
  };
  return <div aria-label="Diagram controls" className={`message-diagram-controls ${expanded ? "message-diagram-controls--expanded" : "message-diagram-controls--compact"} ${zoom > 1 ? "message-diagram-controls--zoomed" : ""}`} role="group">
    {button("Zoom out", <MagnifyingGlassMinus size={15} />, () => zoomBy(-.25), zoom <= .5)}
    <span aria-live="polite" className="diagram-zoom-level">{Math.round(zoom * 100)}%</span>
    {button("Zoom in", <MagnifyingGlassPlus size={15} />, () => zoomBy(.25), zoom >= 3)}
    <span aria-hidden="true" className="diagram-control-divider diagram-control-divider--pan" />
    <div aria-label="Pan diagram" className="diagram-pan-controls" role="group">
      {button("Move diagram left", <ArrowLeft size={14} />, () => onPan(-48, 0), zoom <= 1)}
      {button("Move diagram up", <ArrowUp size={14} />, () => onPan(0, -48), zoom <= 1)}
      {button("Move diagram down", <ArrowDown size={14} />, () => onPan(0, 48), zoom <= 1)}
      {button("Move diagram right", <ArrowRight size={14} />, () => onPan(48, 0), zoom <= 1)}
    </div>
    <span aria-hidden="true" className="diagram-control-divider diagram-control-divider--pan" />
    {button("Reset diagram view", <ArrowCounterClockwise size={14} />, onReset, !canReset)}
    {expanded
      ? button("Close expanded diagram", <X size={15} />, onClose, false, true)
      : button("Expand diagram", <ArrowsOutSimple size={15} />, onExpand, false, false, expandRef)}
  </div>;
}

export function DiagramPreview({ source }) {
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasEnteredViewport, setHasEnteredViewport] = useState(false);
  const [svg, setSvg] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const widgetRef = useRef(null);
  const viewportRef = useRef(null);
  const clampPanRef = useRef(null);
  const expandButtonRef = useRef(null);
  const wasExpandedRef = useRef(false);

  function clampPan(next, scale = zoom) {
    const viewport = viewportRef.current;
    const diagram = viewport?.querySelector("svg");
    if (!viewport || !diagram || scale <= 1) return { x: 0, y: 0 };
    const style = window.getComputedStyle(viewport);
    const availableWidth = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const bounds = diagram.getBoundingClientRect();
    const layoutWidth = bounds.width / zoom;
    const layoutHeight = bounds.height / zoom;
    const maxX = Math.max(0, (layoutWidth * scale - availableWidth) / 2);
    const maxY = Math.max(0, (layoutHeight * scale - availableHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }

  clampPanRef.current = clampPan;

  function panBy(x, y) {
    setPan((current) => clampPan({ x: current.x + x, y: current.y + y }));
  }

  function changePan(next) {
    setPan(clampPan(next));
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return undefined;
    const bounds = widget.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (bounds.width > 0 && bounds.height > 0
      && bounds.bottom >= -600 && bounds.top <= viewportHeight + 600
      && bounds.right > 0 && bounds.left < viewportWidth) {
      setHasEnteredViewport(true);
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setHasEnteredViewport(true);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setHasEnteredViewport(true);
      observer.disconnect();
    }, { rootMargin: "600px 0px", threshold: 0 });
    observer.observe(widget);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hasEnteredViewport) return undefined;
    let active = true;
    setError(false);
    setLoading(true);
    renderCanvasDiagramSvg({ kind: "diagram", body: source }).then((renderedSvg) => {
      if (active) {
        setSvg(renderedSvg);
        setLoading(false);
      }
    }).catch(() => {
      if (active) {
        setError(true);
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, [hasEnteredViewport, source]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      setPan((current) => clampPanRef.current?.(current) ?? current);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded, svg]);

  useEffect(() => {
    if (!expanded) return undefined;
    const root = document.documentElement;
    const body = document.body;
    const scrollY = window.scrollY;
    const rootOverflow = root.style.overflow;
    const bodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      root.style.overflow = rootOverflow;
      body.style.overflow = bodyOverflow;
      window.scrollTo({ top: scrollY, behavior: "instant" });
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return undefined;
    function closeOnEscape(event) {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  useEffect(() => {
    if (wasExpandedRef.current && !expanded) expandButtonRef.current?.focus();
    wasExpandedRef.current = expanded;
  }, [expanded]);

  function keepFocusInside(event) {
    if (!expanded || event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll("button:not(:disabled), [tabindex]:not([tabindex='-1'])")];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  if (error) return <div className="message-diagram-error" role="status">
    <p>Diagram preview unavailable. Source is shown below.</p>
    <pre><code>{source}</code></pre>
  </div>;

  const surface = <DiagramViewport hasEnteredViewport={hasEnteredViewport} loading={loading} onPanChange={changePan} pan={pan} svg={svg} viewportRef={viewportRef} zoom={zoom} />;
  return <>
    {!expanded && <div className="message-diagram-widget" ref={widgetRef}>
      <DiagramControls canReset={zoom !== 1 || pan.x !== 0 || pan.y !== 0} constrainPan={clampPan} expandRef={expandButtonRef} expanded={false} onExpand={() => { setHasEnteredViewport(true); setExpanded(true); }} onPan={panBy} onReset={resetView} pan={pan} setPan={setPan} setZoom={setZoom} zoom={zoom} />
      {surface}
    </div>}
    {expanded && createPortal(<div className="message-diagram-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }} role="presentation">
      <section aria-label="Expanded diagram preview" aria-modal="true" className="message-diagram-modal" onKeyDown={keepFocusInside} role="dialog">
        <header className="message-diagram-modal-header"><strong>Diagram preview</strong><DiagramControls canReset={zoom !== 1 || pan.x !== 0 || pan.y !== 0} constrainPan={clampPan} expanded onClose={() => setExpanded(false)} onPan={panBy} onReset={resetView} pan={pan} setPan={setPan} setZoom={setZoom} zoom={zoom} /></header>
        {surface}
      </section>
    </div>, document.body)}
  </>;
}
