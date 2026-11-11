import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Desktop, DeviceMobile, DeviceTablet, DownloadSimple, FloppyDisk, FolderOpen, Globe, MagnifyingGlass, PencilSimple, Plus, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { MarkdownContent } from "../components/MarkdownContent.jsx";
import { SelectControl } from "../components/SelectControl.jsx";
import { addDesignSystemPackageFile, DESIGN_SYSTEM_PRESETS, DESIGN_SYSTEM_VIEWPORTS, MAX_DESIGN_SYSTEM_IMPORT_BYTES, MAX_DESIGN_SYSTEM_SNAPSHOT_BYTES, compareDesignSystemSnapshots, contrastRatio, designSystemFromReference, designSystemGuideHeadings, designSystemPreviewThemeAttributes, designSystemPreviewThemeOptions, designSystemTokenCss, designSystemTokenJson, extractStaticThemeDeclarations, generateColourScale, generateDesignPalettes, mergeDesignSystemReferenceCapture, packageTokenInventory, packageTokensFromCss, parseDesignSystemImport, parseDesignSystemPackage, parseDesignSystemPackageLibrary, removeDesignSystemPackageFile, syncPackageTokens, validateDesignSystemPackageFilePath } from "../domain/design-systems.js";
import { runtime } from "../api/runtime.js";
import { preparePackagePreview, sanitizePackageSvg } from "../domain/design-system-preview-sanitizer.js";

const viewportIcons = { wide: Desktop, tablet: DeviceTablet, mobile: DeviceMobile };
const colorLabels = [
  ["canvas", "Canvas"], ["surface", "Surface"], ["raised", "Raised"],
  ["text", "Text"], ["muted", "Secondary text"], ["accent", "Accent"],
  ["line", "Border"], ["focus", "Focus"], ["success", "Success"],
  ["warning", "Warning"], ["danger", "Error"],
];
const paletteCards = [
  ["canvas", "Canvas", "Page background and main reading surface."],
  ["surface", "Surface", "Quiet grouping surface for related content."],
  ["raised", "Raised surface", "Higher emphasis surfaces and controls."],
  ["text", "Primary text", "Headings and essential content."],
  ["accent", "Accent", "Interactive, selected and focus states."],
  ["line", "Border", "Control edges and structural separation."],
  ["success", "Success", "Positive state and completion."],
  ["warning", "Warning", "Attention and review states."],
  ["danger", "Error", "Destructive actions and error states."],
];
const scalarTokens = [
  ["radius", "Corner radius", ["0px", "4px", "6px", "8px", "10px", "12px", "16px", "20px", "24px", "32px"]],
  ["spacing", "Base spacing", ["2px", "4px", "8px", "12px", "16px", "20px", "24px", "28px", "32px"]],
  ["fontSize", "Body text size", ["12px", "13px", "14px", "15px", "16px", "17px", "18px", "19px", "20px"]],
];
const EMPTY_PROJECT = [{ label: "Choose a project", value: "", disabled: true }];
const PACKAGE_ASSET_MIME_TYPES = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf",
};

function packageAssetName(file) {
  const raw = String(file.name ?? "asset").split(/[\\/]/).at(-1);
  const extension = raw.split(".").at(-1).toLowerCase();
  if (!PACKAGE_ASSET_MIME_TYPES[extension]) throw new Error("Choose an SVG, PNG, JPEG, GIF, WebP, AVIF, WOFF, WOFF2, TTF or OTF asset.");
  const stem = raw.slice(0, -(extension.length + 1)).normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "asset";
  return `${stem}.${extension}`;
}

function packageAssetData(file, mimeType) {
  if (file.name.toLowerCase().endsWith(".svg")) return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result.replace(/^data:[^,]*,/, `data:${mimeType};base64,`))
      : reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function defaultSystemCategory(item) {
  return item.category ?? (item.source === "starter" ? "Starters" : item.source === "curated" ? "Curated" : "Personal");
}

function designSystemSearchText(system) {
  const metadata = [
    system.name, system.description, system.category, system.sourceLabel,
    system.license, system.attribution, system.sourceUrl, system.packageVersion,
    ...(system.tags ?? []), ...(system.references ?? []).flatMap((item) => [item.label, item.url]),
    system.manifest?.source?.name, system.manifest?.source?.origin, system.manifest?.source?.url,
  ];
  let budget = 180_000;
  const packageText = [];
  for (const file of system.packageFiles ?? []) {
    if (budget <= 0) break;
    if (!/\.(?:md|css|json|html|txt)$/i.test(file.path) || typeof file.content !== "string" || file.content.startsWith("data:")) continue;
    const excerpt = file.content.slice(0, Math.min(file.content.length, budget));
    packageText.push(file.path, excerpt);
    budget -= excerpt.length;
  }
  return [...metadata, ...packageText].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase();
}

function presetSnapshot(preset) {
  const packageFiles = preset.packageFiles?.length ? preset.packageFiles : starterPackage(preset);
  return {
    ...preset,
    version: preset.version ?? 1,
    components: preset.components ?? {},
    guidance: preset.guidance ?? "",
    references: preset.references ?? [],
    palettes: Object.keys(preset.palettes ?? {}).length ? preset.palettes : generateDesignPalettes(preset.tokens),
    manifest: preset.manifest ?? JSON.parse(packageFiles.find((file) => file.path === "manifest.json").content),
    packageFiles,
  };
}

function starterPackage(system) {
  const slug = system.id || system.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "system");
  const tokens = system.tokens;
  const sourceUrl = system.sourceUrl || system.references?.[0]?.url || "";
  const sourceName = sourceUrl ? "Visual reference" : "Tribe starter";
  const manifest = {
    id: slug,
    name: system.name,
    description: system.description,
    category: system.category ?? "Starter",
    tags: system.tags ?? [],
    version: "1.0.0",
    source: { name: sourceName, ...(sourceUrl ? { url: sourceUrl } : {}) },
    license: system.license || (sourceUrl ? "Not declared; review source terms" : "Tribe starter content"),
    files: { design: "DESIGN.md", usage: "USAGE.md", tokens: "tokens.css", components: "components.html" },
    preview: { pages: [{ title: "Components", path: "components.html", role: "components" }] },
  };
  const tokenCss = `:root {\n${Object.entries({ bg: tokens.canvas, surface: tokens.surface, "surface-raised": tokens.raised, fg: tokens.text, "fg-muted": tokens.muted, accent: tokens.accent, border: tokens.line, focus: tokens.focus, success: tokens.success, warning: tokens.warning, danger: tokens.danger, radius: tokens.radius, space: tokens.spacing, "text-base": tokens.fontSize, "font-body": tokens.font }).map(([name, value]) => `  --${name}: ${value};`).join("\n")}\n}\n`;
  const components = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:var(--text-base) var(--font-body);background:var(--bg);color:var(--fg);padding:clamp(16px,4vw,32px)}main{max-width:900px;margin:auto;display:grid;gap:24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1,h2,p{margin:0}h1{font-size:1.5rem}small,.muted{color:var(--fg-muted)}section{display:grid;gap:12px}article,.field{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space)}.actions,.states{display:flex;flex-wrap:wrap;align-items:center;gap:10px}button,input{font:inherit;border-radius:var(--radius);padding:10px 14px}button{border:1px solid var(--border);background:var(--surface-raised);color:var(--fg);cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button:disabled{opacity:.5;cursor:not-allowed}input{width:min(100%,360px);background:var(--bg);border:1px solid var(--border);color:var(--fg)}.badge{padding:5px 9px;border-radius:999px;background:var(--success);color:var(--bg)}.badge.warn{background:var(--warning)}.badge.error{background:var(--danger)}@media(max-width:520px){header{align-items:flex-start;flex-direction:column}.actions{align-items:stretch}.actions button{width:100%}}
</style></head><body><main><header><div><small>COMPONENT SPECIMENS</small><h1>${system.name}</h1></div><button class="primary">Primary action</button></header><section><h2>Buttons</h2><div class="actions"><button class="primary">Continue</button><button>Secondary</button><button disabled>Disabled</button></div></section><section><h2>Form field</h2><label class="field">Project name<br><input aria-label="Project name" placeholder="Enter a name" value="Northstar"></label></section><section><h2>Surfaces and status</h2><article><h2>Project overview</h2><p class="muted">A representative content surface using the selected foundation tokens.</p><div class="states"><span class="badge">Ready</span><span class="badge warn">Review due</span><span class="badge error">Blocked</span></div></article></section></main></body></html>`;
  return [
    { path: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    { path: "DESIGN.md", content: `${system.name}\n\n${system.guidance || system.description}\n\n## Foundations\n\nTypography, spacing, surface, focus and semantic colours follow the package tokens. Review the component fixture at wide, tablet and mobile widths before applying changes.\n` },
    { path: "USAGE.md", content: "Read DESIGN.md and tokens.css before implementation. Use components.html to review real control states and responsive behaviour. Preserve semantic token names and keep focus, disabled and status states visible.\n" },
    { path: "tokens.css", content: tokenCss },
    { path: "components.html", content: components },
    { path: "design-tokens.json", content: JSON.stringify({ format: "tribe-design-tokens/v1", tokens: Object.fromEntries(Object.entries(tokens).map(([name, value]) => [name, { value }])) }, null, 2) },
    { path: "source/evidence.md", content: system.attribution || (sourceUrl ? `This draft was extracted from visible computed styles at ${sourceUrl}. Values are inferred from one page; assets and brand ownership were not verified. Review the values and source terms before reuse.\n` : "This package was created from a Tribe starter. It does not claim to reproduce an external brand system.\n") },
    ...(system.sourceEvidence ? [{ path: "source/evidence.json", content: JSON.stringify(system.sourceEvidence, null, 2) }] : []),
  ];
}

function editableDraft(system) {
  return {
    ...system,
    source: "user",
    category: system.category ?? "Starter",
    license: system.license ?? (system.sourceUrl || system.references?.length ? "Not declared; review source terms" : "Tribe starter content"),
    sourceUrl: system.sourceUrl ?? system.references?.[0]?.url ?? "",
    tokens: { ...system.tokens },
    components: { button: "", card: "", input: "", ...system.components },
    guidance: system.guidance ?? "",
    references: [...(system.references ?? [])],
    palettes: Object.keys(system.palettes ?? {}).length ? system.palettes : generateDesignPalettes(system.tokens),
    manifest: system.manifest ?? JSON.parse(starterPackage(system).find((file) => file.path === "manifest.json").content),
    packageFiles: system.packageFiles?.length ? system.packageFiles.map((file) => ({ ...file })) : starterPackage(system),
  };
}

function triggerSystemDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function downloadSystem(system) {
  const blob = new Blob([`${JSON.stringify(system, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const slug = system.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design-system";
  triggerSystemDownload(blob, `${slug}.json`);
}

function downloadSystemTokens(system, format) {
  const slug = system.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design-system";
  if (format === "css") {
    const blob = new Blob([designSystemTokenCss(system)], { type: "text/css;charset=utf-8" });
    triggerSystemDownload(blob, `${slug}-tokens.css`);
    return;
  }

  const blob = new Blob([designSystemTokenJson(system)], { type: "application/json;charset=utf-8" });
  triggerSystemDownload(blob, `${slug}-design-tokens.json`);
}

function packagePreviewEntries(system) {
  const files = system.packageFiles ?? [];
  const html = new Map(files.filter(({ path }) => path.toLowerCase().endsWith(".html")).map((item) => [item.path, item]));
  const entries = [];
  const componentPath = system.manifest?.files?.components ?? "components.html";
  if (html.has(componentPath)) entries.push({ path: componentPath, label: "Components", role: "components" });
  const pages = system.manifest?.preview?.pages;
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (typeof page?.path === "string" && html.has(page.path)) {
        entries.push({ path: page.path, label: String(page.title ?? page.role ?? page.path).slice(0, 50), role: String(page.role ?? "preview") });
      }
    }
  }
  for (const path of html.keys()) {
    if (!entries.some((entry) => entry.path === path)) {
      entries.push({ path, label: path.split("/").at(-1).replace(/\.html$/i, "").replace(/[._-]+/g, " "), role: "preview" });
    }
  }
  return entries;
}

function packageGalleryEntries(system) {
  const componentPath = system.manifest?.files?.components ?? "components.html";
  return packagePreviewEntries(system)
    .filter(({ path, role }) => path !== componentPath && !/foundation|theme|component/i.test(role))
    .slice(0, 8);
}

function packageThemeOptionsForSystem(system) {
  return designSystemPreviewThemeOptions(system);
}

function applyPackagePreviewTheme(source, theme) {
  if (!theme.attribute && !theme.className) return source;
  return source.replace(/<[a-z][^>]*>/gi, (tag) => {
    if (theme.attribute) {
      const attribute = new RegExp(`\\b${theme.attribute}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
      return attribute.test(tag) ? tag.replace(attribute, `${theme.attribute}="${theme.value}"`) : tag;
    }
    const match = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const classes = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").split(/\s+/).filter((name) => name && name !== theme.className);
    if (theme.value === "dark") classes.push(theme.className);
    const value = `class="${classes.join(" ")}"`;
    return match ? tag.replace(match[0], value) : tag.replace(/\s*\/?>$/, (ending) => ` ${value}${ending}`);
  });
}

function packageRootAttributes(source, tagName, theme) {
  const tag = source.match(new RegExp(`<${tagName}\\b[^>]*>`, "i"))?.[0] ?? "";
  const attributes = new Map();
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.slice(tagName.length + 1).matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    if (!/^(?:class|id|lang|dir|role|title|data-[\w-]+|aria-[\w-]+)$/.test(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  if (theme.attribute) attributes.set(theme.attribute, theme.value);
  if (theme.className) {
    const classes = (attributes.get("class") ?? "").split(/\s+/).filter((name) => name && name.toLowerCase() !== theme.className);
    if (theme.value === "dark") classes.push(theme.className);
    attributes.set("class", classes.join(" "));
  }
  return [...attributes].map(([name, value]) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`).join("");
}

function packageLayoutGuidance(system) {
  const content = system.packageFiles?.find((item) => item.path === "DESIGN.md")?.content ?? "";
  const sections = [...content.matchAll(/^#{2,3}\s+([^\n]*(?:layout|spacing|grid|responsive|adaptation)[^\n]*)\n([\s\S]*?)(?=^#{2,3}\s|$(?![\s\S]))/gim)];
  return sections.map((match) => ({ heading: match[1].trim(), body: match[2].trim() })).filter((item) => item.body);
}

function packageLogo(system) {
  return system.packageFiles?.find(({ path }) => /(^|\/)(?:logo|brand-mark|mark)(?:[-_][^/]*)?\.(?:svg|png|jpe?g|gif|webp|avif)$/i.test(path));
}

function packageSvgDataUrl(asset) {
  if (!asset || typeof asset.content !== "string" || asset.content.length > 150_000) return "";
  const svg = sanitizePackageSvg(asset.content);
  if (!svg) return "";
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function packageAsset(system, fromPath, reference) {
  if (typeof reference !== "string" || !reference.trim() || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(reference.trim())) return null;
  try {
    const resolved = new URL(reference.trim(), `https://tribe-package.invalid/${fromPath}`);
    if (resolved.origin !== "https://tribe-package.invalid") return null;
    const path = decodeURIComponent(resolved.pathname.slice(1));
    return system.packageFiles?.find((item) => item.path === path) ?? null;
  } catch {
    return null;
  }
}

function packageCss(system, source, sourcePath, seen = new Set(), depth = 0, budget = { remaining: 1_000_000 }) {
  if (typeof source !== "string" || source.length > 500_000 || source.length > budget.remaining || depth > 8) return "";
  budget.remaining -= source.length;
  const imports = source.replace(/@import\s+(?:url\(\s*)?["']?([^"'\s)]+)["']?\s*\)?\s*;/gi, (_match, reference) => {
    const asset = packageAsset(system, sourcePath, reference);
    if (!asset || !asset.path.toLowerCase().endsWith(".css") || seen.has(asset.path)) return "";
    const nextSeen = new Set(seen).add(asset.path);
    return packageCss(system, asset.content, asset.path, nextSeen, depth + 1, budget);
  });
  return imports.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_match, _quote, reference) => {
    if (reference.trim().startsWith("#")) return `url("${reference.trim()}")`;
    const asset = packageAsset(system, sourcePath, reference);
    const dataUrl = packageAssetDataUrl(asset);
    return dataUrl ? `url("${dataUrl}")` : "none";
  }).replace(/<\/style/gi, "<\\/style");
}

function packageLogoDataUrl(asset) {
  if (!asset) return "";
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+=*$/i.test(asset.content ?? "")) return asset.content;
  return packageSvgDataUrl(asset);
}

function packageAssetDataUrl(asset) {
  if (!asset) return "";
  if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/(?:woff2?|ttf|otf));base64,[a-z\d+/]+=*$/i.test(asset.content ?? "")) return asset.content;
  return asset.path.toLowerCase().endsWith(".svg") ? packageSvgDataUrl(asset) : "";
}

function packageFontPreview(asset) {
  const dataUrl = packageAssetDataUrl(asset);
  if (!dataUrl.startsWith("data:font/")) return "";
  const extension = asset.path.split(".").at(-1).toLowerCase();
  const format = ({ woff: "woff", woff2: "woff2", ttf: "truetype", otf: "opentype" })[extension];
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><style>@font-face{font-family:PackageFont;src:url("${dataUrl}") format("${format}");font-display:block}body{margin:0;padding:20px;background:#101722;color:#eef2f8;font:14px/1.5 system-ui,sans-serif}.sample{font-family:PackageFont,sans-serif;font-size:28px;line-height:1.25}.small{margin-top:10px;color:#aab6c6;font:12px/1.4 system-ui,sans-serif}</style></head><body><div class="sample">Aa Bb Cc 123</div><div class="small">The quick brown fox jumps over the lazy dog.</div></body></html>`;
}

function isBinaryPackageAsset(path) {
  return /\.(?:png|jpe?g|gif|webp|avif|woff2?|ttf|otf)$/i.test(path);
}

function isPackageAsset(path) {
  return isBinaryPackageAsset(path) || /\.svg$/i.test(path);
}

function packageEvidence(system) {
  const content = system.packageFiles?.find(({ path }) => path === "source/evidence.json")?.content;
  if (typeof content !== "string") return null;
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safeEvidenceUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function packagePreview(system, path, themeOverride = "") {
  const fixture = system.packageFiles?.find((item) => item.path === path);
  if (!fixture) return null;
  const tokenCss = system.packageFiles?.find((item) => item.path === "tokens.css")?.content ?? "";
  const cssBudget = { remaining: 1_000_000 };
  const css = packageCss(system, tokenCss, "tokens.css", new Set(["tokens.css"]), 0, cssBudget);
  const theme = designSystemPreviewThemeAttributes(system, themeOverride);
  const prepared = preparePackagePreview(fixture.content, {
    fixturePath: fixture.path,
    theme,
    resolveStylesheet: (href) => {
      const asset = packageAsset(system, fixture.path, href);
      return asset?.path.toLowerCase().endsWith(".css")
        ? packageCss(system, asset.content, asset.path, new Set([asset.path]), 0, cssBudget)
        : "";
    },
    resolveImage: (src) => packageLogoDataUrl(packageAsset(system, fixture.path, src)),
  });
  const fixtureStyles = prepared.styles.map((style) => packageCss(system, style, fixture.path, new Set(), 0, cssBudget)).join("\n");
  return `<!doctype html><html${prepared.htmlAttributes}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>${css}\n${fixtureStyles}\nbody{margin:0;min-height:100vh}*{box-sizing:border-box}</style></head><body${prepared.bodyAttributes}>${prepared.body}</body></html>`;
}

export default function DesignSystemsView({ projects = [], onProjectDesignSystemChanged }) {
  const importInputRef = useRef(null);
  const packageInputRef = useRef(null);
  const packageZipInputRef = useRef(null);
  const assetInputRef = useRef(null);
  const projectComparisonRequest = useRef(0);
  const [userSystems, setUserSystems] = useState([]);
  const [selectedId, setSelectedId] = useState(DESIGN_SYSTEM_PRESETS[0].id);
  const [viewportId, setViewportId] = useState("wide");
  const [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [capturingReference, setCapturingReference] = useState(false);
  const [extractingProject, setExtractingProject] = useState(false);
  const [capturedPagePreview, setCapturedPagePreview] = useState(null);
  const [browserCaptureAvailable, setBrowserCaptureAvailable] = useState(false);
  const [browserCaptureMessage, setBrowserCaptureMessage] = useState("");
  const [editor, setEditor] = useState(null);
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [editorDirty, setEditorDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [assetMessage, setAssetMessage] = useState("");
  const [assetBusy, setAssetBusy] = useState(false);
  const [referenceInput, setReferenceInput] = useState("");
  const [versionHistory, setVersionHistory] = useState([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [displayedSystem, setDisplayedSystem] = useState(null);
  const [versionComparisonOpen, setVersionComparisonOpen] = useState(false);
  const [projectSnapshot, setProjectSnapshot] = useState(null);
  const [projectComparisonOpen, setProjectComparisonOpen] = useState(false);
  const [projectComparisonBusy, setProjectComparisonBusy] = useState(false);
  const [projectComparisonError, setProjectComparisonError] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [packagePreviewPath, setPackagePreviewPath] = useState("");
  const [previewTheme, setPreviewTheme] = useState("");
  const [packageEditorPath, setPackageEditorPath] = useState("");
  const [newPackageFilePath, setNewPackageFilePath] = useState("");
  const [sourceUrlInput, setSourceUrlInput] = useState("");
  const [compareSavedPreview, setCompareSavedPreview] = useState(false);
  const [guideCopyStatus, setGuideCopyStatus] = useState("");

  useEffect(() => {
    setBrowserCaptureAvailable(Boolean(globalThis.window?.tribeDesktopBrowser?.extractDesignReference));
  }, []);

  useEffect(() => {
    let current = true;
    runtime.listDesignSystems().then(({ systems = [] }) => {
      if (!current) return;
      setUserSystems(systems);
      if (systems.length) setSelectedId((id) => id.startsWith("custom-") ? id : id);
    }).catch((error) => {
      if (current) setLoadError(error.message || "Could not load saved design systems.");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!projectId && projects[0]?.id) setProjectId(projects[0].id);
  }, [projectId, projects]);

  useEffect(() => {
    projectComparisonRequest.current += 1;
    setProjectSnapshot(null);
    setProjectComparisonOpen(false);
    setProjectComparisonBusy(false);
    setProjectComparisonError("");
    return () => { projectComparisonRequest.current += 1; };
  }, [projectId, projects.find((item) => item.id === projectId)?.designSystem?.id,
    projects.find((item) => item.id === projectId)?.designSystem?.version,
    projects.find((item) => item.id === projectId)?.designSystem?.appliedAt]);

  const systems = useMemo(() => [...DESIGN_SYSTEM_PRESETS, ...userSystems], [userSystems]);
  const systemSearchIndex = useMemo(() => new Map(systems.map((item) => [item.id, designSystemSearchText(item)])), [systems]);
  const categoryOptions = useMemo(() => [
    { label: "All categories", value: "all" },
    ...[...new Set(systems.map(defaultSystemCategory))]
      .sort((a, b) => a.localeCompare(b)).map((category) => ({ label: category, value: category })),
  ], [systems]);
  const filteredSystems = useMemo(() => systems.filter((item) =>
    (categoryFilter === "all" || defaultSystemCategory(item) === categoryFilter) &&
    systemSearchIndex.get(item.id)?.includes(libraryQuery.trim().normalize("NFKC").toLocaleLowerCase())), [systems, systemSearchIndex, libraryQuery, categoryFilter]);
  const curatedSystems = filteredSystems.filter((item) => item.source === "curated");
  const starterSystems = filteredSystems.filter((item) => item.source === "starter");
  const savedSystems = filteredSystems.filter((item) => item.source === "user");
  const selected = useMemo(() => {
    const item = systems.find((entry) => entry.id === selectedId) ?? systems[0] ?? DESIGN_SYSTEM_PRESETS[0];
    return item.source === "starter" ? presetSnapshot(item) : item;
  }, [systems, selectedId]);
  const shown = displayedSystem?.id === selected.id ? displayedSystem : selected;
  const shownVersion = shown.version ?? 1;
  useEffect(() => {
    if (selected.source !== "user") {
      setVersionHistory([]);
      setDisplayedSystem(null);
      return undefined;
    }
    let current = true;
    setHistoryBusy(true);
    Promise.all([
      runtime.listDesignSystemVersions(selected.id),
      selected.packageFiles
        ? Promise.resolve({ system: selected })
        : runtime.getDesignSystemVersion(selected.id, selected.version),
    ]).then(([{ versions = [] }, { system }]) => {
      if (!current) return;
      setVersionHistory(versions);
      setDisplayedSystem(system);
    }).catch(() => {
      if (current) {
        setVersionHistory([]);
        setDisplayedSystem(selected);
      }
    }).finally(() => { if (current) setHistoryBusy(false); });
    return () => { current = false; };
  }, [selected.id, selected.source, selected.version]);
  useEffect(() => { setVersionComparisonOpen(false); }, [selected.id, selected.version, shownVersion]);
  const viewport = DESIGN_SYSTEM_VIEWPORTS.find((item) => item.id === viewportId) ?? DESIGN_SYSTEM_VIEWPORTS[0];
  const projectOptions = projects.length
    ? projects.map((item) => ({ label: item.name, value: item.id }))
    : EMPTY_PROJECT;
  const project = projects.find((item) => item.id === projectId);
  const appliedSystem = project?.designSystem;
  const projectUsesShownSystem = appliedSystem?.id === shown.id;
  const projectsUsingSystem = projects.filter((item) => item.designSystem?.id === selected.id);
  const visibleProjectUses = projectsUsingSystem.slice(0, 3).map((item) => `${item.name} · v${item.designSystem.version}`);
  const projectUseSummary = projectsUsingSystem.length
    ? `Currently applied to ${visibleProjectUses.join(", ")}${projectsUsingSystem.length > visibleProjectUses.length ? ` and ${projectsUsingSystem.length - visibleProjectUses.length} more` : ""}.`
    : "No projects currently use this system.";
  const isApplied = appliedSystem?.id === shown.id && appliedSystem?.version === shownVersion;
  const applyActionLabel = isApplied
    ? "Applied"
    : projectUsesShownSystem
      ? Number(shownVersion) < Number(appliedSystem.version)
        ? `Restore version ${shownVersion}`
        : `Update to version ${shownVersion}`
      : `Apply version ${shownVersion}`;
  const { tokenChanges: projectTokenChanges, packageChanges: projectFileChanges } = projectSnapshot && !isApplied
    ? compareDesignSystemSnapshots(projectSnapshot, shown)
    : { tokenChanges: [], packageChanges: [] };
  const projectPreviewOptions = projectSnapshot ? packagePreviewEntries(projectSnapshot) : [];
  const projectComparisonPreviewPath = projectSnapshot
    ? packagePreviewEntries(shown).find(({ path }) => projectPreviewOptions.some((item) => item.path === path))?.path
    : undefined;
  const shownPalettes = Object.keys(shown.palettes ?? {}).length ? shown.palettes : generateDesignPalettes(shown.tokens);
  const packageTokenGroups = packageTokenInventory(shown.packageFiles);
  const packageTokenCount = packageTokenGroups.reduce((total, group) => total + group.items.length, 0);
  const packagePreviewOptions = packagePreviewEntries(shown);
  const activePackagePreview = packagePreviewOptions.find((item) => item.path === packagePreviewPath) ?? packagePreviewOptions[0];
  const packageThemeOptions = packageThemeOptionsForSystem(shown);
  const activePreviewTheme = packageThemeOptions.some((option) => option.value === previewTheme) ? previewTheme : packageThemeOptions[0]?.value ?? "";
  const draftThemeOptions = draft ? packageThemeOptionsForSystem(draft) : [];
  const activeDraftPreviewTheme = draftThemeOptions.some((option) => option.value === previewTheme) ? previewTheme : draftThemeOptions[0]?.value ?? "";
  const packageOutputPreviews = packageGalleryEntries(shown);
  const packageMediaAssets = shown.packageFiles?.filter(({ path }) => isPackageAsset(path)) ?? [];
  const designGuideFile = shown.packageFiles?.find(({ path }) => path === "DESIGN.md");
  const usageGuideFile = shown.packageFiles?.find(({ path }) => path === "USAGE.md");
  const sourceEvidenceFile = shown.packageFiles?.find(({ path }) => path === "source/evidence.md");
  const extractionEvidence = packageEvidence(shown);
  const agentGuidance = usageGuideFile?.content || shown.guidance || designGuideFile?.content || "";
  const guideHeadings = useMemo(() => designSystemGuideHeadings(designGuideFile?.content ?? ""), [designGuideFile?.content]);
  const guideHeadingAnchors = useMemo(() => Object.fromEntries(guideHeadings.map(({ line, id }) => [line, id])), [guideHeadings]);
  const layoutGuidance = packageLayoutGuidance(shown);
  const logoAsset = packageLogo(shown);
  const logoDataUrl = packageLogoDataUrl(logoAsset);
  const draftLogoAsset = draft ? packageLogo(draft) : null;
  const draftLogoDataUrl = packageLogoDataUrl(draftLogoAsset);
  const draftExtractionEvidence = draft ? packageEvidence(draft) : null;
  const packagePreviewHtml = activePackagePreview ? packagePreview(shown, activePackagePreview.path, activePreviewTheme) : null;
  const canCompareWithCurrent = selected.source === "user" && shown.source === "user"
    && shown.id === selected.id && Number(shownVersion) < Number(selected.version);
  const { tokenChanges: comparisonTokenChanges, packageChanges: comparisonFiles } = canCompareWithCurrent
    ? compareDesignSystemSnapshots(shown, selected)
    : { tokenChanges: [], packageChanges: [] };
  const currentPreviewOptions = canCompareWithCurrent ? packagePreviewEntries(selected) : [];
  const comparisonPreviewPath = canCompareWithCurrent
    ? currentPreviewOptions.find((item) => item.path === packagePreviewPath && packagePreviewOptions.some((shownItem) => shownItem.path === item.path))?.path
      ?? currentPreviewOptions.find((item) => packagePreviewOptions.some((shownItem) => shownItem.path === item.path))?.path
    : undefined;
  const comparisonPreviewTheme = packageThemeOptionsForSystem(selected).some((option) => option.value === previewTheme) ? previewTheme : "";
  const draftPreviewOptions = draft ? packagePreviewEntries(draft) : [];
  const draftPreviewPath = draftPreviewOptions.find((item) => item.path === packageEditorPath)?.path ?? draftPreviewOptions[0]?.path;
  const draftPreviewHtml = draftPreviewPath ? packagePreview(draft, draftPreviewPath, activeDraftPreviewTheme) : null;
  const savedPreviewHtml = editor?.mode === "edit" && draftPreviewPath ? packagePreview(shown, draftPreviewPath, activeDraftPreviewTheme) : null;

  useEffect(() => { setGuideCopyStatus(""); }, [shown.id, shown.version]);

  async function copyAgentGuidance() {
    if (!agentGuidance) return;
    try {
      await navigator.clipboard.writeText(agentGuidance);
      setGuideCopyStatus("copied");
    } catch {
      setGuideCopyStatus("failed");
    }
  }
  const previewStyle = {
    "--system-canvas": shown.tokens.canvas,
    "--system-surface": shown.tokens.surface,
    "--system-raised": shown.tokens.raised,
    "--system-text": shown.tokens.text,
    "--system-muted": shown.tokens.muted,
    "--system-accent": shown.tokens.accent,
    "--system-line": shown.tokens.line,
    "--system-focus": shown.tokens.focus,
    "--system-success": shown.tokens.success,
    "--system-warning": shown.tokens.warning,
    "--system-danger": shown.tokens.danger,
    "--system-radius": shown.tokens.radius,
    "--system-space": shown.tokens.spacing,
    "--system-font-size": shown.tokens.fontSize,
    "--system-font": shown.tokens.font,
  };

  function openCreate() {
    setCapturedPagePreview(null);
    setBrowserCaptureMessage("");
    setCompareSavedPreview(false);
    setEditor({ mode: "create" });
    const nextDraft = { ...editableDraft(presetSnapshot(selected)), id: undefined, version: 1, name: `${selected.name} copy` };
    setDraft(nextDraft);
    setEditorDirty(false);
    setConfirmDiscard(false);
    setEditorError("");
    setAssetMessage("");
    setReferenceInput("");
    setPackageEditorPath("components.html");
    setNewPackageFilePath("");
    setSourceUrlInput("");
  }

  function openEdit() {
    setCapturedPagePreview(null);
    setBrowserCaptureMessage("");
    setCompareSavedPreview(false);
    setEditor({ mode: "edit", expectedVersion: selected.version });
    setDraft(editableDraft(shown));
    setEditorDirty(false);
    setConfirmDiscard(false);
    setEditorError("");
    setAssetMessage("");
    setReferenceInput("");
    setPackageEditorPath(shown.packageFiles?.find((file) => file.path === "components.html")?.path ?? "DESIGN.md");
    setNewPackageFilePath("");
    setSourceUrlInput(shown.sourceUrl ?? shown.references?.[0]?.url ?? "");
  }

  function updateDraft(field, value) {
    setEditorDirty(true);
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateToken(field, value) {
    setEditorDirty(true);
    const paletteRole = ({ accent: "brand", muted: "neutral", success: "success", warning: "warning", danger: "danger" })[field];
    setDraft((current) => {
      const tokens = { ...current.tokens, [field]: value };
      return {
        ...current,
        tokens,
        packageFiles: syncPackageTokens(current.packageFiles, tokens),
        palettes: paletteRole
          ? { ...current.palettes, [paletteRole]: generateColourScale(value) }
          : current.palettes,
      };
    });
  }

  function updatePackageFile(path, content) {
    const currentDraft = draftRef.current;
    if (!currentDraft || content.length > 1_000_000) {
      setEditorError("A package text file can be up to 1 MB.");
      return;
    }
    const nextSize = currentDraft.packageFiles.reduce((total, file) => total + (file.path === path ? content.length : file.content.length), 0);
    if (nextSize > MAX_DESIGN_SYSTEM_SNAPSHOT_BYTES) {
      setEditorError("The complete package is larger than the 12 MB supported limit.");
      return;
    }
    setEditorError("");
    setEditorDirty(true);
    setDraft((current) => {
      const packageFiles = current.packageFiles.map((file) => file.path === path ? { ...file, content } : file);
      if (path === "tokens.css") {
        const tokens = packageTokensFromCss(content, current.tokens);
        return {
          ...current,
          tokens,
          palettes: generateDesignPalettes(tokens),
          packageFiles: syncPackageTokens(packageFiles, tokens, { syncStylesheet: false }),
        };
      }
      return {
        ...current,
        ...(path === "USAGE.md" ? { guidance: content } : {}),
        packageFiles,
      };
    });
  }

  function addPackageFile() {
    let path;
    try {
      path = validateDesignSystemPackageFilePath(newPackageFilePath, draft.packageFiles);
    } catch (error) {
      setEditorError(error.message);
      return;
    }
    if (draft.packageFiles.length >= 200) {
      setEditorError("A package can contain up to 200 files.");
      return;
    }
    setDraft((current) => addDesignSystemPackageFile(current, path));
    setPackageEditorPath(path);
    setNewPackageFilePath("");
    setEditorDirty(true);
    setEditorError("");
    setAssetMessage(`${path} added to this draft.`);
  }

  function removePackageFile(path) {
    setDraft((current) => removeDesignSystemPackageFile(current, path));
    const nextPath = draft.packageFiles.find((file) => file.path !== path && !["manifest.json", "design-tokens.json"].includes(file.path) && !isBinaryPackageAsset(file.path))?.path ?? "DESIGN.md";
    setPackageEditorPath(nextPath);
    setEditorDirty(true);
    setEditorError("");
    setAssetMessage(`${path} removed from this draft.`);
  }

  async function addPackageAssets(event) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (!files.length || !draft) return;
    setEditorError("");
    setAssetMessage("");
    setAssetBusy(true);
    try {
      const additions = [];
      for (const file of files) {
        const name = packageAssetName(file);
        const extension = name.split(".").at(-1);
        const sizeLimit = extension === "svg" ? 1_000_000 : 3_000_000;
        if (file.size > sizeLimit) throw new Error(`${file.name} is larger than the ${extension === "svg" ? "1 MB" : "3 MB"} asset limit.`);
        additions.push({ path: `assets/${name}`, content: await packageAssetData(file, PACKAGE_ASSET_MIME_TYPES[extension]) });
      }
      const uniqueAdditions = [...new Map(additions.map((item) => [item.path, item])).values()];
      const paths = new Set(uniqueAdditions.map((item) => item.path));
      const currentDraft = draftRef.current;
      if (!currentDraft) return;
      const nextFiles = [
        ...(currentDraft.packageFiles ?? []).filter((item) => !paths.has(item.path)),
        ...uniqueAdditions,
      ];
      if (nextFiles.length > 200) throw new Error("A package can contain up to 200 files.");
      if (nextFiles.reduce((sum, item) => sum + item.content.length, 0) > MAX_DESIGN_SYSTEM_SNAPSHOT_BYTES) {
        throw new Error("The complete package is larger than the 12 MB supported limit.");
      }
      setDraft((current) => current ? ({
        ...current,
        packageFiles: [...(current.packageFiles ?? []).filter((item) => !paths.has(item.path)), ...uniqueAdditions],
      }) : current);
      setEditorDirty(true);
      setAssetMessage(`${uniqueAdditions.length} ${uniqueAdditions.length === 1 ? "asset" : "assets"} added. Files with the same name were replaced.`);
    } catch (error) {
      setEditorError(error.message || "Could not add these package assets.");
    } finally {
      setAssetBusy(false);
    }
  }

  function removePackageAsset(path) {
    setEditorDirty(true);
    setDraft((current) => ({ ...current, packageFiles: current.packageFiles.filter((item) => item.path !== path) }));
    setAssetMessage(`${path.split("/").at(-1)} removed from this draft.`);
    setEditorError("");
  }

  async function extractFromBrowser() {
    const browser = globalThis.window?.tribeDesktopBrowser;
    if (!browser?.extractDesignReference || capturingReference || saving) return;
    setCapturingReference(true);
    setBrowserCaptureMessage("");
    setLoadError("");
    setMessage("");
    try {
      const { reference, screenshot } = await browser.extractDesignReference("workspace");
      const extracted = designSystemFromReference(reference, presetSnapshot(shown));
      setCapturedPagePreview(screenshot ?? null);
      setDraft(editableDraft({ ...extracted, sourceUrl: extracted.references[0]?.url ?? "" }));
      setEditorDirty(false);
      setConfirmDiscard(false);
      setPackageEditorPath("components.html");
      setNewPackageFilePath("");
      setEditor({ mode: "create" });
      setEditorError("");
      setReferenceInput("");
      setSourceUrlInput(extracted.references[0]?.url ?? "");
    } catch (error) {
      setLoadError(error.message || "Could not capture styles from the open browser page.");
    } finally {
      setCapturingReference(false);
    }
  }

  async function captureAnotherBrowserPage() {
    const browser = globalThis.window?.tribeDesktopBrowser;
    if (!browser?.extractDesignReference || capturingReference || saving || !draftRef.current) return;
    setCapturingReference(true);
    setBrowserCaptureMessage("");
    setEditorError("");
    setAssetMessage("");
    try {
      const { reference, screenshot } = await browser.extractDesignReference("workspace");
      const updated = mergeDesignSystemReferenceCapture(draftRef.current, reference);
      setDraft(updated);
      setEditorDirty(true);
      setCapturedPagePreview(screenshot ?? null);
      setBrowserCaptureMessage(`Captured ${updated.references.length} pages. Token candidates and source evidence were refreshed.`);
    } catch (error) {
      setEditorError(error.message || "Could not add this Browser page to the extraction.");
    } finally {
      setCapturingReference(false);
    }
  }

  async function extractFromProject() {
    if (!project || extractingProject || saving) return;
    setExtractingProject(true);
    setLoadError("");
    setMessage("");
    try {
      const pending = [{ path: "", depth: 0 }];
      const visited = new Set();
      const candidates = [];
      while (pending.length && visited.size < 80) {
        const directory = pending.shift();
        if (visited.has(directory.path)) continue;
        visited.add(directory.path);
        const { entry } = await runtime.browseProject(project.id, directory.path);
        if (entry?.kind !== "directory") continue;
        for (const child of entry.entries ?? []) {
          if (child.kind === "directory" && directory.depth < 4 && !/(?:^|\/)(?:\.git|\.svn|\.hg|node_modules|bower_components|\.venv|venv|virtualenv|__pycache__|\.cache|\.next|\.turbo|\.yarn|\.pnpm-store|dist|build|coverage|vendor|public|out|target)(?:\/|$)/i.test(child.path)) {
            pending.push({ path: child.path, depth: directory.depth + 1 });
            continue;
          }
          if (child.kind !== "file") continue;
          if (/^(?:licen[cs]e|notice|copying|copyright)(?:[-_.][a-z0-9.-]+)?$/i.test(child.name) && !child.path.includes("/")) {
            candidates.push({ ...child, priority: 4, kind: "license" });
            continue;
          }
          const stylesheet = /\.(?:css|scss|sass|less)$/i.test(child.name);
          const tokenJson = /\.(?:json|tokens)$/i.test(child.name) && /(?:token|theme|variable|design[-_.]?system)/i.test(`${child.name} ${child.path}`);
          const themeCode = /\.(?:c?js|mjs|cjs|tsx?|jsx)$/i.test(child.name)
            && /(?:tailwind|theme|token|design[-_.]?system|style)/i.test(`${child.name} ${child.path}`);
          if ((!stylesheet && !tokenJson && !themeCode) || child.size > 300_000) continue;
          const priority = /(?:token|theme|colou?r|brand|design|global|variable|style)/i.test(`${child.name} ${child.path}`) ? 3 : 1;
          candidates.push({ ...child, priority, kind: stylesheet ? "stylesheet" : tokenJson ? "tokens-json" : "theme-code" });
        }
      }
      candidates.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));
      const sourceFiles = [];
      let sourceBudget = 1_000_000;
      for (const candidate of candidates) {
        if (sourceFiles.length >= 24 || sourceBudget <= 0) break;
        if (candidate.kind !== "license" && candidate.size > sourceBudget) continue;
        const { entry } = await runtime.browseProject(project.id, candidate.path);
        if (entry?.kind !== "file" || typeof entry.content !== "string" || entry.tooLarge) continue;
        if (candidate.kind === "license" && entry.content.length > 500_000) continue;
        sourceFiles.push({ ...candidate, content: entry.content });
        sourceBudget -= entry.content.length;
      }
      const declarations = new Map();
      const declarationSources = new Map();
      for (const file of sourceFiles.filter((item) => item.kind === "stylesheet")) {
        const source = file.content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const extension = file.name.split(".").at(-1).toLowerCase();
        const patterns = [
          /--([\w-]+)\s*:\s*([^;{}]+)\s*;/g,
          ...(extension === "scss" || extension === "sass" ? [/^\s*\$([\w-]+)\s*:\s*([^;\n]+)\s*;?/gm] : []),
          ...(extension === "less" ? [/^\s*@([\w-]+)\s*:\s*([^;\n]+)\s*;?/gm] : []),
        ];
        for (const pattern of patterns) {
          for (const match of source.matchAll(pattern)) {
            const name = match[1].trim();
            const value = match[2].replace(/[\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
            if (name && value && value.length <= 240 && !declarations.has(name.toLowerCase())) {
              declarations.set(name, value);
              declarationSources.set(name.toLowerCase(), file.path);
            }
          }
        }
      }
      for (const file of sourceFiles.filter((item) => item.kind === "theme-code")) {
        for (const { name, value } of extractStaticThemeDeclarations(file.content)) {
          if (!declarations.has(name)) {
            declarations.set(name, value);
            declarationSources.set(name, file.path);
          }
        }
      }
      function addJsonToken(node, path = [], inheritedType = "", depth = 0, sourcePath = "") {
        if (!node || typeof node !== "object" || Array.isArray(node) || depth > 24 || declarations.size >= 2000) return;
        const type = typeof node.$type === "string" ? node.$type : inheritedType;
        const hasValue = Object.hasOwn(node, "$value") || Object.hasOwn(node, "value");
        if (hasValue) {
          const raw = Object.hasOwn(node, "$value") ? node.$value : node.value;
          let value = "";
          if (typeof raw === "string") value = raw.replace(/\{([\w.-]+)\}/g, (_match, alias) => `var(--${alias.replace(/\./g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()})`);
          else if (typeof raw === "number" && Number.isFinite(raw)) value = String(raw);
          else if (raw && typeof raw === "object" && !Array.isArray(raw) && Number.isFinite(raw.value) && typeof raw.unit === "string" && /^(?:px|rem|em|%|s|ms|deg)$/i.test(raw.unit)) value = `${raw.value}${raw.unit}`;
          else if (type === "color" && raw && typeof raw === "object" && raw.colorSpace === "srgb" && Array.isArray(raw.components) && raw.components.length >= 3 && raw.components.slice(0, 3).every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
            value = `#${raw.components.slice(0, 3).map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
          }
          const parts = path.filter((part) => part.toLowerCase() !== "tokens");
          const name = parts.join("-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
          value = value.replace(/[;{}\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
          if (name && value && value.length <= 240 && !declarations.has(name)) {
            declarations.set(name, value);
            declarationSources.set(name, sourcePath);
          }
          return;
        }
        for (const [key, child] of Object.entries(node)) {
          if (["$type", "$description", "$extensions", "type", "description"].includes(key)) continue;
          if (child && typeof child === "object") addJsonToken(child, [...path, key], type, depth + 1, sourcePath);
        }
      }
      for (const file of sourceFiles.filter((item) => item.kind === "tokens-json")) {
        try { addJsonToken(JSON.parse(file.content), [], "", 0, file.path); }
        catch { continue; }
      }
      if (!declarations.size) throw new Error(`No CSS custom properties, Sass/Less variables or JSON design tokens were found in ${project.name}.`);
      const sourceTokenCss = `:root {\n${[...declarations].map(([name, value]) => `  --${name}: ${value};`).join("\n")}\n}`;
      const tokens = packageTokensFromCss(sourceTokenCss, shown.tokens);
      const semanticAliases = {
        bg: tokens.canvas, surface: tokens.surface, "surface-raised": tokens.raised,
        fg: tokens.text, "fg-muted": tokens.muted, accent: tokens.accent,
        border: tokens.line, focus: tokens.focus, success: tokens.success,
        warning: tokens.warning, danger: tokens.danger, radius: tokens.radius,
        space: tokens.spacing, "text-base": tokens.fontSize, "font-body": tokens.font,
      };
      const tokenCss = `${sourceTokenCss.slice(0, -1)}\n${Object.entries(semanticAliases).map(([name, value]) => `  --${name}: ${value};`).join("\n")}\n}\n`;
      const licenseFile = sourceFiles.find((file) => file.kind === "license");
      const sourcePaths = sourceFiles.filter((file) => file.kind === "stylesheet" || file.kind === "tokens-json" || file.kind === "theme-code").map((file) => file.path);
      const inferenceAliases = {
        canvas: ["bg", "background", "canvas", "color-background", "color-canvas", "background-color"],
        surface: ["surface", "surface-1", "color-surface", "surface-color", "background-surface"],
        raised: ["surface-warm", "surface-raised", "raised", "surface-2", "color-surface-raised"],
        text: ["fg", "foreground", "text", "color-text", "color-foreground", "foreground-color"],
        muted: ["muted", "fg-muted", "fg-2", "text-muted", "color-text-muted", "color-muted", "text-secondary"],
        accent: ["accent", "accent-hover", "primary", "color-primary", "color-accent", "accent-color"],
        line: ["border", "line", "border-color"],
        focus: ["focus", "accent-hover", "accent", "color-accent"],
        success: ["success", "positive", "color-success"],
        warning: ["warn", "warning", "caution", "color-warning"],
        danger: ["danger", "error", "negative", "color-danger", "color-error"],
        radius: ["radius-sm", "radius", "border-radius"],
        spacing: ["space-4", "spacing", "space-md", "spacing-medium", "space-medium"],
        fontSize: ["text-base", "font-size-base", "font-size"],
        font: ["font-body", "font-sans", "font-family"],
      };
      const declarationNames = new Set([...declarations.keys()].map((name) => name.toLowerCase()));
      const sourceEvidence = {
        schema: "tribe-design-system-evidence/v1",
        source: { type: "local-project-files", project: project.name, files: sourcePaths },
        confidence: { level: "low", reason: "Semantic roles are inferred from token names and literal values; aliases, expressions, component behaviour and licence scope need review." },
        observations: [...declarations].slice(0, 120).map(([name, value]) => ({
          group: "Project token", name, value, sourceFile: declarationSources.get(name.toLowerCase()) ?? "Unknown source file",
        })),
        inferences: Object.entries(inferenceAliases).map(([token, aliases]) => {
          const sourceToken = aliases.find((name) => declarationNames.has(name));
          return {
            token,
            value: tokens[token],
            basis: sourceToken ? `Matched --${sourceToken} by name` : "Used the selected starter value; no source token matched",
            ...(sourceToken ? { sourceToken: `--${sourceToken}`, sourceFile: declarationSources.get(sourceToken) ?? "Unknown source file" } : {}),
            confidence: sourceToken ? "low" : "none",
          };
        }),
        limitations: ["Non-literal aliases, computed JavaScript values and preprocessor expressions may not resolve.", "Component behaviour, ownership and redistribution rights were not verified."],
      };
      const attribution = [
        `Extracted from local project files in ${project.name}.`,
        `Source files: ${sourcePaths.join(", ")}`,
        `${declarations.size} CSS custom properties, Sass/Less variables, JSON design tokens and static theme-config values captured as inferred values; unresolved expressions, component behaviour, ownership and redistribution rights were not verified.`,
        licenseFile ? `Included project notice: ${licenseFile.path}.` : "No root project licence or notice file was included.",
      ].join("\n").slice(0, 1000);
      const extracted = {
        name: `${project.name} design system`.slice(0, 100),
        description: `A reviewable token starting point extracted from ${project.name}.`,
        source: "user",
        version: 1,
        category: "Project extraction",
        license: licenseFile ? `See included ${licenseFile.name}` : "Licence not declared; review the source project terms",
        sourceLabel: `Local project · ${project.name}`,
        attribution,
        sourceEvidence,
        tokens,
        palettes: generateDesignPalettes(tokens),
        components: { button: "Review extracted tokens against button states before reuse.", card: "", input: "Review focus and validation states before reuse." },
        guidance: "CSS custom properties, Sass/Less variables, common JSON design-token entries and static values in theme configuration files are extracted as candidates. JavaScript is never executed. Review source notes, unresolved expressions, the responsive preview and component behaviour before applying.",
        references: [],
        packageFiles: [],
      };
      let packageFiles = starterPackage(extracted).map((file) => {
        if (file.path === "tokens.css") return { ...file, content: tokenCss };
        if (file.path === "source/evidence.md") return { ...file, content: attribution };
        return file;
      });
      const manifest = JSON.parse(packageFiles.find((file) => file.path === "manifest.json").content);
      manifest.source = { type: "local-project-extraction", origin: project.name };
      manifest.license = extracted.license;
      manifest.files.license = licenseFile?.path;
      packageFiles = packageFiles.map((file) => file.path === "manifest.json"
        ? { ...file, content: JSON.stringify(manifest, null, 2) }
        : file);
      if (licenseFile) packageFiles.push({ path: licenseFile.name, content: licenseFile.content });
      extracted.manifest = manifest;
      extracted.packageFiles = syncPackageTokens(packageFiles, tokens, { syncStylesheet: false });
      setCapturedPagePreview(null);
      setDraft(editableDraft(extracted));
      setEditorDirty(false);
      setConfirmDiscard(false);
      setPackageEditorPath("components.html");
      setNewPackageFilePath("");
      setEditor({ mode: "create", source: "project" });
      setEditorError("");
      setReferenceInput("");
      setSourceUrlInput("");
    } catch (error) {
      setLoadError(error.message || `Could not extract styles from ${project.name}.`);
    } finally {
      setExtractingProject(false);
    }
  }

  async function saveDraft(event) {
    event.preventDefault();
    if (!draft || saving || assetBusy) return;
    setSaving(true);
    setEditorError("");
    try {
      const payload = {
        ...draft,
        source: "user",
        sourceUrl: sourceUrlInput.trim(),
        packageFiles: syncPackageTokens(draft.packageFiles, draft.tokens, { syncStylesheet: false }),
      };
      if (payload.packageFiles?.some((file) => file.path === "USAGE.md")) {
        payload.packageFiles = payload.packageFiles.map((file) => file.path === "USAGE.md" ? { ...file, content: payload.guidance } : file);
      }
      if (payload.manifest) {
        const manifestSource = typeof payload.manifest.source === "object" && payload.manifest.source
          ? payload.manifest.source
          : {};
        const updatedManifestSource = { ...manifestSource };
        if (payload.sourceUrl) updatedManifestSource.url = payload.sourceUrl;
        else {
          delete updatedManifestSource.url;
          if (/^https?:\/\//i.test(updatedManifestSource.repository ?? "")) delete updatedManifestSource.repository;
        }
        payload.manifest = {
          ...payload.manifest,
          name: payload.name,
          description: payload.description,
          category: payload.category ?? payload.manifest.category,
          tags: payload.tags ?? payload.manifest.tags,
          license: payload.license ?? payload.manifest.license,
          source: updatedManifestSource,
        };
        if (Object.hasOwn(payload.manifest, "sourceUrl")) {
          if (payload.sourceUrl) payload.manifest.sourceUrl = payload.sourceUrl;
          else delete payload.manifest.sourceUrl;
        }
        payload.packageFiles = payload.packageFiles.map((file) => file.path === "manifest.json"
          ? { ...file, content: JSON.stringify(payload.manifest, null, 2) }
          : file);
      }
      payload.attribution = payload.packageFiles?.find((file) => file.path === "source/evidence.md")?.content?.slice(0, 1000) ?? payload.attribution ?? "";
      if (referenceInput.trim()) payload.references = [...payload.references, { url: referenceInput.trim(), label: "Reference" }];
      const { system } = await runtime.saveDesignSystem(payload, editor.mode === "edit" ? editor.expectedVersion : undefined);
      setUserSystems((current) => [system, ...current.filter((item) => item.id !== system.id)]);
      setDisplayedSystem(system);
      setVersionHistory((current) => [{ version: system.version, created_at: new Date().toISOString() }, ...current.filter((item) => item.version !== system.version)]);
      setSelectedId(system.id);
      setEditor(null);
      setDraft(null);
      setEditorDirty(false);
      setConfirmDiscard(false);
      setCapturedPagePreview(null);
      setPackageEditorPath("");
      setNewPackageFilePath("");
      setSourceUrlInput("");
      setMessage(`${system.name} saved as version ${system.version}.`);
    } catch (error) {
      setEditorError(error.message || "Could not save this design system.");
    } finally {
      setSaving(false);
    }
  }

  function closeEditor() {
    setEditor(null);
    setDraft(null);
    setEditorDirty(false);
    setConfirmDiscard(false);
    setCapturedPagePreview(null);
  }

  function requestCloseEditor() {
    if (saving || assetBusy) return;
    if (editorDirty) setConfirmDiscard(true);
    else closeEditor();
  }

  async function importSystem(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setMessage("");
    setLoadError("");
    if (file.size > MAX_DESIGN_SYSTEM_SNAPSHOT_BYTES) {
      setLoadError("Design-system snapshots must be smaller than 12 MB.");
      return;
    }
    setSaving(true);
    try {
      const payload = parseDesignSystemImport(await file.text());
      const { system } = await runtime.saveDesignSystem(payload);
      setUserSystems((current) => [system, ...current.filter((item) => item.id !== system.id)]);
      setSelectedId(system.id);
      setMessage(`${system.name} imported as a new system.`);
    } catch (error) {
      const message = error.message?.startsWith("design_system_")
        ? "This file does not match a supported design system."
        : error.message || "Could not import this design system.";
      setLoadError(message);
    } finally {
      setSaving(false);
    }
  }

  async function importPackage(event) {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (!files.length) return;
    setSaving(true);
    setLoadError("");
    setMessage("");
    try {
      const packages = await parseDesignSystemPackageLibrary(files, presetSnapshot(shown));
      const importedById = new Map();
      const existingByManifestId = new Map(userSystems
        .filter((item) => item.manifest?.id)
        .map((item) => [item.manifest.id, item]));
      const failures = [];
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      for (let index = 0; index < packages.length; index += 1) {
        const payload = packages[index];
        setMessage(`Importing ${index + 1} of ${packages.length}: ${payload.name}…`);
        try {
          const existing = payload.manifest?.id ? existingByManifestId.get(payload.manifest.id) : null;
          const { system } = await runtime.saveDesignSystem(
            existing ? { ...payload, id: existing.id } : payload,
            existing?.version,
          );
          if (!existing) added += 1;
          else if (system.version > existing.version) updated += 1;
          else unchanged += 1;
          if (payload.manifest?.id) existingByManifestId.set(payload.manifest.id, system);
          importedById.set(system.id, system);
        } catch (error) {
          failures.push(`${payload.name}: ${error.message || "could not import"}`);
        }
      }
      const imported = [...importedById.values()];
      const changed = imported.filter((system) => !userSystems.some((item) => item.id === system.id && item.version === system.version));
      if (changed.length) {
        const changedIds = new Set(changed.map((system) => system.id));
        setUserSystems((current) => [...changed, ...current.filter((system) => !changedIds.has(system.id))]);
        setSelectedId(changed[0].id);
      }
      setMessage(failures.length
        ? `Added ${added}, updated ${updated}, left ${unchanged} unchanged, and could not import ${failures.length} of ${packages.length} systems. ${failures.slice(0, 3).join("; ")}`
        : `Added ${added}, updated ${updated}, and left ${unchanged} unchanged.`);
    } catch (error) {
      setLoadError(error.message || "Could not import this design-system package.");
    } finally {
      setSaving(false);
    }
  }

  async function importPackageZip(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 14_000_000) {
      setLoadError("This package ZIP is larger than the 14 MB import limit.");
      return;
    }
    setSaving(true);
    setLoadError("");
    setMessage("Reading package ZIP…");
    try {
      const { files = [] } = await runtime.readDesignSystemPackageArchive(file);
      const bundledSnapshot = files.find((entry) => entry.path.split("/").at(-1) === "tribe-system.json");
      let payload;
      if (bundledSnapshot) {
        payload = parseDesignSystemImport(bundledSnapshot.content);
      } else {
        const manifests = files.filter((entry) => entry.path.split("/").at(-1) === "manifest.json");
        const manifest = manifests.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
        if (!manifest || (manifests.length > 1 && manifest.path.split("/").length === manifests[1].path.split("/").length)) {
          throw new Error("Choose a ZIP containing one design-system package.");
        }
        const prefix = manifest.path.includes("/") ? manifest.path.slice(0, manifest.path.lastIndexOf("/") + 1) : "";
        const packageEntries = files.filter((entry) => entry.path.startsWith(prefix));
        const virtualFiles = packageEntries.map((entry) => {
          const content = entry.content;
          return {
            name: entry.path.split("/").at(-1),
            size: entry.size,
            webkitRelativePath: `package/${entry.path.slice(prefix.length)}`,
            text: async () => content,
            arrayBuffer: async () => {
              const encoded = content.slice(content.indexOf(",") + 1);
              const binary = atob(encoded);
              const bytes = new Uint8Array(binary.length);
              for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
              return bytes.buffer;
            },
          };
        });
        payload = await parseDesignSystemPackage(virtualFiles, presetSnapshot(shown));
      }
      const { system } = await runtime.saveDesignSystem(payload);
      setUserSystems((current) => [system, ...current.filter((item) => item.id !== system.id)]);
      setSelectedId(system.id);
      setMessage(`${system.name} imported from package ZIP.`);
    } catch (error) {
      const code = error.message ?? "";
      setLoadError(code.startsWith("design_system_archive_") || code.startsWith("design_system_package_")
        ? "This ZIP is not a supported design-system package. Choose a package exported by Tribe or a single OpenDesign system folder ZIP."
        : code || "Could not import this design-system package ZIP.");
      setMessage("");
    } finally {
      setSaving(false);
    }
  }

  async function downloadPackage(system) {
    setSaving(true);
    setMessage("");
    try {
      const { blob } = await runtime.exportDesignSystemPackage(system);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${system.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design-system"}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setMessage(`${system.name} package exported.`);
    } catch (error) {
      setMessage(error.message || "Could not export this design-system package.");
    } finally {
      setSaving(false);
    }
  }

  async function applyToProject() {
    if (!project || !shown) return;
    setSaving(true);
    setMessage("");
    try {
      const { designSystem } = await runtime.applyDesignSystem(project.id, presetSnapshot(shown));
      onProjectDesignSystemChanged?.(project.id, designSystem);
      setMessage(`${selected.name} applied to ${project.name}.`);
    } catch (error) {
      setMessage(error.message || "Could not apply this design system.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleProjectComparison() {
    if (projectComparisonOpen) {
      setProjectComparisonOpen(false);
      return;
    }
    if (!project || !appliedSystem || projectComparisonBusy) return;
    const requestId = ++projectComparisonRequest.current;
    setProjectComparisonBusy(true);
    setProjectComparisonError("");
    try {
      const { designSystem } = await runtime.getProjectDesignSystem(project.id);
      if (requestId !== projectComparisonRequest.current) return;
      if (!designSystem) throw new Error("This project no longer has a design system applied.");
      setProjectSnapshot(designSystem);
      setProjectComparisonOpen(true);
    } catch (error) {
      if (requestId !== projectComparisonRequest.current) return;
      setProjectComparisonError(error.message || "Could not load the project's applied design system.");
    } finally {
      if (requestId === projectComparisonRequest.current) setProjectComparisonBusy(false);
    }
  }

  async function selectVersion(version) {
    if (!selected?.id) return;
    if (version === selected.version) {
      setDisplayedSystem(selected);
      return;
    }
    setHistoryBusy(true);
    try {
      const { system } = await runtime.getDesignSystemVersion(selected.id, version);
      setDisplayedSystem(system);
    } catch (error) {
      setMessage(error.message || "Could not load this saved version.");
    } finally {
      setHistoryBusy(false);
    }
  }

  async function deleteSelectedSystem() {
    if (selected.source !== "user" || saving) return;
    setSaving(true);
    setMessage("");
    try {
      await runtime.deleteDesignSystem(selected.id);
      setUserSystems((current) => current.filter((item) => item.id !== selected.id));
      setSelectedId(DESIGN_SYSTEM_PRESETS[0].id);
      setDisplayedSystem(null);
      setVersionHistory([]);
      setConfirmDelete(false);
      setLibraryQuery("");
      setCategoryFilter("all");
      setMessage(`${selected.name} removed from your library. Projects already using it keep their saved snapshot.`);
    } catch (error) {
      setMessage(error.message || "Could not remove this design system.");
    } finally {
      setSaving(false);
    }
  }

  async function removeFromProject() {
    if (!project) return;
    setSaving(true);
    try {
      await runtime.clearProjectDesignSystem(project.id);
      onProjectDesignSystemChanged?.(project.id, null);
      setMessage(`Design system removed from ${project.name}.`);
    } catch (error) {
      setMessage(error.message || "Could not remove this design system.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="tab-panel detail-view design-systems-view">
    <header className="design-systems-heading">
      <div><h2>Design systems</h2><p>Refine reusable foundations against real components and responsive layouts before applying them.</p><span className="design-system-count">{filteredSystems.length} {filteredSystems.length === 1 ? "system" : "systems"}{userSystems.length ? ` · ${userSystems.length} saved` : ""}</span></div>
      <div className="design-systems-heading-actions"><input accept="application/json,.json" aria-hidden="true" className="visually-hidden" onChange={importSystem} ref={importInputRef} tabIndex={-1} type="file" /><input aria-label="Choose a design-system package or library folder" className="visually-hidden" multiple onChange={importPackage} ref={packageInputRef} tabIndex={-1} type="file" webkitdirectory="" /><input accept=".zip,application/zip,application/x-zip-compressed" aria-hidden="true" className="visually-hidden" onChange={importPackageZip} ref={packageZipInputRef} tabIndex={-1} type="file" /><button className="button button--quiet" disabled={!browserCaptureAvailable || capturingReference || saving} onClick={() => void extractFromBrowser()} title={browserCaptureAvailable ? "Capture styles from the selected Tribe Browser tab" : "Available in the Tribe desktop app when a Browser tab is open"} type="button"><Globe size={15} />{capturingReference ? "Capturing…" : "Capture from Browser"}</button><button className="button button--quiet" disabled={!project || extractingProject || saving} onClick={() => void extractFromProject()} title={project ? `Extract CSS tokens from ${project.name}` : "Choose a project below first"} type="button"><FolderOpen size={15} />{extractingProject ? "Extracting…" : "Extract from project"}</button><button className="button button--quiet" disabled={saving} onClick={() => packageInputRef.current?.click()} title="Choose one OpenDesign system folder or the full design-systems folder" type="button"><UploadSimple size={15} />Import OpenDesign</button><button className="button button--quiet" disabled={saving} onClick={() => packageZipInputRef.current?.click()} title="Choose one design-system package ZIP" type="button"><UploadSimple size={15} />Import ZIP</button><button className="button button--quiet" disabled={saving} onClick={() => importInputRef.current?.click()} type="button">Import JSON</button><button className="button button--quiet" disabled={saving} onClick={openCreate} type="button"><Plus size={15} />Create system</button></div>
    </header>
    <p className="design-system-capture-note">Import one package ZIP, a single system folder, or the full OpenDesign library. Imported systems stay on this device.</p>
    {loadError && <p className="settings-error" role="alert">{loadError}</p>}
    {message && <p className="design-system-message" role="status">{message}</p>}
    <div className="design-systems-layout">
      <nav aria-label="Design system library" className="design-system-library">
        <label className="design-system-search"><MagnifyingGlass size={15} /><input aria-label="Search names, tokens and package guidance" onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search names, tokens, guides" value={libraryQuery} /></label>
        <SelectControl aria-label="Filter design systems by category" label="All categories" onChange={setCategoryFilter} options={categoryOptions} size="full" value={categoryFilter} />
        {curatedSystems.length > 0 && <><span className="eyebrow">Curated systems</span>{curatedSystems.map((system) => <SystemOption key={system.id} system={system} selected={system.id === selected.id} onSelect={() => { setConfirmDelete(false); setSelectedId(system.id); }} />)}</>}
        {starterSystems.length > 0 && <><span className="eyebrow">Tribe starters</span>{starterSystems.map((system) => <SystemOption key={system.id} system={system} selected={system.id === selected.id} onSelect={() => { setConfirmDelete(false); setSelectedId(system.id); }} />)}</>}
        {savedSystems.length > 0 && <><span className="eyebrow design-system-saved-label">Imported and created</span>{savedSystems.map((system) => <SystemOption key={system.id} system={system} selected={system.id === selected.id} onSelect={() => { setConfirmDelete(false); setSelectedId(system.id); }} />)}</>}
        {!filteredSystems.length && <p className="design-system-library-empty">No systems match that search.</p>}
        {!userSystems.length && (loading || (!libraryQuery.trim() && categoryFilter === "all")) && <p className="design-system-library-empty">{loading ? "Loading saved systems…" : "Your imported and created systems appear here. Use Import OpenDesign to browse a local package library, or create one from a Tribe starter."}</p>}
      </nav>
      <div className="design-system-inspector">
        <div className="design-system-detail-heading"><div><span className="eyebrow">{shown.source === "user" ? `${shown.sourceLabel ?? "Your system"} · v${shown.version}` : shown.sourceLabel ?? "Tribe starter"}</span><h3>{shown.name}</h3><p>{shown.description}</p></div>
          <div className="design-system-actions">{selected.source === "user" && <><SelectControl aria-label="Saved design system version" disabled={historyBusy} label={historyBusy ? "Loading versions" : "Choose version"} onChange={(value) => void selectVersion(Number(value))} options={versionHistory.map((item) => ({ label: `Version ${item.version} · ${new Date(item.created_at).toLocaleDateString()}`, value: String(item.version) }))} size="regular" value={String(shown.version)} />{canCompareWithCurrent && <button aria-pressed={versionComparisonOpen} className="button button--quiet" onClick={() => setVersionComparisonOpen((value) => !value)} type="button">{versionComparisonOpen ? "Close comparison" : `Compare v${shownVersion} with current`}</button>}</>}<SelectControl aria-label="Export design system" label="Export design system" onChange={(format) => { if (format === "package") void downloadPackage(shown); else if (format === "snapshot") downloadSystem(shown); else downloadSystemTokens(shown, format); }} options={[{ label: "Export…", value: "", disabled: true }, { label: "Portable package (.zip)", value: "package" }, { label: "System snapshot (.json)", value: "snapshot" }, { label: "CSS tokens", value: "css" }, { label: "Design tokens JSON", value: "json" }]} size="regular" value="" />{selected.source === "user" && <><button className="button button--quiet" onClick={openEdit} type="button"><PencilSimple size={15} />Edit</button><button className="button button--quiet" disabled={saving} onClick={() => setConfirmDelete(true)} type="button"><Trash size={15} />Remove</button></>}</div>
        </div>
        {versionComparisonOpen && canCompareWithCurrent && <section aria-label="Saved version comparison" className="design-system-version-comparison">
          <header><div><strong>Version {shownVersion} compared with current version {selected.version}</strong><span>{comparisonTokenChanges.length} token changes · {comparisonFiles.length} package file changes</span></div><button aria-label="Close version comparison" className="button button--quiet" onClick={() => setVersionComparisonOpen(false)} type="button">Close</button></header>
          <div className="design-system-version-diff-grid">
            <section><strong>Changed tokens</strong>{comparisonTokenChanges.length ? <ul>{comparisonTokenChanges.map(({ key, previous, current }) => <li key={key}><code>{key}</code><span>{String(previous)} <span aria-hidden="true">→</span> {String(current)}</span></li>)}</ul> : <p>No semantic token changes.</p>}</section>
            <section><strong>Changed package files</strong>{comparisonFiles.length ? <ul>{comparisonFiles.map(({ path, change }) => <li key={path}><span>{path}</span><span>{change}</span></li>)}</ul> : <p>No package file changes.</p>}</section>
          </div>
          {comparisonPreviewPath ? <div className="design-system-preview-comparison">{[[`Version ${shownVersion}`, shown, activePreviewTheme], [`Current v${selected.version}`, selected, comparisonPreviewTheme]].map(([label, system, theme]) => <section key={label}><strong>{label}</strong><div className="design-system-preview-stage" data-viewport={viewport.id} style={{ "--design-system-preview-width": viewport.id === "wide" ? "100%" : `${viewport.width}px` }}><iframe aria-label={`${system.name} ${label} live preview`} className="design-system-package-preview" sandbox="" srcDoc={packagePreview(system, comparisonPreviewPath, theme)} title={`${system.name} · ${label}`} /></div></section>)}</div> : <p className="design-system-empty-detail">These versions do not share a preview page for a direct comparison.</p>}
        </section>}
        {confirmDelete && <div aria-labelledby="design-system-delete-title" className="design-system-delete-confirm" role="alertdialog"><div><strong id="design-system-delete-title">Remove {selected.name} from your library?</strong><p>This removes its saved versions. Existing project snapshots stay applied, but those projects cannot update the system from this library.</p><p>{projectUseSummary}</p></div><div><button className="button button--quiet" disabled={saving} onClick={() => setConfirmDelete(false)} type="button">Cancel</button><button className="button button--danger" disabled={saving} onClick={() => void deleteSelectedSystem()} type="button">{saving ? "Removing…" : "Remove system"}</button></div></div>}
        {(shown.category || shown.license || shown.packageVersion || shown.tags?.length || shown.sourceUrl) && <div className="design-system-provenance"><span>{shown.category || "Design system"}</span>{shown.packageVersion && <span>Package {shown.packageVersion}</span>}{shown.license && <span>Licence: {shown.license}</span>}{shown.tags?.map((tag) => <span key={tag}>{tag}</span>)}{shown.sourceUrl && <a href={shown.sourceUrl} rel="noreferrer" target="_blank">Package source</a>}</div>}
        <section aria-label="Brand mark" className="design-system-logo-section">
          <header><strong>Logo</strong><span>{logoAsset ? logoAsset.path : "Optional package asset"}</span></header>
          <div className="design-system-logo-stage">{logoDataUrl ? <img alt={`${shown.name} logo`} src={logoDataUrl} /> : <span>No logo supplied</span>}</div>
        </section>
        <section aria-label="Palette roles" className="design-system-palette-cards">
          <header><div><strong>Palette</strong><span>Named roles, values and intended use</span></div></header>
          <div>{paletteCards.filter(([key]) => shown.tokens[key]).map(([key, label, usage]) => <article key={key}><div className="design-system-palette-card-swatch" style={{ background: shown.tokens[key], "--palette-card-text": contrastRatio(shown.tokens[key], "#ffffff") >= 4.5 ? "#ffffff" : "#111827" }}><code>{shown.tokens[key]}</code></div><div className="design-system-palette-card-copy"><strong>{label}</strong><code>{key}</code><p>{usage}</p></div></article>)}</div>
        </section>
        <section aria-label="Layout guidance" className="design-system-layout-guidance">
          <header><div><strong>Layout and responsive guidance</strong><span>Extracted from this package's design guide</span></div></header>
          {layoutGuidance.length ? <div>{layoutGuidance.map((item) => <article key={item.heading}><strong>{item.heading}</strong><p>{item.body.replace(/^\s*[-*]\s+/gm, "• ").replace(/[`*_]/g, "")}</p></article>)}</div> : <p className="design-system-empty-detail">No layout guidance is included in this package.</p>}
        </section>
        {shown.packageFiles?.length > 0 && <section aria-label="Portable package contents" className="design-system-package-section">
          {packagePreviewHtml && <><header className="design-system-package-preview-toolbar"><div><strong>Live package preview</strong><span>Real package pages, reflowed at the selected width.</span></div><div className="design-system-package-preview-controls">
            <SelectControl aria-label="Package preview page" label="Choose preview" onChange={setPackagePreviewPath} options={packagePreviewOptions.map((item) => ({ label: item.label, value: item.path }))} size="regular" value={activePackagePreview.path} />
            {packageThemeOptions.length > 0 && <div aria-label="Preview theme" className="design-system-theme-control" role="group">{packageThemeOptions.map((option) => <button aria-pressed={activePreviewTheme === option.value} key={option.value} onClick={() => setPreviewTheme(option.value)} type="button">{option.label}</button>)}</div>}
            <div aria-label="Preview width" className="design-system-viewport-control" role="group">{DESIGN_SYSTEM_VIEWPORTS.map((item) => { const Icon = viewportIcons[item.id]; return <button aria-label={`${item.label} preview`} aria-pressed={item.id === viewportId} key={item.id} onClick={() => setViewportId(item.id)} title={item.label} type="button"><Icon size={16} /></button>; })}</div>
          </div></header><div className="design-system-preview-stage" data-viewport={viewport.id} style={{ "--design-system-preview-width": viewport.id === "wide" ? "100%" : `${viewport.width}px` }}><iframe aria-label={`${shown.name} ${activePackagePreview.label} preview`} className="design-system-package-preview" sandbox="" srcDoc={packagePreviewHtml} title={`${shown.name} · ${activePackagePreview.label}`} /></div></>}
          <section aria-label="Responsive output previews" className="design-system-assets-gallery">
            <header><div><strong>Responsive output previews</strong><span>Real pages included in this package</span></div><span>{packageOutputPreviews.length} previews</span></header>
            {packageOutputPreviews.length ? <div>{packageOutputPreviews.map((asset) => <article key={asset.path}><iframe aria-label={`${shown.name} ${asset.label} thumbnail`} className="design-system-asset-thumbnail" sandbox="" srcDoc={packagePreview(shown, asset.path, activePreviewTheme)} title={`${shown.name} · ${asset.label}`} /><div><span className="eyebrow">{asset.role}</span><strong>{asset.label}</strong><button className="button button--quiet" onClick={() => { setPackagePreviewPath(asset.path); setViewportId("wide"); }} type="button">Open preview</button></div></article>)}</div> : <p className="design-system-empty-detail">Add representative HTML pages to this package to build the preview gallery.</p>}
          </section>
          {packageMediaAssets.length > 0 && <section aria-label="Brand assets and fonts" className="design-system-brand-assets"><header><div><strong>Brand assets and fonts</strong><span>Local media included in this package</span></div><span>{packageMediaAssets.length} assets</span></header><div>{packageMediaAssets.map((asset) => {
            const isFont = /\.(?:woff2?|ttf|otf)$/i.test(asset.path);
            const name = asset.path.split("/").at(-1);
            return <article key={asset.path}>{isFont ? <iframe aria-label={`${name} font specimen`} sandbox="" srcDoc={packageFontPreview(asset)} title={`${name} font specimen`} /> : <div className="design-system-brand-asset-image"><img alt={`${name} package asset`} loading="lazy" src={packageAssetDataUrl(asset)} /></div>}<div><strong>{name}</strong><code>{asset.path}</code><span>{isFont ? "Font" : "Image or logo"}</span></div></article>;
          })}</div></section>}
          {extractionEvidence && <EvidenceReview evidence={extractionEvidence} tokens={shown.tokens} />}
          {(designGuideFile || usageGuideFile || sourceEvidenceFile) && <details className="design-system-guide-details" open>
            <summary>Design guide{guideHeadings.length ? ` · ${guideHeadings.length} sections` : ""}</summary>
            <div className="design-system-package-files"><section className="design-system-guide-reading">
                <header><div><strong>Design guide</strong><span>Rendered package guidance and source notes</span></div><button aria-label={guideCopyStatus === "copied" ? "Agent guidance copied" : guideCopyStatus === "failed" ? "Could not copy agent guidance" : "Copy agent guidance"} className="button button--quiet" disabled={!agentGuidance} onClick={() => void copyAgentGuidance()} type="button">{guideCopyStatus === "copied" ? <Check size={14} /> : <Copy size={14} />}{guideCopyStatus === "copied" ? "Copied" : guideCopyStatus === "failed" ? "Copy failed" : "Copy agent guidance"}</button></header>
                {guideHeadings.length > 0 && <nav aria-label="Design guide contents"><strong>On this page</strong><ol>{guideHeadings.map((heading) => <li className={`design-system-guide-toc-item design-system-guide-toc-item--${heading.depth}`} key={heading.id}><a href={`#${heading.id}`}>{heading.title}</a></li>)}</ol></nav>}
                {designGuideFile && <article><h4>Design principles</h4><div className="design-system-guide-markdown message-markdown"><MarkdownContent headingAnchors={guideHeadingAnchors}>{designGuideFile.content.slice(0, 30_000)}</MarkdownContent></div></article>}
                {usageGuideFile && <article><h4>Agent instructions</h4><div className="design-system-guide-markdown message-markdown"><MarkdownContent>{usageGuideFile.content.slice(0, 16_000)}</MarkdownContent></div></article>}
                {sourceEvidenceFile && <article><h4>Source evidence</h4><div className="design-system-guide-markdown message-markdown"><MarkdownContent>{sourceEvidenceFile.content.slice(0, 12_000)}</MarkdownContent></div></article>}
              </section></div>
          </details>}
          <details className="design-system-package-guide"><summary>Package files ({shown.packageFiles.length})</summary>
            <div className="design-system-package-files">{shown.packageFiles.filter(({ path }) => /(^|\/)(license|notice|copying|copyright)([-_.][a-z0-9.-]+)?$/i.test(path)).map(({ path, content }) => <article key={path}><h4>{path}</h4><pre>{content.slice(0, 30_000)}</pre></article>)}
              <ul>{shown.packageFiles.filter(({ path }) => !["DESIGN.md", "USAGE.md", "source/evidence.md"].includes(path)).map(({ path }) => <li key={path}><code>{path}</code></li>)}</ul>
            </div>
          </details>
          {shown.attribution && <p className="design-system-source-evidence">{shown.attribution}</p>}
        </section>}
        {!packagePreviewHtml && <section className="design-system-preview-section" aria-label="Live component preview">
          <header className="design-system-preview-toolbar"><div><strong>Component preview</strong><span>Updates with this system's tokens</span></div><div aria-label="Preview width" className="design-system-viewport-control" role="group">{DESIGN_SYSTEM_VIEWPORTS.map((item) => { const Icon = viewportIcons[item.id]; return <button aria-label={`${item.label} preview`} aria-pressed={item.id === viewportId} key={item.id} onClick={() => setViewportId(item.id)} title={item.label} type="button"><Icon size={16} /></button>; })}</div></header>
          <div className="design-system-preview-stage"><div className="design-system-preview-frame" data-viewport={viewport.id} style={{ ...previewStyle, maxWidth: `${viewport.width}px` }}>
            <div className="design-system-example-topbar"><span className="design-system-example-mark" /><strong>Northstar</strong><nav><span>Overview</span><span>Reports</span></nav><button type="button">Open workspace</button></div>
            <div className="design-system-example-content">
              <div className="design-system-example-intro"><span className="eyebrow">Your workspace</span><h4>Make the next decision clearer.</h4><p>A focused view of progress, signals and work that needs attention.</p><button className="design-system-example-primary" type="button">Review insights</button></div>
              <div className="design-system-example-controls">
                <label><span>Search</span><input placeholder="Search projects" /></label>
                <label><span>Period</span><select defaultValue="30"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label>
                <button type="button">Filter</button><span className="design-system-example-status">On track</span><span className="design-system-example-status is-warning">Review due</span><span className="design-system-example-status is-danger">Blocked</span>
              </div>
              <div className="design-system-example-dashboard">
                <div className="design-system-example-cards"><article><span>Active projects</span><strong>12</strong><small>Across 4 teams</small></article><article><span>On track</span><strong>84%</strong><small>Up 6% this month</small></article><article className="design-system-example-summary"><span>Latest update</span><strong>Research brief ready</strong><small>Updated 8 minutes ago</small><a href="#preview" onClick={(event) => event.preventDefault()}>View summary</a></article></div>
                <section aria-label="Delivery by month chart" className="design-system-example-chart"><header><strong>Delivery by month</strong><span>Completed work</span></header><div aria-hidden="true" className="design-system-example-bars">{[42, 67, 52, 78, 61, 91, 74].map((height, index) => <i key={index} style={{ "--bar-height": `${height}%`, "--bar-tone": index === 5 ? "var(--system-accent)" : index === 6 ? "var(--system-success)" : "var(--system-raised)" }} />)}</div><footer><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span></footer></section>
              </div>
            </div>
          </div></div>
          <p className="design-system-preview-caption">Representative dashboard · {viewport.label} width</p>
        </section>}
        <section aria-label="Design tokens" className="design-system-tokens">
          {colorLabels.map(([key, label]) => <div className="design-system-token" key={key}><span className="design-system-token-chip" style={{ backgroundColor: shown.tokens[key] }} /><span>{label}</span><code>{shown.tokens[key]}</code></div>)}
          {["font", "fontSize", "spacing", "radius"].map((key) => <div className="design-system-token design-system-token--text" key={key}><span>{({ font: "Typeface", fontSize: "Body size", spacing: "Base spacing", radius: "Corner radius" })[key]}</span><code>{shown.tokens[key]}</code></div>)}
        </section>
        <ContrastReview tokens={shown.tokens} />
        <section aria-label="Typography foundation" className="design-system-type-foundation"><header><div><strong>Typography</strong><span>Type scale and font stack from this system</span></div><span>{shown.tokens.fontSize} body</span></header><div className="design-system-type-specimen" style={{ fontFamily: shown.tokens.font }}><strong>Aa</strong><div><span>The quick brown fox jumps over the lazy dog.</span><small>Regular · {shown.tokens.fontSize}</small></div><b>Ag 123</b></div></section>
        {packageTokenCount > 15 && <details className="design-system-token-inventory"><summary>All foundations · {packageTokenCount} package tokens</summary><div>{packageTokenGroups.map((group) => <section key={group.name}><header><strong>{group.name}</strong><span>{group.items.length} tokens</span></header><div>{group.items.map((token) => <article key={token.name}>{token.colour && <i aria-hidden="true" style={{ backgroundColor: token.value }} />}<code>{token.name}</code><span title={token.value}>{token.value}</span></article>)}</div></section>)}</div></details>}
        <details aria-label="Generated colour scales" className="design-system-palette-section">
          <summary>Generated colour scales · 11 OKLCH shades for each semantic colour role</summary>
          <PaletteScales palettes={shownPalettes} />
        </details>
        {(shown.guidance || Object.values(shown.components ?? {}).some(Boolean) || shown.references?.length > 0) && <section aria-label="Usage guidance" className="design-system-guidance"><strong>Usage guidance</strong>{shown.guidance && <p>{shown.guidance}</p>}{Object.entries(shown.components ?? {}).filter(([, value]) => value).map(([key, value]) => <p key={key}><b>{key}</b> · {value}</p>)}{shown.references?.map((item) => <a href={item.url} key={item.url} rel="noreferrer" target="_blank">{item.label || item.url}</a>)}</section>}
        {projectComparisonOpen && projectSnapshot && <section aria-label="Compare with the project's applied design system" className="design-system-version-comparison">
          <header><div><strong>Project snapshot compared with selected version</strong><span>{projectSnapshot.name} · v{projectSnapshot.version} → {shown.name} · v{shownVersion} · {projectTokenChanges.length} token changes · {projectFileChanges.length} package file changes</span></div><button aria-label="Close project comparison" className="button button--quiet" onClick={() => setProjectComparisonOpen(false)} type="button">Close</button></header>
          <div className="design-system-version-diff-grid">
            <section><strong>Changed tokens</strong>{projectTokenChanges.length ? <ul>{projectTokenChanges.map(({ key, previous, current }) => <li key={key}><code>{key}</code><span>{String(previous)} <span aria-hidden="true">→</span> {String(current)}</span></li>)}</ul> : <p>No semantic token changes.</p>}</section>
            <section><strong>Changed package files</strong>{projectFileChanges.length ? <ul>{projectFileChanges.map(({ path, change }) => <li key={path}><span>{path}</span><span>{change}</span></li>)}</ul> : <p>No package file changes.</p>}</section>
          </div>
          {projectComparisonPreviewPath ? <div className="design-system-preview-comparison">{[["Currently applied", projectSnapshot, packageThemeOptionsForSystem(projectSnapshot).some((option) => option.value === previewTheme) ? previewTheme : ""], ["Selected version", shown, activePreviewTheme]].map(([label, system, theme]) => <section key={label}><strong>{label}</strong><div className="design-system-preview-stage" data-viewport={viewport.id} style={{ "--design-system-preview-width": viewport.id === "wide" ? "100%" : `${viewport.width}px` }}><iframe aria-label={`${system.name} ${label} preview`} className="design-system-package-preview" sandbox="" srcDoc={packagePreview(system, projectComparisonPreviewPath, theme)} title={`${system.name} · ${label}`} /></div></section>)}</div> : <p className="design-system-empty-detail">These packages do not share a preview page for a direct comparison.</p>}
        </section>}
        {projectComparisonError && <p className="settings-error" role="alert">{projectComparisonError}</p>}
        <section className="design-system-apply">
          <div><strong>Use in a project</strong><span>{projectUsesShownSystem ? `${project.name} uses ${appliedSystem.name} · v${appliedSystem.version}${!isApplied ? `; selecting this version will ${Number(shownVersion) < Number(appliedSystem.version) ? "restore an earlier snapshot" : "update the project snapshot"}.` : "."}` : appliedSystem ? `${project.name} currently uses ${appliedSystem.name} · v${appliedSystem.version}. Applying replaces its selected snapshot.` : "Give project work this system as design guidance."}</span></div>
          <div className="design-system-apply-actions"><SelectControl aria-label="Project to apply design system to" disabled={!projects.length} label="Choose a project" onChange={setProjectId} options={projectOptions} size="regular" value={projectId} />{appliedSystem && !isApplied && <button aria-pressed={projectComparisonOpen} className="button button--quiet" disabled={projectComparisonBusy || saving} onClick={() => void toggleProjectComparison()} type="button">{projectComparisonBusy ? "Loading project snapshot…" : projectComparisonOpen ? "Close comparison" : "Compare with project"}</button>}<button className="button button--primary" disabled={!project || isApplied || saving} onClick={() => void applyToProject()} type="button">{applyActionLabel}</button>{appliedSystem && project && <button className="button button--quiet" disabled={saving} onClick={() => void removeFromProject()} type="button">Remove</button>}</div>
        </section>
      </div>
    </div>
    {editor && draft && <div className="mission-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestCloseEditor(); }}>
      <form aria-labelledby="design-system-editor-title" aria-modal="true" className="mission-dialog design-system-editor" onSubmit={saveDraft} role="dialog">
        <header className="design-system-editor-heading"><div><span className="eyebrow">{editor.mode === "edit" ? "New version" : editor.source === "project" ? "Project extraction" : "Reusable design guidance"}</span><h2 id="design-system-editor-title">{editor.mode === "edit" ? `Edit ${selected.name}` : editor.source === "project" ? `Review ${draft.name}` : "Create a design system"}</h2><p>{editor.source === "project" ? "Review extracted tokens, source files and the responsive preview before saving." : "Set tokens and component guidance, then review them in the live preview."}</p></div><button aria-label="Close" className="icon-button" disabled={saving || assetBusy} onClick={requestCloseEditor} type="button"><X size={16} /></button></header>
        <div className="design-system-editor-body">
          <label>System name<input autoFocus maxLength={100} onChange={(event) => updateDraft("name", event.target.value)} required value={draft.name} /></label>
          <label>Description<input maxLength={500} onChange={(event) => updateDraft("description", event.target.value)} value={draft.description} /></label>
          {draft.packageFiles?.length > 0 && <div className="design-system-package-metadata"><label>Category<input maxLength={80} onChange={(event) => updateDraft("category", event.target.value)} value={draft.category ?? ""} /></label><label>Licence<input maxLength={200} onChange={(event) => updateDraft("license", event.target.value)} value={draft.license ?? ""} /></label><label>Tags<input maxLength={500} onChange={(event) => updateDraft("tags", event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean))} value={(draft.tags ?? []).join(", ")} /></label><label>Package source URL<input autoCapitalize="none" maxLength={2048} onChange={(event) => { setSourceUrlInput(event.target.value); setEditorDirty(true); }} placeholder="https://…" type="url" value={sourceUrlInput} /></label></div>}
          <section aria-label="Generated colour palettes" className="design-system-editor-palettes"><div><strong>Generated colour scales</strong><span>Change a role colour below to regenerate its 50–950 scale.</span></div><PaletteScales compact palettes={draft.palettes} /></section>
          <fieldset className="design-system-colors"><legend>Colour tokens</legend><div>{colorLabels.map(([key, label]) => <label className="design-system-color-field" key={key}><span>{label}</span><input aria-label={`${label} colour`} onChange={(event) => updateToken(key, event.target.value)} type="color" value={draft.tokens[key]} /><code>{draft.tokens[key]}</code></label>)}</div></fieldset>
          <ContrastReview tokens={draft.tokens} />
          <div className="design-system-scalar-fields">{scalarTokens.map(([key, label, values]) => <label key={key}>{label}<SelectControl aria-label={label} label={label} onChange={(value) => updateToken(key, value)} options={values.map((value) => ({ label: value, value }))} size="full" value={draft.tokens[key]} /></label>)}<label>Typeface<input maxLength={120} onChange={(event) => updateToken("font", event.target.value)} value={draft.tokens.font} /></label></div>
          <fieldset className="design-system-component-guidance"><legend>Component guidance</legend>{[["button", "Buttons"], ["card", "Cards"], ["input", "Inputs"]].map(([key, label]) => <label key={key}>{label}<textarea maxLength={800} onChange={(event) => updateDraft("components", { ...draft.components, [key]: event.target.value })} rows={2} value={draft.components[key]} /></label>)}</fieldset>
          <label>System guidance<textarea maxLength={8000} onChange={(event) => updateDraft("guidance", event.target.value)} rows={4} value={draft.guidance} /></label>
          {draftExtractionEvidence && <div className="design-system-extraction-review"><EvidenceReview evidence={draftExtractionEvidence} tokens={draft.tokens} /><div><button className="button button--quiet" disabled={!browserCaptureAvailable || capturingReference || saving || assetBusy || (draftExtractionEvidence.source?.pages?.length ?? 0) >= 12} onClick={() => void captureAnotherBrowserPage()} title={browserCaptureAvailable ? "Capture the current Tribe Browser page and combine its observations with this draft" : "Available in the desktop app when a Browser tab is open"} type="button"><Globe size={15} />{capturingReference ? "Capturing page…" : "Capture another page"}</button>{browserCaptureMessage && <span className="design-system-browser-capture-message" role="status">{browserCaptureMessage}</span>}<p className="design-system-evidence-edit-hint">Edit source/evidence.json to refine observations and confidence. New samples recalculate token candidates in this draft; review the values and preview before saving.</p></div></div>}
          {draft.packageFiles?.length > 0 && <section aria-label="Portable package editor" className="design-system-package-editor">
            <div><strong>Package files</strong><span>Edit component specimens, patterns, previews, provenance and guidance. Manifest fields, semantic tokens and their derived JSON use the controls above.</span></div>
            <SelectControl aria-label="Package file to edit" label="Choose package file" onChange={setPackageEditorPath} options={draft.packageFiles.filter(({ path }) => !["manifest.json", "design-tokens.json"].includes(path) && !isBinaryPackageAsset(path)).map(({ path }) => ({ label: path, value: path }))} size="full" value={packageEditorPath} />
            <div className="design-system-package-file-actions"><label>New package file<input autoCapitalize="none" maxLength={240} onChange={(event) => setNewPackageFilePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addPackageFile(); } }} placeholder="patterns/empty-state.md" value={newPackageFilePath} /></label><button className="button button--quiet" disabled={saving || assetBusy} onClick={addPackageFile} type="button">Add file</button>{packageEditorPath && !["manifest.json", "design-tokens.json", "tokens.css", "DESIGN.md", "USAGE.md", "components.html"].includes(packageEditorPath) && <button className="button button--quiet" disabled={saving || assetBusy} onClick={() => removePackageFile(packageEditorPath)} type="button">Remove selected file</button>}</div>
            {draft.packageFiles.filter(({ path }) => !["manifest.json", "design-tokens.json"].includes(path) && !isBinaryPackageAsset(path)).some(({ path }) => path === packageEditorPath) && <label className="design-system-package-source">{packageEditorPath}{packageEditorPath === "tokens.css" && <small>Canonical package tokens. Changes refresh the semantic controls and token JSON where Tribe can resolve them.</small>}<textarea aria-label={`Edit ${packageEditorPath}`} maxLength={1_000_000} onChange={(event) => updatePackageFile(packageEditorPath, event.target.value)} rows={16} spellCheck={/\.md$/i.test(packageEditorPath)} value={draft.packageFiles.find((file) => file.path === packageEditorPath)?.content ?? ""} /></label>}
            <section aria-label="Package assets" className="design-system-package-assets">
              <div><strong>Brand assets and fonts</strong><span>Add or remove local package assets. Reference each asset with a path relative to its package file, such as <code>../assets/logo.svg</code> from a page in <code>preview/</code>.</span></div>
              <input accept=".svg,.png,.jpg,.jpeg,.gif,.webp,.avif,.woff,.woff2,.ttf,.otf" aria-hidden="true" className="visually-hidden" multiple onChange={addPackageAssets} ref={assetInputRef} tabIndex={-1} type="file" />
              <button className="button button--quiet" disabled={saving || assetBusy} onClick={() => assetInputRef.current?.click()} type="button"><UploadSimple size={15} />{assetBusy ? "Adding assets…" : "Add assets"}</button>
              {(assetMessage || assetBusy) && <span className="design-system-package-assets-message" role="status">{assetBusy ? "Reading assets into this draft…" : assetMessage}</span>}
              {draft.packageFiles.filter(({ path }) => isPackageAsset(path)).length > 0
                ? <ul>{draft.packageFiles.filter(({ path }) => isPackageAsset(path)).map((asset) => <li key={asset.path}><code>{asset.path}</code><button aria-label={`Remove ${asset.path}`} className="button button--quiet" disabled={saving || assetBusy} onClick={() => removePackageAsset(asset.path)} type="button">Remove</button></li>)}</ul>
                : <p>No image or font assets in this package.</p>}
              {draftLogoDataUrl && <div className="design-system-package-assets-logo"><img alt={`${draft.name || "Draft system"} logo preview`} src={draftLogoDataUrl} /><span>Brand mark preview</span></div>}
            </section>
            {draftPreviewHtml && <section className="design-system-editor-preview" aria-label="Live package preview"><header><strong>Live preview</strong><div className="design-system-editor-preview-actions">{savedPreviewHtml && <button aria-pressed={compareSavedPreview} className="button button--quiet" onClick={() => setCompareSavedPreview((value) => !value)} type="button">{compareSavedPreview ? "Close comparison" : `Compare with saved v${shown.version ?? 1}`}</button>}{draftThemeOptions.length > 0 && <div className="design-system-theme-control" role="group" aria-label="Preview theme">{draftThemeOptions.map((option) => <button aria-pressed={option.value === activeDraftPreviewTheme} key={option.value} onClick={() => setPreviewTheme(option.value)} type="button">{option.label}</button>)}</div>}<div className="design-system-viewport-control" role="group" aria-label="Preview width">{DESIGN_SYSTEM_VIEWPORTS.map((item) => { const Icon = viewportIcons[item.id]; return <button aria-label={`${item.label} preview`} aria-pressed={item.id === viewportId} key={item.id} onClick={() => setViewportId(item.id)} title={item.label} type="button"><Icon size={16} /></button>; })}</div></div></header>{compareSavedPreview && savedPreviewHtml ? <div className="design-system-preview-comparison">{[["Saved version", savedPreviewHtml, `${shown.name} saved version preview`], ["Draft", draftPreviewHtml, `${draft.name} draft preview`]].map(([label, html, title]) => <section key={label}><strong>{label}</strong><div className="design-system-preview-stage" data-viewport={viewport.id} style={{ "--design-system-preview-width": viewport.id === "wide" ? "100%" : `${viewport.width}px` }}><iframe aria-label={title} className="design-system-package-preview" sandbox="" srcDoc={html} title={title} /></div></section>)}</div> : <div className="design-system-preview-stage" data-viewport={viewport.id} style={{ "--design-system-preview-width": viewport.id === "wide" ? "100%" : `${viewport.width}px` }}><iframe aria-label={`${draft.name} live preview`} className="design-system-package-preview" sandbox="" srcDoc={draftPreviewHtml} title={`${draft.name} live package preview`} /></div>}</section>}
          </section>}
          {draft.references?.length > 0 && <section className="design-system-captured-references" aria-label="Captured references"><strong>Captured styles from</strong>{draft.references.map((item, index) => <div className="design-system-reference-item" key={`${item.url}-${index}`}><a href={item.url} rel="noreferrer" target="_blank">{item.label || item.url}</a><button aria-label={`Remove reference ${item.label || item.url}`} className="button button--quiet" disabled={saving} onClick={() => updateDraft("references", draft.references.filter((_, itemIndex) => itemIndex !== index))} type="button">Remove</button></div>)}</section>}
          {capturedPagePreview && <section aria-label="Compare the source page and design system preview" className="design-system-reference-comparison">
            <div className="design-system-reference-comparison-heading"><strong>Compare with the source page</strong><span>The page image stays on this device and is cleared when you close the editor.</span></div>
            <div className="design-system-reference-comparison-grid">
              <figure><img alt="Current visible page in Tribe Browser" height={capturedPagePreview.height} src={`data:${capturedPagePreview.mimeType};base64,${capturedPagePreview.data}`} width={capturedPagePreview.width} /><figcaption>Open Browser page</figcaption></figure>
              <div className="design-system-reference-mock" style={{ background: draft.tokens.canvas, color: draft.tokens.text, borderColor: draft.tokens.line, borderRadius: draft.tokens.radius, fontFamily: draft.tokens.font, fontSize: draft.tokens.fontSize }}>
                <span style={{ color: draft.tokens.muted }}>Draft system · {draft.name || "Untitled"}</span><strong>Preview components</strong>
                <input aria-label="Preview search field" placeholder="Search items" style={{ background: draft.tokens.surface, color: draft.tokens.text, borderColor: draft.tokens.line, borderRadius: draft.tokens.radius }} />
                <div><button style={{ background: draft.tokens.accent, color: draft.tokens.canvas, borderRadius: draft.tokens.radius }}>Primary action</button><span style={{ background: draft.tokens.success, color: contrastRatio(draft.tokens.success, "#ffffff") >= 4.5 ? "#ffffff" : "#07111c", borderRadius: draft.tokens.radius }}>Ready</span></div>
                <small style={{ color: draft.tokens.muted }}>Body text, field and status colours</small>
              </div>
            </div>
          </section>}
          <label>Reference URL <small>Add a page used as visual evidence for this system.</small><input autoCapitalize="none" maxLength={2048} onChange={(event) => { setReferenceInput(event.target.value); setEditorDirty(true); }} placeholder="https://example.com" type="url" value={referenceInput} /></label>
          {editorError && <p className="settings-error" role="alert">{editorError}</p>}
        </div>
        <footer className={`design-system-editor-footer${confirmDiscard ? " is-confirming-discard" : ""}`}>
          {confirmDiscard ? <div aria-labelledby="design-system-discard-title" className="design-system-discard-prompt" role="alertdialog"><div><strong id="design-system-discard-title">Discard unsaved changes?</strong><span>Your edits will be lost. Keep editing or discard this draft.</span></div><div><button autoFocus className="button button--quiet" onClick={() => setConfirmDiscard(false)} type="button">Keep editing</button><button className="button button--danger" onClick={closeEditor} type="button">Discard changes</button></div></div> : <><span>Saving keeps earlier versions available to projects that already use them.</span><div><button className="button button--quiet" disabled={saving || assetBusy} onClick={requestCloseEditor} type="button">Cancel</button><button className="button button--primary" disabled={saving || assetBusy} type="submit"><FloppyDisk size={15} />{saving ? "Saving…" : assetBusy ? "Adding assets…" : editor.mode === "edit" ? "Save new version" : "Save system"}</button></div></>}
        </footer>
      </form>
    </div>}
  </section>;
}

function SystemOption({ system, selected, onSelect }) {
  const source = system.sourceLabel || (system.source === "curated" ? "Curated reference" : system.source === "starter" ? "Tribe starter" : "Imported or created");
  const license = system.license || (system.source === "starter" ? "Tribe starter content" : "Licence not declared");
  return <button aria-pressed={selected} className={`design-system-option${selected ? " is-selected" : ""}`} onClick={onSelect} type="button">
    <span className="design-system-swatch-row" aria-hidden="true">{["canvas", "surface", "raised", "accent"].map((key) => <i key={key} style={{ backgroundColor: system.tokens[key] }} />)}</span>
    <span className="design-system-option-copy"><strong>{system.name}</strong><small>{system.description}</small><small className="design-system-option-provenance" title={`${source} · ${license}`}>{source} · {license}</small></span>
    {selected && <Check aria-hidden="true" size={15} />}
  </button>;
}

function PaletteScales({ palettes, compact = false }) {
  const labels = { brand: "Brand", neutral: "Neutral", success: "Success", warning: "Warning", danger: "Error" };
  return <div className={`design-system-palette-scales${compact ? " is-compact" : ""}`}>
    {Object.entries(labels).map(([role, label]) => <div className="design-system-palette-row" key={role}>
      <strong>{label}</strong>
      <div className="design-system-palette-swatches">
        {(palettes?.[role] ?? []).map(({ step, color }) => {
          const blackRatio = contrastRatio(color, "#000000");
          const whiteRatio = contrastRatio(color, "#ffffff");
          const contrast = Math.max(blackRatio, whiteRatio);
          const textColour = blackRatio > whiteRatio ? "black" : "white";
          return <span aria-label={`${label} shade ${step} · ${color} · ${contrast.toFixed(1)}:1 contrast with ${textColour} text`} key={step} style={{ backgroundColor: color, color: textColour }} title={`${label} ${step} · ${color} · ${contrast.toFixed(1)}:1 with ${textColour} text`}>
            <small>{step}</small><code>{color}</code>
          </span>;
        })}
      </div>
    </div>)}
  </div>;
}

function ContrastReview({ tokens }) {
  const checks = [
    ["Primary text on canvas", "text", "canvas", 4.5],
    ["Secondary text on canvas", "muted", "canvas", 4.5],
    ["Primary text on surface", "text", "surface", 4.5],
    ["Primary text on raised surface", "text", "raised", 4.5],
    ["Accent on canvas · controls", "accent", "canvas", 3],
    ["Focus indicator on canvas", "focus", "canvas", 3],
  ];
  return <section aria-label="Contrast review" className="design-system-contrast-review">
    <header><div><strong>Contrast review</strong><span>Checks key text and control pairings against common contrast targets.</span></div></header>
    <ul>{checks.map(([label, foreground, background, target]) => {
      const ratio = contrastRatio(tokens[foreground], tokens[background]);
      const passes = ratio >= target;
      return <li key={label}><span>{label}</span><code>{ratio.toFixed(2)}:1</code><span className={passes ? "is-pass" : "is-below"}>{passes ? `Meets ${target}:1` : `Below ${target}:1`}</span></li>;
    })}</ul>
  </section>;
}

function EvidenceReview({ evidence, tokens = {} }) {
  const observations = Array.isArray(evidence.observations) ? evidence.observations.slice(0, 120) : [];
  const inferences = Array.isArray(evidence.inferences) ? evidence.inferences.slice(0, 32) : [];
  const source = evidence.source && typeof evidence.source === "object" ? evidence.source : {};
  const pages = Array.isArray(source.pages) ? source.pages.slice(0, 12) : [];
  const confidence = evidence.confidence && typeof evidence.confidence === "object" ? evidence.confidence : {};
  const sourceLabel = pages.length ? `${pages.length} browser pages` : source.url || source.project || source.origin || source.type || "Source not recorded";
  return <section aria-label="Extraction evidence and inferred tokens" className="design-system-evidence-review">
    <header><div><strong>Extraction evidence</strong><span>Observed source values are kept separate from inferred design tokens.</span></div><span className={`design-system-evidence-confidence is-${String(confidence.level ?? "unknown").toLowerCase()}`}>{confidence.level ?? "Confidence not recorded"} confidence</span></header>
    <p className="design-system-evidence-source"><strong>Source:</strong> {sourceLabel}{source.scope ? ` · ${source.scope}` : ""}</p>
    {confidence.reason && <p className="design-system-evidence-reason">{confidence.reason}</p>}
    {pages.length > 0 && <details className="design-system-evidence-observations"><summary>Captured pages · {pages.length}</summary><ul>{pages.map((page, index) => { const href = safeEvidenceUrl(page.url); return <li key={`${page.url}-${index}`}>{href ? <a href={href} rel="noreferrer" target="_blank">{page.url}</a> : <code>{String(page.url ?? "Invalid source URL")}</code>}<small>{page.sampleCount ?? 0} visible elements · {page.buttonSamples ?? 0} buttons · {page.inputSamples ?? 0} inputs</small></li>; })}</ul></details>}
    {observations.length > 0 && <details className="design-system-evidence-observations"><summary>Observed values · {observations.length}</summary><ul>{observations.map((item, index) => <li key={`${item.name ?? item.group ?? "observation"}-${index}`}><span>{item.group ?? "Observation"}{item.name ? ` · ${item.name}` : ""}</span><code>{String(item.value ?? "")}</code>{item.sourceFile && <small>{item.sourceFile}</small>}{Number.isFinite(item.samples) && <small>{item.samples} samples</small>}</li>)}</ul></details>}
    {inferences.length > 0 && <section className="design-system-evidence-inferences"><strong>Inferred tokens</strong><ul>{inferences.map((item, index) => {
      const current = tokens[item.token];
      const changed = current !== undefined && String(current) !== String(item.value);
      return <li key={`${item.token ?? "token"}-${index}`}><code>{item.token ?? "Token"}</code><span>{String(item.value ?? "Not set")}{changed ? ` · currently ${String(current)}` : ""}</span><small>{item.basis ?? "Basis not recorded"}{item.sourceFile ? ` · ${item.sourceFile}` : ""} · {item.confidence ?? "confidence not recorded"} confidence</small></li>;
    })}</ul></section>}
    {Array.isArray(evidence.limitations) && evidence.limitations.length > 0 && <section className="design-system-evidence-limitations"><strong>Review notes</strong><ul>{evidence.limitations.slice(0, 16).map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>}
  </section>;
}
