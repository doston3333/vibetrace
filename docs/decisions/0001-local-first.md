# ADR 0001: Local-first by default

Status: Accepted

## Context

Trace data can contain source code, prompts, terminal output, credentials, and internal URLs. A hosted default would add account, upload, and telemetry requirements before a user receives value.

## Decision

VibeTrace will operate locally by default, without an account, network upload, or telemetry. Its API binds only to loopback or a local Unix socket and requires local authentication.

## Consequences

The product must provide local storage, local lifecycle management, and careful browser authentication. Collaboration and hosted synchronization are future, explicit opt-in work rather than MVP dependencies.
