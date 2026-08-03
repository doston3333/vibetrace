# Canonical event schema

The canonical schema is source-neutral, append-only, and versioned. It records only observable data. It must not imply access to hidden reasoning or silently fill absent fields.

## Event model

Each canonical event includes the following required fields:

```ts
interface TraceEvent {
  schemaVersion: string;
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  source: EventSource;
  type: EventType;
  payload: unknown;
  provenance: Provenance;
}
```

`timestamp` is ISO 8601 UTC. `sequence` establishes a stable local ordering when source timestamps are absent, imprecise, or tied. Optional source timestamps and monotonic clocks are retained as provenance rather than replacing the canonical order.

## Validation and compatibility

The TypeScript schema is authored in Zod and emitted as JSON Schema for runtime validation and interoperability. All untrusted adapter input is validated before storage. A breaking canonical change receives a new `schemaVersion` and migration coverage; older normalized versions remain readable.

Unknown source fields are preserved in the immutable raw payload, not discarded during normalization. Normalization is a pure, versioned derivation that retains the raw-event identifier and adapter/source-version provenance.

## Data integrity

- Raw events are immutable and append-only.
- Normalized events are derived, versioned records; they never overwrite raw input.
- Stable event IDs and idempotent import prevent duplicate source events.
- Large inputs and outputs are content-addressed encrypted blobs referenced by events.
- Findings must cite existing normalized event IDs.
- Missing or unsupported source data produces `capture.gap` rather than a fabricated value.

The MVP storage and ingest choices are described in the [architecture overview](overview.md) and [privacy architecture](privacy.md).
