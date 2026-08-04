import {
  createEventId,
  createSessionId,
  TraceEventSchema,
} from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  ComparisonMatrixConfigurationSchema,
  firstDivergence,
  summarizeRuns,
} from './index.js';

function event(sequence: number, content: string) {
  return TraceEventSchema.parse({
    schemaVersion: '0.1.0',
    id: createEventId({
      adapter: 'fixture',
      sourceSessionId: 'session',
      sourceSequence: sequence,
      type: 'message.agent',
    }),
    sessionId: createSessionId('fixture', 'session'),
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'agent',
    type: 'message.agent',
    payload: { content },
    rawPayload: {},
    provenance: {
      adapter: 'fixture',
      adapterVersion: '1.0.0',
      captureMode: 'full',
    },
  });
}

describe('evaluation comparison', () => {
  it('finds the first meaningful divergence and ignores transport timing', () => {
    const divergence = firstDivergence(
      [event(1, 'same'), event(2, 'left')],
      [event(1, 'same'), event(2, 'right')],
    );
    expect(divergence).toMatchObject({ index: 1, reason: 'payload' });
    expect(divergence?.leftEventId).toBeDefined();
    expect(divergence?.rightEventId).toBeDefined();
  });

  it('aggregates success, pending, and operational metrics deterministically', () => {
    const makeRun = (
      id: string,
      success: boolean | undefined,
      durationMs: number,
    ) => ({
      id,
      evalCaseId: 'case',
      configuration: {},
      configurationHash: 'a'.repeat(64),
      worktreeFingerprintHash: id.padEnd(64, 'b'),
      status:
        success === undefined
          ? ('pending_review' as const)
          : ('completed' as const),
      outcome: success === undefined ? undefined : { success },
      metrics: { durationMs, toolCount: durationMs / 10, diffFileCount: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const summary = summarizeRuns([
      makeRun('one', true, 10),
      makeRun('two', false, 30),
      makeRun('three', undefined, 20),
    ]);
    expect(summary).toMatchObject({
      runCount: 3,
      passedCount: 1,
      failedCount: 1,
      pendingCount: 1,
      successRate: 0.5,
    });
    expect(summary.durationMs.median).toBe(20);
  });

  it('rejects duplicate matrix dimensions at the configuration boundary', () => {
    expect(
      ComparisonMatrixConfigurationSchema.safeParse({
        dimensions: ['model', 'model'],
      }).success,
    ).toBe(false);
    expect(
      ComparisonMatrixConfigurationSchema.parse({
        dimensions: ['model', 'skillSet'],
        repetitions: 2,
      }),
    ).toMatchObject({ dimensions: ['model', 'skillSet'], repetitions: 2 });
    expect(
      ComparisonMatrixConfigurationSchema.parse({
        dimensions: ['prompt', 'repetition'],
        repetitions: 2,
        variants: [
          { id: 'control', prompt: 'Use the baseline prompt.' },
          { id: 'treatment', prompt: 'Use the revised prompt.' },
        ],
      }),
    ).toMatchObject({ dimensions: ['prompt', 'repetition'] });
    expect(
      ComparisonMatrixConfigurationSchema.safeParse({
        repetitions: 100,
        variants: Array.from({ length: 11 }, (_, index) => ({
          id: `variant-${index}`,
        })),
      }).success,
    ).toBe(false);
  });
});
