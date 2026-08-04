import { createSyntheticTrace } from '@vibetrace/test-fixtures';
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
