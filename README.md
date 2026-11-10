# Tribe

Tribe is a local-first desktop workspace for using AI agents on software projects. It brings project chats, shared planning, repository work, reviews and deliverables into one workspace, with the application runtime running locally.

Tribe is an active prototype. Capabilities and platform support are still evolving; see the [capability roadmap](docs/parity-roadmap.md) for current scope and known gaps.

## What it does

- Connects project chats to a local folder, with optional Git.
- Coordinates selected agent roles around shared tasks and project context.
- Provides a desktop workspace for repository files, runs, plans and artifacts.
- Supports hosted model providers and local model endpoints configured by the user.

The project does not include model access or subscriptions. Provider availability, pricing and terms are set by the provider. Local inference requires a separately installed endpoint such as Ollama.

## Run from source

Requirements: Node.js 22, Python 3.11 or later, and [uv](https://docs.astral.sh/uv/).

```sh
npm ci
uv sync --project runtime --extra ai
npm run dev
```

Open the local URL printed by Vite. Add a workspace folder, then configure a model provider and credentials in Settings to run model-backed agents. The desktop shell can be developed with `npm run desktop:dev`; platform packaging details are in [runtime and application architecture](docs/runtime-foundation.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, checks and pull request guidance. Product direction and capability status are tracked in the [roadmap](docs/parity-roadmap.md).

## Security and local data

Tribe can access the project folders and capabilities that the user configures. Review project permissions and model-provider terms before using sensitive data. Application data and credentials are stored locally; see the architecture guide for runtime boundaries and current limitations.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Licence

Tribe is licensed under the Apache License 2.0. See [LICENSE](LICENSE). Third-party components and assets may have separate terms; retain their notices and review the relevant upstream licence before redistribution. Runtime notices are in [runtime/tribe_runtime/THIRD_PARTY_NOTICES.md](runtime/tribe_runtime/THIRD_PARTY_NOTICES.md).
