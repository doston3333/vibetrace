# MVP architecture overview

VibeTrace's approved MVP is a local-first foundation for capturing observable Codex activity. This document records the target architecture; it does not claim that the services, storage, or capture adapter are implemented in VT-001.

## Scope

The MVP consists of a Codex hook adapter, a local daemon, encrypted local storage, and a browser dashboard. It records only source-exposed data and represents unavailable data as explicit capture gaps. It does not inspect private reasoning or execute imported trace content.

```text
Codex lifecycle hooks
        │
        ▼
atomic per-event JSONL spool segments
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

## MVP boundaries

Codex lifecycle hooks are the only capture integration in the MVP. The MVP excludes Eval replay, Lab/app-server capture, OpenTelemetry ingestion, and AI-assisted analysis. It starts with deterministic, evidence-linked analysis only after the capture foundation is trustworthy.

Every field or source activity the adapter cannot observe must become a `capture.gap` event with an explicit reason. See [capture modes](capture-modes.md).

## Related decisions

- [ADR 0001: Local-first](../decisions/0001-local-first.md)
- [ADR 0002: Canonical event schema](../decisions/0002-canonical-event-schema.md)
- [ADR 0003: Codex-first capture](../decisions/0003-codex-first-capture.md)
- [ADR 0004: Deterministic analysis first](../decisions/0004-deterministic-analysis-first.md)
- [ADR 0005: Encryption at rest](../decisions/0005-encryption-at-rest.md)
