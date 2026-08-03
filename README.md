# VibeTrace

VibeTrace is a local-first, open-source forensic debugger and evaluation environment for AI coding sessions.

The current MVP foundation includes the canonical trace schema and deterministic fixtures, encrypted local SQLite/blob storage, a crash-safe spool, an authenticated loopback daemon, Codex lifecycle-hook capture, a responsive forensic dashboard, and evidence-linked deterministic diagnostics. Portable encrypted bundle workflows are built in the next roadmap slice.

## Documentation

- [Product plan](docs/product/product-plan.md)
- [MVP architecture overview](docs/architecture/overview.md)
- [Canonical event schema](docs/architecture/event-schema.md)
- [Capture modes and gaps](docs/architecture/capture-modes.md)
- [Privacy and encryption](docs/architecture/privacy.md)
- [Deterministic diagnostic rules](docs/diagnostics/rules.md)
- [Diagnostic fixture precision/recall report](docs/diagnostics/precision-recall.md)
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

- `apps/dashboard` — React and Vite forensic dashboard
- `packages/adapter-codex` — versioned Codex hook, installer, doctor, and transcript adapter
- `packages/cli` — the `vibetrace` command-line interface
- `packages/daemon` — authenticated loopback API and crash-safe spool importer
- `packages/diagnostics` — versioned deterministic rules and labeled fixture corpus
- `packages/enrichment` — repository, command, verification, and run-fingerprint evidence
- `packages/schema` — canonical trace model and stable identifiers
- `packages/storage` — encrypted SQLCipher-compatible storage and blob layer
- `packages/test-fixtures` — deterministic trace corpora

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

Preview and install the Codex integration, then approve the exact handler definitions in Codex with `/hooks`:

```bash
pnpm exec vibetrace init codex --dry-run
pnpm exec vibetrace init codex
pnpm exec vibetrace doctor
```

Captured hooks write directly to the local spool even when the daemon is stopped. Start and open the local dashboard separately:

```bash
pnpm exec vibetrace start
pnpm exec vibetrace open
```

Remove only the exact manifest-owned handlers with:

```bash
pnpm exec vibetrace uninstall codex --dry-run
pnpm exec vibetrace uninstall codex
```

Start the dashboard during development:

```bash
pnpm --filter @vibetrace/dashboard dev
```

Build the CLI, then inspect its available commands:

```bash
pnpm --filter @vibetrace/cli build
pnpm exec vibetrace --help
pnpm exec vibetrace --version
```
