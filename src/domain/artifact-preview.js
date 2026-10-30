const INLINE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

const INLINE_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
]);

const INLINE_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

const PLAYABLE_MEDIA_TYPE_ALIASES = new Map([
  ["audio/m4a", "audio/mp4"],
  ["audio/mp3", "audio/mpeg"],
  ["audio/x-m4a", "audio/mp4"],
  ["audio/x-mp3", "audio/mpeg"],
  ["video/m4v", "video/mp4"],
  ["video/x-m4v", "video/mp4"],
]);

export function playableMediaType(mediaType) {
  const type = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  const normalized = PLAYABLE_MEDIA_TYPE_ALIASES.get(type) ?? type;
  return INLINE_AUDIO_TYPES.has(normalized) || INLINE_VIDEO_TYPES.has(normalized) ? normalized : null;
}

export function playableMediaKind(mediaType) {
  const type = playableMediaType(mediaType);
  if (type?.startsWith("audio/")) return "audio";
  if (type?.startsWith("video/")) return "video";
  return null;
}

export function inlineImagePreview(mediaType, contentBase64) {
  const type = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!INLINE_IMAGE_TYPES.has(type) || typeof contentBase64 !== "string" || !contentBase64) {
    return null;
  }
  return `data:${type};base64,${contentBase64}`;
}
