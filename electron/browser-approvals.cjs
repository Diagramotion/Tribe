const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RISK_LABELS = [
  { pattern: /\b(delete|remove|erase|wipe|destroy|discard|revoke)\b/i, label: "Delete or remove website data" },
  { pattern: /\b(pay|purchase|buy|place order|subscribe|transfer|refund)\b/i, label: "Make a purchase or payment" },
  { pattern: /\b(checkout)\b/i, label: "Continue to checkout" },
  { pattern: /\b(upload|attach(?: a)? file|choose file|browse files|select file)\b/i, label: "Open a file chooser or share a file" },
  { pattern: /\b(credit card|card number|security code|cvv|cvc|routing number|bank account|social security|tax id)\b/i, label: "Enter payment or identity details" },
  { pattern: /\b(send|publish|post|share|invite|message|submit)\b/i, label: "Send or publish information" },
  { pattern: /\b(save|update|change|confirm|apply|cancel subscription|unsubscribe)\b/i, label: "Confirm a website change" },
];

function browserActionFingerprint(target) {
  if (!target || typeof target !== "object") return "";
  return JSON.stringify([
    target.tagName || "", target.role || "", target.name || "", target.type || "",
    target.href || "", target.formAction || "", target.formMethod || "",
    Boolean(target.inForm), Boolean(target.isSubmit), Boolean(target.financialForm),
  ]);
}

function classifyBrowserAction(target, intent = "click") {
  if (!target || typeof target !== "object") return null;
  const method = String(target.formMethod || "GET").toUpperCase();
  if (target.inForm && MUTATING_METHODS.has(method)) return "Submit a website form";

  const descriptor = `${String(target.name || "").slice(0, 300)} ${String(target.href || "").slice(0, 500)}`;
  if (target.isSubmit && target.financialForm) return "Make a purchase or payment";
  for (const { pattern, label } of RISK_LABELS) {
    if (pattern.test(descriptor)) return label;
  }

  if (intent === "enter" && target.inForm && target.isSubmit) return "Submit a website form";
  if (intent === "space" && target.isSubmit) return "Submit a website form";
  return null;
}

function browserActionRequiresHandoff(target, intent = "click") {
  const label = classifyBrowserAction(target, intent) || "";
  return label === "Make a purchase or payment"
    || Boolean(target?.isSubmit && target?.financialForm);
}

async function requestBrowserActionApproval(dialog, window, actionLabel, origin) {
  const decision = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Approve this browser action?",
    message: `${actionLabel} on ${origin}.`,
    detail: "An agent requested this specific page action. Approve it once to continue.",
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return decision.response === 1;
}

async function authorizeBrowserAction({ dialog, window, target, intent, origin, isStillCurrent, getCurrentTarget }) {
  const actionLabel = classifyBrowserAction(target, intent);
  if (!actionLabel) return target;
  if (!await requestBrowserActionApproval(dialog, window, actionLabel, origin)) return null;
  if (!await isStillCurrent()) throw new Error("The visible browser page changed during approval.");
  const freshTarget = await getCurrentTarget();
  if (freshTarget.fileInput || browserActionFingerprint(freshTarget) !== browserActionFingerprint(target)) {
    throw new Error("The page action changed during approval.");
  }
  return freshTarget;
}

module.exports = { authorizeBrowserAction, browserActionFingerprint, browserActionRequiresHandoff, classifyBrowserAction, requestBrowserActionApproval };
