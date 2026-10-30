const assert = require("node:assert/strict");
const { test } = require("node:test");
const { authorizeBrowserAction, browserActionFingerprint, browserActionRequiresHandoff, classifyBrowserAction, requestBrowserActionApproval } = require("./browser-approvals.cjs");

test("allows ordinary navigation and controls without an approval prompt", () => {
  assert.equal(classifyBrowserAction({ tagName: "A", name: "Tailwind colors", href: "https://example.test/colors" }), null);
  assert.equal(classifyBrowserAction({ tagName: "BUTTON", name: "Search", inForm: true, formMethod: "GET", isSubmit: true }), null);
  assert.equal(classifyBrowserAction({ tagName: "BUTTON", name: "Open menu" }), null);
});

test("requires exact approval for mutating forms and consequential actions", () => {
  assert.equal(classifyBrowserAction({ tagName: "BUTTON", name: "Continue", inForm: true, formMethod: "POST" }), "Submit a website form");
  assert.equal(classifyBrowserAction({ tagName: "BUTTON", name: "Delete project" }), "Delete or remove website data");
  assert.equal(classifyBrowserAction({ tagName: "A", name: "Pay now", href: "https://example.test/checkout" }), "Make a purchase or payment");
  assert.equal(classifyBrowserAction({ tagName: "BUTTON", name: "Send invitation" }), "Send or publish information");
  assert.equal(classifyBrowserAction({ tagName: "BUTTON", name: "Upload a file" }), "Open a file chooser or share a file");
  assert.equal(classifyBrowserAction({ tagName: "INPUT", name: "Continue", inForm: true, isSubmit: true }, "enter"), "Submit a website form");
  assert.equal(classifyBrowserAction({ tagName: "INPUT", name: "Credit card number", type: "text" }, "fill"), "Enter payment or identity details");
  assert.equal(browserActionRequiresHandoff({ tagName: "BUTTON", name: "Pay now" }, "click"), true);
  assert.equal(browserActionRequiresHandoff({ tagName: "BUTTON", name: "Continue", isSubmit: true, financialForm: true }, "enter"), true);
  assert.equal(browserActionRequiresHandoff({ tagName: "BUTTON", name: "Continue to checkout" }, "click"), false);
  assert.equal(classifyBrowserAction({ tagName: "A", name: "Continue to checkout" }, "click"), "Continue to checkout");
});

test("detects a changed target after approval so it cannot authorize a different action", () => {
  const before = { tagName: "BUTTON", role: "button", name: "Delete account", type: "submit", formMethod: "POST", inForm: true, isSubmit: true };
  const after = { ...before, name: "Save changes" };
  assert.notEqual(browserActionFingerprint(before), browserActionFingerprint(after));
  assert.equal(browserActionFingerprint(before), browserActionFingerprint({ ...before }));
});

test("asks for a one-time approval with cancel as the safe default", async () => {
  const calls = [];
  const dialog = { showMessageBox: async (window, options) => { calls.push([window, options]); return { response: 1 }; } };
  const window = {};
  assert.equal(await requestBrowserActionApproval(dialog, window, "Make a purchase or payment", "https://shop.example"), true);
  assert.equal(calls[0][0], window);
  assert.equal(calls[0][1].message, "Make a purchase or payment on https://shop.example.");
  assert.deepEqual(calls[0][1].buttons, ["Cancel", "Allow once"]);
  assert.equal(calls[0][1].defaultId, 0);
  assert.equal(calls[0][1].cancelId, 0);

  dialog.showMessageBox = async () => ({ response: 0 });
  assert.equal(await requestBrowserActionApproval(dialog, window, "Submit a website form", "https://shop.example"), false);
});

test("does not act after cancellation and revalidates approved page and target", async () => {
  const target = { tagName: "BUTTON", name: "Delete account", inForm: true, formMethod: "POST", isSubmit: true };
  let currentTargetCalls = 0;
  let isCurrent = true;
  const dialog = { showMessageBox: async () => ({ response: 0 }) };
  const options = {
    dialog, window: {}, target, intent: "click", origin: "https://example.test",
    isStillCurrent: async () => isCurrent,
    getCurrentTarget: async () => { currentTargetCalls += 1; return { ...target }; },
  };
  assert.equal(await authorizeBrowserAction(options), null);
  assert.equal(currentTargetCalls, 0);

  dialog.showMessageBox = async () => ({ response: 1 });
  assert.deepEqual(await authorizeBrowserAction(options), target);
  assert.equal(currentTargetCalls, 1);
  isCurrent = false;
  await assert.rejects(authorizeBrowserAction(options), /page changed/);
  isCurrent = true;
  options.getCurrentTarget = async () => ({ ...target, name: "Transfer funds" });
  await assert.rejects(authorizeBrowserAction(options), /action changed/);
});
