# ADR 0003: Codex-first capture

Status: Accepted

## Context

Reliable capture is a prerequisite for reconstruction and diagnosis. Supporting multiple source adapters before one integration meets its exit criteria would spread compatibility and testing effort too thin.

## Decision

The standard capture mode is Codex lifecycle hooks. Hooks write atomic per-event JSONL spool segments locally and report missing source data as capture gaps. Additional adapters are isolated behind the adapter SDK and cannot change the canonical schema or weaken the standard hook boundary.

## Consequences

The hook process remains small and resilient to daemon downtime. Codex-specific compatibility code is isolated behind adapter provenance, while the canonical schema remains source-neutral. App-server, generic JSONL, and OpenTelemetry capture are explicit opt-in adapters with their own capability gaps.
