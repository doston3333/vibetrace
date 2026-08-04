# Codex app-server contract artifacts

The versioned JSON files in this directory are the checked-in envelope
contracts used by the adapter registry. They intentionally permit unknown
fields so source data remains lossless while the runtime mapper applies the
canonical event allow-list. A new Codex version gets a new artifact and
fixture review before it is marked `validated`; unknown later versions use the
nearest older artifact as an explicitly forward-compatible fallback.
