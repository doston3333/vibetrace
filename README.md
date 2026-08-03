# VibeTrace

VibeTrace is a local-first, open-source forensic debugger and evaluation environment for AI coding sessions.

VT-001 provides the repository foundation: a dashboard placeholder, a CLI placeholder, workspace tooling, and CI. The architecture documents and accepted decisions below define the approved MVP direction; capture, storage, diagnostics, exports, and evaluations are not implemented yet.

## Documentation

- [Product plan](docs/product/product-plan.md)
- [MVP architecture overview](docs/architecture/overview.md)
- [Canonical event schema](docs/architecture/event-schema.md)
- [Capture modes and gaps](docs/architecture/capture-modes.md)
- [Privacy and encryption](docs/architecture/privacy.md)
- [ADR 0001: Local-first](docs/decisions/0001-local-first.md)
- [ADR 0002: Canonical event schema](docs/decisions/0002-canonical-event-schema.md)
- [ADR 0003: Codex-first capture](docs/decisions/0003-codex-first-capture.md)
- [ADR 0004: Deterministic analysis first](docs/decisions/0004-deterministic-analysis-first.md)
- [ADR 0005: Encryption at rest](docs/decisions/0005-encryption-at-rest.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Apache-2.0 license](LICENSE)

## Requirements

- Node.js 22.12.0 or later
- pnpm 10.33.4

## Workspace layout

- `apps/dashboard` — React and Vite dashboard placeholder
- `packages/cli` — `vibetrace` command-line placeholder

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Local use

Start the dashboard placeholder:

```bash
pnpm --filter @vibetrace/dashboard dev
```

Build the CLI, then inspect its available commands:

```bash
pnpm --filter @vibetrace/cli build
pnpm exec vibetrace --help
pnpm exec vibetrace --version
```
