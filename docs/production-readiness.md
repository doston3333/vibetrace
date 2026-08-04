# Production readiness matrix

This is the release evidence index for the documented VibeTrace target. A
capability is marked complete only when the implementation and its required
verification are both present. Native smoke evidence is intentionally kept as
an external release artifact; a local Linux pass cannot stand in for macOS or
Windows.

| Area                                  | Implementation evidence                                                                                                                                                                                                        | Verification                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Canonical schema and raw preservation | `packages/schema`, generated JSON Schema, deterministic IDs, migration registry                                                                                                                                                | schema, fixture, and integration gates                         |
| Encrypted storage and blobs           | `packages/storage`, SQLCipher-compatible database, keyed authenticated blobs, FTS5                                                                                                                                             | storage/security/performance gates                             |
| Crash-safe capture                    | `packages/daemon/src/spool.ts`, atomic sealed segments, quarantine, checkpoints, cross-process capacity reservation, bounded incoming/total/quarantine retention, post-commit archive retention, and health pressure reporting | daemon integration/security gates                              |
| Authenticated local API               | loopback Fastify API, bearer daemon token, ticket-bound single-use browser handoff and strict origin checks                                                                                                                    | daemon and pack smoke gates                                    |
| Codex hooks                           | `packages/adapter-codex`, manifest-owned install/uninstall and transcript gaps                                                                                                                                                 | Codex adapter corpus and native smoke                          |
| Claude Code adapter                   | `packages/adapter-claude-code`, documented hook JSONL normalization, SDK conformance, secret redaction, and explicit gaps                                                                                                      | adapter corpus and workspace gates                             |
| App-server contract                   | `packages/adapter-codex-app-server/src/schemas.ts`, packaged versioned envelope artifacts, bounded JSONL, handshake deadlines, explicit approval resolutions                                                                   | versioned adapter fixtures                                     |
| Repository/verification enrichment    | `packages/enrichment`, shell-free subprocess calls, fingerprints and diffs                                                                                                                                                     | enrichment and adapter fixtures                                |
| Forensic dashboard                    | `apps/dashboard`, virtual timeline, inspector, coverage, context/causal views, annotations, scorecard                                                                                                                          | dashboard 20k-event and browser tests                          |
| Deterministic diagnostics             | fifteen versioned rules, positive/negative/edge fixture corpus                                                                                                                                                                 | precision/recall report and diagnostics gate                   |
| Optional AI synthesis                 | `packages/analyzer-ai`, fixed taxonomy, tool-free prompt, evidence verifier                                                                                                                                                    | analyzer and daemon security tests                             |
| Evaluation and comparison             | versioned manifests, deterministic session extraction, fail-closed Codex execution policies/effective argv, detached worktrees, captured eval sessions, bounded matrix variants/repetitions, summaries and divergence          | eval-runner, comparison, CLI, dashboard, and packed eval smoke |
| Redaction and portable bundles        | previewed derived views, secret detectors, encrypted age stream, bounded safe import                                                                                                                                           | bundle security and pack smoke gates                           |
| Release artifact                      | bundled dashboard/daemon npm CLI, explicit macOS x64/arm64 and three-OS CI matrix                                                                                                                                              | `pnpm pack:smoke` plus native smoke artifacts                  |

## Release checklist

- [ ] CI passes on Ubuntu Node 22.12 and 24, macOS Node 24, and Windows Node 24.
- [ ] One native Codex smoke session is attached for each supported OS.
- [ ] Keychain-unavailable passphrase unlock and wrong-passphrase recovery are
      exercised on each release platform.
- [ ] The exact npm tarball passes initialization, capture, dashboard, export,
      import, evaluation, and ownership-safe uninstall from clean temporary homes.
- [ ] Security review signs off on archive traversal, symlink, hard-link,
      device, archive-bomb, XSS/ANSI, and secret-redaction fixtures.

The unchecked items are environment-dependent release evidence, not claims that
can be inferred from a single developer workstation.

## Local verification record

Commit `28e7e26` was verified on 2026-08-04 from a clean macOS arm64 checkout
with Node `v26.4.0`, pnpm `10.33.4`, and npm `11.17.0`. Node 26 is newer than
the supported release runtimes, so this record supplements rather than replaces
the CI matrix.

The following commands completed successfully:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration   # 11 files, 136 tests
pnpm test:e2e           # 3 files, 16 tests
pnpm test:security      # 7 files, 88 tests
pnpm test:performance   # 7 files, 98 tests
pnpm pack:smoke
```

A separate local Node `v24.19.0` run also passed lint, formatting, typecheck,
the complete workspace test suite, build, and packed-install smoke after the
native bindings were rebuilt for that ABI. This supplements but does not
replace the official Node 22/24 and three-OS CI matrix.

A supplemental `node:22.12.0-bookworm` Docker run under ARM-to-x64 emulation
installed pnpm and the native SQLite binding, then passed lint, formatting,
typecheck, and the 20,000-event diagnostics budget. Its full workspace test
run was not release evidence: the two age-scrypt bundle tests exceeded their
Vitest timeouts under emulation. The native host suite remains green, and the
Ubuntu x64 CI runner is still required for supported-platform evidence.

The native smoke harness also passed locally on macOS arm64 with Codex
`0.144.3` and Node `v24.18.0`: 12 captured events, adapter `codex-hooks`, and
source version `0.144.3`; the report also verified wrong-passphrase rejection
and recovery with the correct local envelope. This is supplementary evidence
because the release runtime matrix still requires independent Linux and
Windows runners.

The packed-install smoke test exercises the bundled CLI, isolated temporary
homes, daemon authentication and lifecycle, dashboard serving, encrypted
export/import, a real clean-worktree eval run with effective policy assertions,
and ownership-safe Codex hook uninstall. The remaining checklist items require
fresh artifacts from the configured Ubuntu, macOS, and Windows CI runners and
native Codex installations before publishing a release. The reusable
`.github/workflows/native-smoke.yml` workflow runs
`scripts/native-smoke.mjs` on both supported macOS runner architectures as well
as Linux and Windows, emits metadata-only provenance evidence, and uploads one
artifact per native runner. `.github/workflows/release-gate.yml` invokes that
workflow together with the full CI matrix for version tags or manual release
verification.
