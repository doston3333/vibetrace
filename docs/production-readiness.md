# Production readiness matrix

This is the release evidence index for the documented VibeTrace target. A
capability is marked complete only when the implementation and its required
verification are both present. Native smoke evidence is intentionally kept as
an external release artifact; a local Linux pass cannot stand in for macOS or
Windows.

| Area                                  | Implementation evidence                                                                               | Verification                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Canonical schema and raw preservation | `packages/schema`, generated JSON Schema, deterministic IDs, migration registry                       | schema, fixture, and integration gates            |
| Encrypted storage and blobs           | `packages/storage`, SQLCipher-compatible database, keyed authenticated blobs, FTS5                    | storage/security/performance gates                |
| Crash-safe capture                    | `packages/daemon/src/spool.ts`, atomic sealed segments, quarantine and checkpoints                    | daemon integration/security gates                 |
| Authenticated local API               | loopback Fastify API, bearer daemon token, single-use browser ticket and strict origin checks         | daemon and pack smoke gates                       |
| Codex hooks                           | `packages/adapter-codex`, manifest-owned install/uninstall and transcript gaps                        | Codex adapter corpus and native smoke             |
| App-server contract                   | `packages/adapter-codex-app-server/src/schemas.ts`, bounded JSONL and handshake deadlines             | versioned adapter fixtures                        |
| Repository/verification enrichment    | `packages/enrichment`, shell-free subprocess calls, fingerprints and diffs                            | enrichment and adapter fixtures                   |
| Forensic dashboard                    | `apps/dashboard`, virtual timeline, inspector, coverage, context/causal views, annotations, scorecard | dashboard 20k-event and browser tests             |
| Deterministic diagnostics             | fifteen versioned rules, positive/negative/edge fixture corpus                                        | precision/recall report and diagnostics gate      |
| Optional AI synthesis                 | `packages/analyzer-ai`, fixed taxonomy, tool-free prompt, evidence verifier                           | analyzer and daemon security tests                |
| Evaluation and comparison             | versioned manifests, detached worktrees, captured eval sessions, matrix summaries and divergence      | eval-runner, comparison, CLI, and dashboard tests |
| Redaction and portable bundles        | previewed derived views, secret detectors, encrypted age stream, bounded safe import                  | bundle security and pack smoke gates              |
| Release artifact                      | bundled dashboard/daemon npm CLI and three-OS CI matrix                                               | `pnpm pack:smoke` plus native smoke artifacts     |

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
