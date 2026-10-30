const assert = require("node:assert/strict");
const { createBrowserAgentControl } = require("./browser-agent-control.cjs");

const control = createBrowserAgentControl();
const firstRequest = control.state("workspace");
control.assertAllowed("workspace", firstRequest.revision);

control.setPaused("workspace", true);
assert.throws(() => control.assertAllowed("workspace", firstRequest.revision), { statusCode: 423 });
const pausedRequest = control.state("workspace");
assert.throws(() => control.assertAllowed("workspace", pausedRequest.revision), /stopped by the user/);

control.setPaused("workspace", false);
assert.throws(() => control.assertAllowed("workspace", pausedRequest.revision), { statusCode: 423 });
const resumedRequest = control.state("workspace");
control.assertAllowed("workspace", resumedRequest.revision);
control.assertAllowed("another-workspace", 0);

console.log("Browser agent-control lifecycle invariants passed.");
