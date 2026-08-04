# VibeTrace

VibeTrace is a local-first, open-source forensic debugger and evaluation lab for AI coding sessions.

The production foundation includes the canonical trace schema and deterministic fixtures, encrypted local SQLite/blob storage, a crash-safe spool, an authenticated loopback daemon, Codex lifecycle-hook and app-server capture, a named Claude Code adapter, generic JSONL and opt-in OpenTelemetry adapters, a responsive forensic dashboard, evidence-linked deterministic and optional tool-free AI findings, annotations, isolated evaluation runs, deterministic comparison summaries, and previewed scrubbed bundles encrypted with standard age passphrase encryption.

## Documentation

- [Product plan](docs/product/product-plan.md)
- [MVP architecture overview](docs/architecture/overview.md)
- [Canonical event schema](docs/architecture/event-schema.md)
- [Capture modes and gaps](docs/architecture/capture-modes.md)
- [Privacy and encryption](docs/architecture/privacy.md)
- [Portable encrypted bundles](docs/architecture/portable-bundles.md)
- [Release gate](docs/release.md)
- [Production-readiness matrix](docs/production-readiness.md)
- [Deterministic diagnostic rules](docs/diagnostics/rules.md)
- [Diagnostic fixture precision/recall report](docs/diagnostics/precision-recall.md)
- [Evaluation and comparison architecture](docs/architecture/evaluation.md)
- [Generated evaluation manifest schema](packages/eval-spec/generated/eval-manifest.schema.json)
- [Adapter SDK](packages/adapter-sdk/README.md)
- [Adapter contract RFC](rfcs/0001-adapter-contract.md)
- [Example local configuration](examples/config/vibetrace.toml)
- [Sample trace corpus](examples/sample-traces/README.md)
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
- macOS 14+ (x64 or arm64), glibc-based Linux (x64), or Windows 11 (x64)
- pnpm 10.33.4 for source development only

## Install

Install the public CLI package and confirm the bundled command is available:

```bash
npm install --global @vibetrace/cli
vibetrace --version
```

The npm package contains the CLI, loopback daemon, and compiled dashboard. It
does not install a login service; `vibetrace open` starts the daemon when
needed.

## Workspace layout

- `apps/dashboard` — React and Vite forensic dashboard
- `packages/adapter-codex` — versioned Codex hook, installer, doctor, and transcript adapter
- `packages/adapter-codex-app-server` — opt-in full-fidelity Codex app-server JSONL adapter
- `packages/adapter-claude-code` — named Claude Code lifecycle-hook adapter
- `packages/adapter-generic-jsonl` — bounded generic agent JSONL adapter
- `packages/adapter-otel` — opt-in OpenTelemetry enrichment adapter
- `packages/adapter-sdk` — source-adapter capability and conformance contracts
- `packages/analyzer-ai` — provider-neutral, tool-free structured analyzer boundary
- `packages/bundle` — derived redaction views and bounded standard-age portable bundles
- `packages/cli` — the `vibetrace` command-line interface
- `packages/daemon` — authenticated loopback API and crash-safe spool importer
- `packages/diagnostics` — versioned deterministic rules and labeled fixture corpus
- `packages/enrichment` — repository, command, verification, and run-fingerprint evidence
- `packages/eval-spec` — versioned, reviewable evaluation manifests
- `packages/eval-runner` — shell-free isolated worktree execution and assertions
- `packages/eval-compare` — deterministic comparison metrics and divergence analysis
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
vibetrace init codex --dry-run
vibetrace init codex
vibetrace doctor
```

Captured hooks write directly to the local spool even when the daemon is stopped. Start and open the local dashboard separately:

```bash
vibetrace start
vibetrace open
```

For optional model-assisted diagnosis, open a session and choose **AI review**.
The dashboard prepares a bounded prompt locally; you copy it to a provider you
approve and paste back the JSON response. VibeTrace does not call a provider or
send trace data over the network, and it rejects responses whose analyzer
version, prompt digest, or evidence IDs no longer match the session.

List and inspect sessions, or preview and create an encrypted scrubbed bundle:

```bash
vibetrace sessions list
vibetrace sessions show <session-id>
vibetrace export <session-id> --profile share-safe --output trace.vibetrace.age
vibetrace import trace.vibetrace.age

# Run an opt-in full-fidelity Codex Lab session with scoped interactive approvals.
vibetrace codex app-server --prompt "Inspect the repository" --approval-policy prompt
# Resume or fork a captured app-server thread when the source contract supports it.
vibetrace codex app-server --prompt "Continue" --thread-mode resume --thread-id <thread-id>

# Convert a captured session into a reviewed eval, run it in a detached worktree,
# then compare persisted runs.
vibetrace eval create <session-id> --name "authorization regression"
vibetrace eval validate eval-manifest.json --json
vibetrace eval run eval-manifest.json --cwd /path/to/checkout --json
# Matrix files are JSON with at least two variants and optional repetitions.
vibetrace eval matrix eval-manifest.json eval-matrix.json --cwd /path/to/checkout --json
vibetrace eval compare <comparison-id> --json
vibetrace eval compare-divergence <comparison-id> <left-run-id> <right-run-id> left-events.json right-events.json --json
```

Export prints the exact versioned manifest before hidden passphrase entry. The manifest hash is submitted with the export request, so a changed session requires a new preview. Portable bundles have no plaintext mode.

Matrix execution is bounded to 100 variants, 100 repetitions, and 1,000 total
runs. Each arm gets a fresh detached worktree and is persisted with its variant
ID and one-based repetition:

```json
{
  "name": "prompt and model variants",
  "repetitions": 2,
  "variants": [
    { "id": "control", "prompt": "Use the captured task." },
    {
      "id": "treatment",
      "prompt": "Use the clarified task.",
      "model": "gpt-5.6-codex"
    }
  ]
}
```

Remove only the exact manifest-owned handlers with:

```bash
vibetrace uninstall codex --dry-run
vibetrace uninstall codex
```

On headless Linux without a usable keyring, unlock storage without placing the
passphrase in process arguments or environment variables:

```bash
printf '%s\n' "$VIBETRACE_STORAGE_PASSPHRASE" | vibetrace start --storage-passphrase-stdin
```

The named shell variable is only an example owned by the calling shell;
VibeTrace does not read storage passphrases from the environment.

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
