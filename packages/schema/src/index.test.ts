import { describe, expect, it } from 'vitest';

import {
  CaptureGapPayloadSchema,
  RawSourceEventSchema,
  SCHEMA_VERSION,
  TraceEventSchema,
  createEventId,
  createMigrationRegistry,
  createSessionId,
  createTurnId,
  getTraceEventJsonSchema,
  safeParseTraceEvent,
} from './index.js';

const validEvent = {
  id: createEventId({
    adapter: 'codex-hooks',
    sourceSequence: 1,
    sourceSessionId: 'session-1',
    type: 'message.user',
  }),
  payload: { content: 'Add a test.' },
  provenance: {
    adapter: 'codex-hooks',
    adapterVersion: '1.0.0',
    captureMode: 'standard',
  },
  rawPayload: { unknownSourceField: { retained: true } },
  schemaVersion: SCHEMA_VERSION,
  sequence: 1,
  sessionId: createSessionId('codex-hooks', 'session-1'),
  source: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'message.user',
};

describe('TraceEventSchema', () => {
  it('accepts valid events and preserves unknown raw source fields', () => {
    const raw = RawSourceEventSchema.parse({
      adapter: 'codex-hooks',
      adapterVersion: '1.0.0',
      sourceSessionId: 'session-1',
      receivedAt: '2026-01-01T00:00:00.000Z',
      payload: { futureField: { untouched: ['yes'] } },
    });
    const event = TraceEventSchema.parse(validEvent);

    expect(raw.payload.futureField).toEqual({ untouched: ['yes'] });
    expect(event.rawPayload.unknownSourceField).toEqual({ retained: true });
  });

  it('reports JSON Pointer paths for invalid input', () => {
    const result = safeParseTraceEvent({ ...validEvent, sequence: 0 });

    expect(result).toEqual({
      problems: [
        expect.objectContaining({ code: 'too_small', path: '/sequence' }),
      ],
      success: false,
    });
  });

  it('rejects invalid type-specific payloads at stable paths', () => {
    const message = safeParseTraceEvent({ ...validEvent, payload: {} });
    const captureGap = safeParseTraceEvent({
      ...validEvent,
      payload: {
        dataClass: 'plans',
        extra: true,
        reason: 'The source did not expose plans.',
        state: 'absent',
      },
      type: 'capture.gap',
    });

    expect(message).toEqual({
      problems: [
        expect.objectContaining({
          code: 'invalid_type',
          path: '/payload/content',
        }),
      ],
      success: false,
    });
    expect(captureGap).toEqual({
      problems: [expect.objectContaining({ path: '/payload/extra' })],
      success: false,
    });
    expect(
      CaptureGapPayloadSchema.safeParse({
        dataClass: 'plans',
        state: 'absent',
        reason: 'The source did not expose plans.',
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('emits conditional JSON Schema variants using Zod native output', () => {
    const schema = getTraceEventJsonSchema();
    const variants = schema.anyOf ?? schema.oneOf;

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Array.isArray(variants)).toBe(true);
    expect(JSON.stringify(variants)).toContain('message.user');
    expect(JSON.stringify(variants)).toContain('capture.gap');
    expect(JSON.stringify(variants)).toContain('content');
    expect(JSON.stringify(variants)).toContain('rawPayload');
  });
});

describe('stable IDs', () => {
  it('is deterministic, UUIDv5, NFC-normalized, and independent of ingest time', () => {
    const session = createSessionId('codex', 'cafe\u0301');
    const event = createEventId({
      adapter: 'codex',
      sourceSequence: 7,
      sourceSessionId: 'café',
      type: 'command.completed',
    });

    expect(session).toBe(createSessionId('codex', 'café'));
    expect(event).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createTurnId('codex', 's', 't')).not.toBe(
      createTurnId('codex', 's', 'u'),
    );
  });
});

describe('migration registry', () => {
  it('is empty at v0.1 and does not mutate values', () => {
    const input = { nested: { value: 1 } };
    const output = createMigrationRegistry([]).migrate(
      input,
      SCHEMA_VERSION,
      SCHEMA_VERSION,
    );

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it('rejects invalid migration routes', () => {
    expect(() =>
      createMigrationRegistry(
        [
          {
            fromVersion: '0.1.0',
            migrate: (value) => value,
            toVersion: '0.3.0',
          },
        ],
        '0.3.0',
      ),
    ).toThrow('Noncontiguous');
    expect(() =>
      createMigrationRegistry([
        { fromVersion: '0.2.0', migrate: (value) => value, toVersion: '0.1.0' },
      ]),
    ).toThrow('forward-only');
    expect(() =>
      createMigrationRegistry([]).migrate({}, '9.0.0', SCHEMA_VERSION),
    ).toThrow('Unknown');
  });
});
