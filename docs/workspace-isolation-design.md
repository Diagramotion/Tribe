# Workspace isolation design

## Decision status

Proposed boundary; implementation remains open. Tribe uses Pydantic AI Harness for file and shell capabilities. Do not add a second command runner or describe a Git worktree as a security sandbox.

## Current behaviour

An agent's repository tools are rooted at the project checkout or its detached Git worktree. Tribe validates repository paths, serialises file writes, records diffs and gates risky tool calls. Harness shell command allowlists reduce accidental command use, but an allowed executable can run other programs and access files and services available to the Tribe process. A Git worktree isolates edits from the shared checkout; it does not isolate filesystem, process or network access.

Pydantic AI Harness `LocalWorkspace` has the same boundary. In the pinned dependency, `LocalWorkspaceBackend` is POSIX-only because its timeout contract kills a process group. Tribe therefore omits Harness local filesystem, shell and deferred-skill capabilities on Windows and uses its cross-platform repository and skill tools there; this fallback still needs native Windows CI acceptance. Its `DockerSandbox` is a local container workspace and is the preferred framework primitive to evaluate before any custom process sandbox. Docker's default bridge can reach the internet and the host's local network; network access must be an explicit policy choice. The current lock includes Harness 0.61.0, whose installed package provides `DockerSandbox`.

On POSIX, if an agent starts an isolated worktree during a model run, the already-composed Harness workspace still points at the original checkout. Tribe now rejects Harness file and shell calls for the remainder of that run and directs the agent to Tribe's repository tools, which follow the live workspace root. A subsequent run composes Harness against the isolated root. This is a fail-closed transition guard, not yet a unified workspace provider.

## Required architecture

Isolation is a workspace provider behind one Tribe-owned workspace contract. Repository reads, edits, search, shell and tests must all operate on the same selected workspace. The provider must preserve Tribe's plan claims, write locks, change events, exact approvals, artifacts, cancellation and restart semantics.

For an isolated task, the candidate flow is:

1. Create a detached worktree from a clean project checkout.
2. Start the selected sandbox provider with access only to that worktree and the minimum runtime dependencies.
3. Expose one workspace backend to Pydantic AI Harness and Tribe tools; do not let local tools edit a separate host copy.
4. Keep external network disabled by default. If an approved operation needs network access, make that action explicit and bounded; never silently switch the whole sandbox to unrestricted networking.
5. On completion, stop and remove the sandbox, compare the worktree with its base, create a durable patch artifact and request individual approval before integration.
6. On interruption, persist the sandbox reference and workspace state, but do not replay an action with an unknown outcome.

This flow is not ready to ship. Harness `DockerSandbox` provides execution but does not by itself connect Tribe's synchronous repository tools, path-lock lifecycle, event recording or isolated patch review to that same container. A bind mount of the user's checkout would also weaken the isolation boundary and allow shell writes to bypass Tribe's per-file events. A container must not be presented as secure until those boundaries are joined and tested.

## Platform and product constraints

- Keep the normal local workspace as the default for the user's selected local-first workflow.
- Make sandbox availability explicit. If the configured container runtime is missing or unhealthy, fail closed for a sandbox-required task; never fall back silently to host execution.
- Keep container runtime installation optional for the desktop app. Show the user which workspace mode a mission uses and where its changes will land.
- Do not send provider credentials, desktop credentials or the host environment into a repository container. Provider requests continue from Tribe's runtime; the container receives no credentials unless a separately approved connector explicitly needs them.
- Make the network policy visible. `DockerSandbox(allow_internet_access=False)` is the safer starting point, but dependencies and tests may need network. Exact network approvals need a boundary that can actually restrict destinations; Docker's default bridge alone cannot enforce an approved-host list.
- Retain the existing detached-worktree review and approval before changes reach the shared checkout.

## Acceptance gate

Before describing this as sandboxing, verify on macOS and Windows that:

1. Harness file tools, Tribe repository tools and commands read and write the same isolated worktree.
2. A command cannot read or modify a sentinel file outside the worktree, including through symlinks, absolute paths, child processes or alternate drive paths.
3. Network is unavailable by default and does not reach host-local services; any allowed external operation is individually approved and cannot broaden later commands.
4. File locks, `repo.file.changed` events, artifacts, plan claims, cancellation and process-tree shutdown behave as they do for local work.
5. Restart and cleanup recover or remove the container without losing the worktree, duplicating events or replaying unknown actions.
6. A reviewed patch is the only path from isolated work into the shared checkout.

Until this gate passes, call the current mode **isolated worktree**, not **sandboxed execution**. The local repository boundary and shell allowlist remain operational guardrails, not protection against a hostile command.

## References

- [Pydantic AI Harness Shell](https://pydantic.dev/docs/ai/harness/shell/)
- [Pydantic AI Harness Docker Sandbox](https://pydantic.dev/docs/ai/harness/docker-sandbox/)
- [Pydantic AI Workspaces](https://pydantic.dev/docs/ai/core-concepts/workspace/)
