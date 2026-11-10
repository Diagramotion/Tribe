import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { addDesignSystemPackageFile, DESIGN_SYSTEM_PALETTE_STEPS, DESIGN_SYSTEM_PRESETS, MAX_DESIGN_SYSTEM_IMPORT_BYTES, compareDesignSystemSnapshots, contrastRatio, designSystemFromReference, designSystemGuideHeadings, designSystemPreviewThemeAttributes, designSystemPreviewThemeOptions, designSystemTokenCss, designSystemTokenJson, extractStaticThemeDeclarations, generateColourScale, generateDesignPalettes, mergeDesignSystemReferenceCapture, packageDesignTokenFile, packageTokensFromCss, parseDesignSystemImport, parseDesignSystemPackage, parseDesignSystemPackageLibrary, removeDesignSystemPackageFile, syncPackageTokens, validateDesignSystemPackageFilePath } from "../src/domain/design-systems.js";

let vite;
let DesignSystemsView;
let RuntimePresets;
let MarkdownContent;
const originalWindow = globalThis.window;

before(async () => {
  globalThis.window = { setTimeout };
  vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ default: DesignSystemsView } = await vite.ssrLoadModule("/src/views/DesignSystemsView.jsx"));
  ({ DESIGN_SYSTEM_PRESETS: RuntimePresets } = await vite.ssrLoadModule("/src/domain/design-systems.js"));
  ({ MarkdownContent } = await vite.ssrLoadModule("/src/components/MarkdownContent.jsx"));
});

after(async () => {
  await vite?.close();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test("design-system export snapshots import as a fresh user-owned version", () => {
  const exported = { ...DESIGN_SYSTEM_PRESETS[0], version: 4 };
  const imported = parseDesignSystemImport(JSON.stringify(exported));

  assert.equal(imported.name, exported.name);
  assert.equal(imported.source, "user");
  assert.equal(imported.version, 1);
  assert.equal("id" in imported, false);
  assert.equal("sourceLabel" in imported, false);
  assert.deepEqual(imported.tokens, exported.tokens);
  assert.deepEqual(imported.components, exported.components);
  assert.deepEqual(imported.references, exported.references);
  assert.equal(MAX_DESIGN_SYSTEM_IMPORT_BYTES, 8_000_000);
});

test("OpenDesign package import preserves its files and derives preview tokens", async () => {
  const files = [
    { name: "manifest.json", webkitRelativePath: "linear/manifest.json", size: 70, text: async () => JSON.stringify({ id: "linear-app", name: "Linear", category: "Productivity & SaaS", license: "Apache-2.0", version: 2, files: { designTokens: "design.tokens" } }) },
    { name: "DESIGN.md", webkitRelativePath: "linear/DESIGN.md", size: 50, text: async () => "# Design by intent" },
    { name: "tokens.css", webkitRelativePath: "linear/tokens.css", size: 120, text: async () => ":root { --bg: #08090a; --surface: #191a1b; --fg: #f7f8f8; --accent: #5e6ad2; --radius-sm: 6px; --text-base: 16px; --font-body: \"Inter\", \"SF Pro\", sans-serif; }" },
    { name: "components.html", webkitRelativePath: "linear/components.html", size: 30, text: async () => "<main><button>Save</button></main>" },
    { name: "design.tokens", webkitRelativePath: "linear/design.tokens", size: 80, text: async () => JSON.stringify({ color: { primary: { $type: "color", $value: "#5e6ad2" } } }) },
    { name: "mark.png", webkitRelativePath: "linear/assets/mark.png", size: 3, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer },
  ];
  const imported = await parseDesignSystemPackage(files);
  assert.equal(imported.name, "Linear");
  assert.equal(imported.category, "Productivity & SaaS");
  assert.equal(imported.tokens.canvas, "#08090a");
  assert.equal(imported.tokens.accent, "#5e6ad2");
  assert.equal(imported.tokens.radius, "6px");
  assert.equal(imported.tokens.font, "'Inter', 'SF Pro', sans-serif");
  assert.equal(imported.packageFiles.find(({ path }) => path === "assets/mark.png")?.content, "data:image/png;base64,AQID");
  assert.deepEqual(imported.packageFiles.map(({ path }) => path).sort(), ["DESIGN.md", "assets/mark.png", "components.html", "design.tokens", "manifest.json", "tokens.css"]);
  assert.equal(packageDesignTokenFile(imported.packageFiles)?.path, "design.tokens");
});

test("OpenDesign library import discovers multiple local systems in one folder", async () => {
  const files = [];
  for (const [folder, name, accent] of [["linear-app", "Linear", "#5e6ad2"], ["vercel", "Vercel", "#000000"]]) {
    const add = (filename, content) => files.push({
      name: filename, webkitRelativePath: `open-design/${folder}/${filename}`,
      size: content.length, text: async () => content,
    });
    add("manifest.json", JSON.stringify({ id: folder, name, category: "Developer Tools" }));
    add("DESIGN.md", `# ${name}`);
    add("tokens.css", `:root { --bg: #08090a; --accent: ${accent}; }`);
  }
  const systems = await parseDesignSystemPackageLibrary(files);
  assert.deepEqual(systems.map(({ name }) => name), ["Linear", "Vercel"]);
  assert.deepEqual(systems.map(({ category }) => category), ["Developer Tools", "Developer Tools"]);
});

test("curated reference systems keep their source evidence and real responsive package pages", () => {
  const curated = DESIGN_SYSTEM_PRESETS.filter((system) => system.source === "curated");
  assert.equal(curated.length, 4);
  for (const system of curated) {
    const files = new Map(system.packageFiles.map(({ path, content }) => [path, content]));
    const manifest = JSON.parse(files.get("manifest.json"));
    assert.equal(manifest.source.type, "curated-reference", system.name);
    assert.match(manifest.source.url, /^https:\/\//, system.name);
    assert.equal(manifest.license, system.license, system.name);
    assert.ok(files.get("source/evidence.md")?.length > 100, system.name);
    for (const path of ["DESIGN.md", "USAGE.md", "tokens.css", "design-tokens.json", "components.html"]) {
      assert.ok(files.has(path), `${system.name} is missing ${path}`);
    }
    const pages = manifest.preview.pages.filter((page) => files.has(page.path));
    assert.ok(pages.some((page) => page.path !== "components.html" && page.path.startsWith("preview/")), system.name);
    assert.ok(files.get("components.html").includes("var(--"), `${system.name} components must use package tokens`);
    assert.doesNotThrow(() => JSON.parse(files.get("design-tokens.json")), system.name);
    const syncedDtcg = syncPackageTokens(system.packageFiles, system.tokens, { syncStylesheet: false })
      .find(({ path }) => path === "design-tokens.json");
    assert.deepEqual(JSON.parse(syncedDtcg.content), JSON.parse(files.get("design-tokens.json")), `${system.name} token JSON should match its canonical semantic tokens`);
    const parsedTokens = packageTokensFromCss(files.get("tokens.css"), system.tokens);
    for (const key of ["canvas", "surface", "raised", "text", "muted", "accent", "line", "focus", "success", "warning", "danger", "radius", "spacing", "fontSize"]) {
      assert.equal(parsedTokens[key], system.tokens[key], `${system.name} ${key} token does not match its canonical stylesheet`);
    }
    const normaliseFont = (value) => value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
    assert.equal(normaliseFont(parsedTokens.font), normaliseFont(system.tokens.font), `${system.name} font token does not match its canonical stylesheet`);
  }
});

test("package import requires the portable manifest, guide and token stylesheet", async () => {
  await assert.rejects(parseDesignSystemPackage([
    { name: "readme.md", webkitRelativePath: "kit/readme.md", size: 4, text: async () => "hello" },
  ]), /manifest.json, DESIGN.md and tokens.css/);
});

test("editing package tokens updates the canonical stylesheet used by previews", () => {
  const files = [{ path: "tokens.css", content: ":root { --bg: #08090a; --surface-warm: var(--surface); --surface: #191a1b; --accent: #5e6ad2; }" }];
  const synced = syncPackageTokens(files, { ...DESIGN_SYSTEM_PRESETS[0].tokens, canvas: "#101010", surface: "#202020", accent: "#abcdef" });
  assert.match(synced[0].content, /--bg: #101010/);
  assert.match(synced[0].content, /--surface: #202020/);
  assert.match(synced[0].content, /--accent: #abcdef/);
  assert.match(synced[0].content, /--surface-warm: var\(--surface\)/);
});

test("semantic edits update DTCG literal colours and dimensions while preserving aliases", () => {
  const files = [
    { path: "tokens.css", content: ":root { --bg: #101010; --accent: #abcdef; --space-4: 12px; }" },
    { path: "design-tokens.json", content: JSON.stringify({ tokens: {
      background: { default: { $type: "color", $value: "#ffffff" } },
      accent: { primary: { $type: "color", $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 1 } } },
      spacing: { $type: "dimension", $value: { value: 8, unit: "px" } },
      reference: { $type: "color", $value: "{accent.primary}" },
    } }) },
  ];
  const synced = syncPackageTokens(files, { ...DESIGN_SYSTEM_PRESETS[0].tokens, canvas: "#202020", accent: "#123456", spacing: "16px" }, { syncStylesheet: false });
  const tokens = JSON.parse(synced.find(({ path }) => path === "design-tokens.json").content).tokens;
  assert.equal(tokens.background.default.$value, "#101010");
  assert.deepEqual(tokens.accent.primary.$value.components, [0.6705882352941176, 0.803921568627451, 0.9372549019607843]);
  assert.equal(tokens.spacing.$value.value, 12);
  assert.equal(tokens.reference.$value, "{accent.primary}");
});

test("semantic edits honour a manifest-declared design-token JSON path", () => {
  const files = [
    { path: "manifest.json", content: JSON.stringify({ files: { designTokens: "interchange/tokens.json" } }) },
    { path: "tokens.css", content: ":root { --bg: #202020; --accent: #123456; }" },
    { path: "interchange/tokens.json", content: JSON.stringify({ tokens: { background: { default: { $type: "color", $value: "#ffffff" } } } }) },
  ];
  const synced = syncPackageTokens(files, { ...DESIGN_SYSTEM_PRESETS[0].tokens, canvas: "#202020" }, { syncStylesheet: false });
  const json = synced.find(({ path }) => path === "interchange/tokens.json").content;
  assert.equal(JSON.parse(json).tokens.background.default.$value, "#202020");
});

test("standalone token export selects the package manifest's declared JSON file", () => {
  const files = [
    { path: "manifest.json", content: JSON.stringify({ files: { designTokens: "interchange/tokens.json" } }) },
    { path: "design-tokens.json", content: JSON.stringify({ marker: "stale default" }) },
    { path: "interchange/tokens.json", content: JSON.stringify({ marker: "declared source" }) },
  ];
  assert.equal(packageDesignTokenFile(files), files[2]);
  assert.equal(packageDesignTokenFile(files.slice(1)), files[1]);
  assert.equal(packageDesignTokenFile([{ path: "theme.tokens", content: "{}" }])?.path, "theme.tokens");
  assert.equal(packageDesignTokenFile([
    { path: "theme.tokens", content: "{}" },
    { path: "brand.tokens.json", content: "{}" },
  ]), undefined);
});

test("standalone JSON export preserves declared token structure and adds provenance", () => {
  const tokenDocument = {
    $schema: "https://design-tokens.github.io/community-group/format/",
    $extensions: { "org.example.tokens": { importedFrom: "catalogue" } },
    tokens: { colour: { primary: { $type: "color", $value: "{colour.blue.600}" }, blue: { 600: { $type: "color", $value: "#2563eb" } } } },
  };
  const system = {
    name: "Example system", packageVersion: 4, sourceUrl: "https://example.org/system",
    license: "MIT", attribution: "Example Studio",
    packageFiles: [
      { path: "manifest.json", content: JSON.stringify({ files: { designTokens: "interchange/tokens.json" } }) },
      { path: "design-tokens.json", content: JSON.stringify({ marker: "stale" }) },
      { path: "interchange/tokens.json", content: JSON.stringify(tokenDocument) },
    ],
  };
  const exported = JSON.parse(designSystemTokenJson(system));
  assert.deepEqual(exported.$schema, tokenDocument.$schema);
  assert.deepEqual(exported.tokens, tokenDocument.tokens);
  assert.deepEqual(exported.$extensions["org.example.tokens"], { importedFrom: "catalogue" });
  assert.deepEqual(exported.$extensions["com.tribe.design-system"].provenance, {
    name: "Example system", version: 4, source: "https://example.org/system", license: "MIT", attribution: "Example Studio",
  });
  assert.equal(Object.hasOwn(exported, "provenance"), false);
});

test("standalone CSS export preserves packaged tokens and safely attributes the source", () => {
  const stylesheet = ":root { --brand-accent: #2563eb; }\n";
  const system = {
    name: "Example */ system", version: 3, sourceUrl: "https://example.org/system",
    license: "MIT", attribution: "Studio */ name",
    packageFiles: [{ path: "tokens.css", content: stylesheet }],
  };
  const exported = designSystemTokenCss(system);
  assert.match(exported, /Example \* \/ system · v3/);
  assert.match(exported, /Source: https:\/\/example\.org\/system/);
  assert.match(exported, /Licence: MIT/);
  assert.match(exported, /Attribution: Studio \* \/ name/);
  assert.ok(exported.endsWith(stylesheet));
});

test("project extraction reads literal theme values from JS and TS without executing code", () => {
  const source = `
    export default {
      theme: {
        extend: {
          colors: { primary: "#2563eb", surface: "hsl(var(--surface))", unrelated: "not-a-token" },
          spacing: { page: "1.5rem" },
          fontFamily: { sans: "Inter, system-ui, sans-serif" },
          borderRadius: { card: "12px" },
          danger: getDangerColour(),
        },
      },
    };
  `;
  assert.deepEqual(extractStaticThemeDeclarations(source), [
    { name: "primary", value: "#2563eb" },
    { name: "surface", value: "hsl(var(--surface))" },
    { name: "page", value: "1.5rem" },
    { name: "font-sans", value: "Inter, system-ui, sans-serif" },
    { name: "card", value: "12px" },
  ]);
});

test("design-system import rejects malformed and non-object JSON", () => {
  for (const input of ["{broken", "null", "[]", "\"system\""]) {
    assert.throws(() => parseDesignSystemImport(input), /valid design-system JSON file/);
  }
});

test("captured page styles become a refinable system with live reference attribution", () => {
  const system = designSystemFromReference({
    url: "https://example.com/products?session=secret#pricing",
    backgrounds: [
      { value: "rgb(250, 248, 244)", count: 14 },
      { value: "rgb(255, 255, 255)", count: 9 },
      { value: "rgb(240, 238, 232)", count: 4 },
    ],
    foregrounds: [
      { value: "rgb(30, 32, 35)", count: 15 },
      { value: "rgb(105, 108, 112)", count: 4 },
    ],
    links: [{ value: "rgb(31, 91, 168)", count: 6 }],
    borders: [{ value: "rgb(212, 213, 215)", count: 8 }],
    fonts: [{ value: "Inter, Arial, sans-serif", count: 14 }],
    fontSizes: [{ value: "16px", count: 10 }],
    spacing: [{ value: "24px", count: 8 }, { value: "1px", count: 12 }],
    radii: [{ value: "8px", count: 7 }],
    buttons: [{ color: "rgb(255, 255, 255)", background: "rgb(31, 91, 168)" }],
    inputs: [{ color: "rgb(30, 32, 35)", background: "rgb(255, 255, 255)" }],
  });

  assert.equal(system.name, "Captured from example.com");
  assert.equal(system.tokens.canvas, "#faf8f4");
  assert.equal(system.tokens.surface, "#ffffff");
  assert.equal(system.tokens.raised, "#f0eee8");
  assert.equal(system.tokens.text, "#1e2023");
  assert.equal(system.tokens.muted, "#696c70");
  assert.equal(system.tokens.accent, "#1f5ba8");
  assert.equal(system.tokens.line, "#d4d5d7");
  assert.equal(system.tokens.spacing, "24px");
  assert.equal(system.tokens.font, "Inter, Arial, sans-serif");
  assert.equal(system.references[0].url, "https://example.com/products");
  assert.match(system.guidance, /one page/);
  assert.equal(system.sourceEvidence.schema, "tribe-design-system-evidence/v1");
  assert.equal(system.sourceEvidence.confidence.level, "low");
  assert.ok(system.sourceEvidence.observations.some((item) => item.group === "Backgrounds" && item.samples === 14));
  assert.ok(system.sourceEvidence.inferences.some((item) => item.token === "canvas" && item.value === system.tokens.canvas));
});

test("captured reference rejects unsupported URLs and ignores unsafe font strings", () => {
  assert.throws(() => designSystemFromReference({ url: "file:///etc/passwd" }), /invalid/);
  const system = designSystemFromReference({
    url: "https://example.com",
    fonts: [{ value: "Inter; color: red" }],
  });
  assert.equal(system.tokens.font, DESIGN_SYSTEM_PRESETS[0].tokens.font);
});

test("browser extraction combines evidence and token candidates across pages", () => {
  const first = designSystemFromReference({
    url: "https://example.com/home",
    backgrounds: [{ value: "rgb(255, 255, 255)", count: 8 }],
    sampleCount: 12,
  });
  const system = {
    ...first,
    packageFiles: [
      { path: "tokens.css", content: ":root { --bg: #ffffff; --surface: #ffffff; --accent: #0f62fe; }" },
      { path: "source/evidence.json", content: JSON.stringify(first.sourceEvidence) },
      { path: "source/evidence.md", content: first.attribution },
    ],
  };
  const second = {
    url: "https://example.com/workspace",
    backgrounds: [
      { value: "rgb(16, 16, 16)", count: 20 },
      { value: "rgb(255, 255, 255)", count: 3 },
    ],
    sampleCount: 25,
    buttons: [{}, {}],
    inputs: [{}],
  };
  const merged = mergeDesignSystemReferenceCapture(system, second);
  const report = JSON.parse(merged.packageFiles.find(({ path }) => path === "source/evidence.json").content);
  assert.equal(merged.tokens.canvas, "#101010");
  assert.equal(merged.references.length, 2);
  assert.equal(report.source.pages.length, 2);
  assert.equal(report.source.pages.reduce((sum, page) => sum + page.sampleCount, 0), 37);
  assert.ok(report.observations.some((item) => item.group === "Backgrounds" && item.value === "rgb(255, 255, 255)" && item.samples === 11));
  assert.match(merged.packageFiles.find(({ path }) => path === "tokens.css").content, /--bg: #101010/);
  assert.throws(() => mergeDesignSystemReferenceCapture(merged, second), /already included/);
});

test("OKLCH palette generation preserves the brand colour and produces readable shade labels", () => {
  const scale = generateColourScale("#6b9df7");

  assert.deepEqual(scale.map(({ step }) => step), DESIGN_SYSTEM_PALETTE_STEPS);
  assert.equal(scale[5].color, "#6b9df7");
  assert.ok(scale.every(({ color }) => /^#[\da-f]{6}$/.test(color)));
  assert.ok(scale.every(({ color }) => Math.max(
    contrastRatio(color, "#000000"), contrastRatio(color, "#ffffff"),
  ) >= 4.5));
  assert.throws(() => generateColourScale("red"), /six-digit hex/);
});

test("design systems keep generated scales for each semantic colour role", () => {
  const palettes = generateDesignPalettes(DESIGN_SYSTEM_PRESETS[0].tokens);

  assert.deepEqual(Object.keys(palettes), ["brand", "neutral", "success", "warning", "danger"]);
  assert.ok(Object.values(palettes).every((scale) => scale.length === 11));
});

test("package editor accepts safe extensible files and removes manifest references cleanly", () => {
  const files = [
    { path: "manifest.json", content: "{}" },
    { path: "DESIGN.md", content: "# Guide" },
    { path: "tokens.css", content: ":root {}" },
    { path: "preview/overview.html", content: "<main />" },
  ];
  assert.equal(validateDesignSystemPackageFilePath("patterns/empty-state.md", files), "patterns/empty-state.md");
  assert.equal(validateDesignSystemPackageFilePath("tokens/brand.tokens", files), "tokens/brand.tokens");
  for (const path of ["../outside.md", ".hidden.md", "nested/.private/guide.md", "/absolute.md", "DESIGN.md", "preview/overview.html", "Preview/Overview.html", "notes.exe"]) {
    assert.throws(() => validateDesignSystemPackageFilePath(path, files));
  }

  const draft = {
    manifest: {
      files: { design: "DESIGN.md", preview: "preview/overview.html", patterns: ["patterns/example.html"] },
      componentsManifest: "components.manifest.json",
      sourceFiles: { evidence: "source/evidence.md", tokens: ["tokens.css", "patterns/example.html"] },
      preview: { pages: [{ path: "preview/overview.html" }, { path: "patterns/example.html" }] },
    },
    packageFiles: [...files, { path: "patterns/example.html", content: "<main />" }, { path: "components.manifest.json", content: "{}" }],
  };
  const added = addDesignSystemPackageFile(draft, "preview/empty-state.html");
  assert.deepEqual(added.manifest.preview.pages.at(-1), {
    path: "preview/empty-state.html", title: "empty state", role: "preview",
  });
  assert.deepEqual(JSON.parse(added.packageFiles.find(({ path }) => path === "manifest.json").content), added.manifest);
  assert.deepEqual(draft.manifest.preview.pages, [{ path: "preview/overview.html" }, { path: "patterns/example.html" }]);
  const updated = removeDesignSystemPackageFile(draft, "patterns/example.html");
  assert.equal(updated.packageFiles.some(({ path }) => path === "patterns/example.html"), false);
  assert.deepEqual(updated.manifest.files, { design: "DESIGN.md", preview: "preview/overview.html" });
  assert.deepEqual(updated.manifest.preview.pages, [{ path: "preview/overview.html" }]);
  assert.deepEqual(updated.manifest.sourceFiles, { evidence: "source/evidence.md", tokens: ["tokens.css"] });
  const noComponentManifest = removeDesignSystemPackageFile(updated, "components.manifest.json");
  assert.equal("componentsManifest" in noComponentManifest.manifest, false);
  assert.deepEqual(draft.manifest.preview.pages, [{ path: "preview/overview.html" }, { path: "patterns/example.html" }]);
  assert.equal(removeDesignSystemPackageFile(updated, "DESIGN.md"), updated);
});

test("package theme controls support document-root attributes and dark classes", () => {
  const dataModeSystem = { packageFiles: [{ path: "tokens.css", content: ":root[data-mode=dark] { --canvas: #000; }" }] };
  assert.deepEqual(designSystemPreviewThemeOptions(dataModeSystem), [
    { label: "Light", value: "light" }, { label: "Dark", value: "dark" },
  ]);
  assert.deepEqual(designSystemPreviewThemeAttributes(dataModeSystem, "dark"), {
    attribute: "data-mode", className: "", value: "dark",
  });

  const classSystem = { packageFiles: [{ path: "tokens.css", content: ".dark .button { color: white; }" }] };
  assert.deepEqual(designSystemPreviewThemeOptions(classSystem), [
    { label: "Light", value: "light" }, { label: "Dark", value: "dark" },
  ]);
  assert.deepEqual(designSystemPreviewThemeAttributes(classSystem, "dark"), {
    attribute: "", className: "dark", value: "dark",
  });
});

test("design guide headings produce stable, duplicate-safe anchors outside code fences", () => {
  const markdown = "# System guide\n\n## Colour roles\n\n### Light and dark\n\n```md\n## Example heading\n```\n\n## Colour roles\n";
  const headings = designSystemGuideHeadings(markdown);
  assert.deepEqual(headings.map(({ depth, id, line, title }) => ({ depth, id, line, title })), [
    { depth: 2, id: "design-guide-colour-roles", line: 3, title: "Colour roles" },
    { depth: 3, id: "design-guide-light-and-dark", line: 5, title: "Light and dark" },
    { depth: 2, id: "design-guide-colour-roles-2", line: 11, title: "Colour roles" },
  ]);
  const headingAnchors = Object.fromEntries(headings.map(({ line, id }) => [line, id]));
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { headingAnchors, children: markdown }));
  assert.match(html, /<h2 id="design-guide-colour-roles">Colour roles<\/h2>/);
  assert.match(html, /<h3 id="design-guide-light-and-dark">Light and dark<\/h3>/);
  assert.match(html, /<h2 id="design-guide-colour-roles-2">Colour roles<\/h2>/);
});

test("design-system snapshot comparison reports token and package file changes", () => {
  const result = compareDesignSystemSnapshots(
    { tokens: { accent: "#111111", radius: "8px" }, packageFiles: [{ path: "DESIGN.md", content: "old" }, { path: "old.md", content: "keep" }] },
    { tokens: { accent: "#222222", radius: "8px", spacing: "12px" }, packageFiles: [{ path: "DESIGN.md", content: "new" }, { path: "new.md", content: "added" }] },
  );
  assert.deepEqual(result.tokenChanges, [
    { key: "accent", previous: "#111111", current: "#222222" },
    { key: "spacing", previous: "Not set", current: "12px" },
  ]);
  assert.deepEqual(result.packageChanges, [
    { path: "DESIGN.md", change: "Changed" },
    { path: "old.md", change: "Removed" },
    { path: "new.md", change: "Added" },
  ]);
});

test("design-system preview renders semantic scales, package components and responsive output gallery", () => {
  const originalSystem = RuntimePresets[0];
  const isolationPage = "preview/isolation-check.html";
  RuntimePresets[0] = {
    ...originalSystem,
    manifest: { ...originalSystem.manifest, preview: { ...originalSystem.manifest.preview, pages: [...(originalSystem.manifest.preview?.pages ?? []), { path: isolationPage, title: "Isolation check" }] } },
    packageFiles: [...originalSystem.packageFiles,
      { path: isolationPage, content: '<!doctype html><html><body><a href="https://unsafe-preview.example" target="_top">Keep visible link text</a><script>unsafe-script-marker</script><iframe src="https://unsafe-frame.example">unsafe-frame-marker</iframe><form action="https://unsafe-form.example"><button>Submit</button></form></body></html>' },
      { path: "assets/mark.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="30" /></svg>' },
      { path: "fonts/team.woff2", content: "data:font/woff2;base64,AQID" },
      { path: "source/evidence.json", content: JSON.stringify({ schema: "tribe-design-system-evidence/v1", source: { type: "browser-page", url: "https://example.com" }, confidence: { level: "low", reason: "One page only." }, observations: [{ group: "Backgrounds", value: "#ffffff", samples: 8 }], inferences: [{ token: "canvas", value: "#ffffff", basis: "Most common background", confidence: "low" }], limitations: ["Other pages not sampled."] }) },
    ],
  };
  let html;
  try {
    html = renderToStaticMarkup(React.createElement(DesignSystemsView, {
      projects: [{ id: "project-1", name: "Example" }],
    }));
  } finally {
    RuntimePresets[0] = originalSystem;
  }

  assert.match(html, /aria-label="Generated colour scales"/);
  assert.match(html, /Brand/);
  assert.match(html, /aria-label="[^"]+ Components preview"/);
  assert.ok([...html.matchAll(/data-carbon-theme=&quot;white&quot;/g)].length >= 2);
  assert.match(html, /Responsive output previews/);
  assert.match(html, /Brand assets and fonts/);
  assert.match(html, /team\.woff2 font specimen/);
  assert.match(html, /Design guide contents/);
  assert.match(html, /Extraction evidence/);
  assert.match(html, /Most common background/);
  assert.match(html, /Copy agent guidance/);
  assert.match(html, /Package files \(/);
  assert.match(html, /Import OpenDesign/);
  assert.match(html, /Export design system/);
  assert.match(html, /Filter design systems by category/);
});

test("package preview keeps fixtures local by disabling navigation and active content", () => {
  const originalSystem = RuntimePresets[0];
  const path = "preview/isolation-check.html";
  RuntimePresets[0] = {
    ...originalSystem,
    manifest: { ...originalSystem.manifest, preview: { ...originalSystem.manifest.preview, pages: [{ path, title: "Isolation check" }] } },
    packageFiles: [...originalSystem.packageFiles, {
      path,
      content: '<!doctype html><html><body><a href="https://unsafe-preview.example/?next=>remote" target="_top">Keep visible link text</a><script>unsafe-script-marker</script><iframe src="https://unsafe-frame.example">unsafe-frame-marker</iframe><form action="https://unsafe-form.example"><button>Submit</button></form></body></html>',
    }],
  };
  let html;
  try {
    html = renderToStaticMarkup(React.createElement(DesignSystemsView, { projects: [] }));
  } finally {
    RuntimePresets[0] = originalSystem;
  }

  assert.match(html, /Keep visible link text/);
  assert.doesNotMatch(html, /unsafe-preview\.example|unsafe-frame\.example|unsafe-form\.example/);
  assert.doesNotMatch(html, /unsafe-script-marker|unsafe-frame-marker/);
});
