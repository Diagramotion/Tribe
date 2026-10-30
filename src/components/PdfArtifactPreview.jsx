import { useEffect, useState } from "react";
import { runtime } from "../api/runtime.js";

export function PdfArtifactPreview({ artifact }) {
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setLoading(true);
    setError("");
    setImageUrl("");
    runtime.previewPdfArtifactPage(artifact.id, page)
      .then(({ blob, pageCount: count }) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
        setPageCount(count);
      })
      .catch((loadError) => { if (active) setError(loadError.message || "Could not preview this PDF page."); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, page]);

  async function downloadPdf() {
    if (downloading) return;
    setDownloading(true);
    setError("");
    try {
      const { contentBase64 } = await runtime.getArtifact(artifact.id);
      const binary = atob(contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (downloadError) {
      setError(downloadError.message || "Could not download this PDF.");
    } finally {
      setDownloading(false);
    }
  }

  return <section aria-label={`${artifact.name} PDF preview`} className="pdf-artifact-view">
    <div className="pdf-artifact-toolbar">
      <div className="pdf-artifact-pages">
        <button aria-label="Previous page" className="button button--quiet" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
        <span aria-live="polite">Page {page} of {pageCount ?? "…"}</span>
        <button aria-label="Next page" className="button button--quiet" disabled={!pageCount || page >= pageCount || loading} onClick={() => setPage((current) => Math.min(pageCount ?? current, current + 1))} type="button">Next</button>
      </div>
      <div className="pdf-artifact-zoom">
        <button aria-label="Zoom out" className="button button--quiet" disabled={zoom <= 75} onClick={() => setZoom((value) => Math.max(75, value - 25))} type="button">−</button>
        <span>{zoom}%</span>
        <button aria-label="Zoom in" className="button button--quiet" disabled={zoom >= 200} onClick={() => setZoom((value) => Math.min(200, value + 25))} type="button">+</button>
        {zoom !== 100 && <button className="button button--quiet" onClick={() => setZoom(100)} type="button">Reset</button>}
      </div>
      <button className="button button--quiet" disabled={downloading} onClick={() => void downloadPdf()} type="button">{downloading ? "Downloading…" : "Download PDF"}</button>
    </div>
    {error && <p className="pdf-artifact-error" role="alert">{error}</p>}
    <div className="pdf-artifact-stage">
      {loading && <p role="status">Rendering page {page}…</p>}
      {!loading && imageUrl && <img alt={`Page ${page} of ${artifact.name}`} src={imageUrl} style={{ width: `${zoom}%` }} />}
      {!loading && !error && !imageUrl && <p role="status">This PDF page is unavailable.</p>}
    </div>
  </section>;
}
