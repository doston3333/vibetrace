import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  EventTypeSchema,
  TraceEventSchema,
  createEventId,
  createSessionId,
  type EventType,
  type JsonObject,
  type JsonValue,
} from '@vibetrace/schema';
import {
  validateMappedEvent,
  type AdapterMappedEvent,
  type SourceAdapter,
} from '@vibetrace/adapter-sdk';
import { z } from 'zod';

export const OTEL_ADAPTER_ID = 'opentelemetry';
export const OTEL_ADAPTER_VERSION = '0.1.0';
export const MAX_OTEL_BODY_BYTES = 1 * 1024 * 1024;

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
const objectSchema = z.record(z.string(), jsonValue);

export interface OtelContext {
  readonly sourceSessionId: string;
  readonly sourceVersion?: string;
  readonly allowPromptContent?: boolean;
  readonly sequence?: number;
}

export interface OtelInput {
  readonly body: unknown;
  readonly context: OtelContext;
}

function object(value: unknown): JsonObject {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? (parsed.data as JsonObject) : {};
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Keep telemetry metadata to an explicit allow-list; arbitrary attributes can contain credentials. */
function approvedAttributes(
  value: JsonObject,
  allowPromptContent: boolean,
): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (key === 'vibetrace.event_type' && typeof candidate === 'string') {
      output[key] = candidate;
      continue;
    }
    if (
      /^gen_ai\.usage\.(?:input_tokens|output_tokens|cached_input_tokens|reasoning_tokens)$/u.test(
        key,
      ) &&
      number(candidate) !== undefined
    ) {
      output[key] = number(candidate)!;
      continue;
    }
    if (
      allowPromptContent &&
      key === 'vibetrace.payload' &&
      objectSchema.safeParse(candidate).success
    )
      output[key] = candidate as JsonObject;
  }
  return output;
}

function gap(
  context: OtelContext,
  sequence: number,
  reason: string,
  payload: JsonObject,
): AdapterMappedEvent {
  const sourceEventId = `otel-gap:${sequence}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
  const sessionId = createSessionId(OTEL_ADAPTER_ID, context.sourceSessionId);
  const timestamp = new Date().toISOString();
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: OTEL_ADAPTER_ID,
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
      expectedSource: 'opentelemetry',
    },
    rawPayload: payload,
    provenance: {
      adapter: OTEL_ADAPTER_ID,
      adapterVersion: OTEL_ADAPTER_VERSION,
      captureMode: 'partial',
    },
  });
  return validateMappedEvent({
    raw: {
      adapter: OTEL_ADAPTER_ID,
      adapterVersion: OTEL_ADAPTER_VERSION,
      sourceSessionId: context.sourceSessionId,
      sourceEventId,
      receivedAt: timestamp,
      payload,
    },
    event,
  });
}

/** Convert only explicit telemetry fields; prompt/body content remains disabled by default. */
export function captureOtelJson(
  input: OtelInput,
): readonly AdapterMappedEvent[] {
  const serialized = JSON.stringify(input.body);
  const bytes = Buffer.byteLength(serialized ?? '', 'utf8');
  if (bytes > MAX_OTEL_BODY_BYTES)
    throw new Error('OpenTelemetry payload exceeds the bounded body limit.');
  const body = object(input.body);
  const resourceLogs = Array.isArray(body.resourceLogs)
    ? body.resourceLogs
    : [];
  const output: AdapterMappedEvent[] = [];
  let sequence = input.context.sequence ?? 0;
  for (const resourceLog of resourceLogs) {
    const scopeLogs = object(resourceLog).scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const scopeLog of scopeLogs) {
      const records = object(scopeLog).logRecords;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        sequence += 1;
        const item = object(record);
        const attributes = approvedAttributes(
          object(item.attributes),
          input.context.allowPromptContent === true,
        );
        const eventType = EventTypeSchema.safeParse(
          attributes['vibetrace.event_type'],
        );
        const inputTokens = number(attributes['gen_ai.usage.input_tokens']);
        const outputTokens = number(attributes['gen_ai.usage.output_tokens']);
        if (
          !eventType.success &&
          inputTokens === undefined &&
          outputTokens === undefined
        ) {
          output.push(
            gap(
              input.context,
              sequence,
              'Telemetry record did not contain an approved VibeTrace field.',
              {
                attributes,
                ...(input.context.allowPromptContent
                  ? { body: object(item.body) }
                  : {}),
              },
            ),
          );
          continue;
        }
        const type: EventType = eventType.success
          ? eventType.data
          : 'usage.updated';
        const sessionId = createSessionId(
          OTEL_ADAPTER_ID,
          input.context.sourceSessionId,
        );
        const sourceEventId = `otel:${sequence}`;
        const timestamp = new Date().toISOString();
        const payload: JsonObject = eventType.success
          ? object(attributes['vibetrace.payload'])
          : { metric: 'token-usage' };
        const event = TraceEventSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id: createEventId({
            adapter: OTEL_ADAPTER_ID,
            sourceSessionId: input.context.sourceSessionId,
            sourceEventId,
            sourceSequence: sequence,
            type,
          }),
          sessionId,
          sourceEventId,
          sequence,
          timestamp,
          source: 'harness',
          ...(type === 'usage.updated'
            ? {
                usage: {
                  ...(inputTokens === undefined ? {} : { inputTokens }),
                  ...(outputTokens === undefined ? {} : { outputTokens }),
                },
              }
            : {}),
          type,
          payload,
          rawPayload: {
            attributes,
            ...(input.context.allowPromptContent
              ? { body: object(item.body) }
              : {}),
          },
          provenance: {
            adapter: OTEL_ADAPTER_ID,
            adapterVersion: OTEL_ADAPTER_VERSION,
            captureMode: 'partial',
          },
        });
        output.push(
          validateMappedEvent({
            raw: {
              adapter: OTEL_ADAPTER_ID,
              adapterVersion: OTEL_ADAPTER_VERSION,
              sourceSessionId: input.context.sourceSessionId,
              sourceEventId,
              receivedAt: timestamp,
              payload: {
                attributes,
                ...(input.context.allowPromptContent
                  ? { body: object(item.body) }
                  : {}),
              },
            },
            event,
          }),
        );
      }
    }
  }
  return output;
}

export const otelAdapter: SourceAdapter<OtelInput> = {
  descriptor: {
    id: OTEL_ADAPTER_ID,
    version: OTEL_ADAPTER_VERSION,
    source: 'opentelemetry',
    capabilities: {
      prompts: false,
      messages: false,
      plans: false,
      reasoning: false,
      toolInputs: true,
      toolOutputs: true,
      approvals: true,
      compaction: false,
      subagents: false,
      tokenUsage: true,
      diffs: false,
      verification: true,
    },
  },
  async *capture(input) {
    yield* captureOtelJson(input);
  },
};
