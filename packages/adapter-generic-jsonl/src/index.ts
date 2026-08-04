import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  EventSourceSchema,
  EventTypeSchema,
  TraceEventSchema,
  createEventId,
  createSessionId,
  type EventSource,
  type EventType,
  type JsonObject,
} from '@vibetrace/schema';
import {
  validateMappedEvent,
  type AdapterMappedEvent,
  type SourceAdapter,
} from '@vibetrace/adapter-sdk';
import { z } from 'zod';

export const GENERIC_ADAPTER_ID = 'generic-jsonl-agent';
export const GENERIC_ADAPTER_VERSION = '0.1.0';
export const MAX_GENERIC_FRAME_BYTES = 8 * 1024 * 1024;

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const jsonObject = z.record(z.string(), jsonValue);
const recordSchema = z
  .object({
    sourceSessionId: z.string().min(1).max(512),
    sourceEventId: z.string().min(1).max(512).optional(),
    sourceVersion: z.string().min(1).max(128).optional(),
    type: z.string().min(1).max(128),
    source: z.string().min(1).max(64),
    status: z.string().min(1).max(32).optional(),
    payload: jsonObject,
  })
  .passthrough();

export interface GenericJsonlContext {
  readonly sourceSessionId: string;
  readonly sourceVersion?: string;
  readonly sequence?: number;
}

export interface GenericJsonlInput {
  readonly chunks: AsyncIterable<Buffer | string>;
  readonly context: GenericJsonlContext;
  readonly maxFrameBytes?: number;
}

function object(value: unknown): JsonObject {
  const parsed = jsonObject.safeParse(value);
  return parsed.success ? (parsed.data as JsonObject) : {};
}

function source(value: unknown): EventSource {
  const parsed = EventSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : 'harness';
}

function status(
  value: unknown,
): 'pending' | 'running' | 'completed' | 'failed' | 'declined' | undefined {
  return value === 'pending' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'declined'
    ? value
    : undefined;
}

function gap(
  context: GenericJsonlContext,
  sequence: number,
  reason: string,
  sourceEventId: string,
): AdapterMappedEvent {
  const sessionId = createSessionId(
    GENERIC_ADAPTER_ID,
    context.sourceSessionId,
  );
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: GENERIC_ADAPTER_ID,
      sourceVersion: context.sourceVersion,
      sourceSessionId: context.sourceSessionId,
      sourceEventId,
      sourceSequence: sequence,
      type: 'capture.gap',
    }),
    sessionId,
    sourceEventId,
    sequence,
    timestamp: new Date().toISOString(),
    source: 'vibetrace',
    type: 'capture.gap',
    payload: {
      dataClass: 'unknown',
      state: 'unknown',
      reason,
      expectedSource: GENERIC_ADAPTER_ID,
    },
    rawPayload: { reason, sourceEventId },
    provenance: {
      adapter: GENERIC_ADAPTER_ID,
      adapterVersion: GENERIC_ADAPTER_VERSION,
      ...(context.sourceVersion
        ? { sourceVersion: context.sourceVersion }
        : {}),
      captureMode: 'partial',
    },
  });
  return validateMappedEvent({
    raw: {
      adapter: GENERIC_ADAPTER_ID,
      adapterVersion: GENERIC_ADAPTER_VERSION,
      ...(context.sourceVersion
        ? { sourceVersion: context.sourceVersion }
        : {}),
      sourceSessionId: context.sourceSessionId,
      sourceEventId,
      receivedAt: event.timestamp,
      payload: { reason, sourceEventId },
    },
    event,
  });
}

function mapRecord(
  context: GenericJsonlContext,
  value: unknown,
  sequence: number,
): AdapterMappedEvent {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success)
    return gap(
      context,
      sequence,
      'Malformed generic JSONL record was discarded.',
      `malformed:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`,
    );
  const item = parsed.data;
  const type = EventTypeSchema.safeParse(item.type);
  if (!type.success)
    return gap(
      context,
      sequence,
      `Unsupported generic event type: ${item.type}`,
      `unsupported:${item.type}:${sequence}`,
    );
  const eventType = type.data as EventType;
  const sessionId = createSessionId(GENERIC_ADAPTER_ID, item.sourceSessionId);
  const sourceEventId = item.sourceEventId ?? `sequence-${sequence}`;
  const receivedAt = new Date().toISOString();
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: GENERIC_ADAPTER_ID,
      sourceVersion: item.sourceVersion ?? context.sourceVersion,
      sourceSessionId: item.sourceSessionId,
      sourceEventId,
      sourceSequence: sequence,
      type: eventType,
    }),
    sessionId,
    sourceEventId,
    sequence,
    timestamp: receivedAt,
    source: source(item.source),
    ...(status(item.status) ? { status: status(item.status) } : {}),
    type: eventType,
    payload: item.payload,
    rawPayload: object(value),
    provenance: {
      adapter: GENERIC_ADAPTER_ID,
      adapterVersion: GENERIC_ADAPTER_VERSION,
      ...((item.sourceVersion ?? context.sourceVersion)
        ? { sourceVersion: item.sourceVersion ?? context.sourceVersion }
        : {}),
      captureMode: 'full',
    },
  });
  return validateMappedEvent({
    raw: {
      adapter: GENERIC_ADAPTER_ID,
      adapterVersion: GENERIC_ADAPTER_VERSION,
      ...((item.sourceVersion ?? context.sourceVersion)
        ? { sourceVersion: item.sourceVersion ?? context.sourceVersion }
        : {}),
      sourceSessionId: item.sourceSessionId,
      sourceEventId,
      receivedAt,
      payload: object(value),
    },
    event,
  });
}

/** Capture generic agent JSONL while turning malformed/unsupported data into gaps. */
export async function* captureGenericJsonl(
  input: GenericJsonlInput,
): AsyncGenerator<AdapterMappedEvent> {
  const maxFrameBytes = input.maxFrameBytes ?? MAX_GENERIC_FRAME_BYTES;
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
            'Oversized generic JSONL frame was discarded.',
            `oversized:${dropped}`,
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
            'Oversized generic JSONL frame was discarded.',
            `oversized:${dropped}`,
          );
          dropped = 0;
        } else {
          dropping = true;
        }
      } else {
        buffer = Buffer.concat([buffer, part]);
        if (hasNewline) {
          const line = buffer;
          buffer = Buffer.alloc(0);
          if (line.length === 0) {
            offset = end + 1;
            continue;
          }
          sequence += 1;
          try {
            yield mapRecord(
              input.context,
              JSON.parse(line.toString('utf8')),
              sequence,
            );
          } catch {
            yield gap(
              input.context,
              sequence,
              'Malformed generic JSONL frame was discarded.',
              `malformed:${createHash('sha256').update(line).digest('hex')}`,
            );
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
      dropping
        ? 'Oversized unterminated generic JSONL frame was discarded.'
        : 'Truncated generic JSONL frame was discarded.',
      `eof:${dropping ? dropped + buffer.length : buffer.length}`,
    );
  }
}

export const genericJsonlAdapter: SourceAdapter<GenericJsonlInput> = {
  descriptor: {
    id: GENERIC_ADAPTER_ID,
    version: GENERIC_ADAPTER_VERSION,
    source: 'generic-agent',
    capabilities: {
      prompts: true,
      messages: true,
      plans: true,
      reasoning: true,
      toolInputs: true,
      toolOutputs: true,
      approvals: true,
      compaction: true,
      subagents: true,
      tokenUsage: true,
      diffs: true,
      verification: true,
    },
  },
  capture(input) {
    return captureGenericJsonl(input);
  },
};
