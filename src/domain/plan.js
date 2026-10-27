const ACTIVE_STATUSES = new Set(["In progress", "In review"]);

export function summariseTeamWork(agents, workItems) {
  const owners = new Map(agents.map((agent) => [agent.id, {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    runtimeStatus: agent.status,
    items: [],
  }]));

  for (const item of workItems) {
    const ownerId = item.owner === "Unclaimed" ? "unassigned" : item.owner;
    if (!owners.has(ownerId)) {
      owners.set(ownerId, {
        id: ownerId,
        name: ownerId === "unassigned" ? "Unassigned" : item.owner,
        role: "",
        runtimeStatus: ownerId === "unassigned" ? "Ready" : "Agent unavailable",
        items: [],
      });
    }
    owners.get(ownerId).items.push(item);
  }

  return [...owners.values()].map((owner) => {
    const activeItems = owner.items.filter((item) => ACTIVE_STATUSES.has(item.status));
    return {
      ...owner,
      activeItems,
      readyCount: owner.items.filter((item) => item.status === "Ready").length,
      blockedItems: owner.items.filter((item) => item.status === "Blocked"),
      completedCount: owner.items.filter((item) => item.status === "Done").length,
      totalCount: owner.items.length,
    };
  });
}
