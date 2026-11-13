# Contributing to Tribe

Thanks for your interest in improving Tribe. The project is an active prototype, so larger changes are best discussed in an issue before implementation. Keep changes focused and follow the existing architecture and product boundaries documented in `docs/` and `AGENTS.md`.

## Development setup

Requirements: Node.js 22, Python 3.11 or later, and `uv`.

```sh
npm ci
uv sync --project runtime --extra ai --extra test
npm run dev
```

For the Electron desktop shell and managed Browser, use `npm run desktop:dev`. The legacy Tauri shell is available separately through `npm run desktop:tauri:dev`.

## Checks

Run the checks relevant to your change before opening a pull request:

```sh
npm run test:ui
npm run test:sites
npm run test:browser
uv run --project runtime --extra ai --extra test python -m unittest discover -s runtime/tests
```

The desktop build and native tests are also exercised by GitHub Actions on macOS and Windows. Browser end-to-end checks require a graphical desktop environment and are separate from `npm run test:browser`.

## Pull requests

- Explain the user-visible problem and the behaviour changed.
- Keep the diff focused; include or update tests for behavioural changes.
- Update product and architecture documentation when the supported behaviour or boundary changes.
- Do not include credentials, personal data, generated build output or unrelated local changes.
- Preserve third-party copyright and licence notices. Identify new dependencies and bundled assets with their source and licence.
- Avoid claims of platform support or verification that the change does not establish.

By submitting a contribution, you agree that it is offered under the repository's Apache License 2.0, unless you explicitly state otherwise.
