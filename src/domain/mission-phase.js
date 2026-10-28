export function advanceMissionWorkflowContext(context = {}, event) {
  if (!event?.type) return context;
  if (event.type === "workflow.stage.changed") {
    return { ...context, stage: { id: event.id, sequence: event.sequence,
      stageId: event.payload?.stageId, title: event.payload?.title ?? "" } };
  }
  if (event.type === "workflow.state.updated") {
    return { ...context, state: { id: event.id, sequence: event.sequence,
      revision: event.payload?.revision, state: event.payload?.state ?? {} } };
  }
  return context;
}

function mergeLatest(left, right) {
  if (!left) return right;
  if (!right) return left;
  return right.sequence > left.sequence ? right : left;
}

export function mergeMissionWorkflowContext(current, incoming) {
  if (!current && !incoming) return undefined;
  const existing = current ?? {};
  const next = incoming ?? {};
  return {
    ...next,
    stage: mergeLatest(existing.stage, next.stage) ?? null,
    state: mergeLatest(existing.state, next.state) ?? null,
  };
}

export function preserveMissionWorkflowContext(current, next) {
  if (!next || !current || current.id !== next.id) return next;
  const workflowContext = mergeMissionWorkflowContext(current.workflow_context, next.workflow_context);
  return workflowContext ? { ...next, workflow_context: workflowContext } : next;
}

export function missionPhase(mission, _workItems, context = {}) {
  if (!mission?.recipe_id) return null;
  let workflow;
  try {
    workflow = typeof mission.recipe_snapshot === "string"
      ? JSON.parse(mission.recipe_snapshot) : mission.recipe_snapshot;
  } catch {
    workflow = null;
  }
  const state = context.state?.state ?? {};
  const stageId = state.stage_id ?? context.stage?.stageId ?? null;
  const stage = workflow?.stages?.find((item) => item.id === stageId);
  return {
    stageId,
    label: stage?.title ?? (stageId ? "Unknown workflow stage" : "Not started"),
    detail: stage?.objective ?? stage?.guide ?? workflow?.objective ?? workflow?.description ?? "",
    state,
    revision: context.state?.revision ?? 0,
    chatCompleted: mission.status === "completed",
  };
}
