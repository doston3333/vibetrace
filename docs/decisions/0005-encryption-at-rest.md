# ADR 0005: Encryption at rest

Status: Accepted

## Context

Local-first traces remain sensitive when a device is shared, backed up, or accessed by another local process. Ordinary SQLite and plaintext artifact files do not provide adequate protection.

## Decision

Use SQLCipher for local SQLite storage and encrypt blob-store contents. Retrieve keys from the operating-system keyring when available, with a passphrase-derived fallback when it is not.

## Consequences

Storage initialization and recovery need clear key-management UX. Secrets must not appear in logs, tickets, or diagnostics. Exports and redactions are derived views with separate, explicit handling; encryption does not authorize data sharing.
