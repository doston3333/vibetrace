# Privacy and encryption architecture

VibeTrace is local-first: it requires no account, cloud upload, or telemetry by default. Prompts, code, terminal output, credentials, and internal URLs are treated as sensitive untrusted data.

## Encryption at rest

The MVP storage design uses SQLCipher for the local SQLite database and encrypted content-addressed blobs for large artifacts. The database key and blob-encryption key material are obtained from the operating-system keyring when available. If a supported keyring is unavailable, the user supplies a passphrase-derived fallback; raw passphrases are never persisted. VibeTrace state boundaries use owner-only POSIX modes and protected, current-user-only Windows ACLs.

Keys, browser tickets, and local API tokens must be redacted from logs and diagnostics. Backups and exports require their own explicit encryption and redaction policy; no export is implied by local persistence.

Bounded verification output and repository diffs are buffered from sealed spool segments and written through the encrypted blob-store interface before the segment is checkpointed. Artifact metadata import is idempotent and rejects an identifier collision with different content. Because the filesystem blob store and SQLite cannot share one transaction, a crash between encrypted blob publication and metadata commit can leave an unreachable encrypted blob; retry remains safe and deduplicated.

Repository fingerprints retain content hashes, recognized version or policy enum values, and explicit bounded-capture omissions only. Unknown policy strings are omitted and recorded as such instead of being copied into metadata. Plugin manifests are not available through the Codex hook contract and are recorded as omitted instead of silently appearing complete. File contents, absolute repository paths, source session identifiers, and environment-variable values are excluded. The small cross-hook baseline pointer contains only a canonical full commit ID and repository-root hash, uses an opaque session-derived filename, and is stored with user-only permissions.

## Local API and browser access

The Fastify API binds only to loopback or a local Unix socket. It requires a random local authentication token. A browser obtains access through an authenticated, short-lived, one-time ticket; the ticket can be redeemed once and is not stored in URLs, logs, or browser persistence.

## Trust boundaries

- Imported traces, prompts, terminal output, diffs, and tool payloads are untrusted content.
- Trace content is escaped before UI rendering and never executed during import or display.
- Raw environment-variable values are not persisted by default.
- Redaction produces a derived export view; it never changes the private raw event or encrypted local original.
- Portable bundles are always passphrase-encrypted with standard age encryption and contain only the records named by the approved manifest.
- Capture gaps make unavailable sensitive or non-sensitive data explicit without inventing it.

See [portable encrypted bundles](portable-bundles.md) for the export/import boundary, [overview](overview.md) for the storage and API flow, and [ADR 0005](../decisions/0005-encryption-at-rest.md) for the decision record.
