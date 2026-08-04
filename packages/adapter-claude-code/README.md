# Claude Code adapter

`@vibetrace/adapter-claude-code` is the named second coding-agent adapter for
VibeTrace. It consumes Claude Code command-hook JSONL and normalizes the
observable lifecycle, prompts, tool calls, permissions, compaction, subagents,
instructions, file changes, and stop/error events into the canonical trace
model.

The adapter is capture-only: it never writes to Claude Code stdout, makes no
permission decisions, and does not read transcript files. Unknown hook fields
remain in the encrypted raw payload. Malformed, unsupported, truncated, and
oversized frames become explicit capture gaps. Standard capture policy redacts
known credentials before an event can enter the spool.

The supported input boundary follows the documented Claude Code hook event
names (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`,
`StopFailure`, `InstructionsLoaded`, `ConfigChange`, `FileChanged`,
`MessageDisplay`, `TaskCreated`, and `TaskCompleted`). Event payloads are
versioned through adapter provenance and source fields are never treated as a
stable transcript API.
