# ADR 0002: Versioned canonical event schema

Status: Accepted

## Context

Source adapters evolve independently and expose different levels of detail. Product features need a stable, source-neutral representation while retaining evidence and original fidelity.

## Decision

Use a Zod-authored canonical schema with JSON Schema output. Preserve raw events immutably and derive separately stored, versioned normalized events with stable IDs and provenance.

## Consequences

All external input requires runtime validation. Breaking changes require a new schema version and migration coverage. Unknown source fields remain available in raw payloads, and findings can reference only existing normalized event IDs.
