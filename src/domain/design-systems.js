import { APACHE_2_0_LICENSE } from "./apache-license.js";

const carbonTokensCss = `:root {
  --cds-background: #ffffff;
  --cds-background-inverse: #393939;
  --cds-background-brand: #0f62fe;
  --cds-interactive: #0f62fe;
  --cds-layer-01: #f4f4f4;
  --cds-layer-02: #ffffff;
  --cds-layer-03: #f4f4f4;
  --cds-field-01: #f4f4f4;
  --cds-border-subtle-00: #e0e0e0;
  --cds-border-subtle-01: #c6c6c6;
  --cds-border-strong-01: #8d8d8d;
  --cds-border-interactive: #0f62fe;
  --cds-text-primary: #161616;
  --cds-text-secondary: #525252;
  --cds-text-helper: #6f6f6f;
  --cds-text-placeholder: rgba(22, 22, 22, 0.4);
  --cds-text-on-color: #ffffff;
  --cds-link-primary: #0f62fe;
  --cds-link-primary-hover: #0043ce;
  --cds-link-inverse: #78a9ff;
  --cds-support-error: #da1e28;
  --cds-support-success: #24a148;
  --cds-support-warning: #f1c21b;
  --cds-support-info: #0043ce;
  --cds-focus: #0f62fe;
  --cds-focus-inset: #ffffff;
  --cds-shadow: rgba(0, 0, 0, 0.3);
  --cds-font-sans: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif;
  --cds-font-mono: 'IBM Plex Mono', Menlo, 'DejaVu Sans Mono', Courier, monospace;
  --cds-body-compact-01-size: 14px;
  --cds-body-compact-01-line-height: 18px;
  --cds-body-compact-01-letter-spacing: 0.16px;
  --cds-body-compact-02-size: 16px;
  --cds-body-compact-02-line-height: 22px;
  --cds-label-01-size: 12px;
  --cds-label-01-line-height: 16px;
  --cds-label-01-letter-spacing: 0.32px;
  --cds-heading-03-size: 20px;
  --cds-heading-03-line-height: 28px;
  --cds-spacing-01: 2px;
  --cds-spacing-02: 4px;
  --cds-spacing-03: 8px;
  --cds-spacing-04: 12px;
  --cds-spacing-05: 16px;
  --cds-spacing-06: 24px;
  --cds-spacing-07: 32px;
  --cds-spacing-08: 40px;
  --cds-spacing-09: 48px;
  --cds-spacing-10: 64px;
  --cds-spacing-11: 80px;
  --cds-spacing-12: 96px;
  --cds-spacing-13: 160px;
  --cds-grid-columns: 16;
  --cds-grid-gutter: 32px;
  --cds-grid-margin: 32px;
  --cds-breakpoint-sm: 320px;
  --cds-breakpoint-md: 672px;
  --cds-breakpoint-lg: 1056px;
  --cds-breakpoint-xlg: 1312px;
  --cds-breakpoint-max: 1584px;
  --cds-radius-control: 0px;
  --cds-radius-pill: 24px;
  --cds-motion-fast-01: 70ms;
  --cds-motion-moderate-01: 150ms;
  --cds-button-primary: #0f62fe;
  --cds-button-primary-hover: #0050e6;
  --cds-button-primary-active: #002d9c;
  --cds-button-secondary: #393939;
  --cds-button-danger: #da1e28;
  --cds-tag-blue-background: #edf5ff;
  --cds-tag-blue-color: #0f62fe;
  --cds-tag-red-background: #ffd7d9;
  --cds-tag-red-color: #a2191f;
  --bg: var(--cds-background);
  --surface: var(--cds-layer-01);
  --surface-raised: var(--cds-layer-02);
  --fg: var(--cds-text-primary);
  --fg-muted: var(--cds-text-secondary);
  --accent: var(--cds-interactive);
  --border: var(--cds-border-subtle-01);
  --focus: var(--cds-focus);
  --success: var(--cds-support-success);
  --warning: var(--cds-support-warning);
  --danger: var(--cds-support-error);
  --radius: var(--cds-radius-control);
  --space: var(--cds-spacing-05);
  --text-base: var(--cds-body-compact-01-size);
  --font-body: var(--cds-font-sans);
}

[data-carbon-theme="g100"] {
  --cds-background: #161616;
  --cds-background-inverse: #f4f4f4;
  --cds-interactive: #78a9ff;
  --cds-layer-01: #262626;
  --cds-layer-02: #393939;
  --cds-layer-03: #525252;
  --cds-field-01: #262626;
  --cds-border-subtle-00: #393939;
  --cds-border-subtle-01: #525252;
  --cds-border-strong-01: #a8a8a8;
  --cds-text-primary: #f4f4f4;
  --cds-text-secondary: #c6c6c6;
  --cds-text-helper: #a8a8a8;
  --cds-text-placeholder: rgba(244, 244, 244, 0.4);
  --cds-text-on-color: #ffffff;
  --cds-link-primary: #78a9ff;
  --cds-link-primary-hover: #a6c8ff;
  --cds-link-inverse: #0f62fe;
  --cds-support-error: #fa4d56;
  --cds-support-success: #42be65;
  --cds-support-warning: #f1c21b;
  --cds-support-info: #4589ff;
  --cds-focus: #ffffff;
  --cds-focus-inset: #161616;
  --cds-button-primary: #0f62fe;
  --cds-button-primary-hover: #0050e6;
  --cds-button-primary-active: #002d9c;
  --cds-button-secondary: #6f6f6f;
  --cds-button-danger: #da1e28;
  --cds-tag-blue-background: #002d9c;
  --cds-tag-blue-color: #d0e2ff;
  --cds-tag-red-background: #750e13;
  --cds-tag-red-color: #ffd7d9;
}
`;

const carbonComponentsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:var(--cds-spacing-07);background:var(--cds-background);color:var(--cds-text-primary);font:var(--cds-body-compact-01-size)/var(--cds-body-compact-01-line-height) var(--cds-font-sans)}main{max-width:1100px;margin:auto;display:grid;gap:var(--cds-spacing-07)}h1,h2,p{margin:0}h1{font-size:32px;line-height:40px;font-weight:400}h2{font-size:20px;line-height:28px;font-weight:400}small,.helper{color:var(--cds-text-helper)}header{display:flex;justify-content:space-between;align-items:center;gap:16px}section{display:grid;gap:16px}button,input,select{font:inherit}button{min-height:48px;padding:0 16px;border:0;border-radius:0;cursor:pointer}button.primary{background:var(--cds-button-primary);color:#fff}button.primary:hover{background:var(--cds-button-primary-hover)}button.primary:active{background:var(--cds-button-primary-active)}button.secondary{background:var(--cds-button-secondary);color:#fff}button.tertiary{background:transparent;color:var(--cds-link-primary);border-bottom:1px solid currentColor}button.danger{background:var(--cds-button-danger);color:#fff}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--cds-focus);outline-offset:2px}button:disabled{background:#c6c6c6;color:#8d8d8d;cursor:not-allowed}.row{display:flex;flex-wrap:wrap;gap:1px;background:var(--cds-border-subtle-00)}.tile,.field-block,.notice{padding:24px;background:var(--cds-layer-01)}.field-block{display:grid;gap:8px;max-width:420px}label{font-size:12px;letter-spacing:.32px}input{height:40px;padding:0 12px;background:var(--cds-field-01);color:var(--cds-text-primary);border:0;border-bottom:1px solid var(--cds-border-strong-01)}input:focus{border-bottom:2px solid var(--cds-focus);outline:none}.field-error{border-bottom:2px solid var(--cds-support-error)}.tags{display:flex;gap:8px;flex-wrap:wrap}.tag{padding:4px 8px;border-radius:24px;background:var(--cds-tag-blue-background);color:var(--cds-tag-blue-color)}.tag.red{background:var(--cds-tag-red-background);color:var(--cds-tag-red-color)}.notice{border-left:4px solid var(--cds-support-info);background:var(--cds-layer-01)}.notice.error{border-color:var(--cds-support-error)}.status{display:flex;gap:12px;align-items:center}.status i{width:10px;height:10px;border-radius:50%;background:var(--cds-support-success)}table{width:100%;border-collapse:collapse;background:var(--cds-background)}th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--cds-border-subtle-01)}th{background:var(--cds-layer-01);font-weight:600}.table-wrap{overflow:auto}.layout{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--cds-border-subtle-00)}@media(max-width:672px){body{padding:16px}header{align-items:flex-start;flex-direction:column}.layout{grid-template-columns:1fr}.row button{flex:1 1 100%}}
</style></head><body><main><header><div><small>CARBON REFERENCE · COMPONENTS</small><h1>Controls and patterns</h1></div><button class="primary">Create report</button></header><section><h2>Button hierarchy and states</h2><div class="row"><button class="primary">Primary action</button><button class="secondary">Secondary action</button><button class="tertiary">Tertiary action</button><button class="danger">Delete report</button><button class="primary" disabled>Unavailable</button></div></section><section class="layout"><article class="tile"><h2>Layered tile</h2><p>Use surface changes to express hierarchy; reserve shadows for overlays.</p></article><article class="tile"><h2>Form field</h2><label class="field-block">Project name<input value="Northstar analytics"><small class="helper">Choose a clear, recognisable name.</small></label></article><article class="tile"><h2>Inline status</h2><div class="status"><i></i><span>All systems operational</span></div><div class="tags"><span class="tag">Information</span><span class="tag red">Action required</span></div></article></section><section><h2>Data table</h2><div class="table-wrap"><table><thead><tr><th>Workspace</th><th>Owner</th><th>Status</th><th>Updated</th></tr></thead><tbody><tr><td>Northstar</td><td>A. Chen</td><td>Active</td><td>Today</td></tr><tr><td>Atlas research</td><td>M. Patel</td><td>Review</td><td>Yesterday</td></tr></tbody></table></div><div class="notice">Inline notifications use a clear status colour and concise message.</div><div class="notice error">The report could not be saved. Review the required fields.</div></section></main></body></html>`;

const carbonPatternsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:var(--cds-background);color:var(--cds-text-primary);font:14px/1.5 var(--cds-font-sans)}.shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr)}aside{padding:24px 16px;background:#161616;color:#f4f4f4}aside strong{display:block;margin-bottom:32px;font-size:18px}aside nav{display:grid;gap:4px}aside a{padding:10px 12px;color:#c6c6c6;text-decoration:none}aside a[aria-current]{background:#393939;color:white;border-left:3px solid #0f62fe}.main{min-width:0}.top{height:48px;padding:0 32px;display:flex;align-items:center;justify-content:space-between;background:#161616;color:#f4f4f4}.content{padding:32px;max-width:1320px;margin:auto;display:grid;gap:24px}.intro{display:flex;justify-content:space-between;align-items:flex-end;gap:24px}.intro h1{font-size:32px;line-height:40px;font-weight:400;margin:0 0 8px}.intro p{color:var(--cds-text-secondary);margin:0}.btn{height:48px;padding:0 16px;border:0;background:#0f62fe;color:white;font:inherit}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#e0e0e0}.card{padding:24px;background:var(--cds-layer-01);min-height:150px}.card small{color:var(--cds-text-secondary)}.card strong{display:block;font-size:28px;font-weight:400;margin:12px 0}.panel{padding:24px;background:#fff}.bars{height:180px;display:flex;align-items:flex-end;gap:16px;border-bottom:1px solid #c6c6c6}.bars i{flex:1;background:#0f62fe;height:var(--h)}.footer{display:flex;justify-content:space-between;color:var(--cds-text-secondary);font-size:12px;padding-top:12px}@media(max-width:672px){.shell{grid-template-columns:1fr}aside{display:none}.top{padding:0 16px}.content{padding:16px}.intro{align-items:flex-start;flex-direction:column}.cards{grid-template-columns:1fr}.panel{padding:16px}}
</style></head><body><div class="shell"><aside><strong>Northstar</strong><nav><a aria-current="page">Overview</a><a>Analytics</a><a>Reports</a><a>Settings</a></nav></aside><div class="main"><div class="top"><span>Operations / Overview</span><span>Help&nbsp;&nbsp; Profile</span></div><main class="content"><div class="intro"><div><small>MONDAY, 2 NOVEMBER</small><h1>Operations overview</h1><p>Monitor delivery and find the work that needs attention.</p></div><button class="btn">Create report</button></div><section class="cards"><article class="card"><small>Active projects</small><strong>12</strong><span>Across four teams</span></article><article class="card"><small>On track</small><strong>84%</strong><span>Six points above last month</span></article><article class="card"><small>Needs review</small><strong>3</strong><span>Two due this week</span></article></section><section class="panel"><h2>Monthly delivery</h2><p>Completed work items · 2026</p><div class="bars" aria-label="Monthly delivery chart"><i style="--h:42%"></i><i style="--h:59%"></i><i style="--h:51%"></i><i style="--h:73%"></i><i style="--h:66%"></i><i style="--h:88%"></i></div><div class="footer"><span>Jan&nbsp;&nbsp; Feb&nbsp;&nbsp; Mar&nbsp;&nbsp; Apr&nbsp;&nbsp; May&nbsp;&nbsp; Jun</span><span>Updated 8 minutes ago</span></div></section></main></div></div></body></html>`;

const carbonFoundationsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:32px;background:var(--cds-background);color:var(--cds-text-primary);font:14px/1.5 var(--cds-font-sans)}main{max-width:1000px;margin:auto;display:grid;gap:28px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1,h2,p{margin:0}h1{font-size:28px;font-weight:400}.switch{display:flex;gap:4px}.switch button{padding:8px 12px;border:1px solid var(--cds-border-subtle-01);background:var(--cds-background);color:var(--cds-text-primary)}.swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--cds-border-subtle-00)}.swatch{min-height:90px;padding:12px;background:var(--swatch);display:flex;flex-direction:column;justify-content:flex-end;color:var(--swatch-text,#161616)}.swatch code{font-size:11px}.type{display:grid;gap:10px;padding:24px;background:var(--cds-layer-01)}.type strong{font-size:28px;font-weight:400}.scale{display:flex;align-items:end;gap:16px;flex-wrap:wrap}.scale span{display:grid;gap:4px}.scale b{font-weight:400}.spacing{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.spacing span{width:80px;display:grid;gap:6px;font-size:11px}.spacing i{height:32px;background:#0f62fe;width:var(--width)}@media(max-width:600px){body{padding:16px}header{align-items:flex-start;flex-direction:column}}
</style></head><body><main><header><div><small>FOUNDATIONS</small><h1>Carbon's token system</h1></div><span>White theme</span></header><section><h2>Semantic colour roles · White theme</h2><div class="swatches"><div class="swatch" style="--swatch:#ffffff"><b>Background</b><code>#ffffff</code></div><div class="swatch" style="--swatch:#f4f4f4"><b>Layer 01</b><code>#f4f4f4</code></div><div class="swatch" style="--swatch:#ffffff"><b>Layer 02</b><code>#ffffff</code></div><div class="swatch" style="--swatch:#161616;--swatch-text:#fff"><b>Text primary</b><code>#161616</code></div><div class="swatch" style="--swatch:#0f62fe;--swatch-text:#fff"><b>Interactive</b><code>#0f62fe</code></div><div class="swatch" style="--swatch:#da1e28;--swatch-text:#fff"><b>Error</b><code>#da1e28</code></div></div></section><section class="type"><h2>Typography · IBM Plex family</h2><strong>Productive interfaces</strong><span>Body compact 01 · 14px / 18px · regular · 0.16px tracking</span><div class="scale"><span><b style="font-size:12px">Label 01</b><small>12 / 16</small></span><span><b style="font-size:14px">Body compact 01</b><small>14 / 18</small></span><span><b style="font-size:16px">Body compact 02</b><small>16 / 22</small></span><span><b style="font-size:20px">Heading 03</b><small>20 / 28</small></span><span><b style="font-size:28px">Heading 05</b><small>28px</small></span></div></section><section><h2>Spacing scale</h2><div class="spacing">${[2,4,8,12,16,24,32,40,48,64,80,96,160].map((size, index) => `<span><i style="--width:${Math.min(size, 80)}px"></i><code>spacing-${String(index + 1).padStart(2, "0")} · ${size}px</code></span>`).join("")}</div></section></main></body></html>`;

const carbonDarkFoundationsHtml = carbonFoundationsHtml
  .replace("<body>", '<body data-carbon-theme="g100">')
  .replace("<h1>Carbon's token system</h1>", "<h1>Carbon's token system · Gray 100</h1>")
  .replace("<span>White theme</span>", "<span>Gray 100 theme</span>")
  .replace("Semantic colour roles · White theme", "Semantic colour roles · Gray 100 theme")
  .replace('<div class="swatch" style="--swatch:#ffffff"><b>Background</b><code>#ffffff</code>', '<div class="swatch" style="--swatch:#161616;--swatch-text:#f4f4f4"><b>Background</b><code>#161616</code>')
  .replace('<div class="swatch" style="--swatch:#f4f4f4"><b>Layer 01</b><code>#f4f4f4</code>', '<div class="swatch" style="--swatch:#262626;--swatch-text:#f4f4f4"><b>Layer 01</b><code>#262626</code>')
  .replace('<div class="swatch" style="--swatch:#ffffff"><b>Layer 02</b><code>#ffffff</code>', '<div class="swatch" style="--swatch:#393939;--swatch-text:#f4f4f4"><b>Layer 02</b><code>#393939</code>')
  .replace('<div class="swatch" style="--swatch:#161616;--swatch-text:#fff"><b>Text primary</b><code>#161616</code>', '<div class="swatch" style="--swatch:#f4f4f4"><b>Text primary</b><code>#f4f4f4</code>')
  .replace('<div class="swatch" style="--swatch:#0f62fe;--swatch-text:#fff"><b>Interactive</b><code>#0f62fe</code>', '<div class="swatch" style="--swatch:#78a9ff"><b>Interactive</b><code>#78a9ff</code>')
  .replace('<div class="swatch" style="--swatch:#da1e28;--swatch-text:#fff"><b>Error</b><code>#da1e28</code>', '<div class="swatch" style="--swatch:#fa4d56"><b>Error</b><code>#fa4d56</code>');

const carbonDesignGuide = `# Carbon Design System · curated reference

This package presents a selected, implementation-ready slice of Carbon Design System v11 for product UI work. It includes the White and Gray 100 color themes, semantic color roles, productive typography, the 2x spacing scale, grid breakpoints, and representative controls and patterns. It does not reproduce Carbon's full 250+ theme token set, component library, assets, or source code.

## Design intent

Carbon is built for clear, productive interfaces. Neutral gray layers organise content; blue is reserved for interactive emphasis. Use the layer model to create depth. Light themes alternate White and Gray 10; dark themes progress through lighter gray layers. Keep the user's task and content ahead of decoration.

## Color and themes

Use semantic roles rather than raw palette values. The White theme uses White as the page background, Gray 10 for Layer 01, White for Layer 02, Gray 100 for primary text, Blue 60 for interactive controls, and dedicated support colors for error, success, warning, and information. Gray 100 is included as a second preview theme. The preview shows the selected reference subset; use the official Carbon token documentation for the complete theme values.

## Typography

Carbon uses IBM Plex. Productive styles suit task-heavy product screens; expressive styles suit editorial pages. The productive base is 14px; expressive body begins at 16px. This package lists IBM Plex in the font stack but does not redistribute font files. Include the licensed font in a project only through its own approved source.

## Spacing and layout

Use the 2–160px spacing scale provided in tokens.css. The 2x grid uses a 16-column desktop structure and responsive margins/gutters. Adjust grid composition at the included breakpoints; do not scale desktop layouts down as a single image.

## Components and patterns

Buttons communicate action hierarchy: one primary action per page, with secondary and tertiary actions at lower emphasis. Use the red variant for destructive actions only. Inputs use a field surface and bottom border; focus and validation states stay visible. Tags, inline notifications, layered tiles and data tables are shown in components.html. The preview/patterns.html dashboard illustrates navigation, metric tiles, and a responsive chart panel.

## Interaction and accessibility

Preserve keyboard focus, disabled states, clear labels, semantic status text, and sufficient contrast. Do not communicate status by color alone. Button actions are buttons; navigation destinations are links. Long tables can scroll horizontally on narrow screens.

## Scope and attribution

This Tribe reference package selects and adapts values and guidance from the official Carbon documentation and repository. The HTML specimens and package organisation are authored for Tribe. It contains no IBM logo, font binaries, or copied Carbon component implementation. Carbon and IBM are trademarks of IBM; this package does not claim IBM endorsement or grant trademark rights. See source/evidence.md, NOTICE, and LICENSE.
`;

const carbonUsageGuide = `Read DESIGN.md and source/evidence.md first. The canonical preview tokens are in tokens.css; design-tokens.json is an interchange projection. Review preview/foundations.html for the White and Gray 100 reference themes, components.html for control states, and preview/patterns.html for a responsive product page. This is a selected Carbon reference package, not the full Carbon component library. Confirm the upstream documentation before implementing tokens beyond this scope. IBM Plex font files are not included.
`;

const carbonNotice = `Carbon Design System is developed by IBM. Copyright 2015 IBM Corp. The included token values and descriptions are adapted from official Carbon documentation and are provided under the Apache License, Version 2.0. Tribe-authored preview specimens and package guidance are marked as adaptations in source/evidence.md. IBM, IBM Plex, and Carbon are names and marks of their respective owners; this package does not imply endorsement or grant trademark rights.
`;

const carbonEvidence = `# Carbon Design System source evidence

- Source system: Carbon Design System v11, maintained by IBM.
- Official theme and color references: https://www.carbondesignsystem.com/building-blocks/foundations/color/overview and https://www.carbondesignsystem.com/building-blocks/foundations/color/tokens
- Official typography: https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets
- Official spacing: https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview
- Component behaviour: https://www.carbondesignsystem.com/components/button/usage
- Source repository and licence: https://github.com/carbon-design-system/carbon and https://github.com/carbon-design-system/carbon/blob/main/LICENSE
- Licence: Apache-2.0. The package includes the licence text and IBM attribution notice.

Scope: this package selects documented White-theme semantic values and palette-derived Gray 100 values, records productive type and spacing guidance, and presents Tribe-authored HTML examples. It is not a full upstream package import and does not claim to reproduce every Carbon token or component. No IBM or Carbon source code, logo, icons, or font files are included. Dark theme values beyond the displayed subset should be checked against current upstream tokens before production use.

Adaptations: the package metadata, semantic CSS aliases, component and dashboard specimens, responsive behaviour, and guidance composition were authored for Tribe. The package name identifies the reference system; it does not imply IBM affiliation or endorsement.
`;

const carbonTokenJson = JSON.stringify({
  format: "tribe-design-tokens/v1",
  source: "Carbon Design System v11 documented token subset",
  themes: {
    white: { background: "#ffffff", layer01: "#f4f4f4", layer02: "#ffffff", textPrimary: "#161616", textSecondary: "#525252", interactive: "#0f62fe", focus: "#0f62fe", supportError: "#da1e28", supportSuccess: "#24a148", supportWarning: "#f1c21b" },
    g100: { background: "#161616", layer01: "#262626", layer02: "#393939", textPrimary: "#f4f4f4", textSecondary: "#c6c6c6", interactive: "#78a9ff", focus: "#ffffff", supportError: "#fa4d56", supportSuccess: "#42be65", supportWarning: "#f1c21b" },
  },
  typography: { productiveBody: "14px / 18px", expressiveBody: "16px / 22px", family: "IBM Plex Sans" },
  spacingPx: [2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160],
}, null, 2);

const carbonSystem = {
  id: "carbon-reference",
  name: "Carbon Design System",
  source: "curated",
  sourceLabel: "Carbon documentation · reference package",
  description: "Layered neutral themes, productive typography, a precise spacing scale and enterprise-ready component patterns.",
  category: "Enterprise product",
  tags: ["enterprise", "product", "light theme", "dark theme", "data dense", "accessible"],
  license: "Apache-2.0",
  packageVersion: "Carbon v11 docs · checked 2026-11-02",
  sourceUrl: "https://www.carbondesignsystem.com/",
  attribution: "Selected and adapted from official Carbon Design System documentation. Tribe-authored specimens; not an IBM-endorsed package.",
  tokens: { canvas: "#ffffff", surface: "#f4f4f4", raised: "#ffffff", text: "#161616", muted: "#525252", accent: "#0f62fe", line: "#c6c6c6", focus: "#0f62fe", success: "#24a148", warning: "#f1c21b", danger: "#da1e28", radius: "0px", spacing: "16px", fontSize: "14px", font: "IBM Plex Sans, Helvetica Neue, Arial, sans-serif" },
  components: { button: "Use one primary action per page. Secondary and tertiary buttons carry less emphasis; reserve danger buttons for destructive actions.", card: "Build hierarchy with the alternating layer model and 1px seams; avoid shadows except for overlays.", input: "Use a field surface with a bottom border, visible focus, concise label, and helper or error text." },
  guidance: "Use semantic token roles, not palette values, in product components. Review both included themes and the mobile preview. The package is a selected reference subset; consult official Carbon sources for complete tokens and component APIs.",
  references: [
    { url: "https://www.carbondesignsystem.com/building-blocks/foundations/color/overview", label: "Carbon color and theme model" },
    { url: "https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets", label: "Carbon typography" },
    { url: "https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview", label: "Carbon spacing scale" },
    { url: "https://www.carbondesignsystem.com/components/button/usage", label: "Carbon button guidance" },
  ],
  manifest: {
    schemaVersion: "tribe-design-system/v1",
    id: "carbon-reference",
    name: "Carbon Design System",
    category: "Enterprise product",
    description: "A selected Carbon v11 reference package with two theme previews, foundations, components and responsive patterns.",
    version: "1.0.0",
    source: { type: "curated-reference", name: "IBM Carbon Design System", url: "https://github.com/carbon-design-system/carbon" },
    license: "Apache-2.0",
    files: { design: "DESIGN.md", usage: "USAGE.md", tokens: "tokens.css", components: "components.html" },
    preview: { dir: "preview", pages: [
      { title: "Foundations", path: "preview/foundations.html", role: "foundations" },
      { title: "Gray 100 theme", path: "preview/foundations-dark.html", role: "theme" },
      { title: "Components", path: "components.html", role: "components" },
      { title: "Product pattern", path: "preview/patterns.html", role: "patterns" },
    ] },
  },
  packageFiles: [
    { path: "manifest.json", content: "" },
    { path: "DESIGN.md", content: carbonDesignGuide },
    { path: "USAGE.md", content: carbonUsageGuide },
    { path: "tokens.css", content: carbonTokensCss },
    { path: "design-tokens.json", content: carbonTokenJson },
    { path: "components.html", content: carbonComponentsHtml },
    { path: "preview/foundations.html", content: carbonFoundationsHtml },
    { path: "preview/foundations-dark.html", content: carbonDarkFoundationsHtml },
    { path: "preview/patterns.html", content: carbonPatternsHtml },
    { path: "source/evidence.md", content: carbonEvidence },
    { path: "NOTICE", content: carbonNotice },
    { path: "LICENSE", content: APACHE_2_0_LICENSE },
  ],
};
carbonSystem.packageFiles[0].content = JSON.stringify(carbonSystem.manifest, null, 2);

const material3Tokens = `:root {
  --md-sys-color-primary: #6750a4;
  --md-sys-color-on-primary: #ffffff;
  --md-sys-color-primary-container: #eaddff;
  --md-sys-color-on-primary-container: #21005d;
  --md-sys-color-secondary: #625b71;
  --md-sys-color-on-secondary: #ffffff;
  --md-sys-color-secondary-container: #e8def8;
  --md-sys-color-on-secondary-container: #1d192b;
  --md-sys-color-tertiary: #7d5260;
  --md-sys-color-error: #b3261e;
  --md-sys-color-on-error: #ffffff;
  --md-sys-color-surface: #fef7ff;
  --md-sys-color-on-surface: #1d1b20;
  --md-sys-color-on-surface-variant: #49454f;
  --md-sys-color-surface-container-lowest: #ffffff;
  --md-sys-color-surface-container-low: #f7f2fa;
  --md-sys-color-surface-container: #f3edf7;
  --md-sys-color-surface-container-high: #ece6f0;
  --md-sys-color-surface-container-highest: #e6e0e9;
  --md-sys-color-outline: #79747e;
  --md-sys-color-outline-variant: #cac4d0;
  --md-sys-color-inverse-surface: #322f35;
  --md-sys-color-inverse-on-surface: #f5eff7;
  --md-sys-color-inverse-primary: #d0bcff;
  --md-ref-typeface-brand: 'Roboto', 'Arial', sans-serif;
  --md-ref-typeface-plain: 'Roboto', 'Arial', sans-serif;
  --md-sys-typescale-display-large-size: 57px;
  --md-sys-typescale-headline-medium-size: 28px;
  --md-sys-typescale-title-large-size: 22px;
  --md-sys-typescale-body-large-size: 16px;
  --md-sys-typescale-label-large-size: 14px;
  --md-sys-shape-corner-none: 0px;
  --md-sys-shape-corner-extra-small: 4px;
  --md-sys-shape-corner-small: 8px;
  --md-sys-shape-corner-medium: 12px;
  --md-sys-shape-corner-large: 16px;
  --md-sys-shape-corner-extra-large: 28px;
  --tribe-space-unit: 4px;
  --tribe-motion-preview-duration-short: 150ms;
  --tribe-motion-preview-duration-medium: 300ms;
  --canvas: var(--md-sys-color-surface);
  --surface: var(--md-sys-color-surface-container);
  --surface-raised: var(--md-sys-color-surface-container-high);
  --fg: var(--md-sys-color-on-surface);
  --fg-muted: var(--md-sys-color-on-surface-variant);
  --accent: var(--md-sys-color-primary);
  --border: var(--md-sys-color-outline-variant);
  --focus: var(--md-sys-color-primary);
  --success: #386a20;
  --warning: #7c5800;
  --danger: var(--md-sys-color-error);
  --radius: var(--md-sys-shape-corner-medium);
  --space: 16px;
  --text-base: var(--md-sys-typescale-body-large-size);
  --font-body: var(--md-ref-typeface-plain);
}
[data-theme="dark"] {
  --md-sys-color-primary: #d0bcff;
  --md-sys-color-on-primary: #381e72;
  --md-sys-color-primary-container: #4f378b;
  --md-sys-color-on-primary-container: #eaddff;
  --md-sys-color-secondary: #ccc2dc;
  --md-sys-color-on-secondary: #332d41;
  --md-sys-color-secondary-container: #4a4458;
  --md-sys-color-on-secondary-container: #e8def8;
  --md-sys-color-tertiary: #efb8c8;
  --md-sys-color-error: #f2b8b5;
  --md-sys-color-on-error: #601410;
  --md-sys-color-surface: #141218;
  --md-sys-color-on-surface: #e6e0e9;
  --md-sys-color-on-surface-variant: #cac4d0;
  --md-sys-color-surface-container-lowest: #0f0d13;
  --md-sys-color-surface-container-low: #1d1b20;
  --md-sys-color-surface-container: #211f26;
  --md-sys-color-surface-container-high: #2b2930;
  --md-sys-color-surface-container-highest: #36343b;
  --md-sys-color-outline: #938f99;
  --md-sys-color-outline-variant: #49454f;
  --md-sys-color-inverse-surface: #e6e0e9;
  --md-sys-color-inverse-on-surface: #322f35;
  --md-sys-color-inverse-primary: #6750a4;
  --md-sys-color-primary-container: #4f378b;
  --md-sys-color-success: #a8d58d;
  --md-sys-color-warning: #efc148;
  --md-sys-color-danger: #f2b8b5;
  --success: #a8d58d;
  --warning: #efc148;
  --danger: #f2b8b5;
}
`;

const material3Components = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--md-sys-color-surface);color:var(--md-sys-color-on-surface);font:16px/1.5 var(--md-ref-typeface-plain)}main{max-width:900px;margin:auto;display:grid;gap:24px}h1,h2,p{margin:0}h1{font-size:28px;line-height:36px;font-weight:400}h2{font-size:20px;font-weight:500}small{color:var(--md-sys-color-on-surface-variant)}section{display:grid;gap:12px}.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.filled,.tonal,.outlined,.text{height:40px;padding:0 24px;border-radius:999px;font:500 14px var(--md-ref-typeface-plain);cursor:pointer}.filled{border:0;background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary)}.tonal{border:0;background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}.outlined{border:1px solid var(--md-sys-color-outline);background:transparent;color:var(--md-sys-color-primary)}.text{border:0;background:transparent;color:var(--md-sys-color-primary)}button:focus-visible,input:focus-visible{outline:3px solid var(--md-sys-color-primary);outline-offset:2px}.card{padding:20px;border-radius:var(--md-sys-shape-corner-medium);background:var(--md-sys-color-surface-container-low);display:grid;gap:12px}.field{height:56px;max-width:360px;border:1px solid var(--md-sys-color-outline);border-radius:4px;padding:0 16px;background:transparent;color:inherit;font:inherit}.field:focus{border:2px solid var(--md-sys-color-primary)}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{border:1px solid var(--md-sys-color-outline);border-radius:8px;padding:6px 14px;color:var(--md-sys-color-on-surface-variant)}.chip[aria-pressed="true"]{border-color:transparent;background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}.snackbar{padding:14px 18px;border-radius:4px;background:var(--md-sys-color-inverse-surface);color:var(--md-sys-color-inverse-on-surface);display:flex;justify-content:space-between;gap:16px}.snackbar b{color:var(--md-sys-color-inverse-primary)}.disabled{opacity:.38;cursor:not-allowed}@media(max-width:560px){body{padding:16px}.row>*{flex:1 1 auto}.card{padding:16px}}
</style></head><body><main><header><small>MATERIAL 3 · COMPONENT SPECIMENS</small><h1>Controls and states</h1><p>Roles, shape and typography stay connected across components.</p></header><section><h2>Button hierarchy</h2><div class="row"><button class="filled">Create project</button><button class="tonal">Save draft</button><button class="outlined">Preview</button><button class="text">Learn more</button><button class="filled disabled" disabled>Unavailable</button></div></section><section class="card"><h2>Surface container</h2><p>Container roles create quiet hierarchy without relying on shadow.</p><label><small>Project name</small><br><input class="field" value="Northstar analytics" aria-label="Project name"></label><div class="chips"><button class="chip" aria-pressed="true">Selected</button><button class="chip">Available</button><button class="chip">Archived</button></div></section><div class="snackbar"><span>Changes saved</span><b>Undo</b></div></main></body></html>`;

const material3Patterns = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:var(--md-sys-color-surface);color:var(--md-sys-color-on-surface);font:14px/1.5 var(--md-ref-typeface-plain)}.shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr)}aside{padding:24px 16px;background:var(--md-sys-color-surface-container);display:grid;align-content:start;gap:28px}aside strong{font-size:18px;font-weight:600}nav{display:grid;gap:6px}nav a{padding:10px 16px;border-radius:999px;text-decoration:none;color:var(--md-sys-color-on-surface-variant)}nav a[aria-current]{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}main{min-width:0;padding:32px;display:grid;align-content:start;gap:24px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.top h1{font-size:28px;line-height:36px;font-weight:400;margin:0}.top p{color:var(--md-sys-color-on-surface-variant);margin:4px 0 0}.button{height:40px;padding:0 24px;border:0;border-radius:999px;background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);font:500 14px var(--md-ref-typeface-plain)}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.metric,.panel{padding:20px;border-radius:var(--md-sys-shape-corner-medium);background:var(--md-sys-color-surface-container)}.metric span{color:var(--md-sys-color-on-surface-variant)}.metric strong{display:block;font-size:28px;font-weight:400;margin:8px 0}.panel{background:var(--md-sys-color-surface-container-low);display:grid;gap:14px}.bars{height:150px;display:flex;align-items:flex-end;gap:12px;border-bottom:1px solid var(--md-sys-color-outline-variant)}.bars i{flex:1;background:var(--md-sys-color-primary-container);border-radius:8px 8px 0 0;height:var(--h)}.bars i:nth-child(3n){background:var(--md-sys-color-primary)}@media(max-width:700px){.shell{grid-template-columns:1fr}aside{padding:12px 16px;display:flex;align-items:center;justify-content:space-between}nav{display:flex;overflow:auto}nav a{white-space:nowrap}main{padding:20px 16px}.metrics{grid-template-columns:1fr 1fr}.metric:last-child{grid-column:span 2}.top{align-items:flex-start;flex-direction:column}}@media(max-width:420px){.metrics{grid-template-columns:1fr}.metric:last-child{grid-column:auto}}
</style></head><body><div class="shell"><aside><strong>Northstar</strong><nav><a aria-current="page">Overview</a><a>Projects</a><a>Insights</a></nav></aside><main><header class="top"><div><h1>Project overview</h1><p>Progress across your active work.</p></div><button class="button">New project</button></header><section class="metrics"><article class="metric"><span>Active projects</span><strong>12</strong><small>Across four teams</small></article><article class="metric"><span>On track</span><strong>84%</strong><small>Six points above last month</small></article><article class="metric"><span>Needs attention</span><strong>3</strong><small>Two due this week</small></article></section><section class="panel"><h2>Monthly delivery</h2><p>Completed work items · 2026</p><div class="bars"><i style="--h:42%"></i><i style="--h:59%"></i><i style="--h:51%"></i><i style="--h:73%"></i><i style="--h:66%"></i><i style="--h:88%"></i></div><small>January&nbsp;&nbsp; February&nbsp;&nbsp; March&nbsp;&nbsp; April&nbsp;&nbsp; May&nbsp;&nbsp; June</small></section></main></div></body></html>`;

const material3Guide = `# Material Design 3 · curated reference

This package is a Tribe-authored reference to Material Design 3 guidance. It represents the semantic role model, type hierarchy, shape families, motion principles and responsive component patterns; it is not Google's official design kit or a full token export. The sample palette and page examples are illustrative and should be remapped to a product seed colour before use.

## Foundations

### Color roles
Use paired roles such as primary/on-primary and primary-container/on-primary-container. Keep primary, secondary, tertiary, error, surface and outline roles distinct. Surface containers provide five levels for nested regions. Keep the same semantic role mapped to the same layout region across breakpoints. This reference shows a baseline purple palette in light and dark themes; treat it as a sample, not a product's dynamic color output.

### Typography
Use the display, headline, title, body and label roles, each with large, medium and small sizes. Reserve display for short, high-emphasis content. Body styles carry longer reading; labels serve compact component text. Allow line height and padding to establish vertical alignment. The preview uses a system Roboto stack and does not include font files.

### Shape and spacing
Use a shape family from none and extra-small through extra-large, then select corner treatment by component role. The examples use rounded full buttons, compact chips, and medium corners on containers. This package uses 4px as a sample authoring unit; confirm platform-specific spacing in current component specifications rather than treating that variable as an official Material token.

### Layout and adaptation
Keep content hierarchy and semantic surface mappings stable while navigation and grid composition adapt to available width. The dashboard fixture reflows metric cards, navigation and chart content at tablet and phone widths; it is a live page, not a scaled desktop image.

## Components and interaction

The component fixture includes filled, tonal, outlined and text buttons, a disabled state, a labelled input, selected filter chips, surface containers and a snackbar. Reserve the filled treatment for the highest-emphasis action in a group. Pair text and icons with the matching on-color role. Make focus, disabled and selected states legible without relying on color alone.

## Motion and accessibility

Material's current M3 Expressive direction uses standard and expressive spring motion schemes with spatial and effects tokens. The generic duration variables in this reference fixture are Tribe preview parameters, not official Material motion tokens. Keep transitions purposeful and respect reduced-motion preferences where the target platform supports them. Validate role pairings for contrast, use a clear focus indicator and keep touch targets appropriate to the platform. This static preview is a design reference, not an accessibility certification.

## Sources and scope

Guidance is summarised from official Material Design 3 documentation. The semantic CSS palette is a sample reference authored for this package; component HTML and responsive dashboard are Tribe-authored specimens. No Google logos, Material Symbols, fonts, screenshots, or copied component implementation are included. Material Design and Google are names and marks of their respective owners; this package does not imply endorsement or grant trademark rights. Upstream documentation is not redistributed under the Material Web code licence. See source/evidence.md for URLs and scope.
`;

const material3Evidence = `# Material Design 3 source evidence

- Official design system overview: https://m3.material.io/
- Color role model and pairing: https://m3.material.io/m3/pages/color-roles
- Type roles, sizing and use: https://m3.material.io/styles/typography/applying-type
- Components and current guidance index: https://m3.material.io/components
- Current M3 Expressive motion guidance: https://m3.material.io/styles/motion/overview/how-it-works
- Official Material Web implementation repository and licence: https://github.com/material-components/material-web (Apache-2.0; code licence applies to repository code, not this package's summaries of design guidance).

Scope: the design prose is a concise Tribe-authored summary of linked public guidance. The displayed light/dark role values and UI specimens are illustrative Tribe-authored examples; they are not copied from Google's design kit and are not a certified baseline or dynamic-color output. Confirm current upstream component specifications before production implementation. No external logos, icons, screenshots or font files are present.
`;

const material3System = {
  id: "material-3-reference",
  name: "Material Design 3",
  source: "curated",
  sourceLabel: "Material Design 3 documentation · reference package",
  description: "A complete reference slice covering semantic color roles, type hierarchy, shape, motion, component states and responsive product patterns.",
  category: "Platform design system",
  tags: ["mobile", "cross-platform", "responsive", "components", "light theme", "dark theme"],
  license: "Tribe-authored reference; upstream terms apply to linked materials",
  packageVersion: "Material Design 3 docs · checked 2026-11-02",
  sourceUrl: "https://m3.material.io/",
  attribution: "Summarised from official Material Design 3 documentation. Original token sample and previews by Tribe; not Google-endorsed.",
  tokens: { canvas: "#fef7ff", surface: "#f3edf7", raised: "#ece6f0", text: "#1d1b20", muted: "#49454f", accent: "#6750a4", line: "#cac4d0", focus: "#6750a4", success: "#386a20", warning: "#7c5800", danger: "#b3261e", radius: "12px", spacing: "16px", fontSize: "16px", font: "Roboto, Arial, sans-serif" },
  components: { button: "Use filled for the highest-emphasis action; tonal, outlined and text treatments reduce emphasis. Pair each fill with its matching on-color role.", card: "Create hierarchy with surface-container roles before adding elevation. Keep surface mappings stable across responsive layouts.", input: "Keep a visible outline, clear label and focus treatment; validate selected, disabled and error states." },
  guidance: "Use the display, headline, title, body and label type roles. Keep paired semantic color roles together. Adapt layout to available width while preserving role mappings. The included palette and responsive specimens are Tribe-authored references, not official Google assets.",
  references: [
    { url: "https://m3.material.io/m3/pages/color-roles", label: "Material 3 color roles" },
    { url: "https://m3.material.io/styles/typography/applying-type", label: "Material 3 typography" },
    { url: "https://m3.material.io/components", label: "Material 3 component guidance" },
    { url: "https://m3.material.io/styles/motion/overview/how-it-works", label: "M3 Expressive motion schemes" },
    { url: "https://github.com/material-components/material-web", label: "Material Web implementation and code licence" },
  ],
  manifest: { schemaVersion: "tribe-design-system/v1", id: "material-3-reference", name: "Material Design 3", category: "Platform design system", version: "1.0.0", source: { type: "curated-reference", name: "Google Material Design 3", url: "https://m3.material.io/" }, license: "Tribe-authored reference; upstream terms apply to linked materials", files: { design: "DESIGN.md", usage: "USAGE.md", tokens: "tokens.css", components: "components.html" }, preview: { dir: "preview", pages: [ { title: "Light foundations", path: "preview/foundations.html", role: "foundations" }, { title: "Dark foundations", path: "preview/foundations-dark.html", role: "theme" }, { title: "Components", path: "components.html", role: "components" }, { title: "Responsive product pattern", path: "preview/patterns.html", role: "patterns" } ] } },
  packageFiles: [
    { path: "manifest.json", content: "" },
    { path: "DESIGN.md", content: material3Guide },
    { path: "USAGE.md", content: "Read DESIGN.md and source/evidence.md first. Use tokens.css as the sample reference theme; design-tokens.json mirrors its semantic roles. Review preview/foundations.html, components.html, and preview/patterns.html at wide, tablet and mobile widths. Re-seed colors for the target product and validate current upstream guidance before implementation. No assets or font files are included.\n" },
    { path: "tokens.css", content: material3Tokens },
    { path: "design-tokens.json", content: JSON.stringify({ format: "tribe-design-tokens/v1", source: "Tribe-authored Material Design 3 reference sample", themes: { light: { primary: "#6750a4", onPrimary: "#ffffff", surface: "#fef7ff", onSurface: "#1d1b20", surfaceContainer: "#f3edf7" }, dark: { primary: "#d0bcff", onPrimary: "#381e72", surface: "#141218", onSurface: "#e6e0e9", surfaceContainer: "#211f26" } }, typographyRoles: ["display", "headline", "title", "body", "label"], shapeCornersPx: [0, 4, 8, 12, 16, 28], spacingUnitPx: 4 }, null, 2) },
    { path: "components.html", content: material3Components },
    { path: "preview/foundations.html", content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--md-sys-color-surface);color:var(--md-sys-color-on-surface);font:14px/1.5 var(--md-ref-typeface-plain)}main{max-width:900px;margin:auto;display:grid;gap:24px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}h1,h2,p{margin:0}h1{font-size:24px;font-weight:400}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.swatch{min-height:95px;padding:12px;background:var(--c);color:var(--t);border-radius:12px;display:flex;flex-direction:column;justify-content:space-between}.type{display:grid;gap:12px}.type article{display:grid;grid-template-columns:140px 1fr;align-items:baseline;border-bottom:1px solid var(--md-sys-color-outline-variant);padding:10px 0}.shape{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.shape i{width:68px;height:52px;background:var(--md-sys-color-primary-container);border-radius:var(--r)}@media(max-width:500px){body{padding:16px}.type article{grid-template-columns:1fr;gap:4px}}</style></head><body><main data-theme="light"><header><div><small>FOUNDATIONS · LIGHT SAMPLE</small><h1>Roles, type and shape</h1></div></header><section><h2>Semantic color roles</h2><div class="grid"><div class="swatch" style="--c:var(--md-sys-color-primary);--t:var(--md-sys-color-on-primary)"><b>Primary / on-primary</b><code>High emphasis</code></div><div class="swatch" style="--c:var(--md-sys-color-primary-container);--t:var(--md-sys-color-on-primary-container)"><b>Primary container</b><code>Container pairing</code></div><div class="swatch" style="--c:var(--md-sys-color-surface-container);--t:var(--md-sys-color-on-surface)"><b>Surface container</b><code>Default container</code></div><div class="swatch" style="--c:var(--md-sys-color-surface-container-high);--t:var(--md-sys-color-on-surface)"><b>Surface container high</b><code>Raised hierarchy</code></div></div></section><section class="type"><h2>Type roles</h2><article><small>Display large · 57px</small><span style="font-size:32px">A clear beginning</span></article><article><small>Headline medium · 28px</small><span style="font-size:24px">Organise the page</span></article><article><small>Title large · 22px</small><span style="font-size:20px">Group related content</span></article><article><small>Body large · 16px</small><span>Readable product content at comfortable line-height.</span></article><article><small>Label large · 14px</small><span style="font-size:14px;font-weight:500">CREATE PROJECT</span></article></section><section><h2>Shape family</h2><div class="shape"><i style="--r:0px"></i><i style="--r:4px"></i><i style="--r:8px"></i><i style="--r:12px"></i><i style="--r:16px"></i><i style="--r:28px"></i></div><small>None · extra-small · small · medium · large · extra-large</small></section></main></body></html>` },
    { path: "preview/patterns.html", content: material3Patterns },
    { path: "source/evidence.md", content: material3Evidence },
  ],
};
const material3LightFoundations = material3System.packageFiles.find(({ path }) => path === "preview/foundations.html").content;
material3System.packageFiles.push({ path: "preview/foundations-dark.html", content: material3LightFoundations.replace('data-theme="light"', 'data-theme="dark"').replace("LIGHT SAMPLE", "DARK SAMPLE") });
material3System.packageFiles[0].content = JSON.stringify(material3System.manifest, null, 2);

const primerTokens = `:root {
  --bgColor-default: #ffffff;
  --bgColor-muted: #f6f8fa;
  --bgColor-inset: #eff2f5;
  --borderColor-default: #d1d9e0;
  --borderColor-muted: #d8dee4;
  --fgColor-default: #1f2328;
  --fgColor-muted: #59636e;
  --fgColor-subtle: #818b98;
  --fgColor-onEmphasis: #ffffff;
  --bgColor-accent-emphasis: #0969da;
  --bgColor-success-emphasis: #1f883d;
  --bgColor-danger-emphasis: #cf222e;
  --bgColor-done-emphasis: #8250df;
  --control-medium-size: 32px;
  --control-small-size: 28px;
  --text-body-size-medium: 14px;
  --text-title-size-medium: 20px;
  --space-unit: 4px;
  --radius-small: 6px;
  --radius-medium: 8px;
  --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --canvas: var(--bgColor-default);
  --surface: var(--bgColor-muted);
  --surface-raised: #ffffff;
  --fg: var(--fgColor-default);
  --fg-muted: var(--fgColor-muted);
  --accent: var(--bgColor-accent-emphasis);
  --border: var(--borderColor-default);
  --focus: var(--bgColor-accent-emphasis);
  --success: var(--bgColor-success-emphasis);
  --warning: #9a6700;
  --danger: var(--bgColor-danger-emphasis);
  --radius: var(--radius-small);
  --space: 16px;
  --text-base: var(--text-body-size-medium);
  --font-body: var(--font-family);
}
[data-theme="dark"] {
  --bgColor-default: #0d1117;
  --bgColor-muted: #151b23;
  --bgColor-inset: #010409;
  --borderColor-default: #3d444d;
  --borderColor-muted: #30363d;
  --fgColor-default: #f0f6fc;
  --fgColor-muted: #9198a1;
  --fgColor-subtle: #6e7681;
  --fgColor-onEmphasis: #ffffff;
  --bgColor-accent-emphasis: #1f6feb;
  --bgColor-success-emphasis: #238636;
  --bgColor-danger-emphasis: #da3633;
  --bgColor-done-emphasis: #8957e5;
  --surface-raised: #212830;
  --warning: #d29922;
}
`;

const primerComponents = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bgColor-default);color:var(--fgColor-default);font:14px/1.5 var(--font-family)}main{max-width:920px;margin:auto;display:grid;gap:20px}h1,h2,p{margin:0}h1{font-size:24px;font-weight:600;line-height:1.25}h2{font-size:16px;font-weight:600}small,.muted{color:var(--fgColor-muted)}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.button{height:32px;padding:0 12px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-muted);color:var(--fgColor-default);font:500 13px var(--font-family)}.button.primary{border-color:#1f2328;background:var(--bgColor-success-emphasis);color:#fff}.button.danger{color:var(--bgColor-danger-emphasis)}.button.invisible{border-color:transparent;background:transparent}.button:focus-visible,input:focus-visible{outline:2px solid var(--bgColor-accent-emphasis);outline-offset:2px}.button:disabled{opacity:.5}.field{height:32px;max-width:320px;padding:0 10px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-default);color:var(--fgColor-default);font:inherit}.field[aria-invalid="true"]{border-color:var(--bgColor-danger-emphasis)}.token{display:inline-flex;align-items:center;padding:2px 8px;border:1px solid var(--borderColor-muted);border-radius:999px;background:var(--bgColor-muted);font-size:12px}.token.green{color:var(--bgColor-success-emphasis)}.token.purple{color:var(--bgColor-done-emphasis)}.panel{border:1px solid var(--borderColor-default);border-radius:6px;overflow:hidden}.panel>header{padding:12px 16px;background:var(--bgColor-muted);border-bottom:1px solid var(--borderColor-default);font-weight:600}.list{display:grid}.item{display:flex;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid var(--borderColor-muted)}.item:last-child{border-bottom:0}.item>div{display:grid;gap:3px}.item strong{font-weight:600}.status{color:var(--fgColor-muted);font-size:12px}@media(max-width:560px){body{padding:16px}.item{align-items:flex-start;flex-direction:column;gap:8px}}
</style></head><body><main><header><small>PRIMER REFERENCE · COMPONENTS</small><h1>Actions, fields and issue rows</h1><p>Neutral defaults keep page chrome quiet; reserve emphasis for key actions and state.</p></header><section><h2>Button hierarchy and states</h2><div class="row"><button class="button">Secondary action</button><button class="button primary">New issue</button><button class="button invisible">More options</button><button class="button danger">Delete</button><button class="button" disabled>Unavailable</button></div></section><section class="panel"><header>Form controls</header><div class="item"><div><strong>Search issues</strong><small>Use concise labels and visible focus</small></div><input class="field" value="is:open label:bug" aria-label="Search issues"></div><div class="item"><div><strong>Invalid field</strong><small>Explain the problem in text</small></div><input class="field" aria-invalid="true" value="Missing title" aria-label="Issue title"></div></section><section class="panel"><header>Labels and status</header><div class="item"><div><strong>Repository is ready for review</strong><small>Updated recently by the product team</small></div><div class="row"><span class="token green">approved</span><span class="token purple">enhancement</span></div></div></section></main></body></html>`;

const primerPatterns = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:var(--bgColor-default);color:var(--fgColor-default);font:14px/1.5 var(--font-family)}.shell{min-height:100vh;display:grid;grid-template-columns:230px minmax(0,1fr)}aside{padding:20px 16px;background:var(--bgColor-muted);border-right:1px solid var(--borderColor-default);display:grid;align-content:start;gap:24px}aside strong{font-size:15px}.nav{display:grid;gap:4px}.nav a{padding:6px 10px;border-radius:6px;text-decoration:none;color:var(--fgColor-muted)}.nav a[aria-current]{background:var(--bgColor-default);color:var(--fgColor-default);font-weight:600;box-shadow:0 1px 0 var(--borderColor-default)}main{min-width:0;padding:28px 32px;display:grid;align-content:start;gap:18px}.crumb{color:var(--fgColor-muted);font-size:12px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.heading h1{margin:0;font-size:24px;line-height:1.25}.heading p{margin:4px 0 0;color:var(--fgColor-muted)}button{height:32px;padding:0 12px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-muted);color:var(--fgColor-default);font:500 13px var(--font-family)}button.primary{background:var(--bgColor-success-emphasis);border-color:var(--bgColor-success-emphasis);color:white}.filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--borderColor-default)}.filters input{height:32px;flex:1 1 220px;padding:0 10px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-default);color:var(--fgColor-default);font:inherit}.list{border:1px solid var(--borderColor-default);border-radius:6px;overflow:hidden}.row{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--borderColor-muted)}.row:last-child{border:0}.state{width:16px;height:16px;flex:none;border:2px solid var(--bgColor-success-emphasis);border-radius:50%;margin-top:2px}.copy{min-width:0;flex:1}.copy strong{display:block;font-weight:600}.copy p{margin:3px 0 8px;color:var(--fgColor-muted);font-size:12px}.meta{display:flex;gap:6px;flex-wrap:wrap}.pill{padding:1px 7px;border:1px solid var(--borderColor-muted);border-radius:999px;color:var(--fgColor-muted);font-size:11px}.count{color:var(--fgColor-muted);font-size:12px;white-space:nowrap}@media(max-width:700px){.shell{grid-template-columns:1fr}aside{padding:10px 16px;border-right:0;border-bottom:1px solid var(--borderColor-default);display:flex;align-items:center;justify-content:space-between}.nav{display:flex;overflow:auto}.nav a{white-space:nowrap}main{padding:20px 16px}.heading{align-items:flex-start;flex-direction:column}.heading .actions{width:100%;display:flex;gap:8px}.heading .actions button{flex:1}.row{padding:12px}.count{display:none}}
</style></head><body><div class="shell"><aside><strong>octo-labs / planner</strong><nav class="nav"><a>Code</a><a aria-current="page">Issues</a><a>Pull requests</a><a>Projects</a></nav></aside><main><div class="crumb">octo-labs / planner / Issues</div><header class="heading"><div><h1>Issues</h1><p>Track the work that improves the project.</p></div><div class="actions"><button>New view</button><button class="primary">New issue</button></div></header><div class="filters"><input value="is:open sort:updated-desc" aria-label="Filter issues"><button>Labels</button><button>Milestones</button><span class="count">24 open · 7 closed</span></div><section class="list"><article class="row"><i class="state"></i><div class="copy"><strong>Keep the activity panel usable at narrow widths</strong><p>Long descriptions wrap inside the issue row.</p><div class="meta"><span class="pill">responsive</span><span class="pill">needs design</span><span class="pill">#248</span></div></div><span class="count">6 comments</span></article><article class="row"><i class="state"></i><div class="copy"><strong>Add keyboard access to saved filters</strong><p>Expose focus and selection without relying on colour alone.</p><div class="meta"><span class="pill">accessibility</span><span class="pill">#241</span></div></div><span class="count">3 comments</span></article><article class="row"><i class="state"></i><div class="copy"><strong>Document the new project overview</strong><p>Link design guidance and preview examples.</p><div class="meta"><span class="pill">documentation</span><span class="pill">#235</span></div></div><span class="count">1 comment</span></article></section></main></div></body></html>`;

const primerFoundations = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bgColor-default);color:var(--fgColor-default);font:14px/1.5 var(--font-family)}main{max-width:920px;margin:auto;display:grid;gap:20px}h1,h2,p{margin:0}h1{font-size:24px}h2{font-size:16px}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px}.toolbar button{padding:6px 10px;border:1px solid var(--borderColor-default);border-radius:6px;background:var(--bgColor-muted);color:inherit}.swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.swatch{min-height:90px;padding:12px;background:var(--c);color:var(--t);border:1px solid var(--borderColor-muted);border-radius:6px;display:flex;flex-direction:column;justify-content:space-between}.type{display:grid;gap:10px}.type article{display:grid;grid-template-columns:150px 1fr;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--borderColor-muted)}.scale{display:flex;gap:8px;flex-wrap:wrap}.scale i{width:64px;height:44px;padding:6px;background:var(--bgColor-muted);border:1px solid var(--borderColor-default);border-radius:6px;font-style:normal;font-size:12px}@media(max-width:520px){body{padding:16px}.type article{grid-template-columns:1fr;gap:4px}}</style></head><body><main data-theme="light"><header class="toolbar"><div><small>FOUNDATIONS · LIGHT MODE SAMPLE</small><h1>Functional roles and scale</h1></div></header><section><h2>Functional color roles</h2><div class="swatches"><div class="swatch" style="--c:var(--bgColor-default);--t:var(--fgColor-default)"><b>Canvas</b><code>bgColor-default</code></div><div class="swatch" style="--c:var(--bgColor-muted);--t:var(--fgColor-default)"><b>Muted surface</b><code>bgColor-muted</code></div><div class="swatch" style="--c:var(--bgColor-accent-emphasis);--t:#fff"><b>Accent emphasis</b><code>bgColor-accent-emphasis</code></div><div class="swatch" style="--c:var(--bgColor-success-emphasis);--t:#fff"><b>Success emphasis</b><code>bgColor-success-emphasis</code></div><div class="swatch" style="--c:var(--borderColor-default);--t:var(--fgColor-default)"><b>Default border</b><code>borderColor-default</code></div></div></section><section class="type"><h2>Typography</h2><article><small>Title · 24px</small><span style="font-size:24px;font-weight:600">A clear page title</span></article><article><small>Body · 14px</small><span>Readable product copy and issue descriptions.</span></article><article><small>Muted · 14px</small><span style="color:var(--fgColor-muted)">Supporting information</span></article></section><section><h2>Four-pixel spacing steps</h2><div class="scale"><i>4px</i><i>8px</i><i>12px</i><i>16px</i><i>24px</i><i>32px</i></div></section></main></body></html>`;

const primerSystem = {
  id: "primer-reference",
  name: "GitHub Primer",
  source: "curated",
  sourceLabel: "Primer Product UI documentation · reference package",
  description: "A product-interface reference built around functional tokens, quiet defaults, accessible states and compact issue-management patterns.",
  category: "Product interface",
  tags: ["developer tools", "product UI", "light theme", "dark theme", "accessibility", "data dense"],
  license: "Tribe-authored reference; Primer implementation repositories are MIT",
  packageVersion: "Primer docs · checked 2026-11-02",
  sourceUrl: "https://primer.style/product/",
  attribution: "Summarised from Primer Product UI and Primitives documentation. Tribe-authored token examples and previews; no GitHub logos, Octicons, copied source code, or official endorsement.",
  tokens: { canvas: "#ffffff", surface: "#f6f8fa", raised: "#ffffff", text: "#1f2328", muted: "#59636e", accent: "#0969da", line: "#d1d9e0", focus: "#0969da", success: "#1f883d", warning: "#9a6700", danger: "#cf222e", radius: "6px", spacing: "16px", fontSize: "14px", font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  components: { button: "Use the default button for most actions. Use one primary action for the page or group; keep danger actions rare and contextual.", card: "Prefer clear borders and muted surfaces over decorative shadows. Use compact issue rows with a distinct title, supporting text and metadata.", input: "Keep the field boundary, label and focus state visible. Explain invalid values in text and pair them with an error style." },
  guidance: "Map base values to functional roles, then use component tokens only when a pattern needs a specific override. Keep color mode changes in tokens so layout remains stable. This reference shows selected role examples rather than Primer's full theme set.",
  references: [
    { url: "https://primer.style/", label: "Primer design system" },
    { url: "https://primer.style/product/contribute/design/", label: "Primer design foundations and patterns" },
    { url: "https://primer.style/product/getting-started/foundations/color-usage/", label: "Primer color usage and themes" },
    { url: "https://primer.style/product/components/button/guidelines/", label: "Primer button guidelines" },
    { url: "https://primer.style/product/primitives/token-names/", label: "Primer token naming" },
  ],
  manifest: { schemaVersion: "tribe-design-system/v1", id: "primer-reference", name: "GitHub Primer", category: "Product interface", version: "1.0.0", source: { type: "curated-reference", name: "GitHub Primer Product UI", url: "https://primer.style/product/" }, license: "Tribe-authored reference; Primer implementation repositories are MIT", files: { design: "DESIGN.md", usage: "USAGE.md", tokens: "tokens.css", components: "components.html" }, preview: { dir: "preview", pages: [ { title: "Light foundations", path: "preview/foundations.html", role: "foundations" }, { title: "Dark foundations", path: "preview/foundations-dark.html", role: "theme" }, { title: "Components", path: "components.html", role: "components" }, { title: "Issue list pattern", path: "preview/patterns.html", role: "patterns" } ] } },
  packageFiles: [
    { path: "manifest.json", content: "" },
    { path: "DESIGN.md", content: `# GitHub Primer · curated reference\n\nThis Tribe-authored package summarises Primer Product UI guidance and demonstrates its token model with original fixtures. Primer Product UI, Primer Brand UI and GitHub brand assets are distinct; this package covers Product UI only. It is a selected reference, not the official GitHub design kit or a full export of Primer's nine themes.\n\n## Foundations and token layers\n\nPrimer organises tokens as base, functional, and component or pattern tokens. Use functional roles for backgrounds, foregrounds, borders, actions and statuses. Keep raw palette values inside token definitions; components should consume semantic roles.\n\n## Color and themes\n\nPrimer supports light and dark modes across multiple themes. A role such as default background changes with the selected mode, while component layout remains stable. Pair emphasis backgrounds with on-emphasis foregrounds. The package's light and dark samples are Tribe-authored illustrations, not an exported Primer theme.\n\n## Typography\n\nUse compact system typography for product screens. Maintain a clear distinction between page titles, body text and muted metadata; scale headings with available space and keep long descriptions readable. The system font stack is used without bundled fonts.\n\n## Spacing and layout\n\nUse a small, repeatable spacing scale and align list, form and navigation regions consistently. Primer's public CSS utilities expose responsive typography and layout primitives. The specimen uses selected 4px steps as a reference, not a full spacing-token export.\n\n## Components\n\nThe component preview includes default, primary, invisible, danger and unavailable button states, text fields with focus and invalid state, labels, issue rows and metadata. Prefer the default button in most cases; use a single primary action when hierarchy needs it. Use semantic HTML for interactive controls.\n\n## Patterns and responsive behaviour\n\nThe issue-list specimen shows a compact navigation rail, search/filter controls, status, title, description, labels and counts. On narrow screens the navigation becomes horizontal, controls wrap and supporting metadata yields space to the title. Patterns should solve a concrete context and remain flexible before being promoted to reusable components.\n\n## Accessibility\n\nKeep visible focus, contrast-compliant text and borders, keyboard access, clear error copy and status labels. Never rely on a color change alone. Ensure token groups remain accessible when truncated and provide an accessible count for hidden items.\n\n## Scope and attribution\n\nGuidance is summarised from Primer Product UI documentation. Preview pages, sample token values and this package composition are authored for Tribe. No GitHub logo, Octicons, fonts, screenshots or Primer component implementation is included. The MIT licences in the Primer Primitives and Primer React repositories apply to those repositories' software; they are not asserted as a licence for Primer documentation or brand assets. GitHub and Primer are marks of their respective owners. This package is not endorsed by GitHub. See source/evidence.md for linked evidence.\n` },
    { path: "USAGE.md", content: "Read DESIGN.md and source/evidence.md first. Use tokens.css as a selected functional-token example, not a full Primer theme export. Review both foundation modes, components.html, and preview/patterns.html at wide, tablet, and phone widths. Preserve semantic roles, keyboard focus and explicit status text. Do not use GitHub marks or assume Product UI rules also cover Primer Brand UI.\n" },
    { path: "tokens.css", content: primerTokens },
    { path: "design-tokens.json", content: JSON.stringify({ format: "tribe-design-tokens/v1", source: "Tribe-authored Primer reference sample", themes: { light: { background: "#ffffff", backgroundMuted: "#f6f8fa", foreground: "#1f2328", foregroundMuted: "#59636e", accent: "#0969da", success: "#1f883d", danger: "#cf222e" }, dark: { background: "#0d1117", backgroundMuted: "#151b23", foreground: "#f0f6fc", foregroundMuted: "#9198a1", accent: "#1f6feb", success: "#238636", danger: "#da3633" } }, tokenLayers: ["base", "functional", "component/pattern"], spacingPx: [4, 8, 12, 16, 24, 32] }, null, 2) },
    { path: "components.html", content: primerComponents },
    { path: "preview/foundations.html", content: primerFoundations },
    { path: "preview/foundations-dark.html", content: primerFoundations.replace('data-theme="light"', 'data-theme="dark"').replace("LIGHT MODE SAMPLE", "DARK MODE SAMPLE") },
    { path: "preview/patterns.html", content: primerPatterns },
    { path: "source/evidence.md", content: `# Primer source evidence\n\n- Primer overview and Product UI distinction: https://primer.style/\n- Design foundations and reusable pattern guidance: https://primer.style/product/contribute/design/\n- Color roles, light/dark modes, and token layers: https://primer.style/product/getting-started/foundations/color-usage/\n- Button hierarchy and states: https://primer.style/product/components/button/guidelines/\n- Token naming: https://primer.style/product/primitives/token-names/\n- Primer Primitives source repository and MIT licence: https://github.com/primer/primitives/blob/main/LICENSE\n- Primer React source repository and MIT licence: https://github.com/primer/react/blob/main/LICENSE\n\nScope: docs describe GitHub Primer Product UI, while examples and sample values are authored for Tribe. MIT applies to the named source repositories' software and is not represented as a licence for design documentation or GitHub marks. No upstream code or assets are redistributed.\n` },
  ],
};
primerSystem.packageFiles[0].content = JSON.stringify(primerSystem.manifest, null, 2);

const fluent2Tokens = `:root {
  --colorNeutralBackground1: #ffffff;
  --colorNeutralBackground2: #fafafa;
  --colorNeutralBackground3: #f5f5f5;
  --colorNeutralForeground1: #242424;
  --colorNeutralForeground2: #424242;
  --colorNeutralForeground3: #616161;
  --colorNeutralStroke1: #d1d1d1;
  --colorNeutralStroke2: #e0e0e0;
  --colorBrandBackground: #0f6cbd;
  --colorBrandBackgroundHover: #115ea3;
  --colorBrandForeground1: #0f6cbd;
  --colorNeutralForegroundOnBrand: #ffffff;
  --colorStatusSuccessBackground1: #f1faf1;
  --colorStatusSuccessForeground1: #0e700e;
  --colorStatusWarningBackground1: #fff9f5;
  --colorStatusWarningForeground1: #bc4b09;
  --colorStatusDangerBackground1: #fdf3f4;
  --colorStatusDangerForeground1: #b10e1c;
  --colorNeutralBackgroundDisabled: #f0f0f0;
  --colorNeutralForegroundDisabled: #bdbdbd;
  --colorNeutralStrokeDisabled: #e0e0e0;
  --colorStrokeFocus1: #000000;
  --fontFamilyBase: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --fontSizeBase300: 14px;
  --fontSizeHero700: 28px;
  --fontWeightRegular: 400;
  --fontWeightSemibold: 600;
  --lineHeightBase300: 20px;
  --spacingHorizontalS: 8px;
  --spacingHorizontalM: 12px;
  --spacingHorizontalL: 16px;
  --spacingVerticalS: 8px;
  --spacingVerticalM: 12px;
  --spacingVerticalL: 16px;
  --borderRadiusSmall: 2px;
  --borderRadiusMedium: 4px;
  --borderRadiusLarge: 8px;
  --shadow4: 0 2px 4px rgba(0,0,0,.14), 0 0 2px rgba(0,0,0,.12);
  --bg: var(--colorNeutralBackground1);
  --surface: var(--colorNeutralBackground2);
  --surface-raised: var(--colorNeutralBackground3);
  --fg: var(--colorNeutralForeground1);
  --fg-muted: var(--colorNeutralForeground2);
  --accent: var(--colorBrandBackground);
  --border: var(--colorNeutralStroke1);
  --focus: var(--colorStrokeFocus1);
  --success: var(--colorStatusSuccessForeground1);
  --warning: var(--colorStatusWarningForeground1);
  --danger: var(--colorStatusDangerForeground1);
  --radius: var(--borderRadiusMedium);
  --space: var(--spacingHorizontalL);
  --text-base: var(--fontSizeBase300);
  --font-body: var(--fontFamilyBase);
}
[data-theme="dark"] {
  --colorNeutralBackground1: #292929;
  --colorNeutralBackground2: #1f1f1f;
  --colorNeutralBackground3: #141414;
  --colorNeutralForeground1: #ffffff;
  --colorNeutralForeground2: #d6d6d6;
  --colorNeutralForeground3: #adadad;
  --colorNeutralStroke1: #666666;
  --colorNeutralStroke2: #525252;
  --colorBrandBackground: #479ef5;
  --colorBrandBackgroundHover: #62abf5;
  --colorBrandForeground1: #479ef5;
  --colorNeutralForegroundOnBrand: #000000;
  --colorStatusSuccessBackground1: #052505;
  --colorStatusSuccessForeground1: #54b054;
  --colorStatusWarningBackground1: #4a1e04;
  --colorStatusWarningForeground1: #f98836;
  --colorStatusDangerBackground1: #3b0509;
  --colorStatusDangerForeground1: #e37d80;
  --colorNeutralBackgroundDisabled: #424242;
  --colorNeutralForegroundDisabled: #757575;
  --colorNeutralStrokeDisabled: #424242;
  --colorStrokeFocus1: #ffffff;
}
`;

const fluent2Components = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--colorNeutralBackground1);color:var(--colorNeutralForeground1);font:var(--fontWeightRegular) var(--fontSizeBase300)/var(--lineHeightBase300) var(--fontFamilyBase)}main{max-width:980px;margin:auto;display:grid;gap:24px}h1,h2,p{margin:0}h1{font-size:var(--fontSizeHero700);line-height:36px;font-weight:var(--fontWeightSemibold)}h2{font-size:20px;line-height:28px;font-weight:var(--fontWeightSemibold)}small,.muted{color:var(--colorNeutralForeground2)}section{display:grid;gap:12px}.toolbar,.actions,.tags{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.toolbar{justify-content:space-between}.toolbar>div:first-child{display:grid;gap:4px}button,input{font:inherit}button{min-height:32px;padding:0 12px;border:1px solid var(--colorNeutralStroke1);border-radius:var(--borderRadiusMedium);background:var(--colorNeutralBackground1);color:var(--colorNeutralForeground1);cursor:pointer}button.primary{border-color:var(--colorBrandBackground);background:var(--colorBrandBackground);color:var(--colorNeutralForegroundOnBrand)}button.primary:hover{background:var(--colorBrandBackgroundHover)}button:focus-visible,input:focus-visible{outline:2px solid var(--colorStrokeFocus1);outline-offset:2px}button:disabled{border-color:var(--colorNeutralStrokeDisabled);background:var(--colorNeutralBackgroundDisabled);color:var(--colorNeutralForegroundDisabled);cursor:not-allowed}.card,.field{padding:16px;border:1px solid var(--colorNeutralStroke2);border-radius:var(--borderRadiusMedium);background:var(--colorNeutralBackground2)}.field{display:grid;gap:6px;max-width:420px}.field input{height:32px;padding:0 8px;border:1px solid var(--colorNeutralStroke1);border-radius:var(--borderRadiusMedium);background:var(--colorNeutralBackground1);color:inherit}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.metric{display:grid;gap:6px;padding:16px;border:1px solid var(--colorNeutralStroke2);border-radius:var(--borderRadiusMedium);background:var(--colorNeutralBackground2)}.metric strong{font-size:24px;line-height:32px}.badge{padding:2px 8px;border-radius:999px;background:var(--colorStatusSuccessBackground1);color:var(--colorStatusSuccessForeground1)}.badge.warning{background:var(--colorStatusWarningBackground1);color:var(--colorStatusWarningForeground1)}.badge.error{background:var(--colorStatusDangerBackground1);color:var(--colorStatusDangerForeground1)}.table-wrap{overflow:auto;border:1px solid var(--colorNeutralStroke2);border-radius:var(--borderRadiusMedium)}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--colorNeutralStroke2)}th{font-weight:var(--fontWeightSemibold);background:var(--colorNeutralBackground2)}tr:last-child td{border-bottom:0}.table-status{white-space:nowrap}@media(max-width:600px){body{padding:16px}.metrics{grid-template-columns:1fr}.toolbar{align-items:flex-start;flex-direction:column}.actions button{flex:1}}
</style></head><body><main data-theme="light"><header class="toolbar"><div><small>FLUENT 2 · WEB PRODUCT SPECIMEN</small><h1>Workspace overview</h1><p class="muted">A token-driven product page with responsive information hierarchy.</p></div><div class="actions"><button>View activity</button><button class="primary">New workspace</button></div></header><section><h2>Project health</h2><div class="metrics"><article class="metric"><span class="muted">Active projects</span><strong>12</strong><span class="muted">Across four teams</span></article><article class="metric"><span class="muted">On track</span><strong>84%</strong><span class="badge">6% above last month</span></article><article class="metric"><span class="muted">Needs attention</span><strong>3</strong><span class="badge warning">2 due this week</span></article></div></section><section><h2>Recent work</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th>Owner</th><th>Status</th><th>Updated</th></tr></thead><tbody><tr><td>Customer insights</td><td>Alex Chen</td><td class="table-status"><span class="badge">On track</span></td><td>Today</td></tr><tr><td>Quarterly planning</td><td>Sam Patel</td><td class="table-status"><span class="badge warning">Review</span></td><td>Yesterday</td></tr><tr><td>Service migration</td><td>Jordan Lee</td><td class="table-status"><span class="badge error">Blocked</span></td><td>Monday</td></tr></tbody></table></div></section><section class="card"><h2>Invite your team</h2><p class="muted">Bring project owners into the workspace to keep decisions moving.</p><label class="field">Work email<input type="email" value="alex@example.com" aria-label="Work email"></label><div class="actions"><button class="primary">Send invitation</button><button>Cancel</button><button disabled>Unavailable</button></div></section></main></body></html>`;

const fluent2System = {
  id: "fluent-2-reference",
  name: "Microsoft Fluent 2",
  source: "curated",
  sourceLabel: "Fluent 2 design guidance · reference package",
  description: "A web product reference for semantic alias tokens, adaptive layouts, accessible controls and consistent component behaviour.",
  category: "Platform design system",
  tags: ["web", "enterprise", "light theme", "dark theme", "adaptive layout", "accessibility"],
  license: "Tribe-authored reference; Microsoft design guidance linked, no Microsoft assets included",
  packageVersion: "Fluent 2 docs · checked 2026-11-02",
  sourceUrl: "https://fluent2.microsoft.design/",
  attribution: "Summarised from Microsoft's Fluent 2 web design guidance. Sample package composition and preview fixtures are authored for Tribe; not Microsoft-endorsed.",
  tokens: { canvas: "#ffffff", surface: "#fafafa", raised: "#f5f5f5", text: "#242424", muted: "#424242", accent: "#0f6cbd", line: "#d1d1d1", focus: "#000000", success: "#0e700e", warning: "#bc4b09", danger: "#b10e1c", radius: "4px", spacing: "16px", fontSize: "14px", font: "Segoe UI, Helvetica Neue, Arial, sans-serif" },
  components: { button: "Use one primary button for the most important action. Keep peer actions neutral and use links for navigation.", card: "Use neutral surfaces and strokes to establish grouping; reserve elevation for overlays and clear hierarchy.", input: "Keep a visible label, border and focus indication. Preserve disabled and validation states with text and semantic colours." },
  guidance: "Map raw palette values through global tokens into functional alias tokens. Keep component styling semantic so light and dark modes can change without rewriting layouts. This package demonstrates selected web aliases and is not a full Fluent token export.",
  references: [
    { url: "https://fluent2.microsoft.design/get-started/design", label: "Fluent 2 design language and UI kits" },
    { url: "https://fluent2.microsoft.design/design-tokens", label: "Global and alias design tokens" },
    { url: "https://fluent2.microsoft.design/color-tokens", label: "Web alias colour tokens" },
    { url: "https://fluent2.microsoft.design/typography", label: "Typography" },
    { url: "https://fluent2.microsoft.design/layout", label: "Adaptive layout" },
    { url: "https://fluent2.microsoft.design/components/web/react/core/button/usage/", label: "React button usage and accessibility" },
    { url: "https://fluent2.microsoft.design/shapes", label: "Shapes and corner radii" },
  ],
  manifest: { schemaVersion: "tribe-design-system/v1", id: "fluent-2-reference", name: "Microsoft Fluent 2", category: "Platform design system", version: "1.0.0", source: { type: "curated-reference", name: "Microsoft Fluent 2", url: "https://fluent2.microsoft.design/" }, license: "Tribe-authored reference; Microsoft design guidance linked, no Microsoft assets included", files: { design: "DESIGN.md", usage: "USAGE.md", tokens: "tokens.css", components: "components.html" }, preview: { dir: "preview", pages: [{ title: "Light foundations", path: "preview/foundations.html", role: "foundations" }, { title: "Dark foundations", path: "preview/foundations-dark.html", role: "theme" }, { title: "Components", path: "components.html", role: "components" }, { title: "Workspace overview", path: "preview/workspace.html", role: "product pattern" }] } },
  packageFiles: [
    { path: "manifest.json", content: "" },
    { path: "DESIGN.md", content: `# Microsoft Fluent 2 · curated reference\n\nThis Tribe-authored package captures a selected web reference to Fluent 2's token, layout and component guidance. It does not redistribute Microsoft's Figma UI kits, fonts, icons or implementation code and does not claim endorsement. The preview aliases use published Fluent 2 names with a selected sample of values; consult Microsoft's current design language for full theme coverage.\n\n## Brand and foundations\n\nFluent separates global raw-value tokens from alias tokens with semantic intent. Use alias roles in components and preserve the connection to base values for theming. The preview demonstrates a restrained Microsoft blue action alongside neutral surfaces and explicit status roles. Do not use Microsoft's marks or imply an official Microsoft product.\n\n## Typography and shape\n\nUse a compact Segoe UI stack for web, with clear display, title and body hierarchy. The sample uses regular and semibold weights, 14px body copy, and a 28px page heading. Most rectangular components use a 4px corner; use 2px for small badges and reserve 8px or 12px for larger surfaces where the component warrants it. These are selected references, not an exhaustive type or shape export.\n\n## Spacing and responsive layout\n\nUse repeatable horizontal and vertical spacing tokens and create relationships through alignment and proximity. Keep information order stable as available width changes: metric columns collapse to a single column, action controls wrap, and wide tables scroll within their own region. Do not scale a desktop layout as an image.\n\n## Components and interaction\n\nThe component specimen includes primary and neutral buttons, a labelled field, disabled actions, semantic status badges and a table. Use one primary action for the most important task; use a link for navigation. Keep focus visible and meet text and icon contrast requirements in every interactive state. Provide an action or next step for warning and error messages.\n\n## Motion and accessibility\n\nFluent includes animation and stroke information in its global token layer and provides theming for light, dark and high-contrast contexts. This reference does not claim to reproduce its full motion system. Preserve keyboard focus, semantic status text and readable contrast, and test alternate themes and narrow widths before applying a package.\n\n## Sources and scope\n\nGuidance is summarised from official Fluent 2 documentation. All HTML fixtures, semantic CSS mapping and package composition are authored for Tribe. No upstream code or visual assets are included. Microsoft and Fluent are marks of their respective owners; this package grants no trademark rights. See source/evidence.md for linked references and evidence scope.\n` },
    { path: "USAGE.md", content: "Read DESIGN.md and source/evidence.md before implementation. Use tokens.css as a selected alias-token reference and design-tokens.json as its structured projection. Review foundations, component states and the responsive workspace page in both themes and at wide, tablet and mobile widths. Revalidate current upstream guidance; this is not a full Fluent 2 token or component export. No Microsoft fonts, icons or Figma assets are bundled.\n" },
    { path: "tokens.css", content: fluent2Tokens },
    { path: "design-tokens.json", content: JSON.stringify({ format: "tribe-design-tokens/v1", source: "Tribe-authored Fluent 2 reference sample", tokenLayers: ["global", "alias"], themes: { light: { colorNeutralBackground1: "#ffffff", colorNeutralBackground2: "#fafafa", colorNeutralForeground1: "#242424", colorNeutralForeground2: "#424242", colorBrandBackground: "#0f6cbd" }, dark: { colorNeutralBackground1: "#292929", colorNeutralBackground2: "#1f1f1f", colorNeutralForeground1: "#ffffff", colorNeutralForeground2: "#d6d6d6", colorBrandBackground: "#479ef5" } }, typography: { fontFamilyBase: "Segoe UI, Helvetica Neue, Arial, sans-serif", fontSizeBase300: "14px", fontSizeHero700: "28px" }, spacingPx: [8, 12, 16], cornerRadiusPx: [2, 4, 8, 12] }, null, 2) },
    { path: "components.html", content: fluent2Components },
    { path: "preview/foundations.html", content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--colorNeutralBackground1);color:var(--colorNeutralForeground1);font:14px/1.5 var(--fontFamilyBase)}main{max-width:900px;margin:auto;display:grid;gap:20px}h1,h2,p{margin:0}h1{font-size:28px}.swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.swatch{min-height:90px;padding:12px;border:1px solid var(--colorNeutralStroke2);border-radius:4px;background:var(--c);color:var(--t);display:grid;align-content:space-between}.types{display:grid;gap:8px}.types article{display:grid;grid-template-columns:150px 1fr;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--colorNeutralStroke2)}.radii{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.radii i{width:68px;height:52px;border:1px solid var(--colorNeutralStroke1);background:var(--colorNeutralBackground2);border-radius:var(--r)}@media(max-width:520px){body{padding:16px}.types article{grid-template-columns:1fr;gap:4px}}</style></head><body><main data-theme="light"><header><small>FOUNDATIONS · LIGHT SAMPLE</small><h1>Aliases, typography and shape</h1></header><section><h2>Semantic colour roles</h2><div class="swatches"><div class="swatch" style="--c:var(--colorNeutralBackground1);--t:var(--colorNeutralForeground1)"><b>Default canvas</b><code>colorNeutralBackground1</code></div><div class="swatch" style="--c:var(--colorNeutralBackground2);--t:var(--colorNeutralForeground1)"><b>Subtle surface</b><code>colorNeutralBackground2</code></div><div class="swatch" style="--c:var(--colorBrandBackground);--t:var(--colorNeutralForegroundOnBrand)"><b>Brand action</b><code>colorBrandBackground</code></div><div class="swatch" style="--c:var(--colorStatusSuccessBackground1);--t:var(--colorStatusSuccessForeground1)"><b>Success</b><code>colorStatusSuccessBackground1</code></div></div></section><section class="types"><h2>Type roles</h2><article><small>Hero · 28px / semibold</small><span style="font-size:28px;font-weight:600">Make work clear</span></article><article><small>Base · 14px / regular</small><span>Use readable body copy with a consistent 20px line-height.</span></article><article><small>Secondary</small><span style="color:var(--colorNeutralForeground2)">Keep supporting details distinct from primary content.</span></article></section><section><h2>Corner family</h2><div class="radii"><i style="--r:2px"></i><i style="--r:4px"></i><i style="--r:8px"></i><i style="--r:12px"></i></div><small>Small · medium · large · extra-large</small></section></main></body></html>` },
    { path: "preview/foundations-dark.html", content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--colorNeutralBackground1);color:var(--colorNeutralForeground1);font:14px/1.5 var(--fontFamilyBase)}main{max-width:900px;margin:auto;display:grid;gap:20px}h1,h2,p{margin:0}h1{font-size:28px}.swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.swatch{min-height:90px;padding:12px;border:1px solid var(--colorNeutralStroke2);border-radius:4px;background:var(--c);color:var(--t);display:grid;align-content:space-between}.types{display:grid;gap:8px}.types article{display:grid;grid-template-columns:150px 1fr;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--colorNeutralStroke2)}.radii{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.radii i{width:68px;height:52px;border:1px solid var(--colorNeutralStroke1);background:var(--colorNeutralBackground2);border-radius:var(--r)}@media(max-width:520px){body{padding:16px}.types article{grid-template-columns:1fr;gap:4px}}</style></head><body><main data-theme="dark"><header><small>FOUNDATIONS · DARK SAMPLE</small><h1>Aliases, typography and shape</h1></header><section><h2>Semantic colour roles</h2><div class="swatches"><div class="swatch" style="--c:var(--colorNeutralBackground1);--t:var(--colorNeutralForeground1)"><b>Default canvas</b><code>colorNeutralBackground1</code></div><div class="swatch" style="--c:var(--colorNeutralBackground2);--t:var(--colorNeutralForeground1)"><b>Subtle surface</b><code>colorNeutralBackground2</code></div><div class="swatch" style="--c:var(--colorBrandBackground);--t:var(--colorNeutralForegroundOnBrand)"><b>Brand action</b><code>colorBrandBackground</code></div><div class="swatch" style="--c:var(--colorStatusSuccessBackground1);--t:var(--colorStatusSuccessForeground1)"><b>Success</b><code>colorStatusSuccessBackground1</code></div></div></section><section class="types"><h2>Type roles</h2><article><small>Hero · 28px / semibold</small><span style="font-size:28px;font-weight:600">Make work clear</span></article><article><small>Base · 14px / regular</small><span>Use readable body copy with a consistent 20px line-height.</span></article><article><small>Secondary</small><span style="color:var(--colorNeutralForeground2)">Keep supporting details distinct from primary content.</span></article></section><section><h2>Corner family</h2><div class="radii"><i style="--r:2px"></i><i style="--r:4px"></i><i style="--r:8px"></i><i style="--r:12px"></i></div><small>Small · medium · large · extra-large</small></section></main></body></html>` },
    { path: "preview/workspace.html", content: fluent2Components.replace("FLUENT 2 · WEB PRODUCT SPECIMEN", "FLUENT 2 · RESPONSIVE PRODUCT PATTERN") },
    { path: "source/evidence.md", content: `# Microsoft Fluent 2 source evidence\n\n- Design language and platform kit structure: https://fluent2.microsoft.design/get-started/design\n- Global and alias token architecture, theming: https://fluent2.microsoft.design/design-tokens\n- Web alias colour roles and light/dark mappings: https://fluent2.microsoft.design/color-tokens\n- Typography roles and type ramp: https://fluent2.microsoft.design/typography\n- Adaptive layout guidance: https://fluent2.microsoft.design/layout\n- Web React button hierarchy and contrast guidance: https://fluent2.microsoft.design/components/web/react/core/button/usage/\n- Shape and corner-radius guidance: https://fluent2.microsoft.design/shapes\n\nScope: package interpretation is based on public Microsoft design documentation. The sample palette, CSS mapping, HTML fixtures and package composition are authored for Tribe. No Microsoft code, font files, icons, screenshots, logos or Figma assets are included. Microsoft and Fluent are marks of their owners; no endorsement or trademark licence is implied. The package licence applies to Tribe-authored files only.\n` },
  ],
};
fluent2System.packageFiles[0].content = JSON.stringify(fluent2System.manifest, null, 2);

const referenceOutputScreens = [
  { path: "preview/launch-page.html", title: "Launch page", role: "landing", heading: "Make space for better work", body: "Bring your projects, decisions and team updates into one clear workspace.", action: "Create workspace" },
  { path: "preview/analytics-brief.html", title: "Analytics brief", role: "dashboard", heading: "Delivery at a glance", body: "A compact view of performance, ownership and work that needs attention.", action: "Export report" },
  { path: "preview/access-form.html", title: "Access request", role: "form", heading: "Request project access", body: "Choose the workspace and explain what you need to get started.", action: "Send request" },
];

function referenceOutputHtml(system, screen) {
  const common = `*{box-sizing:border-box}body{margin:0;padding:clamp(16px,4vw,36px);background:var(--bg);color:var(--fg);font:var(--text-base)/1.5 var(--font-body)}[data-theme="light"],[data-carbon-theme="white"]{color-scheme:light}[data-theme="dark"],[data-carbon-theme="g100"]{color-scheme:dark}main{max-width:920px;margin:auto;display:grid;align-content:start;gap:24px}h1,h2,p{margin:0}h1{font-size:clamp(24px,4vw,36px);line-height:1.14;font-weight:600}h2{font-size:18px;line-height:1.35}small,.muted{color:var(--fg-muted)}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}.mark{width:26px;height:26px;border-radius:var(--radius);background:var(--accent)}.brand{display:flex;align-items:center;gap:10px;font-weight:600}.button{min-height:36px;padding:0 14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-raised);color:var(--fg);font:inherit}.button.primary{border-color:var(--accent);background:var(--accent);color:#fff}.hero{display:grid;justify-items:start;gap:14px;padding:clamp(20px,5vw,48px);border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);background:var(--surface)}.hero p{max-width:58ch;color:var(--fg-muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{display:grid;align-content:start;gap:8px;min-width:0;padding:16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}.metric{font-size:28px;line-height:1.1;font-weight:600}.pill{display:inline-flex;width:max-content;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--success) 14%,var(--surface));color:var(--success);font-size:12px}.bars{height:124px;display:flex;align-items:end;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)}.bars i{flex:1;min-width:0;height:var(--h);border-radius:var(--radius) var(--radius) 0 0;background:var(--accent);opacity:var(--opacity,1)}.bars i:nth-child(even){opacity:.62}.field{display:grid;gap:6px}.field input,.field textarea,.field select{width:100%;min-height:40px;padding:9px 11px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--fg);font:inherit}.field textarea{min-height:82px;resize:vertical}.form{max-width:620px;display:grid;gap:16px;padding:20px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}.steps{display:flex;gap:8px;flex-wrap:wrap}.steps span{padding:5px 10px;border-radius:999px;background:var(--surface-raised);color:var(--fg-muted);font-size:12px}.steps span:first-child{background:var(--accent);color:#fff}.actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:600px){.top{align-items:flex-start}.top .button{white-space:nowrap}.grid{grid-template-columns:1fr}.hero{padding:20px}.top nav{display:none}}`;
  let content = "";
  if (screen.role === "landing") {
    content = `<header class="top"><div class="brand"><i class="mark"></i><span>${system.name} · Studio</span></div><nav class="muted">Product　 Resources　 About</nav><button class="button">Sign in</button></header><section class="hero"><small>YOUR NEXT CHAPTER STARTS HERE</small><h1>${screen.heading}</h1><p>${screen.body}</p><div class="actions"><button class="button primary">${screen.action}</button><button class="button">Explore the preview</button></div></section><section class="grid"><article class="card"><span class="pill">Clarity</span><h2>Keep the important work visible</h2><p class="muted">Give every project a useful home and a clear next step.</p></article><article class="card"><span class="pill">Momentum</span><h2>Move from plan to progress</h2><p class="muted">Bring updates, owners and decisions together.</p></article><article class="card"><span class="pill">Focus</span><h2>Make room for deep work</h2><p class="muted">Turn scattered activity into a calm shared view.</p></article></section>`;
  } else if (screen.role === "dashboard") {
    content = `<header class="top"><div class="brand"><i class="mark"></i><span>${system.name} · Insights</span></div><button class="button primary">${screen.action}</button></header><section><small>MONDAY, 2 NOVEMBER · TEAM SUMMARY</small><h1>${screen.heading}</h1><p class="muted">${screen.body}</p></section><section class="grid"><article class="card"><small>Work completed</small><strong class="metric">84%</strong><span class="pill">↑ 6% this month</span></article><article class="card"><small>Active projects</small><strong class="metric">12</strong><span class="muted">Across four teams</span></article><article class="card"><small>Needs review</small><strong class="metric">3</strong><span class="muted">Two due this week</span></article></section><section class="card"><div><h2>Weekly delivery</h2><small class="muted">Completed work items · last six weeks</small></div><div class="bars" role="img" aria-label="Weekly delivery trend"><i style="--h:38%"></i><i style="--h:57%"></i><i style="--h:49%"></i><i style="--h:76%"></i><i style="--h:66%"></i><i style="--h:92%"></i></div><small class="muted">Week 1　 Week 2　 Week 3　 Week 4　 Week 5　 Week 6</small></section>`;
  } else {
    content = `<header class="top"><div class="brand"><i class="mark"></i><span>${system.name} · Workspace</span></div><small>STEP 1 OF 2</small></header><section><div class="steps"><span>1 · Request</span><span>2 · Review</span></div><h1>${screen.heading}</h1><p class="muted">${screen.body}</p></section><form class="form"><label class="field">Workspace<select aria-label="Workspace"><option>Northstar analytics</option><option>Product research</option></select></label><label class="field">Your role<input aria-label="Your role" value="Product designer"></label><label class="field">Reason<textarea aria-label="Reason">I need access to review project patterns and share feedback.</textarea></label><small class="muted">The workspace owner will review your request.</small><div class="actions"><button class="button primary" type="button">${screen.action}</button><button class="button" type="button">Cancel</button></div></form>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${common}</style></head><body><main>${content}</main></body></html>`;
}

for (const system of [carbonSystem, material3System, fluent2System, primerSystem]) {
  for (const screen of referenceOutputScreens) {
    system.packageFiles.push({ path: screen.path, content: referenceOutputHtml(system, screen) });
    system.manifest.preview.pages.push({ title: screen.title, path: screen.path, role: screen.role });
  }
  system.packageFiles[0].content = JSON.stringify(system.manifest, null, 2);
}

export const DESIGN_SYSTEM_PRESETS = [
  carbonSystem,
  material3System,
  fluent2System,
  primerSystem,
  {
    id: "workbench",
    name: "Workbench",
    source: "starter",
    sourceLabel: "Tribe starter",
    description: "Quiet navy surfaces, compact controls and focused blue emphasis.",
    tokens: { canvas: "#111827", surface: "#182234", raised: "#202d42", text: "#e8edf5", muted: "#a0aec2", accent: "#6b9df7", line: "#42516a", focus: "#83c5ff", success: "#59d5a2", warning: "#ffb34d", danger: "#f07d7d", radius: "10px", spacing: "12px", fontSize: "14px", font: "Inter, ui-sans-serif, system-ui, sans-serif" },
    components: { button: "Use a clear primary action and quiet secondary actions.", card: "Keep distinct work areas open and lightly grouped.", input: "Use a visible focus ring and a single control border." },
    guidance: "Keep hierarchy clear through spacing and typography. Use accent colour for actions and focus, not decoration.",
    references: [],
  },
  {
    id: "field-notes",
    name: "Field Notes",
    source: "starter",
    sourceLabel: "Tribe starter",
    description: "Warm paper tones and measured typography for research-heavy tools.",
    tokens: { canvas: "#f2eee5", surface: "#fffdf8", raised: "#e8e1d4", text: "#24231f", muted: "#69665f", accent: "#53765f", line: "#c9c1b4", focus: "#42674d", success: "#3d714d", warning: "#9d681d", danger: "#a5443f", radius: "6px", spacing: "16px", fontSize: "15px", font: "Georgia, 'Times New Roman', serif" },
    components: { button: "Use restrained filled buttons for primary actions.", card: "Use paper surfaces to group related readings and metrics.", input: "Keep labels visible and controls quiet." },
    guidance: "Use measured typography and calm spacing. Preserve contrast for supporting text and interactive states.",
    references: [],
  },
  {
    id: "signal",
    name: "Signal",
    source: "starter",
    sourceLabel: "Tribe starter",
    description: "High-contrast neutral foundations with a sharp, energetic accent.",
    tokens: { canvas: "#171717", surface: "#242424", raised: "#303030", text: "#fafafa", muted: "#b0b0b0", accent: "#e6aa37", line: "#555555", focus: "#f3c45f", success: "#68c28d", warning: "#e6aa37", danger: "#ff7777", radius: "4px", spacing: "8px", fontSize: "14px", font: "Arial, Helvetica, sans-serif" },
    components: { button: "Use strong contrast and concise action labels.", card: "Separate metrics with spacing and surface changes.", input: "Make focus and current values easy to see." },
    guidance: "Prioritise readable contrast and efficient scanning. Reserve the bright accent for meaningful emphasis.",
    references: [],
  },
];

export const DESIGN_SYSTEM_VIEWPORTS = [
  { id: "wide", label: "Wide", width: 960 },
  { id: "tablet", label: "Tablet", width: 680 },
  { id: "mobile", label: "Mobile", width: 390 },
];

export const MAX_DESIGN_SYSTEM_IMPORT_BYTES = 8_000_000;
export const MAX_DESIGN_SYSTEM_SNAPSHOT_BYTES = 12_000_000;
export const MAX_DESIGN_SYSTEM_LIBRARY_BYTES = 80_000_000;
export const MAX_DESIGN_SYSTEM_LIBRARY_ITEMS = 200;
const MAX_DESIGN_SYSTEM_PACKAGE_ASSET_BYTES = 3_000_000;
const MAX_DESIGN_SYSTEM_PACKAGE_TEXT_FILE_BYTES = 1_000_000;
const DESIGN_SYSTEM_PACKAGE_CORE_PATHS = new Set(["manifest.json", "design-tokens.json", "tokens.css", "design.md", "usage.md", "components.html"]);
const PACKAGE_BINARY_MIME_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf",
};
export const DESIGN_SYSTEM_PALETTE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export function validateDesignSystemPackageFilePath(value, packageFiles = []) {
  const path = typeof value === "string" ? value.trim() : "";
  const segments = path.split("/");
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!path || path.length > 240 || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f<>:"|?*]/.test(path)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Use a relative package path without hidden folders or parent-directory segments.");
  }
  if (!/^(?:\.md|\.css|\.json|\.tokens|\.html|\.txt)$/i.test(extension) || DESIGN_SYSTEM_PACKAGE_CORE_PATHS.has(path.toLowerCase())) {
    throw new Error("Add a Markdown, CSS, DTCG token, JSON, HTML or text file. Core package files are managed above.");
  }
  if (packageFiles.some((file) => file.path.toLowerCase() === path.toLowerCase())) {
    throw new Error("A package file already uses that path.");
  }
  return path;
}

export function addDesignSystemPackageFile(system, path) {
  const manifest = system.manifest ? { ...system.manifest } : null;
  if (manifest && /\.html$/i.test(path) && manifest.files?.components !== path) {
    const preview = manifest.preview && typeof manifest.preview === "object" ? manifest.preview : {};
    const pages = Array.isArray(preview.pages) ? preview.pages : [];
    if (!pages.some((page) => page?.path === path)) {
      const filename = path.split("/").at(-1).replace(/\.html$/i, "").replace(/[._-]+/g, " ");
      manifest.preview = {
        ...preview,
        pages: [...pages, { path, title: filename || "Preview", role: "preview" }],
      };
    }
  }
  return {
    ...system,
    manifest,
    packageFiles: [
      ...system.packageFiles,
      { path, content: "" },
    ].map((file) => file.path === "manifest.json" && manifest
      ? { ...file, content: JSON.stringify(manifest, null, 2) }
      : file),
  };
}

function removeManifestPackagePath(value, path) {
  if (value === path) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value) && value.path === path) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => removeManifestPackagePath(item, path)).filter((item) => item !== undefined);
    if (items.length === value.length) return value;
    return items.length ? items : undefined;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, removeManifestPackagePath(item, path)])
    .filter(([, item]) => item !== undefined));
}

export function removeDesignSystemPackageFile(system, path) {
  if (DESIGN_SYSTEM_PACKAGE_CORE_PATHS.has(path.toLowerCase())) return system;
  const manifest = system.manifest ? removeManifestPackagePath(system.manifest, path) : null;
  return {
    ...system,
    manifest,
    packageFiles: system.packageFiles.filter((file) => file.path !== path).map((file) => file.path === "manifest.json" && manifest
      ? { ...file, content: JSON.stringify(manifest, null, 2) }
      : file),
  };
}

function designSystemPreviewThemeModel(system) {
  const styles = (system.packageFiles ?? [])
    .filter((file) => /\.(?:css|html)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  if (/\[\s*data-carbon-theme\s*=\s*["']?g100["']?\s*\]/i.test(styles)) {
    return { attribute: "data-carbon-theme", light: "white", dark: "g100", labels: ["White", "Gray 100"] };
  }
  for (const attribute of ["data-theme", "data-mode", "data-color-scheme"]) {
    if (new RegExp(`\\[\\s*${attribute}\\s*=\\s*[\\"']?(?:light|dark)[\\"']?\\s*\\]`, "i").test(styles)) {
      return { attribute, light: "light", dark: "dark", labels: ["Light", "Dark"] };
    }
  }
  if (/\.dark\b/i.test(styles)) return { className: "dark", light: "light", dark: "dark", labels: ["Light", "Dark"] };
  return null;
}

export function designSystemPreviewThemeOptions(system) {
  const model = designSystemPreviewThemeModel(system);
  return model ? [
    { label: model.labels[0], value: model.light },
    { label: model.labels[1], value: model.dark },
  ] : [];
}

export function designSystemPreviewThemeAttributes(system, theme) {
  const model = designSystemPreviewThemeModel(system);
  if (!model || ![model.light, model.dark].includes(theme)) return { attribute: "", className: "", value: "" };
  return { attribute: model.attribute ?? "", className: model.className ?? "", value: theme };
}

export function designSystemGuideHeadings(markdown) {
  if (typeof markdown !== "string") return [];
  const used = new Map();
  const headings = [];
  let fenceCharacter = "";
  let fenceWidth = 0;
  markdown.split("\n").forEach((line, index) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceWidth = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceWidth) {
        fenceCharacter = "";
        fenceWidth = 0;
      }
      return;
    }
    if (fenceCharacter) return;
    let depth = 0;
    while (line[depth] === "#") depth += 1;
    if ((depth !== 2 && depth !== 3) || (line[depth] !== " " && line[depth] !== "\t")) return;
    let headingText = line.slice(depth).trimEnd();
    let closingHashStart = headingText.length;
    while (closingHashStart > 0 && headingText[closingHashStart - 1] === "#") closingHashStart -= 1;
    if (closingHashStart < headingText.length && closingHashStart > 0 && (headingText[closingHashStart - 1] === " " || headingText[closingHashStart - 1] === "\t")) {
      headingText = headingText.slice(0, closingHashStart).trimEnd();
    }
    if (!headingText) return;
    let title = "";
    for (let position = 0; position < headingText.length;) {
      if (headingText[position] === "[") {
        const labelEnd = headingText.indexOf("]", position + 1);
        const destinationEnd = labelEnd >= 0 && headingText[labelEnd + 1] === "("
          ? headingText.indexOf(")", labelEnd + 2)
          : -1;
        if (destinationEnd >= 0) {
          title += headingText.slice(position + 1, labelEnd);
          position = destinationEnd + 1;
          continue;
        }
      }
      title += headingText[position];
      position += 1;
    }
    title = title.replace(/[`*_~]/g, "").trim();
    const base = title.toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `section-${index + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    headings.push({ depth, id: `design-guide-${base}${count > 1 ? `-${count}` : ""}`, line: index + 1, title });
  });
  return headings;
}

export function compareDesignSystemSnapshots(previous, current) {
  const previousTokens = previous?.tokens ?? {};
  const currentTokens = current?.tokens ?? {};
  const tokenChanges = [...new Set([...Object.keys(previousTokens), ...Object.keys(currentTokens)])]
    .filter((key) => JSON.stringify(previousTokens[key]) !== JSON.stringify(currentTokens[key]))
    .map((key) => ({ key, previous: previousTokens[key] ?? "Not set", current: currentTokens[key] ?? "Not set" }));
  const previousFiles = new Map((previous?.packageFiles ?? []).map(({ path, content }) => [path, content]));
  const currentFiles = new Map((current?.packageFiles ?? []).map(({ path, content }) => [path, content]));
  const packageChanges = [...new Set([...previousFiles.keys(), ...currentFiles.keys()])]
    .filter((path) => previousFiles.get(path) !== currentFiles.get(path))
    .map((path) => ({ path, change: !previousFiles.has(path) ? "Added" : !currentFiles.has(path) ? "Removed" : "Changed" }));
  return { tokenChanges, packageChanges };
}

function linearise(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function delinearise(channel) {
  const value = Math.max(0, Math.min(1, channel));
  return value <= 0.0031308 ? value * 12.92 : 1.055 * (value ** (1 / 2.4)) - 0.055;
}

function hexToOklab(hex) {
  if (typeof hex !== "string" || !/^#[\da-f]{6}$/i.test(hex)) return null;
  const channels = [1, 3, 5].map((index) => linearise(Number.parseInt(hex.slice(index, index + 2), 16)));
  const [r, g, b] = channels;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function oklchHex(L, chroma, hue) {
  const radians = hue * (Math.PI / 180);
  let low = 0;
  let high = Math.max(0, chroma);
  let rgb = oklabToRgb({ L, a: high * Math.cos(radians), b: high * Math.sin(radians) });
  if (rgb.some((channel) => channel < 0 || channel > 1)) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const middle = (low + high) / 2;
      const candidate = oklabToRgb({ L, a: middle * Math.cos(radians), b: middle * Math.sin(radians) });
      if (candidate.every((channel) => channel >= 0 && channel <= 1)) {
        low = middle;
        rgb = candidate;
      } else high = middle;
    }
  }
  return `#${rgb.map((channel) => Math.round(delinearise(channel) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function contrastRatio(first, second) {
  function luminance(hex) {
    if (typeof hex !== "string" || !/^#[\da-f]{6}$/i.test(hex)) return 0;
    const rgb = [1, 3, 5].map((index) => linearise(Number.parseInt(hex.slice(index, index + 2), 16)));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function generateColourScale(seed) {
  const lab = hexToOklab(seed);
  if (!lab) throw new Error("Choose a six-digit hex colour to generate a scale.");
  const chroma = Math.hypot(lab.a, lab.b);
  const hue = Math.atan2(lab.b, lab.a) * (180 / Math.PI);
  const lightness = [0.9, 0.8, 0.6, 0.4, 0.2].map((amount) => lab.L + (1 - lab.L) * amount);
  lightness.push(lab.L, ...[0.9, 0.78, 0.62, 0.42, 0.2].map((amount) => lab.L * amount));
  return DESIGN_SYSTEM_PALETTE_STEPS.map((step, index) => ({
    step,
    color: index === 5 ? seed.toLowerCase() : oklchHex(lightness[index], chroma, hue),
  }));
}

export function generateDesignPalettes(tokens) {
  return {
    brand: generateColourScale(tokens.accent),
    neutral: generateColourScale(tokens.muted),
    success: generateColourScale(tokens.success),
    warning: generateColourScale(tokens.warning),
    danger: generateColourScale(tokens.danger),
  };
}

export function parseDesignSystemImport(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Choose a valid design-system JSON file.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose a valid design-system JSON file.");
  }
  const portable = { ...value };
  delete portable.id;
  delete portable.version;
  delete portable.source;
  delete portable.sourceLabel;
  const paletteSeeds = ["accent", "line", "success", "warning", "danger"];
  if (!portable.tokens || !paletteSeeds.every((key) =>
    typeof portable.tokens[key] === "string" && /^#[\da-f]{6}$/i.test(portable.tokens[key]))) {
    throw new Error("Choose a valid design-system JSON file.");
  }
  return {
    ...portable,
    palettes: Object.keys(portable.palettes ?? {}).length
      ? portable.palettes
      : generateDesignPalettes(portable.tokens ?? {}),
    source: "user",
    version: 1,
  };
}

function packageCssValues(css) {
  const values = {};
  for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;{}]+)\s*;/g)) {
    const name = match[1].toLowerCase();
    if (!(name in values)) values[name] = match[2].trim();
  }
  return values;
}

export function packageDesignTokenFile(packageFiles) {
  const conventional = packageFiles.find((file) => file.path === "design-tokens.json");
  const standardCandidates = packageFiles.filter((file) => /(?:^|\/)design[-_.]?tokens?\.tokens(?:\.json)?$/i.test(file.path)
    || /(?:^|\/)[^/]+\.tokens(?:\.json)?$/i.test(file.path));
  const standard = standardCandidates.find((file) => /(?:^|\/)design[-_.]?tokens?\.tokens(?:\.json)?$/i.test(file.path))
    ?? (standardCandidates.length === 1 ? standardCandidates[0] : undefined);
  const manifestFile = packageFiles.find((file) => file.path === "manifest.json");
  if (!manifestFile) return conventional ?? standard;
  try {
    const manifest = JSON.parse(manifestFile.content);
    const declared = manifest?.files?.designTokens ?? manifest?.files?.design_tokens ?? manifest?.designTokens;
    if (typeof declared === "string") {
      const file = packageFiles.find((item) => item.path === declared);
      if (file) return file;
    }
  } catch {
    // A malformed manifest remains visible to the user and cannot redirect token exports.
  }
  return conventional ?? standard;
}

export function designSystemExportMetadata(system) {
  const source = system.sourceUrl ?? system.references?.[0]?.url
    ?? system.manifest?.source?.url ?? system.manifest?.source?.origin ?? "";
  return {
    name: system.name,
    version: system.packageVersion ?? system.manifest?.version ?? system.version ?? 1,
    source,
    license: system.license ?? system.manifest?.license ?? "Licence not declared",
    attribution: system.attribution ?? system.manifest?.attribution ?? "",
  };
}

function designSystemTokenStylesheet(system) {
  const packaged = system.packageFiles?.find(({ path }) => path === "tokens.css")?.content;
  if (typeof packaged === "string" && packaged.trim()) return packaged;
  const declarations = Object.entries(system.tokens ?? {}).map(([key, value]) => {
    const name = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return `  --tribe-${name}: ${value};`;
  });
  return declarations.length ? `:root {\n${declarations.join("\n")}\n}\n` : "";
}

export function designSystemTokenCss(system) {
  const metadata = designSystemExportMetadata(system);
  const safeComment = (value) => String(value).replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /");
  const source = [metadata.source && `Source: ${metadata.source}`, `Licence: ${metadata.license}`, metadata.attribution && `Attribution: ${metadata.attribution}`]
    .filter(Boolean).map(safeComment).join("\n * ");
  return `/* ${safeComment(metadata.name)} · v${safeComment(metadata.version)}\n * ${source}\n */\n${designSystemTokenStylesheet(system)}`;
}

export function designSystemTokenJson(system) {
  const metadata = designSystemExportMetadata(system);
  const file = packageDesignTokenFile(system.packageFiles ?? []);
  let document;
  try { document = file ? JSON.parse(file.content) : { tokens: system.tokens }; }
  catch { document = { tokens: system.tokens }; }
  const extensions = document.$extensions && typeof document.$extensions === "object" && !Array.isArray(document.$extensions)
    ? document.$extensions
    : {};
  const tribeExtension = extensions["com.tribe.design-system"] && typeof extensions["com.tribe.design-system"] === "object"
    && !Array.isArray(extensions["com.tribe.design-system"])
    ? extensions["com.tribe.design-system"]
    : {};
  return `${JSON.stringify({
    ...document,
    $extensions: {
      ...extensions,
      "com.tribe.design-system": { ...tribeExtension, provenance: metadata },
    },
  }, null, 2)}\n`;
}

export function extractStaticThemeDeclarations(source) {
  const code = String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const declarations = [];
  const property = /(?:^|[,{]\s*)(?:([A-Za-z_$][\w$-]*)|["']([A-Za-z_$][\w$-]*)["'])\s*:\s*(["'])([^\r\n]*?)\3(?=\s*[,}])/gm;
  const tokenName = /(?:color|background|^bg$|surface|foreground|^fg$|text|accent|primary|secondary|brand|success|warning|danger|error|muted|border|ring|focus|radius|spacing|^space$|gap|font|shadow|elevation|breakpoint)/i;
  const colour = /^(?:#[\da-f]{3,8}|(?:rgb|hsl|hwb|oklch|oklab|color)\([^{};]+\)|var\(--[\w-]+(?:\s*,\s*[^{};]+)?\))$/i;
  const dimension = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|s|ms|deg|vh|vw)$/i;
  const fontFamily = /^[\w ,.'"-]{1,120}$/;
  for (const match of code.matchAll(property)) {
    const name = match[1] ?? match[2];
    const value = match[4].trim();
    const isFont = /font|typeface|^(?:sans|serif|mono|display|body|heading)$/i.test(name);
    if (!value || value.length > 160 || /[\x00-\x1f;{}]/.test(value)) continue;
    if (!colour.test(value) && !dimension.test(value) && !(isFont && fontFamily.test(value))) continue;
    if (!tokenName.test(name) && !dimension.test(value) && !(isFont && fontFamily.test(value))) continue;
    declarations.push({
      name: /^(?:sans|serif|mono)$/i.test(name) ? `font-${name.toLowerCase()}` : name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
      value,
    });
  }
  return declarations;
}

function packageDesignTokenPaths(packageFiles) {
  const paths = new Set(["design-tokens.json"]);
  const declared = packageDesignTokenFile(packageFiles);
  if (declared) paths.add(declared.path);
  return paths;
}

export function packageTokensFromCss(css, fallback) {
  const vars = packageCssValues(css);
  const resolve = (value, seen = new Set()) => {
    const alias = value?.match(/^var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)$/i);
    if (!alias) return value;
    const name = alias[1].toLowerCase();
    if (seen.has(name)) return value;
    const next = vars[name] ?? alias[2];
    return next ? resolve(next, new Set([...seen, name])) : value;
  };
  const choose = (...names) => names.map((name) => resolve(vars[name])).find(Boolean);
  const safeColour = (value, otherwise) => {
    const hex = value?.match(/^#[\da-f]{3}(?:[\da-f]{3})?$/i)?.[0];
    if (hex) return hex.length === 4 ? `#${[...hex.slice(1)].map((part) => part + part).join("")}` : hex;
    const rgb = value?.match(/^rgba?\(\s*(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/i);
    return rgb ? `#${rgb.slice(1).map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0")).join("")}` : otherwise;
  };
  const safePx = (value, otherwise, min, max) => {
    const number = Number(value?.match(/^(\d+(?:\.\d+)?)px$/)?.[1]);
    return Number.isFinite(number) && number >= min && number <= max ? `${Math.round(number)}px` : otherwise;
  };
  const font = choose("font-body", "font-sans", "font-family")
    ?.replace(/"/g, "'")
    .replace(/[^A-Za-z0-9 ,_'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const accent = safeColour(choose("accent", "accent-hover", "primary", "color-primary", "color-accent", "accent-color"), fallback.accent);
  const rgb = (hex) => /^#[\da-f]{6}$/i.test(hex ?? "")
    ? [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
    : [0, 0, 0];
  const toHex = (channels) => `#${channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
  const mix = (first, second, amount) => toHex(rgb(first).map((channel, index) => channel * (1 - amount) + rgb(second)[index] * amount));
  const luminance = (hex) => {
    const linear = rgb(hex).map((channel) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (first, second) => {
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  const canvas = safeColour(choose("bg", "background", "canvas", "color-background", "color-canvas", "background-color"), fallback.canvas);
  const darkCanvas = luminance(canvas) < 0.2;
  const textCandidate = safeColour(choose("fg", "foreground", "text", "color-text", "color-foreground", "foreground-color"), "");
  const text = textCandidate || (contrast(fallback.text, canvas) >= 4.5 ? fallback.text : darkCanvas ? "#f4f7fb" : "#161616");
  const surfaceCandidate = safeColour(choose("surface", "surface-1", "color-surface", "surface-color", "background-surface"), "");
  const surface = surfaceCandidate || (darkCanvas && luminance(fallback.surface) > 0.65
    ? mix(canvas, "#ffffff", 0.08)
    : !darkCanvas && luminance(fallback.surface) < 0.12 ? mix(canvas, "#000000", 0.04) : fallback.surface);
  const raisedCandidate = safeColour(choose("surface-warm", "surface-raised", "raised", "surface-2", "color-surface-raised"), "");
  const raised = raisedCandidate || (darkCanvas && luminance(fallback.raised) > 0.65
    ? mix(surface, "#ffffff", 0.16)
    : !darkCanvas && luminance(fallback.raised) < 0.12 ? mix(surface, "#000000", 0.06) : fallback.raised);
  const mutedCandidate = safeColour(choose("muted", "fg-muted", "fg-2", "text-muted", "color-text-muted", "color-muted", "text-secondary"), "");
  const muted = mutedCandidate || (contrast(fallback.muted, canvas) >= 3 ? fallback.muted : darkCanvas ? "#aebdce" : "#525252");
  const lineCandidate = safeColour(choose("border", "line", "border-color"), "");
  const line = lineCandidate || (darkCanvas && luminance(fallback.line) > 0.4
    ? mix(canvas, text, 0.24)
    : !darkCanvas && luminance(fallback.line) < 0.12 ? mix(canvas, text, 0.28) : fallback.line);
  return {
    canvas,
    surface,
    raised,
    text,
    muted,
    accent,
    line,
    focus: safeColour(choose("focus", "colorstrokefocus1", "cds-focus", "md-sys-color-primary", "accent-hover", "accent", "color-accent"), accent),
    success: safeColour(choose("success", "positive", "color-success"), fallback.success),
    warning: safeColour(choose("warn", "warning", "caution", "color-warning"), fallback.warning),
    danger: safeColour(choose("danger", "error", "negative", "color-danger", "color-error"), fallback.danger),
    radius: safePx(choose("radius-sm", "radius", "border-radius"), fallback.radius, 0, 32),
    spacing: safePx(choose("space-4", "spacing", "space-md", "spacing-medium", "space-medium"), fallback.spacing, 2, 32),
    fontSize: safePx(choose("text-base", "font-size-base", "font-size"), fallback.fontSize, 12, 20),
    font: font || fallback.font,
  };
}

export function packageTokenInventory(packageFiles) {
  const css = packageFiles?.find((file) => file.path === "tokens.css")?.content ?? "";
  const groups = new Map([
    ["Colour", []], ["Typography", []], ["Spacing and layout", []],
    ["Surfaces and elevation", []], ["Motion", []], ["Other foundations", []],
  ]);
  for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;{}]+)\s*;/g)) {
    const name = `--${match[1]}`;
    const value = match[2].trim();
    const key = name.toLowerCase();
    const looksLikeColour = /^#|^(?:rgb|hsl|hwb|oklch|oklab|color)\(/i.test(value) || /^var\(--(?:color|bg|fg|surface|accent|border|success|warning|danger|error|muted)/i.test(value);
    const group = looksLikeColour || /(?:^|[-])(color|bg|fg|text|surface|accent|success|warning|danger|error|muted|brand|link)(?:[-]|$)/.test(key)
      ? "Colour"
      : /font|type|line-height|letter|text-size/.test(key)
        ? "Typography"
        : /space|spacing|gap|grid|container|breakpoint|gutter|width|height|size/.test(key)
          ? "Spacing and layout"
          : /shadow|elev|radius|border/.test(key)
            ? "Surfaces and elevation"
            : /motion|duration|ease|transition|animation/.test(key)
              ? "Motion"
              : "Other foundations";
    groups.get(group).push({ name, value, colour: group === "Colour" && (/^#|^(?:rgb|hsl|hwb|oklch|oklab|color)\(/i.test(value) || /^var\(--[\w-]+\)$/.test(value)) });
  }
  return [...groups].filter(([, items]) => items.length).map(([name, items]) => ({ name, items }));
}

function isLicenceOrNoticeFile(path) {
  return /(^|\/)(?:licen[cs]e|notice|copying|copyright)(?:[-_.][a-z0-9.-]+)?$/i.test(path);
}

function packageFileExtension(path) {
  return path.split(".").at(-1).toLowerCase();
}

function packageFileIsSupported(path) {
  return ["md", "css", "json", "tokens", "html", "txt", "svg"].includes(packageFileExtension(path)) ||
    PACKAGE_BINARY_MIME_TYPES[packageFileExtension(path)] || isLicenceOrNoticeFile(path);
}

async function packageFileContent(file, path) {
  const mimeType = PACKAGE_BINARY_MIME_TYPES[packageFileExtension(path)];
  if (!mimeType) return file.text();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export async function parseDesignSystemPackage(files, base = DESIGN_SYSTEM_PRESETS[0]) {
  if (!Array.isArray(files) || !files.length) throw new Error("Choose an OpenDesign-style package folder.");
  const supported = files.filter((file) => {
    const path = String(file.webkitRelativePath || file.name || "");
    const relative = path.split("/").slice(1).join("/") || file.name;
    return relative && !relative.startsWith("/") && !relative.split("/").some((part) => part === ".." || part.startsWith(".")) &&
      packageFileIsSupported(relative);
  });
  const oversized = supported.find((file) => file.size > (PACKAGE_BINARY_MIME_TYPES[packageFileExtension(file.webkitRelativePath || file.name || "")]
    ? MAX_DESIGN_SYSTEM_PACKAGE_ASSET_BYTES
    : MAX_DESIGN_SYSTEM_PACKAGE_TEXT_FILE_BYTES));
  if (oversized) throw new Error(`${oversized.name} is larger than the supported per-file limit.`);
  const total = supported.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_DESIGN_SYSTEM_IMPORT_BYTES) throw new Error("This package is larger than 8 MB of supported files.");
  const packageFiles = await Promise.all(supported.map(async (file) => {
    const parts = String(file.webkitRelativePath || file.name).split("/");
    const path = parts.length > 1 ? parts.slice(1).join("/") : file.name;
    return { path, content: await packageFileContent(file, path) };
  }));
  const byPath = Object.fromEntries(packageFiles.map(({ path, content }) => [path, content]));
  if (!byPath["manifest.json"] || !byPath["DESIGN.md"] || !byPath["tokens.css"]) {
    throw new Error("This folder needs manifest.json, DESIGN.md and tokens.css.");
  }
  let manifest;
  try { manifest = JSON.parse(byPath["manifest.json"]); } catch { throw new Error("The package manifest is not valid JSON."); }
  const tokens = packageTokensFromCss(byPath["tokens.css"], base.tokens);
  const sourceInfo = manifest.source && typeof manifest.source === "object" ? manifest.source : {};
  const sourceUrl = [sourceInfo.url, sourceInfo.repository, manifest.sourceUrl]
    .find((candidate) => typeof candidate === "string" && /^https?:\/\//i.test(candidate)) ?? "";
  const licenseFile = packageFiles.find(({ path }) => isLicenceOrNoticeFile(path));
  return {
    name: String(manifest.name ?? "Imported design system").slice(0, 100),
    description: String(manifest.description ?? "Imported portable design-system package").slice(0, 500),
    source: "user",
    version: 1,
    tokens,
    palettes: generateDesignPalettes(tokens),
    components: { button: "", card: "", input: "" },
    guidance: byPath["USAGE.md"] ?? "",
    references: [],
    category: String(manifest.category ?? "Imported").slice(0, 80),
    tags: Array.isArray(manifest.tags) ? manifest.tags.filter((tag) => typeof tag === "string").slice(0, 40) : [],
    license: String(manifest.license ?? (licenseFile ? `See included ${licenseFile.path.split("/").at(-1)}` : "Licence not declared in package")).slice(0, 200),
    sourceLabel: typeof sourceInfo.origin === "string" ? sourceInfo.origin.slice(0, 120) : typeof sourceInfo.name === "string" ? sourceInfo.name.slice(0, 120) : "Imported package",
    attribution: (byPath["source/evidence.md"] ?? "").slice(0, 1000),
    sourceUrl,
    packageVersion: String(manifest.version ?? ""),
    manifest,
    packageFiles,
  };
}

export async function parseDesignSystemPackageLibrary(files, base = DESIGN_SYSTEM_PRESETS[0]) {
  if (!Array.isArray(files) || !files.length) throw new Error("Choose a design-system package folder.");
  const supported = files.filter((file) => {
    const path = String(file.webkitRelativePath || file.name || "");
    return packageFileIsSupported(path);
  });
  if (supported.reduce((sum, file) => sum + file.size, 0) > MAX_DESIGN_SYSTEM_LIBRARY_BYTES) {
    throw new Error("This design-system library is larger than 80 MB of supported files.");
  }
  const manifests = supported.filter((file) => (file.webkitRelativePath || file.name).split("/").at(-1) === "manifest.json");
  if (!manifests.length) throw new Error("No package manifest.json files were found.");
  if (manifests.length > MAX_DESIGN_SYSTEM_LIBRARY_ITEMS) {
    throw new Error(`This folder contains more than ${MAX_DESIGN_SYSTEM_LIBRARY_ITEMS} packages.`);
  }
  const groups = manifests.map((manifestFile) => {
    const manifestPath = String(manifestFile.webkitRelativePath || manifestFile.name);
    const prefix = manifestPath.slice(0, -"manifest.json".length);
    const root = prefix.replace(/\/$/, "").split("/").at(-1) || "package";
    const group = supported.filter((file) => (file.webkitRelativePath || file.name).startsWith(prefix));
    return group.map((file) => {
      const relative = (file.webkitRelativePath || file.name).slice(prefix.length);
      return {
        name: relative.split("/").at(-1),
        webkitRelativePath: `${root}/${relative}`,
        size: file.size,
        text: () => file.text(),
        arrayBuffer: () => file.arrayBuffer(),
      };
    });
  });
  const systems = [];
  for (const group of groups) systems.push(await parseDesignSystemPackage(group, base));
  return systems;
}

export function syncPackageTokens(packageFiles, tokens, { syncStylesheet = true } = {}) {
  if (!Array.isArray(packageFiles)) return packageFiles;
  const designTokenPaths = packageDesignTokenPaths(packageFiles);
  const bindings = {
    canvas: ["colorneutralbackground1", "cds-background", "md-sys-color-surface", "bgcolor-default", "bg", "background", "canvas", "color-background", "color-canvas", "background-color"],
    surface: ["colorneutralbackground2", "cds-layer-01", "md-sys-color-surface-container", "bgcolor-muted", "surface", "surface-1", "color-surface", "surface-color", "background-surface"],
    raised: ["colorneutralbackground3", "cds-layer-02", "md-sys-color-surface-container-high", "bgcolor-inset", "surface-raised", "raised", "surface-2", "color-surface-raised"],
    text: ["colorneutralforeground1", "cds-text-primary", "md-sys-color-on-surface", "fgcolor-default", "fg", "foreground", "text", "color-text", "color-foreground", "foreground-color"],
    muted: ["colorneutralforeground2", "cds-text-secondary", "md-sys-color-on-surface-variant", "fgcolor-muted", "muted", "fg-muted", "fg-2", "text-muted", "color-text-muted", "color-muted", "text-secondary"],
    accent: ["colorbrandbackground", "cds-interactive", "md-sys-color-primary", "bgcolor-accent-emphasis", "accent", "primary", "color-primary", "color-accent", "accent-color"],
    line: ["colorneutralstroke1", "cds-border-subtle-01", "md-sys-color-outline", "bordercolor-default", "border", "line", "border-color"],
    focus: ["colorstrokefocus1", "cds-focus", "md-sys-color-primary", "focus"],
    success: ["colorstatussuccessforeground1", "cds-support-success", "md-sys-color-success", "fgcolor-success", "success", "positive", "color-success"],
    warning: ["colorstatuswarningforeground1", "cds-support-warning", "md-sys-color-warning", "fgcolor-attention", "warn", "warning", "caution", "color-warning"],
    danger: ["colorstatusdangerforeground1", "cds-support-error", "md-sys-color-error", "fgcolor-danger", "danger", "error", "negative", "color-danger", "color-error"],
    radius: ["borderradiusmedium", "cds-radius-control", "md-sys-shape-corner-medium", "border-radius", "radius-sm", "radius"],
    spacing: ["spacinghorizontall", "cds-spacing-05", "md-sys-spacing-unit", "spacing", "space-4", "space-md", "spacing-medium", "space-medium"],
    fontSize: ["fontsizebase300", "cds-body-compact-01-size", "md-sys-typescale-body-large-size", "font-size-base", "text-base", "font-size"],
    font: ["fontfamilybase", "cds-font-sans", "md-ref-typeface-plain", "font-body", "font-sans", "font-family", "typeface", "font-family-base"],
  };
  const syncedFiles = packageFiles.map((file) => {
    if (file.path !== "tokens.css" || !syncStylesheet) return file;
    let content = file.content;
    for (const [token, names] of Object.entries(bindings)) {
      for (const name of names) {
        const declaration = new RegExp(`(--${name}\\s*:\\s*)([^;{}]+)(;)`, "i");
        if (declaration.test(content)) {
          content = content.replace(declaration, `$1${tokens[token]}$3`);
          break;
        }
      }
    }
    return { ...file, content };
  });
  const stylesheet = syncedFiles.find((file) => file.path === "tokens.css")?.content ?? "";
  const cssValues = packageCssValues(stylesheet);
  const resolveCssAlias = (value, seen = new Set()) => {
    const alias = typeof value === "string" ? value.match(/^var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)$/i) : null;
    if (!alias || seen.has(alias[1].toLowerCase())) return value;
    const key = alias[1].toLowerCase();
    const next = cssValues[key] ?? alias[2]?.trim();
    return next ? resolveCssAlias(next, new Set([...seen, key])) : value;
  };
  const semanticValues = Object.fromEntries(Object.entries(bindings).map(([token, names]) => [token,
    names.map((name) => resolveCssAlias(cssValues[name])).find(Boolean) ?? tokens[token],
  ]));
  const normalisePathPart = (part) => String(part).replace(/^--/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const explicitPaths = [
    [["text", "primary"], "text"], [["foreground", "primary"], "text"],
    [["text", "secondary"], "muted"], [["foreground", "secondary"], "muted"],
    [["surface", "container", "high"], "raised"], [["surface", "container"], "surface"],
    [["surface", "raised"], "raised"], [["background", "default"], "canvas"],
  ];
  const semanticForDtcgPath = (path) => {
    const parts = path.flatMap(normalisePathPart);
    const explicit = explicitPaths.find(([suffix]) => suffix.every((part, index) => parts.at(-suffix.length + index) === part));
    if (explicit) return explicit[1];
    const compactPath = parts.join("");
    const matches = [];
    for (const [semantic, names] of Object.entries(bindings)) {
      for (const name of names) {
        const alias = normalisePathPart(name);
        const compactAlias = alias.join("");
        if (alias.length && (alias.every((part, index) => parts.at(-alias.length + index) === part)
          || (compactAlias.length >= 4 && compactPath.endsWith(compactAlias)))) {
          matches.push({ semantic, size: alias.length });
        }
      }
    }
    const longest = Math.max(0, ...matches.map((match) => match.size));
    const semantics = [...new Set(matches.filter((match) => match.size === longest).map((match) => match.semantic))];
    return semantics.length === 1 ? semantics[0] : null;
  };
  const updateDtcgTree = (value, path = []) => {
    if (Array.isArray(value)) return value.map((item, index) => updateDtcgTree(item, [...path, String(index)]));
    if (!value || typeof value !== "object") return value;
    const semantic = semanticForDtcgPath(path);
    const next = semantic ? semanticValues[semantic] : undefined;
    const updated = { ...value };
    const isAlias = (candidate) => typeof candidate === "string" && /^\{[^{}]+\}$/.test(candidate.trim());
    const syncDimension = (current) => {
      const size = typeof next === "string" ? next.match(/^(\d+(?:\.\d+)?)px$/) : null;
      return size && current && typeof current === "object" && current.unit === "px" && typeof current.value === "number"
        ? { ...current, value: Number(size[1]) }
        : current;
    };
    if (typeof updated.$value === "string" && next !== undefined && !isAlias(updated.$value)) updated.$value = next;
    else if (typeof updated.$value === "object" && updated.$value?.colorSpace === "srgb"
      && Array.isArray(updated.$value.components) && /^#[\da-f]{6}$/i.test(next ?? "")) {
      const channels = [1, 3, 5].map((index) => Number.parseInt(next.slice(index, index + 2), 16) / 255);
      updated.$value = { ...updated.$value, components: [...channels, ...updated.$value.components.slice(3)] };
    } else if (updated.$value && typeof updated.$value === "object") updated.$value = syncDimension(updated.$value);
    if (typeof updated.value === "string" && next !== undefined && !isAlias(updated.value)) updated.value = next;
    else if (typeof updated.value === "object" && updated.value?.colorSpace === "srgb"
      && Array.isArray(updated.value.components) && /^#[\da-f]{6}$/i.test(next ?? "")) {
      const channels = [1, 3, 5].map((index) => Number.parseInt(next.slice(index, index + 2), 16) / 255);
      updated.value = { ...updated.value, components: [...channels, ...updated.value.components.slice(3)] };
    } else if (updated.value && typeof updated.value === "object") updated.value = syncDimension(updated.value);
    for (const [key, item] of Object.entries(updated)) {
      if (key === "$value" || key === "value") continue;
      updated[key] = updateDtcgTree(item, [...path, key]);
    }
    return updated;
  };
  const applyDirectTokenValue = (item, next) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const updated = { ...item };
    const replace = (current) => {
      if (typeof current === "string") return /^\{[^{}]+\}$/.test(current.trim()) ? current : next;
      if (current?.colorSpace === "srgb" && Array.isArray(current.components) && /^#[\da-f]{6}$/i.test(next ?? "")) {
        const channels = [1, 3, 5].map((index) => Number.parseInt(next.slice(index, index + 2), 16) / 255);
        return { ...current, components: [...channels, ...current.components.slice(3)] };
      }
      const size = typeof next === "string" ? next.match(/^(\d+(?:\.\d+)?)px$/) : null;
      if (size && current?.unit === "px" && typeof current.value === "number") return { ...current, value: Number(size[1]) };
      return current;
    };
    if ("$value" in updated) updated.$value = replace(updated.$value);
    else if ("value" in updated) updated.value = replace(updated.value);
    return updated;
  };
  return syncedFiles.map((file) => {
    if (!designTokenPaths.has(file.path)) return file;
    try {
      const document = JSON.parse(file.content);
      if (Array.isArray(document.tokens)) {
        document.tokens = document.tokens.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item;
          const rawName = String(item.name ?? item.sourceName ?? item.path ?? "").replace(/^--/, "");
          const name = rawName.toLowerCase();
          const direct = resolveCssAlias(cssValues[name]);
          const path = rawName.split(/[./\s]+/).filter(Boolean);
          const updated = updateDtcgTree(item, path);
          return direct === undefined ? updated : applyDirectTokenValue(updated, direct);
        });
      } else if (document.tokens && typeof document.tokens === "object" && !Array.isArray(document.tokens)) {
        document.tokens = Object.fromEntries(Object.entries(document.tokens).map(([name, value]) => {
          const semantic = name.replace(/^--/, "").toLowerCase();
          const next = semanticValues[semantic] ?? resolveCssAlias(cssValues[semantic]);
          if (value && typeof value === "object") return [name, updateDtcgTree(value, ["tokens", name])];
          return [name, next === undefined ? value : next];
        }));
      } else {
        Object.assign(document, updateDtcgTree(document));
      }
      return { ...file, content: JSON.stringify(document, null, 2) };
    } catch {
      return file;
    }
  });
}

function colour(value, fallback) {
  if (typeof value !== "string") return fallback;
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((part) => part + part).join("") : hex[1];
    return `#${digits.toLowerCase()}`;
  }
  const rgb = value.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\)$/i);
  if (!rgb || (rgb[4] && Number.parseFloat(rgb[4]) < 0.95)) return fallback;
  const channels = rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))));
  if (channels.some((part) => !Number.isFinite(part))) return fallback;
  return `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function rankedColour(items, fallback, { distinctFrom = [] } = {}) {
  for (const item of items ?? []) {
    const candidate = colour(item?.value, "");
    if (candidate && !distinctFrom.includes(candidate)) return candidate;
  }
  return fallback;
}

function rankedNumber(items, fallback, { min = 0, max = 96 } = {}) {
  for (const item of items ?? []) {
    const match = String(item?.value ?? "").match(/^(\d{1,2})px$/);
    if (match && Number(match[1]) >= min && Number(match[1]) <= max) return `${Number(match[1])}px`;
  }
  return fallback;
}

function rankedFont(items, fallback) {
  for (const item of items ?? []) {
    const candidate = typeof item?.value === "string"
      ? item.value.replace(/[\x00-\x1f;{}<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
      : "";
    if (candidate && /^[A-Za-z0-9 ,_'\-]{1,120}$/.test(candidate)) return candidate;
  }
  return fallback;
}

export function designSystemFromReference(reference, base = DESIGN_SYSTEM_PRESETS[0]) {
  if (!reference || typeof reference !== "object" || typeof reference.url !== "string") {
    throw new Error("Choose a captured browser reference first.");
  }
  let source;
  try { source = new URL(reference.url); } catch { throw new Error("The captured reference URL is invalid."); }
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    throw new Error("The captured reference URL is invalid.");
  }
  source.search = "";
  source.hash = "";
  const tokens = { ...base.tokens };
  const backgrounds = reference.backgrounds ?? [];
  tokens.canvas = rankedColour(backgrounds, tokens.canvas);
  tokens.surface = rankedColour(backgrounds, tokens.surface, { distinctFrom: [tokens.canvas] });
  tokens.raised = rankedColour(backgrounds, tokens.raised, { distinctFrom: [tokens.canvas, tokens.surface] });
  tokens.text = rankedColour(reference.foregrounds ?? [], tokens.text);
  tokens.muted = rankedColour(reference.foregrounds ?? [], tokens.muted, { distinctFrom: [tokens.text] });
  tokens.accent = rankedColour(reference.links ?? [], "", { distinctFrom: [tokens.canvas, tokens.surface, tokens.raised, tokens.text] })
    || rankedColour(reference.controls ?? [], tokens.accent, { distinctFrom: [tokens.canvas, tokens.surface, tokens.raised, tokens.text] });
  tokens.line = rankedColour(reference.borders ?? [], tokens.line);
  tokens.focus = tokens.accent;
  tokens.radius = rankedNumber(reference.radii ?? [], tokens.radius, { min: 0, max: 32 });
  tokens.spacing = rankedNumber(reference.spacing ?? [], tokens.spacing, { min: 4, max: 32 });
  tokens.fontSize = rankedNumber(reference.fontSizes ?? [], tokens.fontSize, { min: 12, max: 20 });
  tokens.font = rankedFont(reference.fonts ?? [], tokens.font);
  const host = source.hostname;
  const buttonCount = Math.min(8, reference.buttons?.length ?? 0);
  const inputCount = Math.min(8, reference.inputs?.length ?? 0);
  const evidence = [
    ["Backgrounds", reference.backgrounds], ["Text colours", reference.foregrounds],
    ["Links", reference.links], ["Fonts", reference.fonts], ["Type sizes", reference.fontSizes],
    ["Spacing", reference.spacing], ["Corner radii", reference.radii],
  ].flatMap(([label, values]) => {
    const samples = (values ?? []).slice(0, 3).map((item) => `${item.value} (${item.count ?? 0} samples)`);
    return samples.length ? [`${label}: ${samples.join(", ")}`] : [];
  });
  const observationGroups = [
    ["Backgrounds", reference.backgrounds], ["Text colours", reference.foregrounds],
    ["Links", reference.links], ["Controls", reference.controls], ["Borders", reference.borders],
    ["Fonts", reference.fonts], ["Type sizes", reference.fontSizes],
    ["Spacing", reference.spacing], ["Corner radii", reference.radii],
  ];
  const observations = observationGroups.flatMap(([group, values]) => (values ?? [])
    .slice(0, 12)
    .filter((item) => typeof item?.value === "string" && item.value.length <= 200)
    .map((item) => ({ group, value: item.value, samples: Math.max(0, Math.min(100_000, Number(item.count) || 0)) })));
  const inferenceSources = {
    canvas: "Most frequent visible background candidate",
    surface: "Next distinct visible background candidate",
    raised: "Next distinct visible background candidate",
    text: "Most frequent visible foreground candidate",
    muted: "Next distinct visible foreground candidate",
    accent: "Visible link or control colour candidate",
    line: "Most frequent visible border candidate",
    focus: "Accent candidate reused as focus colour",
    radius: "Most frequent visible corner radius",
    spacing: "Most frequent visible spacing value",
    fontSize: "Most frequent visible type size",
    font: "Most frequent visible font family",
  };
  const inferences = Object.entries(inferenceSources).map(([token, basis]) => ({
    token, value: tokens[token], basis, confidence: "low",
  }));
  const sourceEvidence = {
    schema: "tribe-design-system-evidence/v1",
    source: { type: "browser-page", url: source.href, pages: [{ url: source.href, sampleCount: Math.max(0, Math.min(400, Number(reference.sampleCount) || 0)), buttonSamples: buttonCount, inputSamples: inputCount }], scope: "Visible computed styles on one rendered page" },
    confidence: { level: "low", reason: "Semantic roles are inferred from one page; off-screen states and other pages were not sampled." },
    observations,
    inferences,
    limitations: ["Brand ownership and source licence were not verified.", "Responsive layouts, off-screen content and interaction states were not sampled."],
  };
  const attribution = [
    `Capture source: ${source.href}`,
    `Scope: ${Math.max(0, Math.min(400, Number(reference.sampleCount) || 0))} visible elements on one rendered page; up to eight button and input specimens.`,
    "Confidence: inferred from visible computed styles only. Brand ownership, off-screen states, responsive layouts and source licence were not verified.",
    ...evidence,
  ].join("\n").slice(0, 1000);
  return {
    name: `Captured from ${host}`.slice(0, 100),
    description: `Starting point captured from ${host}; refine it against the preview before applying.`,
    source: "user",
    version: 1,
    tokens,
    palettes: generateDesignPalettes(tokens),
    components: {
      button: buttonCount ? `Style reference includes ${buttonCount} visible button samples. Review their contrast and interaction states.` : "",
      card: "",
      input: inputCount ? `Style reference includes ${inputCount} visible input samples. Review focus and validation states.` : "",
    },
    guidance: "These tokens come from visible computed styles on one page. Check the responsive preview, contrast and states that were not visible before applying.",
    attribution,
    sourceEvidence,
    references: [{ url: source.href, label: `Visual reference · ${host}` }],
  };
}

export function mergeDesignSystemReferenceCapture(system, reference) {
  const evidenceFile = system.packageFiles?.find(({ path }) => path === "source/evidence.json");
  let previousEvidence;
  try { previousEvidence = JSON.parse(evidenceFile?.content ?? ""); }
  catch { throw new Error("This design system has no readable browser extraction evidence to extend."); }
  if (previousEvidence?.schema !== "tribe-design-system-evidence/v1" || !["browser-page", "browser-pages"].includes(previousEvidence?.source?.type)) {
    throw new Error("Only browser-extracted systems can add another captured page.");
  }
  const captured = designSystemFromReference(reference, system);
  const pageUrl = captured.references[0].url;
  const previousPages = Array.isArray(previousEvidence.source.pages)
    ? previousEvidence.source.pages
    : [{ url: previousEvidence.source.url, sampleCount: 0, buttonSamples: 0, inputSamples: 0 }];
  if (previousPages.some((page) => page.url === pageUrl)) {
    throw new Error("This page is already included in the extraction.");
  }
  if (previousPages.length >= 12) throw new Error("A browser extraction can include up to 12 pages.");
  const pages = [...previousPages, ...(captured.sourceEvidence.source.pages ?? [])];
  const totals = new Map();
  for (const item of [...(previousEvidence.observations ?? []), ...captured.sourceEvidence.observations]) {
    const key = `${item.group}\u0000${item.value}`;
    const current = totals.get(key) ?? { group: item.group, value: item.value, samples: 0 };
    current.samples += Math.max(0, Number(item.samples) || 0);
    totals.set(key, current);
  }
  const observations = [];
  for (const group of [...new Set([...totals.values()].map((item) => item.group))]) {
    observations.push(...[...totals.values()].filter((item) => item.group === group).sort((a, b) => b.samples - a.samples).slice(0, 12));
  }
  const byGroup = new Map();
  for (const item of observations) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push({ value: item.value, count: item.samples });
  }
  const groupFields = {
    Backgrounds: "backgrounds", "Text colours": "foregrounds", Links: "links", Controls: "controls",
    Borders: "borders", Fonts: "fonts", "Type sizes": "fontSizes", Spacing: "spacing", "Corner radii": "radii",
  };
  const combinedReference = {
    url: pageUrl,
    sampleCount: pages.reduce((sum, page) => sum + (Number(page.sampleCount) || 0), 0),
    buttons: Array.from({ length: pages.reduce((sum, page) => sum + (Number(page.buttonSamples) || 0), 0) }, () => ({})),
    inputs: Array.from({ length: pages.reduce((sum, page) => sum + (Number(page.inputSamples) || 0), 0) }, () => ({})),
  };
  for (const [group, field] of Object.entries(groupFields)) combinedReference[field] = byGroup.get(group) ?? [];
  const merged = designSystemFromReference(combinedReference, system);
  const pageCount = pages.length;
  const sourceEvidence = {
    ...merged.sourceEvidence,
    source: { type: "browser-pages", pages, scope: `Visible computed styles sampled across ${pageCount} rendered pages` },
    observations,
    confidence: { level: "low", reason: "Semantic roles are inferred from visible styles across captured pages; responsive states, off-screen content, ownership and source licences still need review." },
    limitations: ["Responsive layouts and off-screen content were not sampled.", "Brand ownership and source licences were not verified."],
  };
  const references = [...(system.references ?? []), ...captured.references]
    .filter((item, index, items) => items.findIndex((other) => other.url === item.url) === index);
  const attribution = [
    `Captured from ${pageCount} pages: ${pages.map((page) => page.url).join(", ")}`,
    `Scope: ${pages.reduce((sum, page) => sum + (Number(page.sampleCount) || 0), 0)} visible elements across the captured pages.`,
    "Confidence: low; semantic roles are inferred from computed styles. Responsive states, ownership and source licences were not verified.",
  ].join("\n").slice(0, 1000);
  const packageFiles = syncPackageTokens(system.packageFiles ?? [], merged.tokens).map((file) => {
    if (file.path === "source/evidence.json") return { ...file, content: JSON.stringify(sourceEvidence, null, 2) };
    if (file.path === "source/evidence.md") return { ...file, content: attribution };
    return file;
  });
  return {
    ...system,
    tokens: merged.tokens,
    palettes: generateDesignPalettes(merged.tokens),
    components: {
      ...system.components,
      button: pages.reduce((sum, page) => sum + (Number(page.buttonSamples) || 0), 0)
        ? `Style reference includes ${pages.reduce((sum, page) => sum + (Number(page.buttonSamples) || 0), 0)} visible button samples across ${pageCount} pages. Review contrast and interaction states.`
        : system.components?.button ?? "",
      input: pages.reduce((sum, page) => sum + (Number(page.inputSamples) || 0), 0)
        ? `Style reference includes ${pages.reduce((sum, page) => sum + (Number(page.inputSamples) || 0), 0)} visible input samples across ${pageCount} pages. Review focus and validation states.`
        : system.components?.input ?? "",
    },
    guidance: `These tokens are inferred from visible computed styles on ${pageCount} pages. Review responsive behaviour, contrast and interaction states before applying.`,
    attribution,
    sourceEvidence,
    references,
    sourceUrl: system.sourceUrl || previousPages[0]?.url || pageUrl,
    packageFiles,
  };
}
