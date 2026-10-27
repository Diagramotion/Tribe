# Distributed mission collaboration backlog

**Status: backlog only.** Distributed missions are an enterprise capability and are not part of the local-first release. Do not add relay traffic, account requirements, or cross-device mission sharing until the architecture and licence model are approved.

## Product boundary

Keep a user's Tribe workspace and agent execution local by default. An organisation may enable a shared mission service, hosted by Tribe or operated as a self-hosted relay. A mission owner invites named users to one mission; joining does not grant access to the owner's whole project, machine, repository credentials, other missions, or local agent configuration.

Participants remain independent users running their own agents on their own devices. They share the mission's agreed event stream, plan, request state and explicitly published artifacts. Repository access remains local to each participant. The relay must not imply that a remote participant can read or modify another participant's checkout.

## Proposed topology

```text
Participant A desktop                         Participant B desktop
  local SQLite + agents                         local SQLite + agents
  local repository                              local repository
        |                                                |
        +--- authenticated sync client ---+  +--- authenticated sync client ---+
                                         \  /
                                  Mission relay
                         canonical event order, membership,
                           durable delivery and task leases
```

The relay is the authority for shared mission membership, canonical event sequence, acknowledgements and cross-device task leases. Each desktop keeps a durable local replica and may continue read-only work while offline. Writes to shared mission state queue locally and sync idempotently on reconnect; agents must not claim shared plan work or make externally visible decisions against an expired lease.

The hosted and self-hosted relay must implement the same versioned protocol. Peer-to-peer-only transport is not the first design: it cannot provide durable delivery or a clear lease authority while participant devices sleep or go offline.

## Event and state model

- Preserve local mission event IDs and add relay-assigned canonical sequence, origin device, and sync state. Retries deduplicate by immutable event ID; clients never infer global order from wall-clock timestamps.
- Separate local-only events from events explicitly shared with the mission. Provider prompts, model traces, local paths, environment data, credentials, computer-use observations, and unshared artifacts remain local.
- Relay only versioned domain events and explicitly published artifact revisions. Store an opaque content hash and access-controlled blob reference for a shared artifact; do not silently upload the local artifact directory.
- Use a relay-issued task lease with a monotonically increasing fencing token, owner user/device/agent, expiry, and renewal. A stale lease holder must be rejected when publishing plan completion or an accepted shared change.
- Keep approval authority local to the machine performing an action. A remote participant cannot approve shell execution, deletion, MCP writes, computer actions, or other side effects on another user's device.
- Model conflict explicitly. Canonical events are append-only; project plan projections can reconcile from ordered events, while concurrent artifact edits produce reviewable proposals or branches rather than last-write-wins replacement.

## Repository and artifact collaboration

Do not share a live checkout or rely on the current local path-level lock across machines. Cross-device repository work uses separate local clones and an explicit branch, patch, or Git-host change request. Tribe should show the source user/device and commit base, detect stale bases, and require local review before applying incoming changes.

Canvas documents and other intentionally shared artifacts can collaborate through immutable revisions, proposals, comments and review decisions. A revision must carry its author, source device, parent revision and content hash. If the parent is no longer current, retain the proposal for review and require a merge or rebase decision.

## Identity, security and governance gates

- Define organisation, user, device, project, mission membership and role identities before protocol work. Invitations are scoped to one mission and expire or can be revoked.
- Authenticate clients with short-lived device credentials; keep long-lived secrets in the OS credential store. Self-hosted deployments need an operator-managed identity provider or documented local identity mode.
- Enforce tenant and mission authorization at every relay read, write, event replay, lease and blob request. Client-side filtering is not an access-control boundary.
- Encrypt transport and relay storage, define key rotation and deletion semantics, and set explicit retention/export policies. Decide whether self-hosted operators can inspect content and how end-to-end encryption would affect search, moderation and recovery.
- Add audit events for invitations, membership changes, sync, lease grants, artifact publication and revocation. A removed participant must lose future access; define treatment of data already synced to that participant's device.
- Distributed access is licensed separately as an enterprise capability. Specify entitlement checks, self-hosted activation, offline grace, upgrade/downgrade behaviour, and data export before rollout. Licence state must not be the sole security control.

## Failure cases to design before implementation

1. Relay unavailable during a long-running mission; retry without duplicate posts or lost artifact revisions.
2. Two devices reconnect with queued plan updates or stale lease holders.
3. A participant is removed while their device is offline, then reconnects with queued events.
4. An invitation is forwarded, expires, is revoked, or is accepted on multiple devices.
5. Relay restore from backup changes its sequence frontier or loses recently acknowledged events.
6. Artifact upload is interrupted, exceeds quotas, conflicts with a new revision, or is referenced by an event that has not arrived yet.
7. Self-hosted relay is upgraded or downgraded across protocol and schema versions.
8. One participant's agent asks another user to approve a local action; the action must remain pending on the machine where it would execute.

## Decision gate

Before implementation, produce an ADR and threat model that choose:

- Hosted service, self-hosted service, or both in the first enterprise release.
- Authentication and organisation tenancy; invitation and mission-role semantics.
- Event protocol, canonical sequencing, client cursors, offline queue and retention.
- Relay lease authority, fencing and recovery behaviour.
- Shared artifact storage, size limits, encryption, retention and export.
- Git collaboration mechanism and stale-base review flow.
- Enterprise licensing, self-hosted activation and offline grace.
- Data residency, operator access, incident response and support model.

Prototype event replay and lease fencing against two independent local databases before exposing a distributed mission UI. Acceptance must include disconnect/reconnect, relay restart, duplicate delivery, revocation while offline, stale lease rejection, artifact conflict, and protocol-version mismatch tests. Keep this backlog separate from dynamic/sub-agent delegation; distributed collaboration shares durable work between users and machines, while sub-agents are an execution primitive inside one user's mission.
