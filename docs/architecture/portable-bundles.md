# Portable encrypted bundles

Portable bundles are explicit derived views, not database backups. VibeTrace first builds a deterministic manifest that lists the session metadata, every exported event and field class, every included or excluded artifact, redaction records, hashes, and omissions. The CLI prints that exact manifest before asking for a passphrase. Export accepts the preview hash and refuses to write if the derived view changed in the meantime.

## Export profiles

- `metadata-only` retains session and event identity metadata while replacing each event with a schema-valid capture gap. Findings, annotations, payloads, and artifacts are omitted.
- `share-safe` scans event payloads, raw payloads, finding and annotation text, artifact metadata, and textual artifact streams. It detects known key formats, authorization headers, credentialed connection strings, `.env`-style secrets, suspicious field names, private keys, and high-entropy tokens. Binary artifacts are excluded.
- `custom:<id>` starts from a stored metadata-only or share-safe profile and applies explicit field and artifact allow/deny rules. A false-positive restore applies only to the derived export pointer and never changes the encrypted local original.

Detection is intentionally conservative and cannot guarantee that every secret shape is known. Text artifacts with an individual line larger than the safe streaming-redaction bound are excluded instead of being split at a boundary that could expose part of a token. The manifest exposes every detected redaction, safety exclusion, and included blob so the user can review the exact view before sharing it.

## Encrypted stream format

The `.vibetrace.age` file is a standard age passphrase-encrypted stream using the library's production scrypt work factor. There is no plaintext export option. All VibeTrace framing is inside the authenticated age plaintext; no manifest, filename, or session metadata is left outside the encryption envelope.

The decrypted payload is a versioned sequence of bounded regular-file records. Each record has a strict header containing its kind, safe logical path, byte length, and SHA-256 content hash. The format deliberately does not embed tar, zip, symlinks, hard links, devices, permissions, or executable metadata. Standard age tools can decrypt the outer stream, while VibeTrace validates and interprets the inner record sequence.

## Import boundary

Import accepts only a regular, non-symlink source whose name ends in `.vibetrace.age`. The clear age header must name exactly one passphrase recipient, and its scrypt work factor is bounded before key derivation. Ciphertext, plaintext, record count, header size, per-record size, JSON size, and event-line size are also bounded. Logical paths containing absolute roots, traversal components, backslashes, NUL bytes, or non-canonical separators are rejected. Duplicate paths, multiple manifests, malformed schemas, missing records, extra records, hash mismatches, invalid evidence references, and artifact or annotation references outside the session are rejected before database mutation.

Decrypted bytes are staged under a user-only temporary directory using generated local filenames; logical bundle paths never become filesystem extraction paths. Import never executes bundle content. After full validation, metadata is committed in one SQLite transaction. Stable event and session identifiers are preserved: an identical manifest import is idempotent, while an existing identifier with different content is rejected. Large artifact content is streamed into the encrypted local blob store.

Because the encrypted filesystem blob store and SQLite cannot share one transaction, a failed metadata commit can leave an unreachable encrypted blob. It contains no plaintext, is not queryable, and can be reclaimed by storage maintenance without weakening retry or collision behavior.
