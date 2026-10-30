const VIEWPORT_PRESETS = Object.freeze({
  responsive: null,
  "iphone-15": Object.freeze({ width: 393, height: 852, screenPosition: "mobile", deviceScaleFactor: 3 }),
  "pixel-7": Object.freeze({ width: 412, height: 915, screenPosition: "mobile", deviceScaleFactor: 3 }),
  "ipad-mini": Object.freeze({ width: 768, height: 1024, screenPosition: "mobile", deviceScaleFactor: 2 }),
  "laptop-1280": Object.freeze({ width: 1280, height: 800, screenPosition: "desktop", deviceScaleFactor: 1 }),
});

function resolveViewport(value) {
  if (typeof value === "string" && Object.hasOwn(VIEWPORT_PRESETS, value)) {
    return { name: value, customViewport: null, config: VIEWPORT_PRESETS[value] };
  }
  if (value && typeof value === "object") {
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 3840 || height < 240 || height > 3840) {
      throw new Error("Custom viewport width and height must be between 240 and 3840 pixels.");
    }
    const config = Object.freeze({ width, height, screenPosition: "desktop", deviceScaleFactor: 1 });
    return { name: "custom", customViewport: Object.freeze({ width, height }), config };
  }
  throw new Error("Choose a supported browser viewport.");
}

function viewportBounds(config, availableSize) {
  if (!config || !availableSize) return { x: 0, y: 0, width: availableSize?.width || 0, height: availableSize?.height || 0 };
  const scale = Math.min(1, availableSize.width / config.width, availableSize.height / config.height);
  const width = Math.max(1, Math.round(config.width * scale));
  const height = Math.max(1, Math.round(config.height * scale));
  return {
    x: Math.max(0, Math.floor((availableSize.width - width) / 2)),
    y: Math.max(0, Math.floor((availableSize.height - height) / 2)),
    width,
    height,
  };
}

module.exports = { VIEWPORT_PRESETS, resolveViewport, viewportBounds };
