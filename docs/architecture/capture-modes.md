# Capture modes and gaps

VibeTrace reports capture completeness as data, not as an assumption. A session includes explicit `capture.gap` events whenever a required or useful observable signal is unavailable.

## Standard mode: Codex hooks

The MVP supports Codex lifecycle hooks first. The hook collector accepts source-exposed lifecycle, prompt, tool, permission, compaction, subagent, stop, and session-end data when Codex provides it. It appends each received event to an atomic local JSONL spool segment and does no analysis in the hook process.

Transcript enrichment is best-effort and versioned when a supported source provides a transcript path. A parser must identify its source and version; it cannot be treated as a canonical interface.

Repository enrichment uses bounded `git` subprocesses with argument arrays and `shell: false`; captured commands are never interpolated into or passed to a shell. External diff and text-conversion helpers are disabled, and revision inputs must be canonical full Git object IDs. The entire observation has a two-second deadline, an 8 MiB evidence ceiling, and a 1,000-path inventory ceiling. VibeTrace records a baseline at `SessionStart`, a cumulative checkpoint after every `PostToolUse`, another checkpoint at `Stop`, and a final state only at `SessionEnd`. `Stop` can occur more than once, so it does not set immutable final-session metadata or discard the baseline pointer. Non-Git, unsafe, unavailable, invalid, or oversized repository observations produce `capture.gap`; bounded partial snapshots retain their observed facts and add a partial gap.

The hook collector seals the original source event before attempting command, repository, turn, or transcript enrichment. A later enrichment failure therefore cannot change Codex behavior or discard the original event. Exposed verification output and Git diffs cross the spool boundary as bounded pending artifacts and become encrypted content-addressed blobs during daemon import.

Before sealing, the collector applies the active local capture profile and
secret detector. Minimal, standard, and full profiles are enforced at the
source boundary, including the immutable raw payload; unknown fields remain
available only after sensitive values are replaced or omitted. The spool
importer also caps one import pass at 512 MiB so a backlog cannot force an
unbounded memory read.

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

## Opt-in modes

VibeTrace also ships bounded opt-in adapters. The Codex app-server adapter
ships a versioned schema registry beginning at Codex `0.144.3`; later versions
are explicitly marked forward-compatible and older/unknown versions produce
capture gaps instead of being silently treated as equivalent:

- `codex-app-server` uses the documented stdio JSONL handshake and captures
  rich lifecycle, messages, plans, exposed reasoning, commands, file changes,
  approvals, compaction, usage, and unsupported-event gaps. Its validated
  envelope artifacts are packaged under
  `packages/adapter-codex-app-server/schemas/`; server approval requests are
  explicitly declined when no policy callback is supplied and every response
  is persisted as a `permission.resolved` event.
- `generic-jsonl-agent` validates a source-neutral JSONL envelope while
  preserving unknown fields in raw payloads.
- `opentelemetry` accepts approved usage or explicitly tagged VibeTrace events;
  prompt bodies remain excluded unless the daemon is explicitly configured to
  allow them.

Batch eval execution uses the separate [evaluation architecture](evaluation.md)
and never runs in the active checkout. Optional AI synthesis is a read-only,
tool-free boundary described there.

## Gap requirements

A gap records the affected session or turn, the unavailable data class, the source/adapter that could not provide it, and a safe explanation. Examples include unavailable hosted-tool output, an unsupported Codex event version, a missing transcript, and an interrupted spool write. A gap must not expose secrets or infer contents that were never observed.
