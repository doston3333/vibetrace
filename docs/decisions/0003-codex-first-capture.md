# ADR 0003: Codex-first capture

Status: Accepted

## Context

Reliable capture is a prerequisite for reconstruction and diagnosis. Supporting multiple source adapters before one integration meets its exit criteria would spread compatibility and testing effort too thin.

## Decision

The MVP supports Codex lifecycle hooks first. Hooks write atomic per-event JSONL spool segments locally and report missing source data as capture gaps. No additional adapter is added before Codex capture is reliable.

## Consequences

The hook process remains small and resilient to daemon downtime. Codex-specific compatibility code is isolated behind adapter provenance, while the canonical schema remains source-neutral. Lab/app-server capture and OpenTelemetry are not MVP capabilities.
