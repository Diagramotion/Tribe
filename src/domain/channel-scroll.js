export function nextChannelPinnedState(currentlyPinned, observedAtBottom, userMoved) {
  if (userMoved) return false;
  if (observedAtBottom) return true;
  return currentlyPinned;
}

export function channelFollowOutput(isPinnedToLatest) {
  return isPinnedToLatest ? "auto" : false;
}

export function channelIsAtBottom(metrics, threshold, reportedAtBottom, fallback = false) {
  if (metrics && Number.isFinite(metrics.scrollHeight)
    && Number.isFinite(metrics.scrollTop) && Number.isFinite(metrics.clientHeight)) {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
  }
  return typeof reportedAtBottom === "boolean" ? reportedAtBottom : fallback;
}
