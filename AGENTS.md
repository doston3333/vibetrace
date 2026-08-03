# AGENTS.md — VibeTrace Repository Guidance

## Product mission

VibeTrace is a local-first, open-source forensic debugger and evaluation environment for AI coding sessions. It captures observable execution, reconstructs sessions, produces evidence-linked diagnostics, and converts real sessions into reproducible evals.

## Non-negotiable product rules

1. Never claim access to hidden reasoning that the source does not expose.
2. Every diagnosis must reference concrete event IDs.
3. Local-first: no network upload, account requirement, or telemetry by default.
4. Never execute imported trace content.
5. Never run eval replays in the user’s active checkout; use a clean worktree or container.
6. Preserve raw source events immutably. Normalized events are derived and versioned.
7. Capture gaps must be explicit in the schema and UI.
8. Do not add a new agent adapter until the Codex adapter’s current milestone exit criteria pass.
9. Do not perform unrelated refactors while implementing a scoped task.
10. Do not add production dependencies without explaining why existing dependencies are insufficient.

## Repository structure

- `apps/dashboard`: local React dashboard
- `packages/cli`: command-line interface
- `packages/daemon`: local ingest and API process
- `packages/schema`: canonical event and bundle schemas
- `packages/storage`: SQLite and blob storage
- `packages/adapter-*`: source-specific adapters
- `packages/analyzer-*`: deterministic and optional AI analysis
- `packages/redaction`: secret detection and export views
- `packages/eval-*`: eval format and isolated runner
- `docs/architecture`: system architecture
- `docs/decisions`: architecture decision records
- `examples`: sample traces and evals

## Standard commands

Use pnpm.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run the smallest relevant test during implementation, then run the full required verification before declaring completion.

## Engineering conventions

- TypeScript strict mode must remain enabled.
- Public package APIs require explicit types and documentation.
- Validate all external input at runtime.
- Prefer pure functions for event normalization and diagnostic rules.
- Store timestamps in ISO 8601 UTC and preserve source timestamps separately when needed.
- Use stable IDs and idempotent imports.
- Large payloads belong in the blob store, not directly in normal query rows.
- Avoid hidden global state.
- Database migrations must be forward-only and tested.
- Error messages must identify the failing adapter, session, or artifact without exposing secrets.

## Schema rules

- Every canonical event includes `schemaVersion`, `id`, `sessionId`, `sequence`, `timestamp`, `source`, `type`, `payload`, and `provenance`.
- Unknown source fields must be preserved in the raw payload.
- Breaking schema changes require a new schema version and migration coverage.
- Findings may not reference nonexistent events.
- Redaction creates a derived export view and never mutates the private original.

## Privacy and security rules

- Bind local services only to loopback or Unix sockets.
- Require a random local auth token for HTTP access.
- Escape all trace content in the UI.
- Treat prompts, tool output, diffs, and imported bundles as untrusted data.
- Defend imports against path traversal, archive bombs, symlinks, and oversized payloads.
- Never persist raw environment-variable values by default.
- Tests must include known secret formats and malicious trace payloads.

## UI rules

- Optimize for long sessions using virtualization and progressive loading.
- Distinguish facts, deterministic findings, user labels, and model-inferred hypotheses visually.
- Do not display one universal quality score.
- Always show capture completeness and gaps.
- A finding card must navigate to its evidence.
- Avoid decorative complexity that obscures chronology.

## Diagnostic-rule rules

Each rule must include:

- Stable rule ID
- Version
- Category
- Positive fixture
- Negative fixture
- Edge-case fixture
- Evidence event IDs
- Clear recommendation

Rules must be deterministic unless they are explicitly part of the optional AI analyzer.

## Definition of done for a task

A task is done only when:

1. Requirements and acceptance criteria are met.
2. Relevant tests are added or updated.
3. Lint and typecheck pass.
4. The smallest relevant tests pass.
5. Full verification required by the task passes.
6. Documentation is updated when behavior or public interfaces change.
7. No unrelated files were modified.
8. Security and privacy implications were considered.
9. The final response lists files changed, tests run, and any remaining uncertainty.

## Working process for Codex

1. Read this file and the task-specific documents.
2. Inspect the existing implementation before proposing changes.
3. Produce a concise implementation plan.
4. Implement one coherent vertical slice.
5. Verify incrementally.
6. Review the diff against the acceptance criteria.
7. Do not claim completion after a failed verification command.
