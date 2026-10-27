const GOAL_DRIVEN_WORKFLOW = "goal-driven-sdlc";

const phases = {
  discovery: { label: "Discovery", detail: "The planner is checking the repository and mission context." },
  planning: { label: "Planning", detail: "The team is shaping the plan." },
  building: { label: "Building", detail: "Agents are working through the plan." },
  verification: { label: "Checking", detail: "The latest repository changes need a successful check." },
  review: { label: "Review", detail: "The work is ready for independent review." },
  ready: { label: "Ready to finish", detail: "Review is approved and the reviewer can complete the mission." },
  completed: { label: "Complete", detail: "The mission is complete." },
};

export function advanceMissionWorkflowContext(context = {}, event) {
  if (!event?.type) return context;
  const sequence = event.sequence;
  const id = event.id;
  switch (event.type) {
    case "sdlc.discovery.completed":
      return { ...context, discovery: { id, sequence, summary: event.payload?.summary ?? "", evidence: event.payload?.evidence ?? [] } };
    case "plan.finalized":
      return { ...context, planFinalizedSequence: sequence };
    case "plan.item.created":
    case "plan.item.updated":
      return { ...context, latestPlanChangeSequence: sequence };
    case "repo.file.changed":
    case "repo.worktree.integrated":
      return { ...context, latestChange: { id, sequence } };
    case "repo.test_run.completed": {
      const latestTest = { id, sequence, exitCode: event.payload?.exitCode ?? null };
      return event.payload?.exitCode === 0
        ? { ...context, latestTest, latestSuccessfulTest: { id, sequence } }
        : { ...context, latestTest };
    }
    case "review.checkpoint.recorded":
      return {
        ...context,
        latestReview: {
          id,
          sequence,
          disposition: event.payload?.disposition,
          verificationEventId: event.payload?.verificationEventId,
          changeEventId: event.payload?.changeEventId ?? null,
        },
      };
    default:
      return context;
  }
}

function latestEvidence(left, right) {
  if (!left) return right;
  if (!right) return left;
  return right.sequence > left.sequence ? right : left;
}

export function mergeMissionWorkflowContext(current, incoming) {
  if (!current && !incoming) return undefined;
  const existing = current ?? {};
  const next = incoming ?? {};
  const discovery = latestEvidence(existing.discovery, next.discovery);
  const planSequences = [existing.planFinalizedSequence, next.planFinalizedSequence].filter(Number.isFinite);
  const planChangeSequences = [existing.latestPlanChangeSequence, next.latestPlanChangeSequence].filter(Number.isFinite);
  return {
    discovery: discovery ?? null,
    planFinalizedSequence: planSequences.length ? Math.max(...planSequences) : null,
    latestPlanChangeSequence: planChangeSequences.length ? Math.max(...planChangeSequences) : null,
    latestChange: latestEvidence(existing.latestChange, next.latestChange) ?? null,
    latestTest: latestEvidence(existing.latestTest, next.latestTest) ?? null,
    latestSuccessfulTest: latestEvidence(existing.latestSuccessfulTest, next.latestSuccessfulTest) ?? null,
    latestReview: latestEvidence(existing.latestReview, next.latestReview) ?? null,
  };
}

export function preserveMissionWorkflowContext(current, next) {
  if (!next || !current || current.id !== next.id) return next;
  const workflowContext = mergeMissionWorkflowContext(current.workflow_context, next.workflow_context);
  return workflowContext ? { ...next, workflow_context: workflowContext } : next;
}

export function missionPhase(mission, workItems, context = {}) {
  if (mission?.recipe_id !== GOAL_DRIVEN_WORKFLOW) return null;
  if (mission.status === "completed") return phases.completed;

  if (mission.recipe_version >= 7 && !context.discovery?.sequence) return phases.discovery;

  const planSequence = context.planFinalizedSequence;
  if (!planSequence || (context.latestPlanChangeSequence ?? 0) > planSequence
      || (context.discovery?.sequence ?? 0) > planSequence) return phases.planning;

  const unfinishedBuildWork = workItems.some((item) => item.status !== "Done" && item.owner !== "reviewer");
  if (unfinishedBuildWork) return phases.building;

  const latestChange = context.latestChange;
  const latestTest = context.latestTest;
  const latestSuccessfulTest = context.latestSuccessfulTest;
  if (!latestSuccessfulTest
      || (latestTest && latestTest.id !== latestSuccessfulTest.id)
      || (latestChange && latestSuccessfulTest.sequence <= latestChange.sequence)) {
    return phases.verification;
  }

  const unfinishedReviewWork = workItems.some((item) => item.status !== "Done" && item.owner === "reviewer");
  if (unfinishedReviewWork) return phases.review;

  const review = context.latestReview;
  const reviewMatchesCurrentEvidence = review
    && review.verificationEventId === latestSuccessfulTest.id
    && (review.changeEventId ?? null) === (latestChange?.id ?? null)
    && review.sequence > latestSuccessfulTest.sequence;
  if (reviewMatchesCurrentEvidence && review.disposition === "approved") return phases.ready;
  return phases.review;
}
