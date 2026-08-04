import { createHash } from 'node:crypto';

import {
  applyCaptureProfileToMappedEvent,
  validateMappedEvent,
  type AdapterMappedEvent,
  type SourceAdapter,
} from '@vibetrace/adapter-sdk';
import {
  EventTypeSchema,
  SCHEMA_VERSION,
  TraceEventSchema,
  createEventId,
  createSessionId,
  type EventType,
  type JsonObject,
  type JsonValue,
} from '@vibetrace/schema';
import type { CaptureProfilePolicy } from '@vibetrace/schema';
import { z } from 'zod';

export const CLAUDE_CODE_ADAPTER_ID = 'claude-code';
export const CLAUDE_CODE_ADAPTER_VERSION = '0.1.0';
export const MAX_CLAUDE_CODE_FRAME_BYTES = 8 * 1024 * 1024;

/** Hook events supported by the documented Claude Code command-hook contract. */
export const CLAUDE_CODE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'InstructionsLoaded',
  'ConfigChange',
  'FileChanged',
  'MessageDisplay',
  'TaskCreated',
  'TaskCompleted',
] as const;

export const ClaudeCodeHookEventSchema = z.enum(CLAUDE_CODE_HOOK_EVENTS);
export type ClaudeCodeHookEvent = z.infer<typeof ClaudeCodeHookEventSchema>;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const hookSchema = z
  .object({
    session_id: z.string().min(1).max(512),
    cwd: z.string().min(1).max(32_768),
    hook_event_name: ClaudeCodeHookEventSchema,
    transcript_path: z.string().max(32_768).nullable().optional(),
    permission_mode: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(512).optional(),
    source: z.string().min(1).max(128).optional(),
    prompt: z.string().max(MAX_CLAUDE_CODE_FRAME_BYTES).optional(),
    content: z.string().max(MAX_CLAUDE_CODE_FRAME_BYTES).optional(),
    message: z.string().max(MAX_CLAUDE_CODE_FRAME_BYTES).optional(),
    last_assistant_message: z
      .string()
      .max(MAX_CLAUDE_CODE_FRAME_BYTES)
      .nullable()
      .optional(),
    tool_name: z.string().min(1).max(1_024).optional(),
    tool_use_id: z.string().min(1).max(1_024).optional(),
    tool_input: jsonValueSchema.optional(),
    tool_response: jsonValueSchema.optional(),
    agent_id: z.string().min(1).max(1_024).optional(),
    agent_type: z.string().min(1).max(1_024).optional(),
    reason: z.string().max(512).optional(),
    trigger: z.string().max(128).optional(),
    error: z.string().max(16_384).optional(),
    timestamp: z.string().datetime().optional(),
  })
  .catchall(jsonValueSchema);

/** Validated Claude Code hook input; unknown fields remain available. */
export type ClaudeCodeHookInput = z.infer<typeof hookSchema>;

export interface ClaudeCodeCaptureContext {
  readonly sourceVersion?: string;
  readonly sequence?: number;
  readonly captureProfile?: CaptureProfilePolicy;
  readonly receivedAt?: string;
}

export interface ClaudeCodeJsonlInput {
  readonly chunks: AsyncIterable<Buffer | string>;
  readonly context: ClaudeCodeCaptureContext & {
    readonly sourceSessionId: string;
  };
  readonly maxFrameBytes?: number;
}

function object(value: unknown): JsonObject {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as JsonObject;
  return {};
}

function hash(value: unknown): string {
  const serialized = JSON.stringify(value);
  return createHash('sha256')
    .update(serialized === undefined ? String(value) : serialized)
    .digest('hex');
}

function safeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    const parsed = new Date(value);
    if (parsed.toISOString().endsWith('Z')) return parsed.toISOString();
  }
  return fallback;
}

function sourceVersion(
  input: ClaudeCodeHookInput,
  context: ClaudeCodeCaptureContext,
): string | undefined {
  const candidate =
    context.sourceVersion ??
    (typeof input.claude_code_version === 'string'
      ? input.claude_code_version
      : undefined) ??
    (typeof input.version === 'string' ? input.version : undefined);
  return candidate && candidate.length <= 128 ? candidate : undefined;
}

function toolStatus(
  response: JsonValue | undefined,
): 'completed' | 'failed' | 'declined' {
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response)
  )
    return 'completed';
  const value = response as JsonObject;
  const status = [value.status, value.outcome, value.decision].find(
    (candidate): candidate is string => typeof candidate === 'string',
  );
  if (
    status &&
    /^(?:declined|denied|rejected|cancelled|canceled)$/iu.test(status)
  )
    return 'declined';
  if (
    status &&
    /^(?:failed|failure|error|errored|timeout|timed_out)$/iu.test(status)
  )
    return 'failed';
  const exitCode = value.exit_code ?? value.exitCode;
  if (
    (typeof exitCode === 'number' && exitCode !== 0) ||
    value.isError === true ||
    value.is_error === true ||
    value.success === false ||
    value.ok === false
  )
    return 'failed';
  return 'completed';
}

function content(input: ClaudeCodeHookInput): string | undefined {
  return [
    input.prompt,
    input.content,
    input.message,
    input.last_assistant_message,
  ].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

function mapping(input: ClaudeCodeHookInput): {
  readonly type?: EventType;
  readonly source: 'user' | 'agent' | 'harness' | 'tool' | 'environment';
  readonly status?: 'pending' | 'running' | 'completed' | 'failed' | 'declined';
  readonly payload: JsonObject;
  readonly gapReason?: string;
} {
  const raw = input as unknown as JsonObject;
  const messageContent = content(input);
  const dynamic = input as unknown as Record<string, unknown>;
  const toolName = input.tool_name;
  const subagentId =
    input.agent_id ??
    (typeof dynamic.task_id === 'string' ? dynamic.task_id : undefined) ??
    hash(raw).slice(0, 32);
  const compactionReason = input.trigger ?? input.reason ?? 'unknown';
  switch (input.hook_event_name) {
    case 'SessionStart':
      return {
        type: 'session.started',
        source: 'harness',
        status: 'running',
        payload: raw,
      };
    case 'SessionEnd':
      return {
        type: 'session.completed',
        source: 'harness',
        status: 'completed',
        payload: raw,
      };
    case 'UserPromptSubmit':
      if (!messageContent)
        return {
          source: 'harness',
          payload: raw,
          gapReason: 'Claude Code UserPromptSubmit did not expose prompt text.',
        };
      return {
        type: 'message.user',
        source: 'user',
        payload: {
          ...raw,
          ...(messageContent ? { content: messageContent } : {}),
        },
      };
    case 'PreToolUse':
      if (!toolName)
        return {
          source: 'harness',
          payload: raw,
          gapReason: 'Claude Code PreToolUse did not expose a tool name.',
        };
      return {
        type: 'tool.started',
        source: 'tool',
        status: 'running',
        payload: {
          ...raw,
          toolName,
        },
      };
    case 'PostToolUse':
      if (!toolName)
        return {
          source: 'harness',
          payload: raw,
          gapReason: 'Claude Code PostToolUse did not expose a tool name.',
        };
      return {
        type: 'tool.completed',
        source: 'tool',
        status: toolStatus(input.tool_response),
        payload: {
          ...raw,
          toolName,
        },
      };
    case 'PostToolUseFailure':
      if (!toolName)
        return {
          source: 'harness',
          payload: raw,
          gapReason:
            'Claude Code PostToolUseFailure did not expose a tool name.',
        };
      return {
        type: 'tool.completed',
        source: 'tool',
        status: 'failed',
        payload: {
          ...raw,
          toolName,
        },
      };
    case 'PermissionRequest':
      return {
        type: 'permission.requested',
        source: 'harness',
        status: 'pending',
        payload: {
          ...raw,
          requestId: input.tool_use_id ?? hash(raw).slice(0, 32),
        },
      };
    case 'PermissionDenied':
      return {
        type: 'permission.resolved',
        source: 'harness',
        status: 'declined',
        payload: {
          ...raw,
          requestId: input.tool_use_id ?? hash(raw).slice(0, 32),
        },
      };
    case 'SubagentStart':
    case 'TaskCreated':
      return {
        type: 'subagent.started',
        source: 'harness',
        status: 'running',
        payload: {
          ...raw,
          subagentId,
        },
      };
    case 'SubagentStop':
    case 'TaskCompleted':
      return {
        type: 'subagent.completed',
        source: 'harness',
        status: 'completed',
        payload: {
          ...raw,
          subagentId,
        },
      };
    case 'PreCompact':
      return {
        type: 'context.compaction.started',
        source: 'harness',
        status: 'running',
        payload: {
          ...raw,
          reason: compactionReason,
        },
      };
    case 'PostCompact':
      return {
        type: 'context.compaction.completed',
        source: 'harness',
        status: 'completed',
        payload: {
          ...raw,
          reason: compactionReason,
        },
      };
    case 'Stop':
      return messageContent
        ? {
            type: 'message.agent',
            source: 'agent',
            payload: { ...raw, content: messageContent },
          }
        : {
            type: 'turn.completed',
            source: 'harness',
            status: 'completed',
            payload: raw,
          };
    case 'StopFailure':
      return {
        type: 'error',
        source: 'harness',
        status: 'failed',
        payload: { ...raw, message: input.error ?? 'Claude Code stop failed.' },
      };
    case 'InstructionsLoaded':
      return {
        type: 'instruction.loaded',
        source: 'harness',
        payload: {
          ...raw,
          name:
            (typeof dynamic.instruction === 'string' && dynamic.instruction) ||
            (typeof dynamic.file_path === 'string' && dynamic.file_path) ||
            'Claude Code instructions',
        },
      };
    case 'ConfigChange':
      return {
        type: 'instruction.loaded',
        source: 'harness',
        payload: {
          ...raw,
          name: 'Claude Code configuration',
          configChange: true,
        },
      };
    case 'FileChanged': {
      const path =
        (typeof dynamic.file_path === 'string' && dynamic.file_path) ||
        (typeof dynamic.path === 'string' && dynamic.path);
      return path
        ? {
            type: 'file.changed',
            source: 'environment',
            payload: { ...raw, path },
          }
        : {
            source: 'harness',
            payload: raw,
            gapReason: 'Claude Code FileChanged did not expose a path.',
          };
    }
    case 'MessageDisplay':
      return messageContent
        ? {
            type: 'message.agent',
            source: 'agent',
            payload: { ...raw, content: messageContent },
          }
        : {
            source: 'harness',
            payload: raw,
            gapReason: 'Claude Code MessageDisplay did not expose text.',
          };
  }
  return {
    source: 'harness',
    payload: raw,
    gapReason: 'Claude Code hook event is not mapped to a canonical event.',
  };
}

function stableSourceEventId(
  input: ClaudeCodeHookInput,
  sequence: number,
): string {
  const raw = input as unknown as JsonObject;
  const stable =
    input.tool_use_id ??
    input.agent_id ??
    (typeof input.event_id === 'string' ? input.event_id : undefined) ??
    ('turn_id' in raw && typeof raw.turn_id === 'string'
      ? raw.turn_id
      : undefined) ??
    `${input.hook_event_name}:${sequence}`;
  return `${input.hook_event_name}:${stable}`.slice(0, 1_024);
}

function gap(
  context: ClaudeCodeJsonlInput['context'],
  sequence: number,
  sourceEventId: string,
  reason: string,
  rawPayload: JsonObject,
  timestamp: string,
): AdapterMappedEvent {
  const sessionId = createSessionId(
    CLAUDE_CODE_ADAPTER_ID,
    context.sourceSessionId,
  );
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: CLAUDE_CODE_ADAPTER_ID,
      sourceVersion: context.sourceVersion,
      sourceSessionId: context.sourceSessionId,
      sourceEventId,
      sourceSequence: sequence,
      type: 'capture.gap',
    }),
    sessionId,
    sourceEventId,
    sequence,
    timestamp,
    source: 'vibetrace',
    type: 'capture.gap',
    payload: {
      dataClass: 'unknown',
      state: 'unknown',
      reason,
      expectedSource: CLAUDE_CODE_ADAPTER_ID,
    },
    rawPayload,
    provenance: {
      adapter: CLAUDE_CODE_ADAPTER_ID,
      adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
      ...(context.sourceVersion
        ? { sourceVersion: context.sourceVersion }
        : {}),
      captureMode: 'partial',
    },
  });
  return applyCaptureProfileToMappedEvent(
    validateMappedEvent({
      raw: {
        adapter: CLAUDE_CODE_ADAPTER_ID,
        adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
        ...(context.sourceVersion
          ? { sourceVersion: context.sourceVersion }
          : {}),
        sourceSessionId: context.sourceSessionId,
        sourceEventId,
        receivedAt: timestamp,
        payload: rawPayload,
      },
      event,
    }),
    context.captureProfile,
  );
}

/** Parse and normalize one Claude Code hook envelope. */
export function mapClaudeCodeHook(
  value: unknown,
  context: ClaudeCodeJsonlInput['context'],
  sequence: number,
): AdapterMappedEvent {
  const timestamp = safeTimestamp(
    (value as { timestamp?: unknown } | null)?.timestamp,
    context.receivedAt ?? new Date().toISOString(),
  );
  const parsed = hookSchema.safeParse(value);
  if (!parsed.success)
    return gap(
      context,
      sequence,
      `malformed:${hash(value).slice(0, 48)}`,
      'Malformed Claude Code hook envelope was preserved as a capture gap.',
      {
        value:
          typeof value === 'string'
            ? value.slice(0, MAX_CLAUDE_CODE_FRAME_BYTES)
            : object(value),
      },
      timestamp,
    );
  const input = parsed.data;
  const sourceEventId = stableSourceEventId(input, sequence);
  const mapped = mapping(input);
  if (mapped.gapReason)
    return gap(
      context,
      sequence,
      sourceEventId,
      mapped.gapReason,
      input as unknown as JsonObject,
      timestamp,
    );
  const eventType = mapped.type;
  if (!eventType || !EventTypeSchema.safeParse(eventType).success)
    return gap(
      context,
      sequence,
      sourceEventId,
      'Claude Code hook event has no canonical mapping.',
      input as unknown as JsonObject,
      timestamp,
    );
  const sourceVersionValue = sourceVersion(input, context);
  const sessionId = createSessionId(CLAUDE_CODE_ADAPTER_ID, input.session_id);
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: CLAUDE_CODE_ADAPTER_ID,
      sourceVersion: sourceVersionValue,
      sourceSessionId: input.session_id,
      sourceEventId,
      sourceSequence: sequence,
      type: eventType,
    }),
    sessionId,
    sourceEventId,
    sequence,
    timestamp,
    source: mapped.source,
    ...(mapped.status ? { status: mapped.status } : {}),
    ...(input.tool_name ? { toolName: input.tool_name } : {}),
    type: eventType,
    payload: mapped.payload,
    rawPayload: input as unknown as JsonObject,
    provenance: {
      adapter: CLAUDE_CODE_ADAPTER_ID,
      adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
      ...(sourceVersionValue ? { sourceVersion: sourceVersionValue } : {}),
      captureMode: 'full',
    },
  });
  return applyCaptureProfileToMappedEvent(
    validateMappedEvent({
      raw: {
        adapter: CLAUDE_CODE_ADAPTER_ID,
        adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
        ...(sourceVersionValue ? { sourceVersion: sourceVersionValue } : {}),
        sourceSessionId: input.session_id,
        sourceEventId,
        receivedAt: timestamp,
        payload: input as unknown as JsonObject,
      },
      event,
    }),
    context.captureProfile,
  );
}

/** Capture Claude Code hook JSONL, preserving unsupported/malformed frames as gaps. */
export async function* captureClaudeCodeJsonl(
  input: ClaudeCodeJsonlInput,
): AsyncGenerator<AdapterMappedEvent> {
  const maxFrameBytes = input.maxFrameBytes ?? MAX_CLAUDE_CODE_FRAME_BYTES;
  if (
    !Number.isInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > MAX_CLAUDE_CODE_FRAME_BYTES
  )
    throw new Error(
      `maxFrameBytes must be between 1 and ${MAX_CLAUDE_CODE_FRAME_BYTES}.`,
    );
  let buffer = Buffer.alloc(0);
  let dropping = false;
  let dropped = 0;
  let sequence = input.context.sequence ?? 0;
  for await (const chunk of input.chunks) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < next.length) {
      const newline = next.indexOf(0x0a, offset);
      const hasNewline = newline >= 0;
      const end = hasNewline ? newline : next.length;
      const part = next.subarray(offset, end);
      if (dropping) {
        dropped += part.length;
        if (hasNewline) {
          sequence += 1;
          yield gap(
            input.context,
            sequence,
            `oversized:${dropped}`,
            'Oversized Claude Code hook frame was discarded.',
            { droppedBytes: dropped },
            input.context.receivedAt ?? new Date().toISOString(),
          );
          dropping = false;
          dropped = 0;
        }
      } else if (buffer.length + part.length > maxFrameBytes) {
        dropped = buffer.length + part.length;
        buffer = Buffer.alloc(0);
        if (hasNewline) {
          sequence += 1;
          yield gap(
            input.context,
            sequence,
            `oversized:${dropped}`,
            'Oversized Claude Code hook frame was discarded.',
            { droppedBytes: dropped },
            input.context.receivedAt ?? new Date().toISOString(),
          );
          dropped = 0;
        } else dropping = true;
      } else {
        buffer = Buffer.concat([buffer, part]);
        if (hasNewline) {
          const line = buffer;
          buffer = Buffer.alloc(0);
          if (line.length > 0) {
            sequence += 1;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line.toString('utf8'));
            } catch {
              parsed = { malformedLine: line.toString('utf8') };
            }
            yield mapClaudeCodeHook(parsed, input.context, sequence);
          }
        }
      }
      offset = hasNewline ? end + 1 : end;
    }
  }
  if (buffer.length > 0 || dropping) {
    sequence += 1;
    yield gap(
      input.context,
      sequence,
      `eof:${dropping ? dropped + buffer.length : buffer.length}`,
      dropping
        ? 'Oversized unterminated Claude Code hook frame was discarded.'
        : 'Truncated Claude Code hook frame was discarded.',
      { bytes: dropping ? dropped + buffer.length : buffer.length },
      input.context.receivedAt ?? new Date().toISOString(),
    );
  }
}

export const claudeCodeAdapter: SourceAdapter<ClaudeCodeJsonlInput> = {
  descriptor: {
    id: CLAUDE_CODE_ADAPTER_ID,
    version: CLAUDE_CODE_ADAPTER_VERSION,
    source: 'claude-code',
    capabilities: {
      prompts: true,
      messages: true,
      plans: false,
      reasoning: false,
      toolInputs: true,
      toolOutputs: true,
      approvals: true,
      compaction: true,
      subagents: true,
      tokenUsage: false,
      diffs: true,
      verification: false,
    },
  },
  capture(input) {
    return captureClaudeCodeJsonl(input);
  },
};
