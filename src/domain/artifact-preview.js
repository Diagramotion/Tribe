const INLINE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

export function inlineImagePreview(mediaType, contentBase64) {
  const type = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!INLINE_IMAGE_TYPES.has(type) || typeof contentBase64 !== "string" || !contentBase64) {
    return null;
  }
  return `data:${type};base64,${contentBase64}`;
}
