# Privacy and encryption architecture

VibeTrace is local-first: it requires no account, cloud upload, or telemetry by default. Prompts, code, terminal output, credentials, and internal URLs are treated as sensitive untrusted data.

## Encryption at rest

The MVP storage design uses SQLCipher for the local SQLite database and encrypted content-addressed blobs for large artifacts. The database key and blob-encryption key material are obtained from the operating-system keyring when available. If a supported keyring is unavailable, the user supplies a passphrase-derived fallback; raw passphrases are never persisted.

Keys, browser tickets, and local API tokens must be redacted from logs and diagnostics. Backups and exports require their own explicit encryption and redaction policy; no export is implied by local persistence.

## Local API and browser access

The Fastify API binds only to loopback or a local Unix socket. It requires a random local authentication token. A browser obtains access through an authenticated, short-lived, one-time ticket; the ticket can be redeemed once and is not stored in URLs, logs, or browser persistence.

## Trust boundaries

- Imported traces, prompts, terminal output, diffs, and tool payloads are untrusted content.
- Trace content is escaped before UI rendering and never executed during import or display.
- Raw environment-variable values are not persisted by default.
- Redaction produces a derived export view; it never changes the private raw event or encrypted local original.
- Capture gaps make unavailable sensitive or non-sensitive data explicit without inventing it.

See [overview](overview.md) for the storage and API flow and [ADR 0005](../decisions/0005-encryption-at-rest.md) for the decision record.
