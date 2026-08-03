# Capture modes and gaps

VibeTrace reports capture completeness as data, not as an assumption. A session includes explicit `capture.gap` events whenever a required or useful observable signal is unavailable.

## MVP mode: Codex hooks

The MVP supports Codex lifecycle hooks first. The hook collector accepts source-exposed lifecycle, prompt, tool, permission, compaction, subagent, stop, and session-end data when Codex provides it. It appends each received event to an atomic local JSONL spool segment and does no analysis in the hook process.

Transcript enrichment is best-effort and versioned when a supported source provides a transcript path. A parser must identify its source and version; it cannot be treated as a canonical interface.

The supported hook baseline is Codex 0.144.3. Its generated hook schemas do not include the later documented `SessionEnd` event, so VibeTrace installs the forward-compatible handler but also performs bounded transcript enrichment from `Stop`. Missing, unsafe, oversized, malformed, mismatched, or unsupported rollout data becomes an explicit capture gap. Only exposed assistant `output_text` rows from the recognized rollout-v1 shape are normalized; encrypted reasoning records are not canonicalized.

Installation uses `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) and preserves unrelated configuration. Each handler contains `commandWindows`, is uniquely tied to a VibeTrace install manifest, and must be reviewed through Codex `/hooks`. Uninstall removes only handlers whose semantic hashes still match that manifest; user-modified handlers are preserved for manual review. The wire behavior follows the [official Codex hooks contract](https://developers.openai.com/codex/hooks).

## Completeness labels

| Label    | Meaning                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| Full     | A source exposes the relevant activity and the adapter captured it.                       |
| Standard | Lifecycle hooks captured the supported local activity; some source details may be absent. |
| Partial  | The source is incomplete, imported, or only partly supported.                             |
| Unknown  | The adapter cannot determine capture completeness.                                        |

The label never substitutes for the gap events that explain missing data.

## Explicit exclusions

The MVP does not include Codex Lab/app-server capture, batch Eval replay, OpenTelemetry ingestion, additional agent adapters, or AI-assisted analysis. These are future product-plan concepts, not present capabilities. The approved MVP architecture is summarized in [overview](overview.md).

## Gap requirements

A gap records the affected session or turn, the unavailable data class, the source/adapter that could not provide it, and a safe explanation. Examples include unavailable hosted-tool output, an unsupported Codex event version, a missing transcript, and an interrupted spool write. A gap must not expose secrets or infer contents that were never observed.
