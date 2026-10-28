const OPERATIONAL_ARTIFACT_NAME = /^(?:test-results-|run_command-output-)|\.diff$/i;

export function isShareableArtifact(artifact) {
  return !OPERATIONAL_ARTIFACT_NAME.test(String(artifact?.name ?? ""));
}

export function shareableArtifacts(artifacts = []) {
  return artifacts.filter(isShareableArtifact);
}
