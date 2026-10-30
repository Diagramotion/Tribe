function createBrowserAgentControl() {
  const scopes = new Map();
  const stateFor = (scope) => {
    if (!scopes.has(scope)) scopes.set(scope, { paused: false, revision: 0 });
    return scopes.get(scope);
  };

  return {
    state(scope) {
      const { paused, revision } = stateFor(scope);
      return { paused, revision };
    },
    setPaused(scope, paused) {
      const state = stateFor(scope);
      if (state.paused !== Boolean(paused)) {
        state.paused = Boolean(paused);
        state.revision += 1;
      }
      return { ...state };
    },
    assertAllowed(scope, revision) {
      const state = stateFor(scope);
      if (state.paused || state.revision !== revision) {
        throw Object.assign(new Error("Browser control was stopped by the user."), { statusCode: 423 });
      }
    },
  };
}

module.exports = { createBrowserAgentControl };
