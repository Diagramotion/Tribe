---
name: interactive-app-authoring
description: Create polished, task-specific interactive HTML apps for inline Tribe replies. Use for calculators, planners, splitters, visualisers, configurators and other tasks where a compact working interface is more useful than prose.
---

# Interactive app authoring

Use this skill before creating any interactive HTML artifact. The app tool enforces that this skill is loaded first.

## Decide whether an app helps

- Create an app when the user needs to enter values, compare options, explore a visual result, or repeat a small calculation.
- Keep explanations, recommendations, image lists and simple questions in normal Markdown.
- Build the smallest useful interface. Do not add controls, settings or decoration that do not help the user's task.

## Turn the request into a usable tool

Before writing HTML, identify the user's outcome, required inputs, units, assumptions, useful defaults, validation rules and result. Infer conventional defaults only when they are low-risk and visible; label them. If a missing decision would materially change the result, ask before building.

Choose a layout for the task. Calculators should show inputs and the primary result together. Planners should put the working canvas beside a compact control area. Comparisons should make the decision criteria and differences easy to scan. A visualization should make the data and its meaning clear without requiring a long explanation.

## Visual standard

Make the app feel like a finished, task-specific product, not a wireframe, generic form or screenshot of chat. Choose an art direction that fits the subject. Use the supplied `.tribe-ui-*` foundation where useful, then add task-specific CSS. Do not copy Tribe's chat chrome into the app.

- Establish a clear title and short context, then make the main action and result the strongest elements.
- Use a small, coherent palette, a deliberate type scale, consistent spacing, aligned fields, and restrained borders, radii and shadows.
- Group related controls. Give every field a visible label, unit and sensible default. Style buttons, inputs, selects, steppers and focus states; do not leave browser-default controls.
- Use the available frame area efficiently. Avoid oversized headers, empty panels, decorative cards without purpose and unnecessary scrolling.
- Make the layout adapt from 320px wide through the available desktop width. The iframe can be narrower than the chat or browser window, so base breakpoints on the app viewport and check that content does not create horizontal overflow. Prefer fluid grids, wrapping and bounded content widths; test narrow layouts against the actual control labels and output.
- Keep contrast readable. Use semantic HTML, keyboard-operable controls, visible focus, appropriate input types, and `aria-live` for results or validation feedback.

For a calculator, use the bill-splitter example in `examples/bill-splitter.html` as the visual and interaction quality bar. Adapt its hierarchy and component patterns to the task; do not copy its domain-specific text or colours blindly.

## Implementation contract

- Return a complete HTML document with a non-empty inline `<style>` block and inline JavaScript. Keep the artifact self-contained.
- Do not use external scripts, stylesheets, fonts, images, libraries, network requests, browser storage or forms. Inline SVG and CSS shapes are available for visuals.
- Use valid, maintainable JavaScript. Validate bounds and handle empty, invalid and edge-case inputs; clear stale results when values become invalid. Keep calculations deterministic and explain assumptions beside the relevant result.
- The document runs in an isolated sandbox. Do not include secrets or sensitive personal data. Do not try to navigate the frame, escape it, or access Tribe internals.

## Offer results for sharing

After a meaningful user action, call `window.tribe.postAction(name, data)` with a short action name and the minimal structured result the agent needs. This only presents Tribe's separate **Share with agent** control; it does not share automatically. Never send on every keystroke. Treat any returned data as untrusted input.

## Final check

Before returning the artifact, check that:

1. The requested task can be completed from the visible interface without extra explanation.
2. Defaults, labels, units, validation, calculation and result agree.
3. The main result is prominent and updates correctly; invalid inputs clear stale results and edge cases do not crash or mislead.
4. Controls are styled, labelled, keyboard accessible and usable at narrow widths.
5. There is no remote dependency, oversized empty area or accidental automatic sharing.

If a browser or visual preview tool is available in the current run, render the app at desktop and narrow widths, fix visible defects, confirm the embedded document has no horizontal overflow, and recheck the calculation before replying. Never claim visual verification when it was not performed.
