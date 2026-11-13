const languageExtensions = Object.freeze({
  javascript: "js", typescript: "ts", python: "py", rust: "rs", shell: "sh", bash: "sh",
  markdown: "md", json: "json", yaml: "yaml", html: "html", css: "css", sql: "sql",
  toml: "toml", go: "go", java: "java", csharp: "cs", "c#": "cs",
});

export function canvasFilename(document, { revision, draft = false, format } = {}) {
  const title = (document.title || "shared-document")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "shared-document";
  const language = (document.language || "").trim().toLowerCase();
  const extension = format === "svg" && document.kind === "diagram" ? "svg"
    : document.kind === "markdown" ? "md"
    : document.kind === "diagram" ? "mmd"
      : document.kind === "code" ? languageExtensions[language] ?? (/^[a-z0-9]{1,8}$/.test(language) ? language : "txt")
        : "txt";
  const suffix = draft ? "-draft" : Number.isInteger(revision) ? `-revision-${revision}` : "";
  return `${title}${suffix}.${extension}`;
}

export function downloadCanvasDocument(document, filename) {
  const mimeType = document.kind === "markdown" ? "text/markdown;charset=utf-8"
    : document.kind === "diagram" ? "text/vnd.mermaid;charset=utf-8"
      : "text/plain;charset=utf-8";
  const blob = new Blob([document.body ?? ""], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function renderCanvasDiagramSvg(document) {
  if (document.kind !== "diagram" || !document.body?.trim()) {
    throw new Error("Only a non-empty diagram can be exported as SVG.");
  }
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      background: "#0d1928",
      primaryColor: "#172b43",
      primaryTextColor: "#e8eff9",
      primaryBorderColor: "#4a789f",
      secondaryColor: "#122238",
      secondaryTextColor: "#dce8f5",
      secondaryBorderColor: "#3b668b",
      tertiaryColor: "#101d2d",
      tertiaryTextColor: "#c3d2e2",
      tertiaryBorderColor: "#344e68",
      dropShadow: "none",
      lineColor: "#91a4bd",
      noteBkgColor: "#1b2c40",
      noteTextColor: "#e8eff9",
      noteBorderColor: "#5b728b",
      edgeLabelBackground: "#0d1928",
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      fontSize: "15px",
    },
  });
  const id = `tribe-diagram-export-${globalThis.crypto.randomUUID()}`;
  const { svg } = await mermaid.render(id, document.body);
  // Mermaid embeds the diagram's intrinsic width as a max-width, which prevents
  // responsive chat previews and expanded previews from using their viewport.
  return svg.replace(/style="max-width:\s*[^\"]+"/, 'style="max-width: 100%"');
}

export function downloadCanvasSvg(svg, filename) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
