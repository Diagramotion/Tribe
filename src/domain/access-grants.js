const exactToolCapabilityPattern = /^tool_action(?:_hmac)?:([^:]+):/;

export function formatAccessGrant(grant) {
  const toolName = exactToolCapabilityPattern.exec(grant?.capability ?? "")?.[1];
  const subject = toolName === "repository_file_changes"
    ? "In-project file changes"
    : toolName
      ? `Exact ${toolName.replaceAll("_", " ")} request`
      : "Public web access";
  const scope = grant?.scope === "workspace"
    ? "Workspace access"
    : grant?.scope === "project"
      ? `Project · ${grant.project_name || "Unknown project"}`
      : `Chat · ${grant?.mission_title || "Unknown chat"}`;
  return { subject, scope };
}
