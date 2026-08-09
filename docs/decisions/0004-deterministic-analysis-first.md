# ADR 0004: Deterministic analysis first

Status: Accepted; AI-provider portion amended by ADR 0006

## Context

Diagnoses need transparent, reproducible evidence. Model-generated conclusions can overstate confidence and are especially risky when trace content is incomplete or adversarial.

## Decision

Initial analysis uses deterministic rules with stable rule IDs, versions, fixtures, clear recommendations, and concrete evidence event IDs. Optional AI-assisted synthesis remains a separate evidence-verified boundary and cannot rewrite deterministic findings. ADR 0006 defines its direct API and isolated Codex providers.

## Consequences

Rules require positive, negative, and edge-case fixtures. The product distinguishes facts from any future hypotheses and never presents a diagnosis without linked evidence. Coverage gaps remain explicit rather than becoming speculative conclusions.
