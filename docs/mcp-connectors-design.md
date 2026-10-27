# MCP service connections

## Boundary

Model providers and service connections are separate concerns. Pydantic AI selects the model provider; MCP connects agents to tools and data services. Keep remote services under the existing project-scoped MCP boundary rather than adding provider-specific connector code.

Use Pydantic AI's `MCPToolset` and its FastMCP client for protocol, discovery and tool lifecycle. Tribe should own the user flow, credential scope, permission policy, durable connection status and audit events. Continue using `load_mcp_toolsets` for ordinary stdio and HTTP configurations. OAuth needs a small direct `MCPToolset` construction path because the installed configuration loader maps HTTP entries to URL plus headers and does not expose its `auth` argument.

Pydantic AI documents HTTP authentication on `MCPToolset`; FastMCP provides an OAuth 2.1 authorization-code flow with PKCE, discovery, local browser callback, token refresh and a pluggable token store. FastMCP's default token store is in memory, so using its default OAuth configuration would silently lose sign-in at runtime restart. See [Pydantic AI MCP client](https://ai.pydantic.dev/mcp/client/) and [FastMCP OAuth client](https://gofastmcp.com/clients/auth/oauth).

## First-party connection flow

The Connections screen offers **Add a remote service** with a small form for no-auth, header-token or browser OAuth connections:

- Name shown to the user and agents.
- HTTPS service address. Permit HTTP only for loopback development servers.
- Authentication: no sign-in, a saved access token sent through a configurable HTTP header, or OAuth sign-in in the system browser.
- Requested OAuth scopes, with the server and scopes visible before opening the system browser.

After connection, show the server's advertised tools and let the user explicitly mark read-only tools. OAuth consent is initiated only by **Sign in and check**; agents cannot open a browser sign-in flow. The user can inspect sign-in state and forget credentials saved on this device. All non-read-only tool calls retain Tribe's exact-action approval. OAuth consent authorises the service account; it does not approve agent actions.

Keep advanced JSON for stdio commands and protocol options. The common OAuth flow must not require editing JSON or environment-variable names.

## Credential and event handling

- Store OAuth access/refresh tokens and any dynamic client registration data in the OS keychain through FastMCP's `AsyncKeyValue` storage interface.
- Scope credential keys to the local workspace, project, server identity and endpoint. Never store credentials in MCP JSON, SQLite, backups, mission events, agent prompts or logs.
- If OS credential storage is unavailable, fail closed; do not fall back to plaintext or memory-only storage.
- Persist only connection metadata and state such as `not_connected`, `connected`, `needs_sign_in` and the last successful check. Never persist token values or authorization codes.
- “Forget sign-in” deletes Tribe's local token and client-registration entries. It cannot promise to revoke the remote grant; explain that provider-side revocation may be needed.
- A local OAuth callback timeout or user cancellation leaves the service unconnected and must not enable its tools.

## Refresh concurrency

Tribe's role consumers run on separate worker threads and event loops. A new FastMCP `OAuth` object per agent run can therefore refresh the same rotating refresh token concurrently. FastMCP's in-object lock does not coordinate separate OAuth objects.

`LeasedOAuth` uses a per-connection cross-thread and cross-process refresh lease. It re-reads the latest keychain token after acquiring the lease, reuses a peer's newly rotated token instead of replaying the old one, and releases the lease after cancellation or failure. Normal authenticated MCP requests do not hold the lease. Each worker still owns its OAuth instance and event loop. Agent runs fail closed when credentials need interactive sign-in; a failed refresh clears local credentials and requires an explicit user sign-in. Network-free integration tests drive FastMCP's real authorization-code flow against a local test OAuth server (including dynamic registration, PKCE, callback and token exchange), and its refresh flow against an expired token. A separate integration test connects `MCPRegistry` and Pydantic AI's `MCPToolset` to an OAuth-protected MCP SDK server, discovers tools, invokes a read-only tool, then drives a mutating call through the agent's exact-action approval, one-time resolution and resume path. Tests also verify credential survival across OAuth adapter recreation and that callback timeout leaves credentials unset. They do not exercise an external provider, user cancellation through a real system browser, or concurrent refresh in separate runtime processes.

## Network and permission boundary

Require HTTPS for non-loopback endpoints, reject embedded credentials and validate resolved addresses before contacting a server or following OAuth discovery endpoints. Do not let an OAuth-enabled URL bypass the existing MCP endpoint policy. Treat server descriptions and tool output as untrusted. Apply the existing per-tool read-only list and exact approval gate to OAuth and token-authenticated servers equally.

## Implementation gates

Progress: the keychain-backed `AsyncKeyValue` store, OAuth connection schema, explicit browser sign-in, direct Pydantic AI `MCPToolset` path, sign-in status and forget actions are implemented. Tokens are scoped by workspace, project, service and endpoint and are excluded from MCP JSON and events. Focused tests cover in-process authorization-code/PKCE sign-in, callback timeout, token refresh, OAuth-protected MCP tool discovery/invocation, read-only filtering, exact mutating-call approval and resume, lock contention across worker threads/processes, cancellation of a lease wait, non-serialised normal requests, stale refresh-token reuse, and OAuth config/status handling. External provider behaviour, user cancellation through a real system browser, concurrent token refresh in separate runtime processes, revocation coverage, durable last-check state and packaged macOS/Windows callback acceptance remain.

1. Validate the connection schema, status and forget operations. **Implemented.**
2. Build an in-process OAuth authorization server and verify authorization, callback cancellation, restart persistence, revoked credentials and secret-free event history. Dynamic registration, PKCE callback, token exchange, refresh, authenticated requests, OAuth-protected Pydantic MCP tool discovery/invocation and fail-closed callback timeout now have network-free integration coverage; explicit user cancellation and revoked credentials remain.
3. Exercise simultaneous refresh from separate role worker threads and a second runtime process against the same local data directory. Primitive and stale-token unit coverage exists; real provider-flow contention remains.
4. Add OAuth sign-in state and token-forget actions to Settings. **Implemented.** OAuth-protected MCP tests verify read-only role filtering and exact one-time approval/resume for mutating calls.
5. Verify the login callback and system-browser hand-off in the packaged macOS app and Windows WebView/sidecar setup.

Distributed Tribe remains separate. OAuth credentials are local to a participant and are never shared through a mission relay.
