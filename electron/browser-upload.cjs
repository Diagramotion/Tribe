function validateUploadTarget(target, ref, origin) {
  if (!/^[a-f0-9]{16}-\d{1,3}$/.test(String(ref || "")) || target?.ref !== ref) {
    throw new Error("Take a fresh browser snapshot and choose a current file-input reference.");
  }
  if (target.tagName !== "INPUT" || target.type !== "file") {
    throw new Error("Choose a file input from the latest browser snapshot.");
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("Files can only be selected for a visible HTTP or HTTPS page.");
  }
  if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error("Files can only be selected for a visible HTTP or HTTPS page.");
  }
  const validated = {
    ref,
    origin: parsedOrigin.origin,
    multiple: Boolean(target.multiple),
    accept: typeof target.accept === "string" ? target.accept.slice(0, 256) : "",
  };
  if (Number.isFinite(target.point?.x) && Number.isFinite(target.point?.y)) {
    validated.point = { x: Math.round(target.point.x), y: Math.round(target.point.y) };
  }
  return validated;
}

function normaliseFileSelection(selection, origin) {
  if (selection?.timedOut === true) return { uploaded: false, timedOut: true, origin };
  const count = Number(selection?.selectedCount);
  if (selection?.cancelled === true || !Number.isSafeInteger(count) || count < 1) {
    return { uploaded: false, cancelled: true, origin };
  }
  return { uploaded: false, filesSelected: true, fileCount: Math.min(count, 1000), origin };
}

module.exports = { normaliseFileSelection, validateUploadTarget };
