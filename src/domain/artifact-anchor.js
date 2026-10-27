export function imagePointAnchor(clientX, clientY, rect) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
      || rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { type: "image_point", x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

export function isImagePointAnchor(anchor) {
  return anchor?.type === "image_point"
    && Number.isFinite(anchor.x) && anchor.x >= 0 && anchor.x <= 1
    && Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= 1;
}
