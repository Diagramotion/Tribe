export function secureInteractiveDocument(source) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'; manifest-src 'none">`;
  const styles = `<style>
:root {
  --tribe-ui-canvas: #f4f6f7;
  --tribe-ui-surface: #ffffff;
  --tribe-ui-ink: #20282d;
  --tribe-ui-muted: #657178;
  --tribe-ui-line: #d8e0e2;
  --tribe-ui-accent: #176b58;
  --tribe-ui-accent-ink: #ffffff;
  --tribe-ui-radius: 12px;
  color-scheme: light;
  color: var(--tribe-ui-ink);
  font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
html { min-width: 0; }
body { min-width: 0; margin: 0; padding: 16px; background: var(--tribe-ui-canvas); color: var(--tribe-ui-ink); }
button, input, select, textarea { font: inherit; color: inherit; }
button { min-height: 40px; padding: 8px 14px; border: 1px solid var(--tribe-ui-line); border-radius: 9px; background: var(--tribe-ui-surface); cursor: pointer; }
button:hover { border-color: var(--tribe-ui-accent); }
button:disabled { cursor: not-allowed; opacity: .55; }
input, select, textarea { min-width: 0; min-height: 40px; padding: 8px 11px; border: 1px solid var(--tribe-ui-line); border-radius: 9px; background: var(--tribe-ui-surface); }
textarea { resize: vertical; }
label { display: block; color: var(--tribe-ui-muted); font-size: .88rem; font-weight: 600; }
a { color: var(--tribe-ui-accent); }
:focus-visible { outline: 3px solid color-mix(in srgb, var(--tribe-ui-accent) 40%, transparent); outline-offset: 2px; }
.tribe-ui-app { width: min(100%, 880px); margin-inline: auto; display: grid; gap: 16px; }
.tribe-ui-header { display: grid; gap: 4px; }
.tribe-ui-eyebrow { color: var(--tribe-ui-muted); font-size: .76rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.tribe-ui-title { margin: 0; font-size: clamp(1.35rem, 4vw, 1.8rem); line-height: 1.15; letter-spacing: -.025em; }
.tribe-ui-description, .tribe-ui-muted { margin: 0; color: var(--tribe-ui-muted); }
.tribe-ui-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; }
.tribe-ui-panel, .tribe-ui-result { padding: 16px; border: 1px solid var(--tribe-ui-line); border-radius: var(--tribe-ui-radius); background: var(--tribe-ui-surface); }
.tribe-ui-field { display: grid; gap: 6px; }
.tribe-ui-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tribe-ui-button-primary { border-color: var(--tribe-ui-accent); background: var(--tribe-ui-accent); color: var(--tribe-ui-accent-ink); font-weight: 700; }
.tribe-ui-result-value { font-size: clamp(1.7rem, 5vw, 2.3rem); font-weight: 750; line-height: 1.05; letter-spacing: -.03em; }
@media (max-width: 480px) { body { padding: 12px; } .tribe-ui-panel, .tribe-ui-result { padding: 13px; } }
</style>`;
  const bridge = `<script>
Object.defineProperty(window, "tribe", { configurable: false, writable: false, value: Object.freeze({ postAction: (name, data) => window.parent.postMessage({ __tribeInteractive: true, type: "action", name, data }, "*") }) });
(() => {
  let lastHeight = 0;
  const reportHeight = () => {
    const rootHeight = document.documentElement?.scrollHeight || 0;
    const viewportHeight = window.innerHeight || 0;
    const bodyHeight = document.body?.getBoundingClientRect().height || 0;
    const height = Math.ceil(Math.max(bodyHeight, rootHeight > viewportHeight ? rootHeight : 0));
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      window.parent.postMessage({ __tribeInteractive: true, type: "resize", height }, "*");
    }
  };
  const observer = new ResizeObserver(reportHeight);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  window.addEventListener("load", reportHeight, { once: true });
  window.setTimeout(reportHeight, 0);
})();
</script>`;
  const html = source
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "")
    .replace(/<(?:iframe|frame|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|frame|object|embed)\s*>/gi, "")
    .replace(/<(?:iframe|frame|object|embed)\b[^>]*\/?\s*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}${styles}${bridge}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}<head>${policy}${styles}${bridge}</head>`);
  }
  return `<!doctype html><head>${policy}${styles}${bridge}</head><body>${html}</body>`;
}
