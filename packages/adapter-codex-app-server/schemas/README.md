# Codex app-server contract artifacts

The versioned JSON files in this directory are the checked-in envelope
contracts used by the adapter registry. They intentionally permit unknown
fields so source data remains lossless while the runtime mapper applies the
canonical event allow-list. The reproducible generator validates every
artifact and emits the runtime-loaded `src/generated-schemas.ts` module:

```bash
pnpm schema:check
pnpm schema:generate
```

A new Codex version gets a new artifact and fixture review before it is marked
`validated`; unknown versions become an explicit capture gap instead of being
silently treated as validated. The CI schema check fails if the registry,
checked-in JSON, and generated runtime module drift apart.
