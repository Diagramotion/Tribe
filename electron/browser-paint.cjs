const VIEWPORT_PAINT_TIMEOUT_MS = 180;

async function waitForBrowserPaint(contents, timeoutMs = VIEWPORT_PAINT_TIMEOUT_MS) {
  if (!contents || contents.isDestroyed()) return;

  let timeout;
  const fallback = new Promise((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  const paint = contents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    true,
  ).catch(() => {});

  await Promise.race([paint, fallback]);
  clearTimeout(timeout);
}

module.exports = { waitForBrowserPaint };
