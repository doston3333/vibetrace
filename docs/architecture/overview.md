# Architecture overview

VibeTrace is a local-first foundation for capturing observable coding-agent activity, reconstructing sessions, diagnosing evidence, and running isolated evaluations. The implementation is intentionally split into source adapters, an append-only spool, an encrypted daemon, deterministic analysis, and a browser dashboard.

## Scope

The default experience consists of the Codex hook adapter, a local daemon, encrypted local storage, and a browser dashboard. Opt-in app-server, generic JSONL, and OpenTelemetry adapters feed the same canonical model. It records only source-exposed data, represents unavailable data as explicit capture gaps, and never treats private reasoning as observable. Imported eval content executes only in a detached worktree.

```text
Codex hooks / app-server / generic JSONL / opt-in OTel
        │
        ▼
source adapters → atomic per-event JSONL spool segments
        │
        ▼
local importer ──► immutable raw events
        │                    │
        ▼                    ▼
Fastify loopback API ─► versioned normalized events
        │
        ▼
authenticated browser dashboard
```

## Local service boundary

The daemon exposes a Fastify API bound only to loopback (or a local Unix socket where supported). It requires a random local authentication token. A browser is admitted with an authenticated, one-time ticket minted by the daemon; tickets expire quickly, may be redeemed once, and must never be placed in logs or persisted in browser storage.

The browser treats all trace content as untrusted data and renders it as escaped text. The dashboard receives only the API responses authorized for that local session.

## Storage and ingest

Codex hooks are intentionally small: each source event is serialized into an atomic, per-event JSONL spool segment. The write uses a temporary file, durable flush where available, and atomic rename so daemon downtime or a process crash cannot produce a partially visible event. The importer reads completed segments idempotently.

Raw source events are immutable. Normalization creates a separately stored, versioned canonical event record that points back to raw provenance. Large payloads live in encrypted blobs, not ordinary event-query rows. See [event schema](event-schema.md) and [privacy](privacy.md).

## Capability boundaries

Codex lifecycle hooks are the standard capture mode. App-server capture, generic JSONL, OpenTelemetry, isolated eval execution, comparison matrices, and AI-assisted synthesis are opt-in capabilities. AI synthesis is provider-neutral, bounded, and tool-free; deterministic findings remain the primary analysis layer.

Every field or source activity the adapter cannot observe must become a
`capture.gap` event with an explicit reason. Session scorecards expose
independent, evidence-linked dimensions and never collapse the record into a
universal quality number. See [capture modes](capture-modes.md).

## Related decisions

- [ADR 0001: Local-first](../decisions/0001-local-first.md)
- [ADR 0002: Canonical event schema](../decisions/0002-canonical-event-schema.md)
- [ADR 0003: Codex-first capture](../decisions/0003-codex-first-capture.md)
- [ADR 0004: Deterministic analysis first](../decisions/0004-deterministic-analysis-first.md)
- [ADR 0005: Encryption at rest](../decisions/0005-encryption-at-rest.md)
