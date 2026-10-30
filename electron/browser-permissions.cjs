function normalisePermissionOrigin(value) {
  try {
    const origin = new URL(String(value ?? "")).origin;
    return ["http://", "https://"].some((scheme) => origin.startsWith(scheme)) ? origin : "";
  } catch {
    return "";
  }
}

function getPermissionRule(rules, origin, permission) {
  const normalisedOrigin = normalisePermissionOrigin(origin);
  if (!normalisedOrigin || typeof permission !== "string") return "";
  const rule = Array.isArray(rules)
    ? rules.find((item) => item?.origin === normalisedOrigin && item?.permission === permission)
    : undefined;
  return rule?.decision === "allow" || rule?.decision === "block" ? rule.decision : "";
}

function setPermissionRule(rules, origin, permission, decision) {
  const normalisedOrigin = normalisePermissionOrigin(origin);
  if (!normalisedOrigin || typeof permission !== "string" || !permission
    || !["allow", "block"].includes(decision)) {
    throw new Error("Choose a valid website permission rule.");
  }
  return [
    ...(Array.isArray(rules) ? rules : []).filter((item) => item?.origin !== normalisedOrigin || item?.permission !== permission),
    { origin: normalisedOrigin, permission, decision, updatedAt: Date.now() },
  ];
}

function removePermissionRule(rules, origin, permission) {
  const normalisedOrigin = normalisePermissionOrigin(origin);
  if (!normalisedOrigin || typeof permission !== "string") return Array.isArray(rules) ? rules : [];
  return (Array.isArray(rules) ? rules : []).filter((item) => item?.origin !== normalisedOrigin || item?.permission !== permission);
}

module.exports = {
  getPermissionRule,
  normalisePermissionOrigin,
  removePermissionRule,
  setPermissionRule,
};
