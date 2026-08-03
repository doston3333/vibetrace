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

`timestamp` is ISO 8601 UTC. `sequence` establishes a stable local ordering when source timestamps are absent or imprecise. Independent events may still share a sequence; repositories and APIs break those ties by deterministic event ID. Optional source timestamps and monotonic clocks are retained as provenance rather than replacing the canonical order.

## Validation and compatibility

The TypeScript schema is authored in Zod and emitted as JSON Schema for runtime validation and interoperability. All untrusted adapter input is validated before storage. A breaking canonical change receives a new `schemaVersion` and migration coverage; older normalized versions remain readable.

Unknown source fields are preserved in the immutable raw payload, not discarded during normalization. Normalization is a pure, versioned derivation that retains the raw-event identifier and adapter/source-version provenance.

## Repository and verification evidence

Observed commands receive one deterministic category: search, read, edit, test, lint, build, typecheck, package install, Git, network, or unknown. Classification parses the exposed command text but never executes it. A completed verification records its command, kind, exit code, duration when exposed, framework, success state, and a bounded summary. Full verification output is referenced as an encrypted artifact rather than copied into the normalized payload.

`git.snapshot` records baseline, event-checkpoint, or final state. Its normalized payload contains commit and state hashes, changed-file facts, truncation state, and an optional encrypted diff-artifact reference. A truncated snapshot also emits an explicit partial `capture.gap`. Post-tool snapshots are cumulative observations; a changed path in one does not by itself claim that the immediately preceding tool introduced the change. `file.changed` children retain that cumulative-observation label and link back to their snapshot.

The session run fingerprint contains version and policy names, hashes of bounded project-local instruction, skill, and lock files, and explicit capture-omission codes. Plugin manifests are marked unavailable because the supported hook payload does not expose a bounded canonical plugin inventory. The fingerprint never contains file contents, the repository root, source session identifiers, or environment-variable values.

## Data integrity

- Raw events are immutable and append-only.
- Normalized events are derived, versioned records; they never overwrite raw input.
- Stable event IDs and idempotent import prevent duplicate source events.
- Large inputs and outputs are content-addressed encrypted blobs referenced by events.
- Findings must cite existing normalized event IDs.
- Missing or unsupported source data produces `capture.gap` rather than a fabricated value.

The MVP storage and ingest choices are described in the [architecture overview](overview.md) and [privacy architecture](privacy.md).
