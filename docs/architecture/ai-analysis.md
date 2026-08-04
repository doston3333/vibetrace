# AI analysis architecture

VibeTrace offers exactly two opt-in ways to synthesize evidence-linked
hypotheses from a captured session: a direct hosted API and the user's existing
Codex installation. There is no local-model provider and no manual paste mode.
Deterministic findings remain available as reproducible signals and are also
included as evidence for deeper model analysis.

## Shared evidence contract

The daemon reconstructs a bounded dossier from canonical events and current
deterministic findings. It includes observable prompts and messages,
provider-exposed reasoning summaries, tool and command activity, code-change
events, verification, compaction, subagents, permissions, errors, corrections,
and capture gaps when those fields were captured. It never claims hidden
reasoning. A session is capped at 20,000 events; any individual event larger
than 16 KiB retains identity, chronology, type, source, a bounded payload
preview, original byte length, and a digest instead of silently overflowing the
model request. Transcript messages explicitly marked as duplicates remain in
local evidence but are omitted from the analysis dossier.

The prompt requires one strict JSON object with a `hypotheses` array containing
at most five material problems or capture limitations. Praise, neutral
observations, and absence-of-problem items are prohibited. Each item has a
fixed kind, category, severity, impact, actionable recommendation, confidence,
evidence event IDs, and counter-evidence IDs. Severity expresses material
impact; confidence expresses epistemic certainty and is never converted into
severity. The daemon validates the shape and proves that every referenced event
belongs to the analyzed session before replacing AI-owned findings. Model
output remains reviewable and visually separate from source facts and
deterministic findings.

## Direct API provider

The direct provider accepts an explicit HTTPS OpenAI-compatible chat
completions endpoint, model ID, per-run API key, and affirmative disclosure
consent. Redirects, URL credentials, fragments, malformed envelopes, and
responses larger than 2 MiB are rejected. The key is sent only from the
dashboard to the authenticated loopback daemon and from the daemon to the
selected endpoint. It is not logged, stored, added to findings, or exported.

The direct provider is the stricter inference-only boundary: VibeTrace sends no
tools and grants the remote model no ability to call back into the daemon,
filesystem, repository, or terminal.

## Codex provider

The Codex provider starts `codex exec` without a shell. The evidence prompt is
written through stdin and never appears in process arguments. The task uses an
empty temporary working directory, `--ephemeral`, `--sandbox read-only`,
`--ignore-user-config`, `--ignore-rules`, a strict output schema, bounded
stdout/stderr, and a sanitized environment that retains only platform and
Codex-authentication paths. API-key, token, password, secret, credential, and
auth environment variables are excluded. Temporary schema state is removed in
a `finally` path.

Codex is an agent runtime rather than a pure inference endpoint. The empty
workspace, read-only sandbox, sanitized environment, no-tool prompt, and
network-disabled tool sandbox reduce exposure, but this mode is not described
as tool-free. Users requiring the narrowest execution boundary should select
direct API.

## Persistence and portability

AI findings store `findingKind` and `impact`, plus only `analyzerProvider`,
`analyzerModel`, `promptDigest`, and the analyzer version as provider
provenance. Human
confirm/reject/category decisions remain durable across stable reruns.
Encrypted portable bundles preserve this non-secret provenance. No credential
field exists in the finding or bundle schema.
