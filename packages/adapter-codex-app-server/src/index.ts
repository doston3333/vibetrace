import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import {
  SpoolSegmentSchema,
  spoolPaths,
  writeSegment,
  type SpoolPaths,
  type SpoolSegment,
} from '@vibetrace/daemon';
import {
  SCHEMA_VERSION,
  TraceEventSchema,
  createEventId,
  createSessionId,
  createTurnId,
  type EventSource,
  type EventType,
  type JsonObject,
  type TraceEvent,
} from '@vibetrace/schema';
import { z } from 'zod';

/** Adapter identifier and version are persisted with every source event. */
export const APP_SERVER_ADAPTER_ID = 'codex-app-server';
export const APP_SERVER_ADAPTER_VERSION = '0.1.0';
export const DEFAULT_CODEX_EXECUTABLE =
  process.platform === 'win32' ? 'codex.exe' : 'codex';
export const MAX_APP_SERVER_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_APP_SERVER_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_APP_SERVER_THREAD_START_TIMEOUT_MS = 30_000;
export const DEFAULT_APP_SERVER_TURN_START_TIMEOUT_MS = 30_000;
export const DEFAULT_APP_SERVER_TURN_TIMEOUT_MS = 5 * 60_000;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const rpcMessageSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    method: z.string().min(1).optional(),
    params: jsonObjectSchema.optional(),
    result: jsonValueSchema.optional(),
    error: jsonObjectSchema.optional(),
  })
  .passthrough();
export type AppServerRpcMessage = z.infer<typeof rpcMessageSchema>;

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    estimatedCostMicros: z.number().int().nonnegative().optional(),
  })
  .strict();

export interface AppServerProjectContext {
  readonly projectId: string;
  readonly displayName: string;
  readonly pathHash?: string;
}

export interface AppServerCaptureContext {
  readonly project: AppServerProjectContext;
  readonly sourceSessionId: string;
  readonly sourceTurnId?: string;
  readonly startedAt?: string;
  readonly sourceVersion?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly sequence?: number;
}

export interface AppServerMappedEvent {
  readonly event: TraceEvent;
  readonly raw: {
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly sourceVersion?: string;
    readonly sourceSessionId: string;
    readonly sourceTurnId?: string;
    readonly sourceEventId: string;
    readonly receivedAt: string;
    readonly payload: JsonObject;
  };
}

export interface AppServerGap {
  readonly reason: string;
  readonly sourceEventId: string;
  readonly receivedAt: string;
  readonly byteLength?: number;
}

export interface AppServerCaptureResult {
  readonly events: readonly TraceEvent[];
  readonly raw: readonly AppServerMappedEvent['raw'][];
  readonly gaps: readonly AppServerGap[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonObject(value: unknown): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? (parsed.data as JsonObject) : {};
}

function normalizedUsage(value: unknown): TraceEvent['usage'] | undefined {
  const parsed = usageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizedStatus(value: unknown): TraceEvent['status'] | undefined {
  const status = stringValue(value)?.toLowerCase();
  if (!status) return undefined;
  if (status === 'pending' || status === 'queued') return 'pending';
  if (
    status === 'running' ||
    status === 'inprogress' ||
    status === 'in_progress'
  )
    return 'running';
  if (status === 'completed' || status === 'succeeded' || status === 'success')
    return 'completed';
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'interrupted' ||
    status === 'cancelled' ||
    status === 'canceled'
  )
    return 'failed';
  if (status === 'declined' || status === 'rejected') return 'declined';
  return undefined;
}

function itemType(item: Record<string, unknown>): string {
  return stringValue(item.type) ?? stringValue(item.kind) ?? 'unknown';
}

function itemContent(item: Record<string, unknown>): string {
  const direct = [item.text, item.content, item.message, item.delta].find(
    (candidate) => typeof candidate === 'string',
  );
  if (typeof direct === 'string') return direct;
  const content = item.content;
  if (Array.isArray(content))
    return content
      .map((part) => {
        const value = record(part);
        return stringValue(value.text) ?? stringValue(value.textDelta) ?? '';
      })
      .join('');
  return '';
}

function commandOf(item: Record<string, unknown>): string {
  return (
    stringValue(item.command) ??
    stringValue(item.cmd) ??
    stringValue(record(item.command).command) ??
    'codex app-server command'
  );
}

function commandCategory(
  command: string,
): 'test' | 'lint' | 'build' | 'typecheck' | 'unknown' {
  const normalized = command.toLowerCase();
  if (/\b(test|pytest|vitest|jest|cargo test|go test)\b/u.test(normalized))
    return 'test';
  if (/\blint\b/u.test(normalized)) return 'lint';
  if (/\b(build|compile|tsc)\b/u.test(normalized))
    return normalized.includes('tsc') ? 'typecheck' : 'build';
  return 'unknown';
}

function eventKind(
  method: string,
  params: Record<string, unknown>,
): {
  readonly type?: EventType;
  readonly source: EventSource;
  readonly payload: JsonObject;
  readonly status?: TraceEvent['status'];
  readonly toolName?: string;
  readonly model?: string;
  readonly usage?: TraceEvent['usage'];
} {
  const item = record(params.item);
  const kind = itemType(item).toLowerCase();
  const turn = record(params.turn);
  const status = normalizedStatus(turn.status);
  if (method === 'thread/started' || method === 'thread/resumed')
    return {
      type: 'session.started',
      source: 'harness',
      payload: { threadId: stringValue(record(params.thread).id) ?? '' },
    };
  if (method === 'thread/archived' || method === 'thread/closed')
    return {
      type: 'session.completed',
      source: 'harness',
      payload: { threadId: stringValue(params.threadId) ?? '' },
      status: 'completed',
    };
  if (method === 'turn/started')
    return {
      type: 'turn.started',
      source: 'harness',
      payload: { turnId: stringValue(turn.id) ?? '' },
      status: 'running',
    };
  if (method === 'turn/completed')
    return {
      type: 'turn.completed',
      source: 'harness',
      payload: {
        turnId: stringValue(turn.id) ?? '',
        status: stringValue(turn.status) ?? 'completed',
      },
      status: status === 'failed' ? 'failed' : 'completed',
      ...(normalizedUsage(turn.usage)
        ? { usage: normalizedUsage(turn.usage) }
        : {}),
    };
  if (method === 'thread/tokenUsage/updated')
    return {
      type: 'usage.updated',
      source: 'harness',
      payload: { threadId: stringValue(params.threadId) ?? '' },
      ...(normalizedUsage(params.tokenUsage)
        ? { usage: normalizedUsage(params.tokenUsage) }
        : {}),
    };
  if (method === 'turn/diff/updated')
    return {
      type: 'file.changed',
      source: 'agent',
      payload: { path: '<turn-diff>', diff: stringValue(params.diff) ?? '' },
    };
  if (method === 'item/agentMessage/delta')
    return {
      type: 'message.agent',
      source: 'agent',
      payload: { content: itemContent(params) },
    };
  if (method === 'item/started' || method === 'item/completed') {
    const completed = method === 'item/completed';
    if (kind.includes('usermessage') || kind === 'user_message')
      return completed
        ? { type: 'message.user', source: 'user', payload: { content: '' } }
        : {
            type: 'message.user',
            source: 'user',
            payload: { content: itemContent(item) },
          };
    if (kind.includes('agentmessage') || kind === 'agent_message')
      return completed
        ? { type: 'message.agent', source: 'agent', payload: { content: '' } }
        : {
            type: 'message.agent',
            source: 'agent',
            payload: { content: itemContent(item) },
          };
    if (kind === 'plan' || kind.includes('plan'))
      return completed
        ? { type: 'message.plan', source: 'agent', payload: { content: '' } }
        : {
            type: 'message.plan',
            source: 'agent',
            payload: { content: itemContent(item) },
          };
    if (kind.includes('reasoning') || kind.includes('analysis'))
      return completed
        ? {
            type: kind.includes('summary')
              ? 'reasoning.summary'
              : 'reasoning.exposed',
            source: 'agent',
            payload: { content: '' },
          }
        : {
            type: kind.includes('summary')
              ? 'reasoning.summary'
              : 'reasoning.exposed',
            source: 'agent',
            payload: { content: itemContent(item) },
          };
    if (kind.includes('command') || kind.includes('shell')) {
      const command = commandOf(item);
      if (!completed)
        return {
          type: 'command.started',
          source: 'tool',
          payload: { command, category: commandCategory(command) },
        };
      const exitCode = Number(
        item.exitCode ??
          item.exit_code ??
          (item.status === 'completed' ? 0 : 1),
      );
      return {
        type: 'command.completed',
        source: 'tool',
        payload: {
          command,
          category: commandCategory(command),
          exitCode: Number.isInteger(exitCode) ? exitCode : 1,
          ...(typeof item.durationMs === 'number'
            ? { durationMs: item.durationMs }
            : {}),
        },
        status: exitCode === 0 ? 'completed' : 'failed',
      };
    }
    if (
      kind.includes('filechange') ||
      kind.includes('file_change') ||
      kind === 'filechange'
    )
      return {
        type: 'file.changed',
        source: 'agent',
        payload: {
          path: stringValue(item.path) ?? '<file-change>',
          ...(stringValue(item.diff) ? { diff: item.diff as string } : {}),
        },
      };
    if (
      kind.includes('mcptool') ||
      kind.includes('mcp_tool') ||
      kind.includes('websearch') ||
      kind.includes('web_search')
    )
      return {
        type: completed ? 'tool.completed' : 'tool.started',
        source: 'tool',
        toolName: stringValue(item.name) ?? kind,
        payload: { toolName: stringValue(item.name) ?? kind },
      };
    if (kind.includes('compaction'))
      return {
        type: completed
          ? 'context.compaction.completed'
          : 'context.compaction.started',
        source: 'harness',
        payload: {
          reason: stringValue(item.reason) ?? 'Codex context compaction.',
        },
      };
    if (kind.includes('error'))
      return {
        type: 'error',
        source: 'harness',
        payload: {
          message: stringValue(item.message) ?? 'Codex app-server error.',
        },
        status: 'failed',
      };
  }
  if (method.includes('approval') || method.includes('permission'))
    return {
      type:
        method.includes('resolved') || method.includes('response')
          ? 'permission.resolved'
          : 'permission.requested',
      source: 'harness',
      payload: {
        requestId:
          stringValue(params.requestId) ?? String(params.id ?? 'approval'),
        ...(stringValue(params.reason)
          ? { reason: params.reason as string }
          : {}),
      },
      status: method.includes('resolved') ? 'completed' : 'pending',
    };
  if (method === 'error' || params.error)
    return {
      type: 'error',
      source: 'harness',
      payload: {
        message:
          stringValue(record(params.error).message) ??
          'Codex app-server error.',
      },
      status: 'failed',
    };
  return {
    type: 'capture.gap',
    source: 'vibetrace',
    payload: {
      dataClass: 'unknown',
      state: 'unknown',
      reason: `Unsupported app-server notification: ${method || 'response'}`,
      expectedSource: 'codex-app-server',
    },
  };
}

function canonicalEvent(
  context: AppServerCaptureContext,
  message: AppServerRpcMessage,
  sequence: number,
  receivedAt: string,
): AppServerMappedEvent {
  const method = message.method ?? '';
  const params = record(message.params);
  const kind = eventKind(method, params);
  const sourceEventId = `${method || 'response'}:${String(message.id ?? sequence)}:${sequence}`;
  const sourceSessionId = context.sourceSessionId;
  const sourceTurnId =
    context.sourceTurnId ??
    stringValue(params.turnId) ??
    stringValue(record(params.turn).id);
  const sessionId = createSessionId(APP_SERVER_ADAPTER_ID, sourceSessionId);
  const turnId = sourceTurnId
    ? createTurnId(APP_SERVER_ADAPTER_ID, sourceSessionId, sourceTurnId)
    : undefined;
  const rawPayload = jsonObject(message);
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: APP_SERVER_ADAPTER_ID,
      sourceVersion: context.sourceVersion ?? 'unknown',
      sourceSessionId,
      sourceEventId,
      sourceSequence: sequence,
      type: kind.type ?? 'capture.gap',
    }),
    sessionId,
    ...(turnId ? { turnId } : {}),
    sourceEventId,
    sequence,
    timestamp: receivedAt,
    source: kind.source,
    ...(kind.status ? { status: kind.status } : {}),
    ...(context.model || kind.model
      ? { model: context.model ?? kind.model }
      : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(kind.toolName ? { toolName: kind.toolName } : {}),
    ...(kind.usage ? { usage: kind.usage } : {}),
    payload: kind.payload,
    rawPayload,
    provenance: {
      adapter: APP_SERVER_ADAPTER_ID,
      adapterVersion: APP_SERVER_ADAPTER_VERSION,
      sourceVersion: context.sourceVersion ?? 'unknown',
      captureMode: 'full',
    },
    type: kind.type ?? 'capture.gap',
  });
  return {
    event,
    raw: {
      adapter: APP_SERVER_ADAPTER_ID,
      adapterVersion: APP_SERVER_ADAPTER_VERSION,
      sourceVersion: context.sourceVersion,
      sourceSessionId,
      ...(sourceTurnId ? { sourceTurnId } : {}),
      sourceEventId,
      receivedAt,
      payload: rawPayload,
    },
  };
}

function gapEvent(
  context: AppServerCaptureContext,
  gap: AppServerGap,
  sequence: number,
): AppServerMappedEvent {
  const message: AppServerRpcMessage = {
    method: 'capture/gap',
    params: {
      dataClass: 'unknown',
      state: 'unknown',
      reason: gap.reason,
      ...(gap.byteLength === undefined ? {} : { byteLength: gap.byteLength }),
    },
  };
  return canonicalEvent(
    context,
    {
      ...message,
      id: gap.sourceEventId,
    },
    sequence,
    gap.receivedAt,
  );
}

/** Parse a bounded JSONL stream, retaining ordering while never buffering unbounded input. */
export async function* parseAppServerJsonl(
  chunks: AsyncIterable<Buffer | string>,
  maxFrameBytes = MAX_APP_SERVER_FRAME_BYTES,
): AsyncGenerator<
  | { readonly message: AppServerRpcMessage; readonly receivedAt: string }
  | { readonly gap: AppServerGap }
> {
  let buffer = Buffer.alloc(0);
  let dropping = false;
  let oversizedBytes = 0;
  for await (const chunk of chunks) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < next.length) {
      const newline = next.indexOf(0x0a, offset);
      const hasNewline = newline >= 0;
      const end = hasNewline ? newline : next.length;
      const part = next.subarray(offset, end);
      if (dropping) {
        oversizedBytes += part.length;
        if (hasNewline) {
          yield {
            gap: {
              reason: 'Oversized app-server JSONL frame was discarded.',
              sourceEventId: `oversized:${oversizedBytes}`,
              receivedAt: new Date().toISOString(),
              byteLength: oversizedBytes,
            },
          };
          dropping = false;
          oversizedBytes = 0;
        }
      } else if (buffer.length + part.length > maxFrameBytes) {
        oversizedBytes = buffer.length + part.length;
        buffer = Buffer.alloc(0);
        if (hasNewline) {
          yield {
            gap: {
              reason: 'Oversized app-server JSONL frame was discarded.',
              sourceEventId: `oversized:${oversizedBytes}`,
              receivedAt: new Date().toISOString(),
              byteLength: oversizedBytes,
            },
          };
          oversizedBytes = 0;
        } else {
          dropping = true;
        }
      } else {
        buffer = Buffer.concat([buffer, part]);
        if (hasNewline) {
          const line = buffer;
          buffer = Buffer.alloc(0);
          if (line.length > 0) {
            try {
              const parsed = rpcMessageSchema.parse(
                JSON.parse(line.toString('utf8')),
              );
              yield { message: parsed, receivedAt: new Date().toISOString() };
            } catch {
              yield {
                gap: {
                  reason: 'Malformed app-server JSONL frame was discarded.',
                  sourceEventId: `malformed:${createHash('sha256').update(line).digest('hex')}`,
                  receivedAt: new Date().toISOString(),
                  byteLength: line.length,
                },
              };
            }
          }
        }
      }
      offset = hasNewline ? end + 1 : end;
    }
  }
  if (buffer.byteLength > 0 || dropping) {
    const byteLength = dropping
      ? oversizedBytes + buffer.byteLength
      : buffer.byteLength;
    yield {
      gap: {
        reason: dropping
          ? 'Oversized unterminated app-server JSONL frame was discarded.'
          : 'Truncated app-server JSONL frame was discarded.',
        sourceEventId: `eof:${byteLength}`,
        receivedAt: new Date().toISOString(),
        byteLength,
      },
    };
  }
}

/** Convert app-server JSONL notifications to immutable source/canonical events. */
export async function captureAppServerJsonl(
  chunks: AsyncIterable<Buffer | string>,
  context: AppServerCaptureContext,
  maxFrameBytes = MAX_APP_SERVER_FRAME_BYTES,
): Promise<AppServerCaptureResult> {
  const events: TraceEvent[] = [];
  const raw: AppServerMappedEvent['raw'][] = [];
  const gaps: AppServerGap[] = [];
  let sequence = context.sequence ?? 0;
  for await (const item of parseAppServerJsonl(chunks, maxFrameBytes)) {
    sequence += 1;
    const mapped =
      'gap' in item
        ? gapEvent(context, item.gap, sequence)
        : canonicalEvent(context, item.message, sequence, item.receivedAt);
    events.push(mapped.event);
    raw.push(mapped.raw);
    if (mapped.event.type === 'capture.gap') {
      gaps.push(
        'gap' in item
          ? item.gap
          : {
              reason: String(
                mapped.event.payload.reason ?? 'Unsupported event.',
              ),
              sourceEventId: mapped.raw.sourceEventId,
              receivedAt: mapped.raw.receivedAt,
            },
      );
    }
  }
  return { events, raw, gaps };
}

function segmentFor(
  context: AppServerCaptureContext & { readonly stateDir: string },
  mapped: AppServerMappedEvent,
): SpoolSegment {
  const { event, raw } = mapped;
  return SpoolSegmentSchema.parse({
    version: 1,
    project: context.project,
    session: {
      source: APP_SERVER_ADAPTER_ID,
      sourceSessionId: context.sourceSessionId,
      startedAt: context.startedAt ?? raw.receivedAt,
      status: event.type === 'session.completed' ? 'completed' : 'active',
      captureMode: 'full',
      ...(context.model ? { model: context.model } : {}),
      ...(context.sourceVersion
        ? { sourceVersion: context.sourceVersion }
        : {}),
    },
    raw,
    event,
    normalizerId: `${APP_SERVER_ADAPTER_ID}/${APP_SERVER_ADAPTER_VERSION}`,
  });
}

/** Write captured app-server events to the normal daemon spool. */
export async function captureAppServerToSpool(
  chunks: AsyncIterable<Buffer | string>,
  context: AppServerCaptureContext & { readonly stateDir: string },
  write: (
    paths: SpoolPaths,
    segment: SpoolSegment,
  ) => Promise<string> = writeSegment,
): Promise<AppServerCaptureResult> {
  const result = await captureAppServerJsonl(chunks, context);
  const paths = spoolPaths(context.stateDir);
  for (const [index, event] of result.events.entries()) {
    const raw = result.raw[index];
    if (!raw) continue;
    const segment = segmentFor(context, { event, raw });
    await write(paths, segment);
  }
  return result;
}

export interface AppServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly kill?: (signal?: NodeJS.Signals) => boolean;
  readonly once?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => AppServerProcess;
}

export interface AppServerClientOptions {
  readonly executable?: string;
  readonly cwd: string;
  readonly context: AppServerCaptureContext & { readonly stateDir: string };
  readonly prompt: string;
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    cwd: string,
  ) => AppServerProcess;
  readonly write?: (
    paths: SpoolPaths,
    segment: SpoolSegment,
  ) => Promise<string>;
  readonly maxFrameBytes?: number;
  readonly approval?: (request: AppServerRpcMessage) => Promise<JsonObject>;
  /** Bound each handshake phase and the complete turn so a stuck child cannot hang the collector. */
  readonly initializeTimeoutMs?: number;
  readonly threadStartTimeoutMs?: number;
  readonly turnStartTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  cwd: string,
): AppServerProcess {
  return nodeSpawn(executable, [...args], {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function send(stdin: Writable, message: Record<string, unknown>): void {
  stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
}

class AppServerPhaseTimeout extends Error {
  constructor(
    readonly phase: 'initialize' | 'thread-start' | 'turn-start' | 'turn',
    readonly timeoutMs: number,
  ) {
    super(`Codex app-server ${phase} timed out after ${timeoutMs} ms.`);
    this.name = 'AppServerPhaseTimeout';
  }
}

function timeoutMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

async function withTimeout<T>(
  operation: Promise<T>,
  durationMs: number,
  phase: AppServerPhaseTimeout['phase'],
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AppServerPhaseTimeout(phase, durationMs)),
      durationMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run one opt-in capture-only app-server session through the documented handshake. */
export async function runAppServerSession(
  options: AppServerClientOptions,
): Promise<AppServerCaptureResult> {
  const process = (options.spawn ?? defaultSpawn)(
    options.executable ?? DEFAULT_CODEX_EXECUTABLE,
    ['app-server', '--stdio'],
    options.cwd,
  );
  const paths = spoolPaths(options.context.stateDir);
  const write = options.write ?? writeSegment;
  const iterator = parseAppServerJsonl(
    process.stdout,
    options.maxFrameBytes ?? MAX_APP_SERVER_FRAME_BYTES,
  )[Symbol.asyncIterator]();
  const events: TraceEvent[] = [];
  const raw: AppServerMappedEvent['raw'][] = [];
  const gaps: AppServerGap[] = [];
  let sequence = options.context.sequence ?? 0;
  let activeContext: AppServerCaptureContext & { readonly stateDir: string } = {
    ...options.context,
  };
  const initializeTimeout = timeoutMs(
    options.initializeTimeoutMs,
    DEFAULT_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  );
  const threadStartTimeout = timeoutMs(
    options.threadStartTimeoutMs,
    DEFAULT_APP_SERVER_THREAD_START_TIMEOUT_MS,
  );
  const turnStartTimeout = timeoutMs(
    options.turnStartTimeoutMs,
    DEFAULT_APP_SERVER_TURN_START_TIMEOUT_MS,
  );
  const turnTimeout = timeoutMs(
    options.turnTimeoutMs,
    DEFAULT_APP_SERVER_TURN_TIMEOUT_MS,
  );
  const append = async (
    item:
      | { readonly message: AppServerRpcMessage; readonly receivedAt: string }
      | { readonly gap: AppServerGap },
  ): Promise<void> => {
    if ('message' in item && item.message.method === 'thread/started') {
      const discovered = stringValue(
        record(record(item.message.params).thread).id,
      );
      if (discovered)
        activeContext = { ...activeContext, sourceSessionId: discovered };
    }
    sequence += 1;
    const mapped =
      'gap' in item
        ? gapEvent(activeContext, item.gap, sequence)
        : canonicalEvent(
            activeContext,
            item.message,
            sequence,
            item.receivedAt,
          );
    events.push(mapped.event);
    raw.push(mapped.raw);
    if (mapped.event.type === 'capture.gap')
      gaps.push(
        'gap' in item
          ? item.gap
          : {
              reason: String(
                mapped.event.payload.reason ?? 'Unsupported event.',
              ),
              sourceEventId: mapped.raw.sourceEventId,
              receivedAt: mapped.raw.receivedAt,
            },
      );
    await write(paths, segmentFor(activeContext, mapped));
  };
  const next = async (
    durationMs: number,
    phase: AppServerPhaseTimeout['phase'],
  ): Promise<AppServerRpcMessage | undefined> => {
    while (true) {
      const item = await withTimeout(iterator.next(), durationMs, phase);
      if (item.done) return undefined;
      if ('gap' in item.value) {
        await append(item.value);
        continue;
      }
      const message = item.value.message;
      if (message.method && message.id !== undefined) {
        await append(item.value);
        const result = options.approval
          ? await options.approval(message)
          : { decision: 'decline' };
        send(process.stdin, {
          jsonrpc: '2.0',
          id: message.id,
          result,
        });
        continue;
      }
      return message;
    }
  };
  const waitForResponse = async (
    id: number,
    durationMs: number,
    phase: AppServerPhaseTimeout['phase'],
  ): Promise<AppServerRpcMessage | undefined> => {
    const deadline = Date.now() + durationMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppServerPhaseTimeout(phase, durationMs);
      const message = await next(remaining, phase);
      if (!message) return undefined;
      if (
        message.id === id &&
        (message.result !== undefined || message.error !== undefined)
      )
        return message;
      if (message.method)
        await append({ message, receivedAt: new Date().toISOString() });
    }
  };
  const shutdown = async (): Promise<void> => {
    try {
      process.stdin.end();
    } catch {
      // The child may have exited between the final event and cleanup.
    }
    if (!process.kill) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      process.once?.('exit', finish);
      try {
        process.kill?.('SIGTERM');
      } catch {
        finish();
        return;
      }
      setTimeout(finish, 250).unref();
    });
  };
  try {
    send(process.stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'vibetrace', title: 'VibeTrace', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
    const initialized = await waitForResponse(
      1,
      initializeTimeout,
      'initialize',
    );
    if (!initialized) {
      await append({
        gap: {
          reason: 'Codex app-server exited before initialize completed.',
          sourceEventId: 'initialize:eof',
          receivedAt: new Date().toISOString(),
        },
      });
      return { events, raw, gaps };
    }
    if (initialized.error !== undefined) {
      await append({
        gap: {
          reason: 'Codex app-server rejected initialize.',
          sourceEventId: 'initialize:error',
          receivedAt: new Date().toISOString(),
        },
      });
      return { events, raw, gaps };
    }
    const serverInfo = record(initialized.result).serverInfo;
    const version = stringValue(record(serverInfo).version);
    if (version) activeContext = { ...activeContext, sourceVersion: version };
    send(process.stdin, { jsonrpc: '2.0', method: 'initialized', params: {} });
    send(process.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'thread/start',
      params: {
        cwd: options.cwd,
        ...(options.context.model ? { model: options.context.model } : {}),
      },
    });
    const thread = await waitForResponse(2, threadStartTimeout, 'thread-start');
    if (!thread) {
      await append({
        gap: {
          reason: 'Codex app-server exited before thread start completed.',
          sourceEventId: 'thread-start:eof',
          receivedAt: new Date().toISOString(),
        },
      });
      return { events, raw, gaps };
    }
    if (thread.error !== undefined) {
      await append({
        gap: {
          reason: 'Codex app-server rejected thread start.',
          sourceEventId: 'thread-start:error',
          receivedAt: new Date().toISOString(),
        },
      });
      return { events, raw, gaps };
    }
    const threadResult = record(thread.result).thread;
    const threadId = stringValue(record(threadResult).id);
    if (threadId)
      activeContext = { ...activeContext, sourceSessionId: threadId };
    send(process.stdin, {
      jsonrpc: '2.0',
      id: 3,
      method: 'turn/start',
      params: {
        threadId: threadId ?? activeContext.sourceSessionId,
        input: [{ type: 'text', text: options.prompt }],
      },
    });
    const turn = await waitForResponse(3, turnStartTimeout, 'turn-start');
    if (!turn) {
      await append({
        gap: {
          reason: 'Codex app-server exited before turn start completed.',
          sourceEventId: 'turn-start:eof',
          receivedAt: new Date().toISOString(),
        },
      });
      return { events, raw, gaps };
    }
    if (turn.error !== undefined) {
      await append({
        gap: {
          reason: 'Codex app-server rejected turn start.',
          sourceEventId: 'turn-start:error',
          receivedAt: new Date().toISOString(),
        },
      });
      return { events, raw, gaps };
    }
    const turnDeadline = Date.now() + turnTimeout;
    while (true) {
      const remaining = turnDeadline - Date.now();
      if (remaining <= 0) throw new AppServerPhaseTimeout('turn', turnTimeout);
      const message = await next(remaining, 'turn');
      if (!message) {
        await append({
          gap: {
            reason: 'Codex app-server exited before turn completion.',
            sourceEventId: `turn:eof:${sequence + 1}`,
            receivedAt: new Date().toISOString(),
          },
        });
        break;
      }
      if (message.method) {
        await append({ message, receivedAt: new Date().toISOString() });
        if (message.method === 'turn/completed') break;
      }
    }
    return { events, raw, gaps };
  } catch (error) {
    if (!(error instanceof AppServerPhaseTimeout)) throw error;
    await append({
      gap: {
        reason: error.message,
        sourceEventId: `${error.phase}:timeout`,
        receivedAt: new Date().toISOString(),
      },
    });
    return { events, raw, gaps };
  } finally {
    await shutdown();
  }
}
