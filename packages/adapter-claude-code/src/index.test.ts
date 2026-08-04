import { Readable } from 'node:stream';

import { assertAdapterConformance } from '@vibetrace/adapter-sdk';
import { createSessionId } from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_ADAPTER_ID,
  captureClaudeCodeJsonl,
  claudeCodeAdapter,
  mapClaudeCodeHook,
} from './index.js';

const context = {
  sourceSessionId: 'claude-fixture-session',
  sourceVersion: '2.1.0',
  receivedAt: '2026-08-04T00:00:00.000Z',
};

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function collect(input: Parameters<typeof captureClaudeCodeJsonl>[0]) {
  const events = [];
  for await (const event of captureClaudeCodeJsonl(input)) events.push(event);
  return events;
}

describe('Claude Code adapter', () => {
  it('normalizes the representative hook corpus with deterministic provenance', async () => {
    const corpus = [
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        source: 'startup',
        extra_field: 'preserved',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Fix the auth flow.',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'pnpm test' },
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'pnpm test' },
        tool_response: { status: 'success', stdout: 'passed' },
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_use_id: 'tool-2',
        tool_input: { command: 'git status' },
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_use_id: 'tool-2',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'PostCompact',
        trigger: 'auto',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'SubagentStart',
        agent_id: 'agent-1',
        agent_type: 'Explore',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-1',
        agent_type: 'Explore',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'InstructionsLoaded',
        file_path: 'CLAUDE.md',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'FileChanged',
        file_path: 'src/auth.ts',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'Stop',
        last_assistant_message: 'Tests pass.',
      },
      {
        session_id: context.sourceSessionId,
        cwd: '/repo',
        hook_event_name: 'SessionEnd',
        reason: 'other',
      },
    ];
    const first = await collect({
      chunks: Readable.from([corpus.map(line).join('')]),
      context,
    });
    const second = await collect({
      chunks: Readable.from([corpus.map(line).join('')]),
      context,
    });
    expect(first).toEqual(second);
    expect(first).toHaveLength(corpus.length);
    expect(
      first.every(
        (item) => item.event.provenance.adapter === CLAUDE_CODE_ADAPTER_ID,
      ),
    ).toBe(true);
    expect(first.map((item) => item.event.type)).toEqual([
      'session.started',
      'message.user',
      'tool.started',
      'tool.completed',
      'permission.requested',
      'permission.resolved',
      'context.compaction.started',
      'context.compaction.completed',
      'subagent.started',
      'subagent.completed',
      'instruction.loaded',
      'file.changed',
      'message.agent',
      'session.completed',
    ]);
    expect(first[0]?.event.rawPayload).toMatchObject({
      extra_field: 'preserved',
    });
    expect(first[1]?.event.sessionId).toBe(
      createSessionId(CLAUDE_CODE_ADAPTER_ID, context.sourceSessionId),
    );
  });

  it('passes the SDK conformance oracle and redacts known secrets', async () => {
    const input = {
      session_id: 'secret-fixture',
      cwd: '/repo',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Use sk-1234567890abcdefghijklmnop in the request.',
    };
    const mapped = mapClaudeCodeHook(
      input,
      {
        sourceSessionId: input.session_id,
        receivedAt: context.receivedAt,
      },
      1,
    );
    expect((mapped.event.payload as Record<string, unknown>).content).toContain(
      '[REDACTED:known-token]',
    );
    expect(mapped.event.rawPayload).not.toEqual(input);
    await expect(
      assertAdapterConformance(claudeCodeAdapter, {
        chunks: Readable.from([line(input)]),
        context: {
          sourceSessionId: input.session_id,
          receivedAt: context.receivedAt,
        },
      }),
    ).resolves.toHaveLength(1);
  });

  it('turns malformed, truncated, and oversized frames into explicit gaps', async () => {
    const malformed = await collect({
      chunks: Readable.from(['{"session_id":"broken"}\n']),
      context,
    });
    const truncated = await collect({
      chunks: Readable.from(['{"session_id":"broken"']),
      context,
    });
    const oversized = await collect({
      chunks: Readable.from(['x'.repeat(128) + '\n']),
      context,
      maxFrameBytes: 32,
    });
    expect(malformed[0]?.event.type).toBe('capture.gap');
    expect(truncated[0]?.event.type).toBe('capture.gap');
    expect(oversized[0]?.event.type).toBe('capture.gap');
    expect(oversized[0]?.event.provenance.captureMode).toBe('partial');
  });
});
