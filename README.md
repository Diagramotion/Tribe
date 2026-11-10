# Tribe — Local-First AI Agent Workspace for Software Engineering

[![Desktop builds](https://github.com/Diagramotion/Tribe/actions/workflows/desktop.yml/badge.svg?branch=main)](https://github.com/Diagramotion/Tribe/actions/workflows/desktop.yml)
[![CodeQL](https://github.com/Diagramotion/Tribe/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Diagramotion/Tribe/actions/workflows/codeql.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

Tribe is a local-first desktop workspace for software development with AI agents. It brings project chats, coordinated agent roles, shared plans, repository work and run history into one place, while the application runtime stays on your machine. Connect the model provider you choose, including a local model endpoint, and keep project work in a workspace you control.

> **Prototype status:** Tribe is under active development. Features, packaging and platform support are evolving. Check the [capability roadmap](docs/parity-roadmap.md) for current scope and known gaps. The Tauri desktop distribution is the established shell; the Electron shell is an experimental route for managed Chromium browser workflows and is not yet release-ready.

![Tribe's dark desktop workspace showing model provider settings](design-qa-implementation.png)

*Model provider setup in Tribe's desktop workspace.*

## What you can do

- **Work in project context:** connect a local folder, with or without Git, and keep chats and project guidance together.
- **Coordinate AI agents:** assign work to selected roles around a shared plan and durable run history.
- **Stay close to the code:** browse and edit repository files, inspect Git changes, and review command and test runs.
- **Use your model setup:** connect hosted providers or a local model endpoint. Tribe does not include model access or subscriptions; provider availability, pricing and terms are set by each provider. Local inference requires a separately installed endpoint such as [Ollama](https://ollama.com/).

Tribe is designed as a local-first AI coding workspace, not a hosted agent service. Review project permissions and provider terms before using sensitive data. See [security and local data](#security-and-local-data) for current boundaries.

## Get started from source

### Requirements

- Node.js 22
- Python 3.11 or later
- [uv](https://docs.astral.sh/uv/)

### Start the workspace

```sh
git clone https://github.com/Diagramotion/Tribe.git
cd Tribe
npm ci
uv sync --project runtime --extra ai
npm run dev
```

Open the local URL printed by Vite. Add a workspace folder, then configure a model provider and credentials in **Settings** to run model-backed agents. To develop the established Tauri desktop shell, run `npm run desktop:dev`. See [runtime and application architecture](docs/runtime-foundation.md) for the shell and local runtime boundaries.

## Project status and design

Tribe's roadmap is intentionally public. It tracks the capabilities being built, the dependencies between them and gaps that remain; it is not a claim of feature parity with other products. Start with the [capability roadmap](docs/parity-roadmap.md), then see the [browser workbench design](docs/browser-workbench-design.md) for the experimental managed browser direction.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, checks and pull request guidance. For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Security and local data

Tribe can access project folders and capabilities that the user configures. Application data and credentials are stored locally. Model requests are sent to the configured provider under that provider's terms. Review project permissions and provider terms before using sensitive data; see [runtime and application architecture](docs/runtime-foundation.md) for current boundaries and limitations.

## Licence

Tribe is licensed under the [Apache License 2.0](LICENSE). Third-party components and assets may have separate terms; retain their notices and review the relevant upstream licence before redistribution. Python runtime notices are in [THIRD_PARTY_NOTICES.md](runtime/tribe_runtime/THIRD_PARTY_NOTICES.md).
