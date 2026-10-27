function removePromptLead(value) {
  return value.replace(/^(?:please\s+)?(?:create|write|generate)\s+(?:a|an|the)\s+(?:(?:concise|brief|short|quick|simple|clear)\s+)+/i, "");
}

export function compactChatTitle(value, maxLength = 56) {
  const title = removePromptLead(String(value ?? "").replace(/\s+/g, " ").trim());
  if (!title) return "New chat";
  if (title.length <= maxLength) return title;
  const clauseBoundary = title.slice(0, maxLength).search(/[,;:—–]\s/);
  if (clauseBoundary >= Math.floor(maxLength * 0.45)) return title.slice(0, clauseBoundary).trimEnd();
  const boundary = title.lastIndexOf(" ", maxLength);
  return `${title.slice(0, boundary > maxLength / 2 ? boundary : maxLength).trimEnd()}…`;
}

export function chatTitleFromPrompt(prompt) {
  const title = String(prompt ?? "").split(/\r?\n/, 1)[0]
    .replace(/^#{1,6}\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  return compactChatTitle(title);
}
