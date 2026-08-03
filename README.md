# VibeTrace

VibeTrace is a local-first, open-source forensic debugger for AI coding sessions. Evaluation and replay are roadmap work, not part of the strict MVP.

The current MVP foundation includes the canonical trace schema and deterministic fixtures, encrypted local SQLite/blob storage, a crash-safe spool, an authenticated loopback daemon, Codex lifecycle-hook capture, a responsive forensic dashboard, evidence-linked deterministic diagnostics, annotations, and previewed scrubbed bundles encrypted with standard age passphrase encryption.

## Documentation

- [Product plan](docs/product/product-plan.md)
- [MVP architecture overview](docs/architecture/overview.md)
- [Canonical event schema](docs/architecture/event-schema.md)
- [Capture modes and gaps](docs/architecture/capture-modes.md)
- [Privacy and encryption](docs/architecture/privacy.md)
- [Portable encrypted bundles](docs/architecture/portable-bundles.md)
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
- `packages/bundle` — derived redaction views and bounded standard-age portable bundles
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

List and inspect sessions, or preview and create an encrypted scrubbed bundle:

```bash
pnpm exec vibetrace sessions list
pnpm exec vibetrace sessions show <session-id>
pnpm exec vibetrace export <session-id> --profile share-safe --output trace.vibetrace.age
pnpm exec vibetrace import trace.vibetrace.age
```

Export prints the exact versioned manifest before hidden passphrase entry. The manifest hash is submitted with the export request, so a changed session requires a new preview. Portable bundles have no plaintext mode.

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
