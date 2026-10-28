# Tribe visual language

Tribe's interface uses the **Workbench** language: a calm navy canvas, compact tool chrome, readable task content and restrained blue emphasis. Structure comes from alignment, spacing and typography first. Lines and cards appear only when they clarify a boundary or group a distinct task.

## Foundations

The values in `src/styles.css` are the implementation source of truth. Keep this guide aligned with those CSS custom properties.

| Role | Tokens | Use |
| --- | --- | --- |
| Canvas and surfaces | `--canvas`, `--surface`, `--surface-soft`, `--surface-well`, `--surface-raised`, `--surface-sidebar` | Separate the app, pane, composer, inset controls and floating surfaces by small luminance steps. |
| Interaction surfaces | `--surface-hover`, `--surface-selected`, `--surface-control-hover`, `--surface-choice` | Hover and selected states. Reserve the strongest fill for the current selection. |
| Separators | `--line-subtle`, `--line-control`, `--line-strong` | Use the lowest contrast that still explains a real boundary. Do not outline every row. |
| Text | `--text`, `--text-secondary`, `--muted`, `--muted-2` | Primary content, supporting content, metadata and tertiary hints, in that order. |
| Emphasis and status | `--accent`, `--accent-hover`, `--accent-text`, `--success`, `--warning`, `--danger`, `--status-*` | Active navigation and meaningful status only; use the shared foreground, surface and border tokens for success, warning, danger, info and neutral states. Do not invent a new shade per view or use status colours as decoration. |
| Focus and primary action | `--focus-ring`, `--focus-glow`, `--accent-primary*` | Consistent keyboard focus, focused composer and primary actions. |
| Shape and scale | `--space-*`, `--radius-*`, `--control-height*`, `--font-*`, `--leading-*` | Reuse across workbench pages and dialogs; add a token only for a repeated semantic role. |

## Component rules

- **Workspace frame:** the sidebar, breadcrumb and tab rail are compact navigation chrome. Main task content gets the remaining width and height. On desktop, keep chat at least 360px wide; cap the resizable secondary pane at 60% of workspace width and 820px. Narrower screens use the overlay layout. Split panes share a single seam and resize handle; avoid adding a gutter beside the handle.
- **Navigation and actions:** selected items use a quiet filled surface without an outline. Expanded sidebars use group labels and spacing; keep separators for the icon-only rail where they clarify tool groups. Hover uses a smaller contrast change. Default routine and utility actions to compact icon-only buttons with an accessible name and tooltip, including toolbar and page-header actions such as add, edit, refresh, open, cancel and close. Use visible text buttons only when the label is needed to complete a form (for example, Save or Connect), confirm a consequential choice, or disambiguate an action that has no recognisable icon. Keep secondary actions quiet; do not turn routine actions into large filled buttons or enlarge controls for emphasis. Use the shared compact control height and reserve stronger fill for the primary action.
- **Tabs:** align tab rails that operate at the same level. Use a short active underline, not a filled card or a second separator around each tab.
- **Content groups:** use open layouts by default. A card is appropriate for a distinct approval, error, empty state or self-contained task. Never nest cards or frame ordinary messages and list rows.
- **Project lists:** let the page surface carry the collection; use spacing and quiet hover fills for rows instead of an outer card around bordered rows.
- **Browse grids:** distinguish entries with breathing room and a soft surface; reserve visible outlines for interactive controls or a selected item.
- **Empty collections:** hide headings and zero counts when they repeat the empty-state message; keep the next step clear in one short supporting line.
- **Separators:** prefer proximity and whitespace. Add one low-contrast, continuous divider only when it distinguishes adjacent regions; avoid stacked rules and borders around every control.
- **Controls:** use the shared `.button`, `.icon-button`, switch and CSS custom properties. Text fields, selects and textareas use the common dark control surface, line, radius and focus ring; selected, hover and focus states reuse the surface and focus tokens instead of introducing local shades. Component-specific sizing can vary without changing their visual language.
- **Status:** express the same state with the same semantic palette across chat, project lists, provider settings, Git and run history. Prefer a coloured icon or dot with restrained text; add a tinted surface and border only when the state needs a contained notice.
- **Typography:** use `--font-*` and `--leading-*` tokens. Keep primary task content readable and metadata subordinate. Avoid repeating a title already established by the breadcrumb or section context.
- **Messages:** keep the timeline unboxed. Align author, body, event dividers and composer consistently. Markdown should use available width; code and diagrams may scroll or zoom within their own content boundary.
- **Responsive density:** use container queries for resizable panes. At 1536×855, preserve the chat, composer and active workspace tool in view; allow controls to collapse to icon-only before they collide. Keep split-pane resizing within the same chat and secondary-pane limits as the workspace frame.
- **Accessibility:** keep visible focus, semantic status, keyboard operation and accessible labels when visual labels collapse. Do not rely on colour alone for state.

## Provider settings

Model settings use a provider tree: known providers remain visible on the left, with their models nested below; selecting a provider opens connection and catalogue details, while selecting a model opens its capability settings. Provider brand marks are local SVG assets sourced from thesvg.org. Keep enablement switches beside the selected item's details and do not add visible “Enabled” copy beside an explanatory switch.

## Review checklist

- Does hierarchy come from spacing and type before borders and cards?
- Are repeated controls using the same theme, radius, focus and interaction states?
- Can a text action become a compact icon button with a clear accessible name and tooltip?
- Are there any redundant labels, titles, nested cards or stacked dividers?
- Does the primary task remain legible at laptop height and in a narrow split pane?
- Can a keyboard user identify focus and understand state without colour alone?
