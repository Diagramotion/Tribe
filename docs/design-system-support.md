# Design-system support

## Goal

Design systems in Tribe are portable, inspectable packages that guide both an agent and the previews a user reviews. A colour palette alone is not a system. The built-in library combines sourced reference systems with Tribe starters; imported packages retain richer upstream specifications and provenance.

## OpenDesign reference inspected

OpenDesign 0.26.1 is installed locally. Its bundled catalogue README reports 151 packages. The repository contract treats `manifest.json`, `DESIGN.md`, and `tokens.css` as the minimum package, with optional usage guidance, runnable component fixtures, derived token/component indexes, framework mappings, responsive previews, and source evidence. A bundled Linear package includes these richer layers. OpenDesign composes the selected package into agent context and keeps canonical files distinct from derived indexes.

The catalogue's own provenance rules matter: its README lists upstream repositories and licences for some source collections, but the inspected Linear package describes itself as a curated OpenDesign fixture and explicitly says it is not a fresh crawl of Linear's upstream repository or website. Its manifest has no licence field. Brand-name packages are described as aesthetic references, not official brand assets. Treat package provenance and licence as per-package evidence; do not infer either from a brand name or from the catalogue as a whole.

The running native window is not exposed by this session's computer-control surface. The installed app bundle, its packaged system files, package schema guidance, and representative system packages were inspected directly; the app's local web endpoint was not listening. The source repository and its package/schema documentation were also inspected.

## Tribe package contract

Use a versioned directory package with a small discovery manifest and explicit canonical sources:

- `manifest.json`: stable ID, name, category, tags, summary, package version, source, licence, declared file paths and compatibility metadata.
- `DESIGN.md`: brand intent, visual principles, typography, layout, component and pattern rules, accessibility, motion, responsive behaviour, and anti-patterns.
- `tokens.css`: semantic CSS variables used by fixtures and implementation output.
- `design-tokens.json`: portable token interchange, derived from the canonical token source.
- `components.html`: runnable, token-bound specimens for real controls, patterns, variants and interaction states.
- `USAGE.md`: concise agent read order, highlights, do/avoid rules, and implementation caveats.
- `preview/`: human previews for foundations, components, and at least one representative responsive screen.
- `source/`: extraction and provenance evidence, including upstream locations, version, licence, confidence and any transformations.
- Optional `assets/` and `fonts/` only when their licences and attribution permit redistribution.

Keep generated indexes and CSS-framework mappings as derived outputs. Do not let them become a second source of truth. Preserve an upstream package's licence, attribution, version, provenance and required tooling. Brand-inspired references must be labelled as references, not official brand assets.

## Library and detail experience

The workspace library should have search, category filters, useful tags, source/licence indicators and compact visual previews. Selecting an entry opens its system detail without losing the browse context. The detail should make these areas first-class:

1. **Preview** — representative screens and responsive variants, plus a focused component gallery.
2. **Foundations** — colour roles, type specimens and scale, spacing, grid and breakpoints, radius, elevation, motion and iconography where defined.
3. **Components and patterns** — real examples with variants, default/hover/focus/selected/disabled/error states, behaviour and usage rules.
4. **Guide** — readable design guidance with a table of contents and copyable agent instructions.
5. **Sources** — upstream links, package version, licence, attribution, extraction scope and known gaps.

The preview must exercise the same tokens and package files shown in Foundations and Components. A static screenshot or unrelated sample dashboard is not evidence that a system is complete. Responsive previews must reflow content at the selected viewport; they must not shrink a desktop mock as one image.

## Create, extract, apply and export

- Create from a starter or from the user's own references, local project files, or the managed Browser.
- Keep source evidence and confidence separate from inferred design decisions; let users review and change both before saving.
- Let users edit each package part and compare the draft against its previous version and reference previews.
- Save immutable versions; projects keep their selected snapshot until a user applies a newer one.
- Give agents the selected package's `USAGE.md`, `DESIGN.md`, tokens, component index and relevant previews through scoped project context.
- Export a portable package with attribution and licence files intact. Also offer common derived formats such as CSS and Design Tokens JSON.

## Delivery order

1. Harden the end-to-end package lifecycle: create, extract, inspect, edit, compare, version, apply, update and remove a selected system without losing provenance or project snapshots.
2. Improve preview fidelity and usability: make package pages, themes, device widths and representative outputs predictable, responsive and easy to compare while editing.
3. Validate package interoperability through OpenDesign imports and round-trip exports, including assets, aliases, common token formats and licence notices.
4. Improve agent hand-off: ensure selected package guidance and the right specimens reach project work in a bounded, actionable form.
5. Expand the catalogue only to address a concrete coverage gap. The starter collection is sufficient for now; prioritise lifecycle, extraction, editing, preview, application and team hand-off improvements.

## Current implementation

Library search covers names, summaries, tags, provenance, token names and bounded text from package guides, stylesheets, manifests and component specimens.

The library searches and filters its visible entries and accepts either one OpenDesign system folder or a folder containing the whole local library (up to 200 packages). Each package must include manifest.json, DESIGN.md and tokens.css. A single package ZIP can also be imported directly; Tribe ZIPs retain their structured snapshot on round-trip, while OpenDesign ZIPs use the same package parser as folder imports. Archive reading is local to the Tribe runtime, bounded by file-count and expanded-size limits, and rejects unsafe paths and symlinks. Tribe preserves supported text files, package metadata, source evidence and licence notices in each immutable version. Saving a snapshot identical to the current saved version returns that version without adding redundant history; re-importing a library only advances packages whose content changed. Licence capture includes common `LICENSE`, `LICENSE-MIT`, `COPYING`, `NOTICE`, and `COPYRIGHT` text-file names; absent terms remain visibly undeclared. Imported entries surface the package's declared source origin beside its version. Package detail surfaces category, tags, licence, source evidence, semantic foundations, the complete CSS-token inventory and typography specimens. Component and foundation fixtures run in a script-free, network-blocked sandbox with wide, tablet and mobile viewport controls. The desktop preview fills the available stage; tablet and mobile previews retain their device widths and centre inside the same stage, leaving package detail aligned as the viewport changes. Local relative stylesheets and sanitised local SVG assets are resolved from the package; external resources remain blocked. The editor can change the complete canonical token stylesheet as well as component fixtures, preview pages, usage/design guidance and provenance files. Semantic edits synchronise the canonical stylesheet and derived token JSON where the token name can be resolved; nested DTCG JSON supports literal colour values, sRGB component values and pixel dimensions, while alias references and unrelated tokens remain intact. Standalone token-JSON export uses the manifest-declared token file when available and includes source, licence and attribution metadata. Users can compare the saved package against the draft at the same viewport. Structured metadata and semantic token controls keep the manifest and package metadata aligned. Extracting from the managed Browser produces a reviewable local draft with a source screenshot, sanitised source URL, visible-style evidence and editable package files. The selected project's agent context receives bounded design guidance, tokens and the component fixture, while foundation preview pages and other package bulk stay out of the prompt. Package ZIP and JSON snapshot exports preserve the portable package; package export remains the format that retains all package files and notices.

Package previews keep the iframe sandboxed, remove executable and embedded documents, disable fixture link/form navigation, and apply a restrictive CSP. Local styles and approved package assets are inlined; remote resources are not loaded.

Project extraction reads bounded CSS, Sass and Less stylesheets, common JSON design-token files, static literal values in named JavaScript/TypeScript theme configuration files, and root licence notices through the selected local project's file access. It never executes project code. It skips source-control, dependency, virtual-environment, cache and build-output directories so its bounded scan remains focused on project sources. It converts CSS custom properties, Sass `$variables`, Less `@variables`, common DTCG-style JSON entries and safe static theme values into canonical `tokens.css`, then creates a reviewable draft with source paths, confidence limits and a responsive preview. It does not claim component completeness or verified redistribution rights; Sass/Less expressions, computed JavaScript values and non-literal token aliases may need manual resolution.

Browser and project extraction now add a portable `source/evidence.json` report alongside the human-readable evidence note. The Inspector and editor separate observed source values from inferred semantic tokens, show the confidence level and its reason, and retain source paths or sample counts where available. Users can edit the evidence report as a package file; token controls remain separate from the evidence record so changing a design decision does not rewrite the captured source values.

Browser extraction can add up to twelve distinct pages to one draft. It aggregates repeated style observations across pages, recalculates token candidates, updates the live package preview and keeps each page URL and sample count in the evidence report. Capturing the same normalized URL twice is rejected rather than inflating its sample weight.

Imported package assets now also preserve common raster logos (`PNG`, `JPEG`, `GIF`, `WebP`, `AVIF`) and web-font files (`WOFF`, `WOFF2`, `TTF`, `OTF`) as local package content. Relative CSS and HTML references can use these assets in previews. ZIP export restores their original bytes, and the editor keeps binary assets out of the text-file editor. Package detail also shows local image previews and a sandboxed font specimen for each bundled media asset. Source licences and redistribution rights still need package-specific review; importing an asset does not grant them.

The package editor can add and remove local image and font assets without re-importing the package folder. Assets are stored under `assets/`; recognised logo filenames preview immediately in the draft, and referenced assets render through the package sandbox. Assets are included in immutable saved versions and preserved by ZIP export. Adding a file with the same package name replaces that asset in the draft; the editor enforces the package's file-count, per-asset (1 MB for SVG, 3 MB for binary assets) and total-size limits. Adding an HTML specimen also registers it in manifest preview pages, and removing a referenced preview removes its manifest entry. The editor tracks changes across tokens, package files, metadata, guidance, references and assets; closing or cancelling a changed draft asks whether to keep editing or discard it.

Agent project context now includes bounded package metadata, usage and design guidance, token CSS, a component index and specimen, up to three manifest-declared or conventionally located pattern/guidance files, up to two manifest-selected preview pages, and source evidence when available. It excludes binary payloads and unrelated preview pages so the selected package informs implementation without copying its whole library into every run.

The built-in library has sourced Carbon, Material Design 3, Fluent 2, and GitHub Primer reference packages plus three Tribe-authored starters. Carbon is labelled as a selected reference, cites official Carbon sources, includes Apache-2.0 terms and IBM attribution, and contains Tribe-authored specimens for foundations, controls, and a responsive dashboard. It covers a selected token subset rather than the full 250+ upstream themes or component API. Material Design 3 covers semantic color pairings, light and dark surface roles, type hierarchy, shape, motion guidance, component states, and responsive patterns. Its token sample and previews are Tribe-authored; it does not redistribute Google assets or claim the Apache-2.0 licence of Material Web applies to Google's design guidance. Fluent 2 demonstrates global-to-alias token layering, light and dark themes, adaptive layout, typography, shape, button hierarchy and status roles. Its sample values and fixtures are Tribe-authored; it includes no Microsoft assets, fonts or code. GitHub Primer covers functional token layers, theme modes, button hierarchy, form states, issue-list patterns, and compact responsive navigation. Its examples are Tribe-authored; the MIT licences of Primer implementation repositories are attributed to those repositories and not used to imply a licence for Primer documentation or GitHub brand assets. All four references link their upstream evidence and disclose their scope. The other OpenDesign systems remain device-local imports.

Import compatibility was checked against the installed OpenDesign app's bundled Linear package: Tribe parsed its 24 supported package files, three manifest-declared preview pages, semantic tokens and source metadata. A local export/read/import round-trip preserved all 24 package file paths and contents, the manifest, source origin and undeclared-licence state through both the OpenDesign package path and Tribe's embedded snapshot path. A missing licence remains undeclared. Semantic edits now resolve a manifest-declared DTCG token JSON path, and agent context follows a manifest-declared component-index path rather than relying only on a conventional filename.

The same Linear package was passed through the project agent-context builder: it included the usage and design guides, token stylesheet, manifest, declared component manifest, component specimen, source evidence and the first two selected preview pages in a 26 KB bounded context. The third preview page and unrelated package files stayed out of the agent payload.

The installed OpenDesign library was also imported as one folder containing 152 manifest-backed packages; all 152 parsed and passed Tribe's save validation. Every package has a component specimen. 151 include usage guidance, source evidence, a declared component index and at least one manifest-declared preview; all 456 declared preview paths resolve. `Tom Modern Design` is the one thinner package (six files, no usage guide, evidence file, component index or preview pages). All 152 packages saved to a temporary local library. Re-importing identical content kept all 152 at version 1 with no duplicate entries; changing one package advanced only that package to version 2. ZIP export/read-back preserved every imported package file for all 152; the largest archive was 1.3 MB. The installed README reports 151 packages, while the folder contains 152 manifests.

OpenDesign's installed package README reports 151 packages and describes its rich package contract. It also states that brand-referencing packages are aesthetic inspirations, not official brand assets. The bundled `material` package's own evidence says it is a normalized OpenDesign fixture, not a fresh source audit, and its metadata does not declare a licence. Tribe therefore treats its package format as an import reference, not verification of provenance or rights. Imported packages with undeclared terms remain visibly undeclared unless an included notice or licence file supplies terms. Importing a system does not certify its licence or source claims. Browser extraction can combine visible computed styles from up to twelve rendered pages; it remains a sampled reference rather than a complete brand audit, and it does not capture off-screen content, responsive states or interactions.

The Carbon reference uses official documentation for its theme layering, semantic roles, productive type scale, 2x spacing scale, and button hierarchy: [color and themes](https://www.carbondesignsystem.com/building-blocks/foundations/color/overview), [color tokens](https://www.carbondesignsystem.com/building-blocks/foundations/color/tokens), [typography](https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets), [spacing](https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview), and [button usage](https://www.carbondesignsystem.com/components/button/usage). Carbon's repository identifies Apache-2.0 licensing and IBM copyright notices: [repository licence](https://github.com/carbon-design-system/carbon/blob/main/LICENSE), [repository package metadata](https://github.com/carbon-design-system/carbon/blob/main/package.json).

The Material Design 3 reference follows Google's current documentation for [color roles and pairings](https://m3.material.io/m3/pages/color-roles), [typography](https://m3.material.io/styles/typography/applying-type), [motion](https://m3.material.io/styles/motion/overview/how-it-works), and [component guidance](https://m3.material.io/components). The Material Web implementation identifies its own code as Apache-2.0, but that code licence is not presented as a licence for the design documentation or this reference package: [Material Web repository](https://github.com/material-components/material-web).

The Primer reference follows official documentation for [product design foundations](https://primer.style/product/contribute/design/), [color roles and modes](https://primer.style/product/getting-started/foundations/color-usage/), [button hierarchy](https://primer.style/product/components/button/guidelines/), and [token naming](https://primer.style/product/primitives/token-names/). The [Primer Primitives repository](https://github.com/primer/primitives/blob/main/LICENSE) and [Primer React repository](https://github.com/primer/react/blob/main/LICENSE) carry MIT licences for their software; those terms are not attributed to the design documentation or GitHub marks.

The Inspector now follows the information hierarchy demonstrated in the user's OpenDesign screenshots: package identity and provenance, optional logo, named palette roles with use notes, extracted layout guidance, an interactive package preview with theme and device-width controls, token foundations, and representative output previews. This is an information-design reference, not a copy of OpenDesign's visual styling. Each curated package includes its own responsive pattern, component and foundation specimens, plus shared Tribe-authored launch, analytics and access-form outputs to compare how each system treats common product surfaces. More system-specific output types and denser multi-page packages remain a catalogue-content gap.

Package design guidance now renders as Markdown with a duplicate-safe table of contents and a one-click copy action for agent instructions; raw package files stay in a separate expandable list.

Semantic colour pairings now show live contrast ratios in both the system detail and editor. Text pairings use a 4.5:1 target; accent controls and focus indicators use a 3:1 target. These checks cover the listed foreground/background pairs and do not certify the full interface or other accessibility requirements.

The Fluent 2 reference uses official documentation for [global and alias token layers](https://fluent2.microsoft.design/design-tokens), [web alias colour roles](https://fluent2.microsoft.design/color-tokens), [typography](https://fluent2.microsoft.design/typography), [adaptive layout](https://fluent2.microsoft.design/layout), [React button hierarchy and accessibility](https://fluent2.microsoft.design/components/web/react/core/button/usage/), and [shape guidance](https://fluent2.microsoft.design/shapes). Token mappings are a selected Tribe-authored reference sample, not a full upstream export; no Microsoft code or design assets are redistributed.

## Completion checks

- A user can browse and filter multiple sourced systems and inspect each package's scope, provenance and licence.
- A system includes meaningful visual rules, semantic tokens, typography/layout foundations, real component states and responsive examples; it is not only a generated palette.
- Desktop preview fills the available stage. Tablet and mobile options change the viewport width while the stage retains its alignment with package detail.
- Theme switching recognises Carbon, data-theme/data-mode/data-color-scheme attributes and `.dark` classes; the selected mode is applied to both the document root and body.
- Changing one semantic token updates the matching token swatch, component specimen and responsive preview.
- Semantic edits bind to the selected package's own CSS variables, and imported light/base values remain the editable values when a package also defines dark-theme overrides.
- Import/export round-trips the package and keeps its source attribution, licence and version intact.
- Editing or clearing the package source URL updates both the saved metadata and exported manifest consistently.
- Captured page references remain visible in the editor and can be removed individually when they are no longer relevant.
- Browser and project extraction include a structured, editable evidence report that separates observed source values from inferred tokens and records confidence, scope and limitations.
- Project extraction recognises literal design values in named JavaScript and TypeScript theme files without executing source code; the evidence report names the originating files and marks these values as inferred.
- A browser-extracted draft can combine observations from up to twelve distinct pages while preserving per-page source and sample evidence.
- Standalone CSS export preserves the package stylesheet (or generates semantic declarations for older systems) and includes source, licence and attribution.
- Standalone token JSON follows the manifest-declared token file, preserves its DTCG structure and aliases, and adds source, licence and attribution under Tribe's namespaced `$extensions` entry.
- Selecting a saved version displays that exact snapshot; it can be compared, exported or applied without changing the active version.
- Comparing a selected historical version with the current version shows changed semantic tokens and package files, plus matched live previews at the same viewport width.
- A package ZIP can be imported directly; Tribe packages round-trip their full snapshot and OpenDesign ZIPs preserve their package files and licence notices.
- Users can add and remove nested Markdown, CSS, JSON, HTML and text package files while editing a system; package paths and file-count limits are enforced before saving.
- Exporting a system without package files still emits readable source evidence with its source, licence and attribution.
- Included raster/vector brand marks and web fonts stay package-local, work in previews, and retain their original bytes in ZIP exports.
- Package detail exposes included images and fonts for inspection without making network requests.
- The package guide renders Markdown, provides working section links, and lets users copy the agent instructions.
- Editing and applying a later version leaves existing project snapshots unchanged until the user selects the update.
- Before replacing a project's selected snapshot, the library can load that exact applied package and compare its semantic tokens, package files and matched responsive preview with the selected version.
- Removing a saved system names the projects using it, deletes its library versions, and preserves their applied snapshots.
- Closing or cancelling an edited system warns before discarding work; untouched drafts close directly.
- Agents receive only the selected project package, with bounded guides, patterns, source evidence, tokens and manifest-selected previews; unrelated preview pages and binary payloads stay out of their context.
