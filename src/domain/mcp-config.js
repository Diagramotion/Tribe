export function sortMcpServerNames(mcpServers) {
  return Object.keys(mcpServers ?? {}).sort((left, right) => left.localeCompare(right, "en"));
}
