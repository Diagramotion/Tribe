import { useEffect, useRef, useState } from "react";
import { runtime } from "../api/runtime.js";
import { playableMediaKind, playableMediaType } from "../domain/artifact-preview.js";

function decodeBase64(base64) {
  if (typeof base64 !== "string" || !base64) throw new Error("No media data is available for preview.");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function MediaArtifactPreview({ artifact, compact = false }) {
  const kind = playableMediaKind(artifact.media_type ?? artifact.type);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const objectUrlRef = useRef("");

  useEffect(() => {
    let active = true;
    setSource("");
    setError("");
    if (!kind) return undefined;
    runtime.getArtifact(artifact.id).then(({ artifact: loadedArtifact, contentBase64 }) => {
      if (playableMediaKind(loadedArtifact.media_type) !== kind) {
        throw new Error("This file format cannot be played in the preview.");
      }
      const url = URL.createObjectURL(new Blob([decodeBase64(contentBase64)], {
        type: playableMediaType(loadedArtifact.media_type),
      }));
      if (active) {
        objectUrlRef.current = url;
        setSource(url);
      } else {
        URL.revokeObjectURL(url);
      }
    }).catch((loadError) => {
      if (active) setError(loadError.message || "Media preview could not be loaded.");
    });
    return () => {
      active = false;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
    };
  }, [artifact.id, kind]);

  if (!kind) return null;
  const handlePlaybackError = () => setError("This media file could not be played in your browser.");
  return <div className={`media-artifact-preview${compact ? " media-artifact-preview--compact" : ""}`}>
    {error
      ? <p className="media-artifact-preview-status" role="status">{error}</p>
      : !source
        ? <p className="media-artifact-preview-status" role="status">Loading {kind} preview…</p>
        : kind === "audio"
          ? <audio aria-label={`Play ${artifact.name}`} controls onError={handlePlaybackError} preload="metadata" src={source} />
          : <video aria-label={`Play ${artifact.name}`} controls onError={handlePlaybackError} playsInline preload="metadata" src={source} />}
  </div>;
}
