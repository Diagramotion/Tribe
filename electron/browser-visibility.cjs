function shouldShowBrowserHost(layout, tab, active) {
  const bounds = layout?.bounds;
  return Boolean(layout?.visible && active && tab?.hasPage !== false && !tab?.pageStopped && !tab?.viewportTransitionCount
    && Number(bounds?.width) > 0 && Number(bounds?.height) > 0);
}

module.exports = { shouldShowBrowserHost };
