import { performance } from 'node:perf_hooks';

import { createSyntheticTrace } from '@vibetrace/test-fixtures';
import {
  SCHEMA_VERSION,
  TraceEventSchema,
  createEventId,
  createSessionId,
} from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTIC_FIXTURES,
  evaluateFixtureCorpus,
  renderPrecisionRecallReport,
} from './fixtures.js';
import {
  DIAGNOSTIC_RULES,
  DIAGNOSTIC_RULE_IDS,
  analyzeSession,
  defineRule,
  type DiagnosticRule,
} from './index.js';

describe('deterministic diagnostics', () => {
  for (const ruleId of DIAGNOSTIC_RULE_IDS) {
    const fixtures = DIAGNOSTIC_FIXTURES.filter(
      (fixture) => fixture.ruleId === ruleId,
    );
    it(`${ruleId} has deterministic positive, negative, and edge fixtures`, () => {
      expect(fixtures.map((fixture) => fixture.variant).sort()).toEqual([
        'edge',
        'negative',
        'positive',
      ]);
      const rule = DIAGNOSTIC_RULES.find(
        (candidate) => candidate.id === ruleId,
      )!;
      for (const fixture of fixtures) {
        const first = analyzeSession(fixture.events, [rule]);
        const second = analyzeSession(fixture.events, [rule]);
        expect(second).toEqual(first);
        expect(first.findings.length > 0, fixture.name).toBe(
          fixture.expectedFinding,
        );
        const eventIds = new Set(fixture.events.map((event) => event.id));
        for (const finding of first.findings) {
          expect(finding.ruleId).toBe(ruleId);
          expect(finding.detectorVersion).toBe('0.1.0');
          expect(finding.recommendation.length).toBeGreaterThan(0);
          expect(finding.evidenceEventIds.length).toBeGreaterThan(0);
          expect(finding.evidenceEventIds.every((id) => eventIds.has(id))).toBe(
            true,
          );
          expect(
            finding.counterevidenceEventIds?.every((id) => eventIds.has(id)),
          ).toBe(true);
        }
      }
    });
  }

  it('validates rule definitions, sessions, and evidence references', () => {
    const events = DIAGNOSTIC_FIXTURES[0]!.events;
    expect(() => analyzeSession([])).toThrow('empty session');
    expect(() =>
      defineRule({
        id: 'no-tests-after-final-change',
        version: 'not-semver',
        evaluate: () => [],
      }),
    ).toThrow('semantic version');
    const unknownEvidence = defineRule({
      id: 'no-tests-after-final-change',
      version: '1.0.0',
      evaluate: () => [
        {
          key: 'bad',
          category: 'test',
          severity: 'low',
          title: 'Bad evidence',
          explanation: 'The evidence ID does not exist.',
          recommendation: 'Use an existing event.',
          evidenceEventIds: ['missing'],
        },
      ],
    });
    expect(() => analyzeSession(events, [unknownEvidence])).toThrow(
      'unknown event ID',
    );
    const noEvidence = defineRule({
      id: 'no-tests-after-final-change',
      version: '1.0.0',
      evaluate: () => [
        {
          key: 'bad',
          category: 'test',
          severity: 'low',
          title: 'No evidence',
          explanation: 'No evidence was emitted.',
          recommendation: 'Attach evidence.',
          evidenceEventIds: [],
        },
      ],
    });
    expect(() => analyzeSession(events, [noEvidence])).toThrow(
      'without evidence',
    );
    expect(() =>
      analyzeSession(events, [DIAGNOSTIC_RULES[0]!, DIAGNOSTIC_RULES[0]!]),
    ).toThrow('Duplicate rule ID');
    const otherSession = DIAGNOSTIC_FIXTURES.at(-1)!.events[0]!;
    expect(() => analyzeSession([events[0]!, otherSession])).toThrow(
      'more than one session',
    );
    expect(() =>
      defineRule({
        id: 'unknown-rule',
        version: '1.0.0',
        evaluate: () => [],
      } as unknown as DiagnosticRule),
    ).toThrow('Unknown diagnostic rule ID');
  });

  it('changes finding identity when detector semantics or evidence change', () => {
    const events = DIAGNOSTIC_FIXTURES.find(
      (fixture) =>
        fixture.ruleId === 'success-claim-after-unresolved-failure' &&
        fixture.variant === 'positive',
    )!.events;
    const rule = (version: string, evidenceIndex: number) =>
      defineRule({
        id: 'no-tests-after-final-change',
        version,
        evaluate: () => [
          {
            key: 'session',
            category: 'identity-test',
            severity: 'low',
            title: 'Stable identity test',
            explanation: 'Only material detector inputs define identity.',
            recommendation: 'Retain reviews only for an unchanged finding.',
            evidenceEventIds: [events[evidenceIndex]!.id],
          },
        ],
      });
    const original = analyzeSession(events, [rule('1.0.0', 0)]).findings[0]!;
    expect(analyzeSession(events, [rule('1.0.0', 0)]).findings[0]!.id).toBe(
      original.id,
    );
    expect(analyzeSession(events, [rule('1.0.0', 1)]).findings[0]!.id).not.toBe(
      original.id,
    );
    expect(analyzeSession(events, [rule('1.0.1', 0)]).findings[0]!.id).not.toBe(
      original.id,
    );
  });

  it('does not report a session-end failure while the session is active', () => {
    const fixture = DIAGNOSTIC_FIXTURES.find(
      (candidate) =>
        candidate.ruleId === 'unresolved-error-at-session-end' &&
        candidate.variant === 'positive',
    )!;
    const rule = DIAGNOSTIC_RULES.find(
      (candidate) => candidate.id === fixture.ruleId,
    )!;
    expect(
      analyzeSession(
        fixture.events.filter((event) => event.type !== 'session.completed'),
        [rule],
      ).findings,
    ).toHaveLength(0);
  });

  it('publishes a fixture-scoped precision and recall report', () => {
    const report = evaluateFixtureCorpus();
    expect(report).toMatchObject({
      fixtureCount: 30,
      truePositive: 17,
      trueNegative: 13,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
      recall: 1,
    });
    expect(Object.keys(report.byRule).sort()).toEqual(
      [...DIAGNOSTIC_RULE_IDS].sort(),
    );
    const markdown = renderPrecisionRecallReport(report);
    expect(markdown).toContain(
      '| no-tests-after-final-change | 2 | 1 | 0 | 0 | 1.00 | 1.00 |',
    );
    expect(markdown).toContain(
      'not a claim about real-world incidence or quality',
    );
  });

  it('analyzes a 20,000-event session within a bounded local budget', () => {
    const trace = createSyntheticTrace({
      eventCount: 20000,
      scenario: 'code-change-tests',
      seed: 601,
    });
    const started = performance.now();
    const result = analyzeSession(trace.events);
    const elapsed = performance.now() - started;
    expect(result.evaluatedRuleIds).toHaveLength(10);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('analyzes 20,000 distinct changed paths without path-by-event scans', () => {
    const sourceSessionId = 'diagnostic-many-files';
    const sessionId = createSessionId('diagnostic-test', sourceSessionId);
    const events = Array.from({ length: 20_000 }, (_, index) => {
      const sequence = index + 1;
      return TraceEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: createEventId({
          adapter: 'diagnostic-test',
          sourceSessionId,
          sourceSequence: sequence,
          type: 'file.changed',
        }),
        sessionId,
        sequence,
        timestamp: new Date(
          Date.parse('2026-02-02T00:00:00.000Z') + sequence,
        ).toISOString(),
        source: 'agent',
        type: 'file.changed',
        payload: { path: `src/generated/file-${index}.ts` },
        rawPayload: { index },
        provenance: {
          adapter: 'diagnostic-test',
          adapterVersion: '0.1.0',
          captureMode: 'full',
        },
      });
    });
    const rule = DIAGNOSTIC_RULES.find(
      (candidate) =>
        candidate.id === 'modified-file-without-observed-inspection',
    )!;
    const started = performance.now();
    const result = analyzeSession(events, [rule]);
    const elapsed = performance.now() - started;
    expect(result.findings).toHaveLength(20_000);
    expect(elapsed).toBeLessThan(3_000);
  });
});
