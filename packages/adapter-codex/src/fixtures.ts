import type { JsonObject } from '@vibetrace/schema';

const common = {
  transcript_path: null,
  cwd: '/workspace/vibetrace-fixture',
  model: 'gpt-5.6-codex',
} as const;

function base(session: string): JsonObject {
  return {
    ...common,
    session_id: session,
    permission_mode: 'default',
  };
}

/** Ten deterministic Codex 0.144.3-compatible session corpora. */
export const CODEX_0_144_3_SESSION_FIXTURES: readonly (readonly JsonObject[])[] =
  [
    [
      {
        ...base('session-success'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
      {
        ...base('session-success'),
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn-success',
        prompt: 'Update the greeting.',
      },
      {
        ...base('session-success'),
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-success',
        tool_name: 'apply_patch',
        tool_use_id: 'tool-edit',
        tool_input: { command: '*** Begin Patch' },
      },
      {
        ...base('session-success'),
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-success',
        tool_name: 'apply_patch',
        tool_use_id: 'tool-edit',
        tool_input: { command: '*** Begin Patch' },
        tool_response: { output: 'Done!' },
      },
      {
        ...base('session-success'),
        hook_event_name: 'Stop',
        turn_id: 'turn-success',
        stop_hook_active: false,
        last_assistant_message: 'Implemented and verified.',
      },
    ],
    [
      {
        ...base('session-failure'),
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
      {
        ...base('session-failure'),
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-failure',
        tool_name: 'Bash',
        tool_use_id: 'tool-test',
        tool_input: { command: 'pnpm test' },
      },
      {
        ...base('session-failure'),
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-failure',
        tool_name: 'Bash',
        tool_use_id: 'tool-test',
        tool_input: { command: 'pnpm test' },
        tool_response: { exitCode: 1, output: 'one test failed' },
      },
    ],
    [
      {
        ...base('session-permission'),
        hook_event_name: 'PermissionRequest',
        turn_id: 'turn-permission',
        tool_name: 'Bash',
        tool_input: { command: 'git fetch', description: 'network access' },
      },
    ],
    [
      {
        ...base('session-compact-manual'),
        hook_event_name: 'PreCompact',
        turn_id: 'turn-compact',
        trigger: 'manual',
      },
      {
        ...base('session-compact-manual'),
        hook_event_name: 'PostCompact',
        turn_id: 'turn-compact',
        trigger: 'manual',
      },
    ],
    [
      {
        ...base('session-compact-auto'),
        hook_event_name: 'PreCompact',
        turn_id: 'turn-compact-auto',
        trigger: 'auto',
      },
      {
        ...base('session-compact-auto'),
        hook_event_name: 'PostCompact',
        turn_id: 'turn-compact-auto',
        trigger: 'auto',
      },
    ],
    [
      {
        ...base('session-subagent'),
        hook_event_name: 'SubagentStart',
        turn_id: 'turn-subagent',
        agent_id: 'agent-reviewer',
        agent_type: 'reviewer',
      },
      {
        ...base('session-subagent'),
        hook_event_name: 'SubagentStop',
        turn_id: 'turn-subagent',
        agent_id: 'agent-reviewer',
        agent_type: 'reviewer',
        agent_transcript_path: null,
        stop_hook_active: false,
        last_assistant_message: 'Review complete.',
      },
    ],
    [
      {
        ...base('session-resume'),
        hook_event_name: 'SessionStart',
        source: 'resume',
      },
      {
        ...base('session-resume'),
        hook_event_name: 'Stop',
        turn_id: 'turn-resume',
        stop_hook_active: false,
        last_assistant_message: null,
      },
    ],
    [
      {
        ...base('session-clear'),
        hook_event_name: 'SessionStart',
        source: 'clear',
      },
      {
        ...base('session-clear'),
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn-correction',
        prompt: 'No, keep the public API unchanged.',
        future_field: { retained: true },
      },
    ],
    [
      {
        ...base('session-after-compact'),
        hook_event_name: 'SessionStart',
        source: 'compact',
      },
      {
        ...base('session-after-compact'),
        hook_event_name: 'Stop',
        turn_id: 'turn-after-compact',
        stop_hook_active: true,
        last_assistant_message: 'Continued after compaction.',
      },
    ],
    [
      {
        ...base('session-mcp'),
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-mcp',
        tool_name: 'mcp__filesystem__read_file',
        tool_use_id: 'tool-mcp',
        tool_input: { path: '/workspace/README.md' },
        agent_id: 'root',
        agent_type: 'default',
      },
      {
        ...base('session-mcp'),
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-mcp',
        tool_name: 'mcp__filesystem__read_file',
        tool_use_id: 'tool-mcp',
        tool_input: { path: '/workspace/README.md' },
        tool_response: { content: [{ type: 'text', text: 'README' }] },
        agent_id: 'root',
        agent_type: 'default',
      },
    ],
  ] as const;

/** Forward-compatible event documented after the 0.144.3 generated schemas. */
export const CODEX_CURRENT_SESSION_END_FIXTURE: JsonObject = {
  ...common,
  session_id: 'session-success',
  hook_event_name: 'SessionEnd',
  reason: 'other',
};

/** One supported rollout-v1 transcript with exposed and ignored record classes. */
export const CODEX_ROLLOUT_V1_FIXTURE = [
  {
    timestamp: '2026-08-03T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'session-transcript',
      cwd: '/workspace/vibetrace-fixture',
      cli_version: '0.144.3',
      future_meta: true,
    },
  },
  {
    timestamp: '2026-08-03T10:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'reasoning',
      encrypted_content: 'not-canonicalized',
    },
  },
  {
    timestamp: '2026-08-03T10:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'Visible final answer.', future: true },
      ],
      phase: 'final_answer',
    },
    future_row: { retained: true },
  },
] as const;
