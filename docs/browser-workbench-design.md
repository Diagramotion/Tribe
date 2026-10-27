# Browser workbench design

## Decision

Build the first Browser pane as an **agent browser session inspector**. It should show the browser session used by the current chat's agent, rather than opening an unrelated embedded browser. This keeps the user looking at the same page and activity the agent is using. A user-owned browsing preview can be considered separately if there is a concrete workflow for it.

The pane belongs beside Repository, Git changes, Artifacts and Preview in the existing resizable workspace pane. It stays open while the user reads the chat and follows the current chat's session; opening another project tool must not reset the chat or its scroll position.

## User experience

- Keep a Browser tab discoverable in the workspace pane. If browser access is not configured, explain the project setting required and link directly to it.
- Show the current session state: starting, open, waiting for approval, complete, stopped or unavailable. Identify the chat and agent that own it.
- Show the active page title and hostname, the latest safe visual snapshot when available, and a compact list of recent browser actions. Do not show URL paths, query strings, entered text, credentials or cookies in routine labels.
- Keep every consequential browser action approval in the chat, with the exact target and action. The Browser pane may link to that request and show its state; it must not add a second, divergent approval control.
- Provide a clear stop/end-session action only when the runtime can guarantee it targets that exact session. Ended sessions remain readable as activity, without retaining page screenshots by default.
- Let the user explicitly save a reviewed screenshot as a chat artifact. Do not persist screenshots, page contents or browser storage automatically.

## Security and runtime boundary

- Reuse the project's configured Playwright browser capability and approved-host policy. Do not create a second browser with different cookies or permissions while presenting it as the agent's session.
- Keep the browser engine isolated from Tribe's application origin. Never render an untrusted page in a privileged in-app webview.
- The current Playwright MCP integration does not expose a durable session identifier, session lifecycle API, or live visual snapshot to the workspace pane. Do not simulate those capabilities with status text or a separate browsing context.
- Before implementing the pane, add a narrow runtime session contract that binds a browser session to its project, chat, agent and MCP connection; exposes bounded page metadata and an optional screenshot; and supports explicit stop/cancel. Reconnect and worker restart must report an unavailable or ended session rather than silently creating a replacement.
- Keep raw page content and screenshots out of durable event records, logs and model snapshots. Preserve the existing exact-call approval and host allowlist boundaries. Any saved screenshot must use the existing explicit artifact flow.

## Delivery order

1. Define and verify the runtime session contract and its ownership/lifecycle semantics.
2. Add a read-only Browser pane for an active session, including empty, waiting, ended and unavailable states.
3. Verify the pane beside chat at 1536×855, test resize and chat-scroll preservation, and exercise approval, cancellation, restart and privacy paths.
4. Consider user-controlled navigation only as a separate feature with its own profile, permissions and explicit action model.

## Acceptance

- The user can tell which chat and agent own the displayed browser session.
- A screenshot or page summary is demonstrably from that session, not a second browser.
- Browser actions still require the existing exact approval; the pane cannot bypass it.
- The chat remains visible and does not lose scroll position when the pane opens or changes tools.
- No URL secrets, form input, page contents or screenshots are persisted unless the user explicitly saves an artifact.
- Missing browser access, session failure, cancellation and restart are communicated without a browser-native dialog or false “live” state.
