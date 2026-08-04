import { Readable } from 'node:stream';

import { assertAdapterConformance } from '@vibetrace/adapter-sdk';
import { captureProfilePolicy } from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  GENERIC_ADAPTER_ID,
  captureGenericJsonl,
  genericJsonlAdapter,
} from './index.js';

const context = { sourceSessionId: 'agent-session', sourceVersion: '2.0.0' };
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe('generic JSONL adapter', () => {
  it('passes the external adapter conformance oracle', async () => {
    const result = await assertAdapterConformance(genericJsonlAdapter, {
      chunks: Readable.from([
        line({
          sourceSessionId: 'agent-session',
          sourceEventId: 'prompt',
          type: 'message.user',
          source: 'user',
          payload: { content: 'Fix it.' },
        }),
        line({
          sourceSessionId: 'agent-session',
          sourceEventId: 'done',
          type: 'message.agent',
          source: 'agent',
          payload: { content: 'Done.' },
        }),
      ]),
      context,
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.event.provenance.adapter).toBe(GENERIC_ADAPTER_ID);
  });

  it('preserves unknown records as gaps and bounds oversized input', async () => {
    const events = [];
    for await (const item of captureGenericJsonl({
      chunks: Readable.from([
        line({
          sourceSessionId: 'agent-session',
          type: 'future.event',
          source: 'agent',
          payload: { secret: 'retained in raw' },
        }),
        `${'x'.repeat(20)}\n`,
      ]),
      context,
      maxFrameBytes: 16,
    }))
      events.push(item);
    expect(events).toHaveLength(2);
    expect(events.every((item) => item.event.type === 'capture.gap')).toBe(
      true,
    );
  });

  it('handles a giant chunk with a trailing newline without unbounded concatenation', async () => {
    const events = [];
    for await (const item of captureGenericJsonl({
      chunks: Readable.from([
        `${'x'.repeat(2 * 1024 * 1024)}\n${line({
          sourceSessionId: 'agent-session',
          type: 'message.agent',
          source: 'agent',
          payload: { content: 'done' },
        })}`,
      ]),
      context,
      maxFrameBytes: 1024,
    }))
      events.push(item);
    expect(events).toHaveLength(2);
    expect(events[0]?.event.type).toBe('capture.gap');
    expect(events[1]?.event.type).toBe('message.agent');
  });

  it('applies the profile before raw and canonical payloads leave the adapter', async () => {
    const [item] = await (async () => {
      const output = [];
      for await (const candidate of captureGenericJsonl({
        chunks: Readable.from([
          line({
            sourceSessionId: 'agent-session',
            sourceEventId: 'prompt',
            type: 'message.user',
            source: 'user',
            payload: {
              content: 'token=sk-test-secret-value-1234567890',
              authorization: 'Bearer generic-secret-value',
              environment: { HOME: '/private/user' },
            },
          }),
        ]),
        context: {
          ...context,
          captureProfile: captureProfilePolicy('minimal'),
        },
      }))
        output.push(candidate);
      return output;
    })();
    expect(item).toBeDefined();
    const serialized = JSON.stringify({ raw: item?.raw, event: item?.event });
    expect(serialized).not.toContain('sk-test-secret-value');
    expect(serialized).not.toContain('generic-secret-value');
    expect(serialized).not.toContain('/private/user');
    expect(item?.event.redactions?.length).toBeGreaterThan(0);
  });
});
