import { createSyntheticTrace } from '@vibetrace/test-fixtures';
import {
  createEventId,
  createSessionId,
  TraceEventSchema,
} from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import { buildSessionScorecard, SCORECARD_DIMENSION_IDS } from './scorecard.js';

describe('session scorecards', () => {
  it('returns ten independent, transparent dimensions without an aggregate', () => {
    const trace = createSyntheticTrace({
      eventCount: 100,
      scenario: 'code-change-tests',
      seed: 77,
    });
    const scorecard = buildSessionScorecard(trace.events);

    expect(scorecard.sessionId).toBe(trace.sessionId);
    expect(scorecard.dimensions.map((item) => item.id)).toEqual(
      SCORECARD_DIMENSION_IDS,
    );
    expect(scorecard).not.toHaveProperty('score');
    expect(
      scorecard.dimensions.every((item) => item.calculation.length > 0),
    ).toBe(true);
    for (const item of scorecard.dimensions) {
      expect(
        item.score === null || (item.score >= 0 && item.score <= 100),
      ).toBe(true);
      expect(
        item.evidenceEventIds.every((id) =>
          trace.events.some((event) => event.id === id),
        ),
      ).toBe(true);
    }
  });

  it('keeps absent observable signals unknown and is deterministic', () => {
    const trace = createSyntheticTrace({
      eventCount: 100,
      scenario: 'successful-edit',
      seed: 78,
    });
    const first = buildSessionScorecard(trace.events);
    const second = buildSessionScorecard([...trace.events].reverse());

    expect(second).toEqual(first);
    expect(
      first.dimensions.find((item) => item.id === 'safety-permissions')?.score,
    ).toBeNull();
    expect(
      first.dimensions.find((item) => item.id === 'recovery-behavior')?.score,
    ).toBeNull();
  });

  it('keeps shell outcomes and one-turn human effort unknown when capture is partial', () => {
    const sessionId = createSessionId('fixture', 'partial-shell-session');
    const observed = (
      sequence: number,
      type:
        | 'session.started'
        | 'message.user'
        | 'tool.completed'
        | 'capture.gap'
        | 'turn.completed',
      payload: Record<string, unknown>,
      options: {
        source?: 'harness' | 'user' | 'tool';
        status?: string;
        toolName?: string;
      } = {},
    ) =>
      TraceEventSchema.parse({
        schemaVersion: '0.1.0',
        id: createEventId({
          adapter: 'fixture',
          sourceSessionId: 'partial-shell-session',
          sourceSequence: sequence,
          type,
        }),
        sessionId,
        sequence,
        timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
        source: options.source ?? 'harness',
        type,
        ...(options.status ? { status: options.status } : {}),
        ...(options.toolName ? { toolName: options.toolName } : {}),
        payload,
        rawPayload: {},
        provenance: {
          adapter: 'fixture',
          adapterVersion: '1.0.0',
          captureMode: 'standard',
        },
      });
    const scorecard = buildSessionScorecard([
      observed(1, 'session.started', {}),
      observed(
        2,
        'message.user',
        { content: 'Inspect the repository.' },
        { source: 'user' },
      ),
      observed(
        3,
        'tool.completed',
        { toolName: 'Bash', tool_response: { output: 'Script completed' } },
        { source: 'tool', status: 'completed', toolName: 'Bash' },
      ),
      observed(4, 'capture.gap', {
        dataClass: 'commands',
        state: 'partial',
        reason: 'Command exit status was not exposed.',
      }),
      observed(5, 'turn.completed', {}),
    ]);

    expect(
      scorecard.dimensions.find((item) => item.id === 'tool-reliability'),
    ).toMatchObject({ score: null, confidence: 'unknown' });
    expect(
      scorecard.dimensions.find((item) => item.id === 'human-effort'),
    ).toMatchObject({ score: null, confidence: 'unknown' });
    expect(
      scorecard.dimensions.find((item) => item.id === 'capture-confidence'),
    ).toMatchObject({ score: 85, confidence: 'medium' });
  });

  it('does not expose finding evidence that is absent from the session', () => {
    const trace = createSyntheticTrace({
      eventCount: 100,
      scenario: 'successful-edit',
      seed: 81,
    });
    const scorecard = buildSessionScorecard(trace.events, [
      { category: 'instruction-adherence', evidenceEventIds: ['not-an-event'] },
    ]);
    expect(
      scorecard.dimensions.find((item) => item.id === 'instruction-adherence')
        ?.evidenceEventIds,
    ).not.toContain('not-an-event');
  });

  it('rejects mixed-session input before producing a scorecard', () => {
    const first = createSyntheticTrace({
      eventCount: 100,
      scenario: 'successful-edit',
      seed: 79,
    });
    const second = createSyntheticTrace({
      eventCount: 100,
      scenario: 'failed-command',
      seed: 80,
    });
    expect(() =>
      buildSessionScorecard([first.events[0]!, second.events[0]!]),
    ).toThrow('more than one session');
  });
});
