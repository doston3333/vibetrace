# ADR 0006: Dual AI analysis providers

Status: Accepted

## Context

The useful product distinction is deep reconstruction of observable coding
sessions, not a larger collection of fixed heuristics. Users need a convenient
path through the Codex account they already use and a controllable API path for
provider choice, cost accounting, and inference-only isolation. Adding a local
model would increase setup and quality variance without helping the first
release validate this experience.

## Decision

VibeTrace exposes exactly two opt-in AI providers:

1. A direct OpenAI-compatible HTTPS chat-completions API using a user-supplied,
   request-scoped key.
2. A shell-free, ephemeral, read-only Codex CLI task using the user's existing
   Codex authentication.

Both providers consume the same bounded dossier and strict output schema. The
daemon remains the evidence verifier and rejects missing, duplicate,
cross-session, or otherwise invalid evidence IDs. Findings persist safe
provider/model/prompt provenance but never credentials. Deterministic rules
remain an explainable baseline, counter-signal, and offline fallback; they do
not replace model-assisted synthesis.

## Consequences

Every AI run causes explicit network egress and must be initiated by the user.
The direct mode requires an HTTPS endpoint, API key, model, and affirmative
disclosure consent. The Codex mode requires a compatible installed and
authenticated Codex CLI and has a broader agent-runtime boundary than the
direct inference-only mode. No local-model or manual-paste provider is shipped.
