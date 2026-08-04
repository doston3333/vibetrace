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
| App-server contract                   | `packages/adapter-codex-app-server/src/schemas.ts`, packaged versioned envelope artifacts, bounded JSONL, handshake deadlines, explicit approval resolutions                                                                   | versioned adapter fixtures                                     |
| Repository/verification enrichment    | `packages/enrichment`, shell-free subprocess calls, fingerprints and diffs                                                                                                                                                     | enrichment and adapter fixtures                                |
| Forensic dashboard                    | `apps/dashboard`, virtual timeline, inspector, coverage, context/causal views, annotations, scorecard                                                                                                                          | dashboard 20k-event and browser tests                          |
| Deterministic diagnostics             | fifteen versioned rules, positive/negative/edge fixture corpus                                                                                                                                                                 | precision/recall report and diagnostics gate                   |
| Optional AI synthesis                 | `packages/analyzer-ai`, fixed taxonomy, tool-free prompt, evidence verifier                                                                                                                                                    | analyzer and daemon security tests                             |
| Evaluation and comparison             | versioned manifests, session-to-case wizard, fail-closed Codex execution policies/effective argv, detached worktrees, captured eval sessions, matrix summaries and divergence                                                  | eval-runner, comparison, CLI, dashboard, and packed eval smoke |
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

Commit `be7fdcc` was verified on 2026-08-04 from a clean macOS arm64 checkout
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
pnpm test:integration   # 11 files, 129 tests
pnpm test:e2e           # 3 files, 14 tests
pnpm test:security      # 7 files, 83 tests
pnpm test:performance   # 7 files, 94 tests
pnpm pack:smoke
```

The packed-install smoke test exercises the bundled CLI, isolated temporary
homes, daemon authentication and lifecycle, dashboard serving, encrypted
export/import, a real clean-worktree eval run with effective policy assertions,
and ownership-safe Codex hook uninstall. The remaining checklist items require
fresh artifacts from the configured Ubuntu, macOS, and Windows CI runners and
native Codex installations before publishing a release. The manual
`.github/workflows/native-smoke.yml` workflow runs
`scripts/native-smoke.mjs`, which emits metadata-only provenance evidence and
uploads one artifact per native runner.
