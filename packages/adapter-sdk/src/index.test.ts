import { describe, expect, it } from 'vitest';

import { assertAdapterConformance, type SourceAdapter } from './index.js';

describe('adapter SDK conformance', () => {
  it('accepts a valid external adapter and rejects duplicate/non-monotonic output', async () => {
    const adapter: SourceAdapter = {
      descriptor: {
        id: 'fixture-adapter',
        version: '1.0.0',
        source: 'fixture',
        capabilities: {
          prompts: true,
          messages: true,
          plans: false,
          reasoning: false,
          toolInputs: false,
          toolOutputs: false,
          approvals: false,
          compaction: false,
          subagents: false,
          tokenUsage: false,
          diffs: false,
          verification: false,
        },
      },
      async *capture() {
        for (const [sequence, content] of [
          [1, 'one'],
          [2, 'two'],
        ] as const) {
          const id = `00000000-0000-5000-8000-${String(sequence).padStart(12, '0')}`;
          yield {
            raw: {
              adapter: 'fixture-adapter',
              adapterVersion: '1.0.0',
              sourceSessionId: 'session',
              sourceEventId: `source-${sequence}`,
              receivedAt: '2026-01-01T00:00:00.000Z',
              payload: { content },
            },
            event: {
              schemaVersion: '0.1.0',
              id,
              sessionId: '00000000-0000-5000-8000-000000000001',
              sequence,
              timestamp: '2026-01-01T00:00:00.000Z',
              source: 'user',
              type: 'message.user',
              payload: { content },
              rawPayload: { content },
              provenance: {
                adapter: 'fixture-adapter',
                adapterVersion: '1.0.0',
                captureMode: 'full',
              },
            },
          };
        }
      },
    };
    await expect(
      assertAdapterConformance(adapter, undefined),
    ).resolves.toHaveLength(2);
  });
});
