import { describe, expect, it } from 'vitest';

import { OTEL_ADAPTER_ID, captureOtelJson } from './index.js';

describe('OpenTelemetry enrichment adapter', () => {
  it('captures approved token usage without persisting prompt bodies by default', () => {
    const [item] = captureOtelJson({
      context: { sourceSessionId: 'otel-session' },
      body: {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    body: { stringValue: 'secret prompt' },
                    attributes: {
                      'gen_ai.usage.input_tokens': 10,
                      'gen_ai.usage.output_tokens': 4,
                      authorization: 'Bearer test-secret',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(item?.event.type).toBe('usage.updated');
    expect(item?.event.usage?.inputTokens).toBe(10);
    expect(JSON.stringify(item?.event.rawPayload)).not.toContain(
      'secret prompt',
    );
    expect(JSON.stringify(item?.event.rawPayload)).not.toContain('test-secret');
    expect(item?.event.provenance.adapter).toBe(OTEL_ADAPTER_ID);
  });

  it('turns unapproved telemetry into a gap and rejects oversized bodies', () => {
    const [item] = captureOtelJson({
      context: { sourceSessionId: 'otel-session' },
      body: {
        resourceLogs: [
          { scopeLogs: [{ logRecords: [{ attributes: { foo: 'bar' } }] }] },
        ],
      },
    });
    expect(item?.event.type).toBe('capture.gap');
    expect(() =>
      captureOtelJson({
        context: { sourceSessionId: 'x' },
        body: 'x'.repeat(2_000_000),
      }),
    ).toThrow('bounded body limit');
  });

  it('treats an absent body as an empty, bounded payload', () => {
    expect(
      captureOtelJson({
        context: { sourceSessionId: 'empty' },
        body: undefined,
      }),
    ).toEqual([]);
  });
});
