const assert = require("node:assert/strict");
const { browserShortcutForInput } = require("./browser-shortcuts.cjs");

const key = (value, modifiers = {}) => ({ type: "keyDown", key: value, ...modifiers });

assert.equal(browserShortcutForInput(key("l", { meta: true }), "darwin"), "focus-address");
assert.equal(browserShortcutForInput(key("t", { meta: true }), "darwin"), "new-tab");
assert.equal(browserShortcutForInput(key("w", { meta: true }), "darwin"), "close-tab");
assert.equal(browserShortcutForInput(key("r", { meta: true, shift: true }), "darwin"), "hard-reload");
assert.equal(browserShortcutForInput(key("ArrowLeft", { alt: true }), "win32"), "back");
assert.equal(browserShortcutForInput(key("Tab", { control: true, shift: true }), "win32"), "previous-tab");
assert.equal(browserShortcutForInput({ type: "char", key: "t", meta: true }, "darwin"), null);
assert.equal(browserShortcutForInput(key("f", { meta: true }), "darwin"), null);
assert.equal(browserShortcutForInput(key("1", { control: true }), "win32"), "select-tab-1");

console.log("Browser keyboard shortcut mappings passed.");
