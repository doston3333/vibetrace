import { describe, expect, it } from 'vitest';

import { TraceEventSchema } from '@vibetrace/schema';

import { SyntheticTraceScenarios, createSyntheticTrace } from './index.js';
import { staticDashboardTrace } from './static-dashboard.js';

describe('createSyntheticTrace', () => {
  it.each(SyntheticTraceScenarios)(
    'creates a valid, semantically representative %s trace',
    (scenario) => {
      const trace = createSyntheticTrace({
        eventCount: 100,
        scenario,
        seed: 7,
      });

      expect(trace.events).toHaveLength(100);
      expect(trace.signature).toContain(scenario);
      expect(
        trace.events.every(
          (event) => TraceEventSchema.safeParse(event).success,
        ),
      ).toBe(true);

      const hasType = (type: string): boolean =>
        trace.events.some((event) => event.type === type);
      const hasSuccessfulTest = (): boolean =>
        trace.events.some(
          (event) =>
            event.type === 'test.completed' && event.payload.success === true,
        );

      if (scenario === 'successful-edit') {
        expect(hasType('file.read')).toBe(true);
        expect(hasType('file.changed')).toBe(true);
        expect(hasSuccessfulTest()).toBe(true);
      }
      if (scenario === 'failed-command') {
        expect(
          trace.events.some(
            (event) =>
              event.type === 'command.completed' &&
              event.payload.exitCode !== 0,
          ),
        ).toBe(true);
      }
      if (scenario === 'retry-loop') {
        const failures = trace.events.filter(
          (event) =>
            event.type === 'command.completed' &&
            event.payload.command === 'pnpm lint' &&
            event.payload.exitCode !== 0,
        );
        expect(failures.length).toBeGreaterThan(1);
      }
      if (scenario === 'user-correction') {
        expect(hasType('user.steered')).toBe(true);
      }
      if (scenario === 'context-compaction') {
        expect(hasType('context.compaction.started')).toBe(true);
        expect(hasType('context.compaction.completed')).toBe(true);
      }
      if (scenario === 'subagent-activity') {
        expect(hasType('subagent.started')).toBe(true);
        expect(hasType('subagent.completed')).toBe(true);
      }
      if (scenario === 'code-change-tests') {
        const changedAt = trace.events.findIndex(
          (event) => event.type === 'file.changed',
        );
        const successfulTestAt = trace.events.findIndex(
          (event) =>
            event.type === 'test.completed' && event.payload.success === true,
        );
        expect(changedAt).toBeGreaterThanOrEqual(0);
        expect(successfulTestAt).toBeGreaterThan(changedAt);
      }
    },
  );

  it('validates the browser-safe static dashboard fixture in Node', () => {
    expect(staticDashboardTrace.events).toHaveLength(1000);
    expect(
      staticDashboardTrace.events.every(
        (event) => TraceEventSchema.safeParse(event).success,
      ),
    ).toBe(true);
  });

  it('supports exact sizes and byte-equivalent output for a repeated seed', () => {
    expect(
      createSyntheticTrace({
        eventCount: 1000,
        scenario: 'successful-edit',
        seed: 4,
      }).events,
    ).toHaveLength(1000);
    expect(
      createSyntheticTrace({
        eventCount: 20000,
        scenario: 'successful-edit',
        seed: 4,
      }).events,
    ).toHaveLength(20000);
    expect(
      JSON.stringify(
        createSyntheticTrace({
          eventCount: 100,
          scenario: 'retry-loop',
          seed: 8,
        }),
      ),
    ).toBe(
      JSON.stringify(
        createSyntheticTrace({
          eventCount: 100,
          scenario: 'retry-loop',
          seed: 8,
        }),
      ),
    );
  });
});
