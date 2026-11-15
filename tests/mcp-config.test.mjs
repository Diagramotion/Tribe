import assert from "node:assert/strict";
import test from "node:test";
import { sortMcpServerNames } from "../src/domain/mcp-config.js";

test("MCP server names use locale-aware alphabetical ordering", () => {
  const servers = { zulu: {}, "äther": {}, alpha: {} };

  assert.deepEqual(sortMcpServerNames(servers), ["alpha", "äther", "zulu"]);
  assert.deepEqual(Object.keys(servers), ["zulu", "äther", "alpha"]);
});

test("missing MCP configuration yields an empty server list", () => {
  assert.deepEqual(sortMcpServerNames(undefined), []);
  assert.deepEqual(sortMcpServerNames(null), []);
});
