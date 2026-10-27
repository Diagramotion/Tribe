# Product benchmark references

**Purpose:** use Codex, Claude Code and Sarathi as product and usability references for Tribe. They are not Tribe execution backends. Tribe runs agents through Pydantic AI provider APIs, compatible gateways and local model endpoints.

This is a directional comparison, not a claim of feature parity. Product capabilities change; verify them again before using this document for a release decision.

## Patterns worth benchmarking

| Reference | Product pattern | Tribe implication |
| --- | --- | --- |
| Codex | Organise independent tasks under projects; run work in parallel; review diffs, comment and open changes in an editor; isolate risky parallel work in worktrees; manage reusable skills and scheduled automations. | Preserve Tribe's project → mission hierarchy and shared mission channel. Keep task ownership, agent lanes, artifacts and exact approvals visible together. Improve diff navigation and the review path for isolated work. |
| Claude Code | Show live progress in an IDE or terminal; save checkpoints before changes and offer rewind; use specialist subagents, hooks and background tasks for longer work. | Keep long-running command state durable and user-readable. Evaluate checkpoint/rewind as a future repository safety feature. Dynamic delegation remains in its fit-assessment backlog; it must not bypass Tribe's task claims, event history, permissions or recovery. |
| Sarathi | Make the team channel itself the collaboration surface: Markdown-defined agents, agent-to-agent messages, structured user questions, concrete tool approvals, MCP services, browser automation, durable memory, workflows, schedules and shared artifacts. | Keep the channel-first team model, while strengthening event durability, user-request handling, artifact collaboration, provider portability and project navigation. Compare every feature against Sarathi's working product, not only its README or this summary. |
| ChatGPT and Gemini | Responses can mix prose with task-specific interactive elements such as buttons, forms, visual layouts, charts, simulations and dynamic views. Interactions can shape follow-up turns. | Add typed interactive response blocks to the channel. Persist action outcomes and make relevant state available to the responsible agent; keep plain prose as the default for simple answers. |

The Codex reference is based on [OpenAI's Codex app overview](https://openai.com/index/introducing-the-codex-app/) and its current [Codex plan guide](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan). The Claude Code patterns are from [Anthropic's overview of autonomous-work features](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously). ChatGPT's interactive response pattern is documented in [Intelligent UI](https://help.openai.com/en/articles/20001598-intelligent-ui-in-chatgpt); [ChatKit widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets) show an explicit action-payload path from widgets to an application backend. Google's current [Gemini app simulation announcement](https://workspaceupdates.googleblog.com/2026/08/generate-interactive-simulations-and-models-in-the-Gemini-app.html), [2026 product direction](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/) and earlier descriptions of [Gemini 3 in Search](https://blog.google/products-and-platforms/products/search/gemini-3-search-ai-mode/) cover interactive simulations, visual responses and dynamic views. Sarathi's feature inventory is based on its README plus a read-only source/test-module inventory; verify each workflow before claiming parity. Keep the Sarathi workspace read-only.

## Tribe coverage and open gaps

The capability ledger in [`parity-roadmap.md`](parity-roadmap.md) remains the authoritative implementation status. At the time of this review, Tribe already has:

- projects with one repository each, durable missions, a shared event channel, self-claiming plan items and a read-only Kanban projection;
- per-agent activity lanes, grouped live activity, durable requests and action-specific approvals;
- shared artifacts with agent/user proposals, revisions, comments and review actions;
- project/user skill discovery, role definitions, MCP connections, workflows, schedules and user-launched background commands;
- worktree isolation for risky repository changes and recovery paths for interrupted agent runs.

Material gaps still tracked in the roadmap include stage-specific SDLC gates, complete provider setup for multi-credential providers, billing-grade spend controls, operation-level recovery for external side effects, real packaged computer-use acceptance on supported desktop platforms, reliable Windows installer/lifecycle acceptance, richer outcomes/evaluation workflows, and continued visual acceptance of the native UI.

Distributed Tribe collaboration remains an enterprise backlog item with a separate licensing model. Dynamic and/or child-agent execution remains a backlog item pending a bounded fit prototype. Neither belongs in the local-first release by default.

## Product boundary

- Benchmark Codex and Claude Code for task organisation, progress visibility, change review, skills, automations and recovery UX.
- Benchmark Sarathi for channel-first multi-agent collaboration, approvals, questions, tools, artifacts and project workflows.
- Do not copy benchmark-specific runtime assumptions into Tribe. In particular, CLI subscriptions and coding-harness execution APIs are not Tribe model-provider integrations.
- Prefer the framework's current capabilities when they fit Tribe's contracts. Keep Tribe-specific events, ownership, approval, audit and recovery semantics explicit and durable.
