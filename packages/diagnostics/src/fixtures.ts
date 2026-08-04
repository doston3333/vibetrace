import {
  SCHEMA_VERSION,
  TraceEventSchema,
  createEventId,
  createSessionId,
  type EventSource,
  type EventType,
  type JsonObject,
  type TraceEvent,
} from '@vibetrace/schema';

import {
  DIAGNOSTIC_RULES,
  analyzeSession,
  type DiagnosticRuleId,
} from './index.js';

export interface DiagnosticFixture {
  readonly name: string;
  readonly ruleId: DiagnosticRuleId;
  readonly variant: 'positive' | 'negative' | 'edge';
  readonly expectedFinding: boolean;
  readonly events: readonly TraceEvent[];
}

interface EventSpec {
  readonly type: EventType;
  readonly payload: JsonObject;
  readonly source?: EventSource;
  readonly status?: 'pending' | 'running' | 'completed' | 'failed' | 'declined';
  readonly toolName?: string;
}

function sourceFor(type: EventType): EventSource {
  if (type === 'message.user' || type === 'user.steered') return 'user';
  if (type === 'message.agent' || type === 'file.changed') return 'agent';
  if (type === 'git.snapshot') return 'vcs';
  if (
    type.startsWith('session.') ||
    type.startsWith('context.') ||
    type === 'instruction.loaded' ||
    type === 'skill.loaded'
  )
    return 'harness';
  return 'tool';
}

function fixtureEvents(name: string, specs: readonly EventSpec[]) {
  const sourceSessionId = `diagnostic-fixture:${name}`;
  const sessionId = createSessionId('diagnostic-fixture', sourceSessionId);
  return Object.freeze(
    specs.map((spec, index) => {
      const sequence = index + 1;
      return TraceEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: createEventId({
          adapter: 'diagnostic-fixture',
          sourceSessionId,
          sourceSequence: sequence,
          type: spec.type,
        }),
        sessionId,
        sequence,
        timestamp: new Date(
          Date.parse('2026-02-01T00:00:00.000Z') + sequence * 1_000,
        ).toISOString(),
        source: spec.source ?? sourceFor(spec.type),
        type: spec.type,
        payload: spec.payload,
        rawPayload: { fixture: name, sequence },
        provenance: {
          adapter: 'diagnostic-fixture',
          adapterVersion: '0.1.0',
          captureMode: 'full',
        },
        ...(spec.status ? { status: spec.status } : {}),
        ...(spec.toolName ? { toolName: spec.toolName } : {}),
      });
    }),
  );
}

function testResult(success: boolean): EventSpec {
  return {
    type: 'test.completed',
    payload: {
      command: 'pnpm test',
      category: 'test',
      kind: 'test',
      success,
      exitCode: success ? 0 : 1,
      summary: success ? 'passed' : 'failed',
    },
  };
}

function command(command: string, exitCode: number): EventSpec {
  return {
    type: 'command.completed',
    payload: { command, category: 'test', exitCode },
  };
}

function search(commandValue: string): EventSpec {
  return {
    type: 'command.completed',
    payload: { command: commandValue, category: 'search', exitCode: 0 },
  };
}

function tool(status: 'completed' | 'failed'): EventSpec {
  return {
    type: 'tool.completed',
    payload: { toolName: 'exec' },
    status,
    toolName: 'exec',
  };
}

function approvalRequest(requestId: string, commandValue?: string): EventSpec {
  return {
    type: 'permission.requested',
    toolName: 'Bash',
    payload: {
      requestId,
      ...(commandValue ? { tool_input: { command: commandValue } } : {}),
    },
  };
}

function declinedTool(commandValue: string): EventSpec {
  return {
    type: 'tool.completed',
    toolName: 'Bash',
    status: 'declined',
    payload: { tool_input: { command: commandValue }, toolName: 'Bash' },
  };
}

function sessionCompleted(): EventSpec {
  return { type: 'session.completed', payload: { reason: 'other' } };
}

function fixture(
  ruleId: DiagnosticRuleId,
  variant: DiagnosticFixture['variant'],
  expectedFinding: boolean,
  specs: readonly EventSpec[],
): DiagnosticFixture {
  const name = `${ruleId}/${variant}`;
  return Object.freeze({
    name,
    ruleId,
    variant,
    expectedFinding,
    events: fixtureEvents(name, specs),
  });
}

export const DIAGNOSTIC_FIXTURES: readonly DiagnosticFixture[] = Object.freeze([
  fixture('no-tests-after-final-change', 'positive', true, [
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    { type: 'message.agent', payload: { content: 'Work stopped.' } },
  ]),
  fixture('no-tests-after-final-change', 'negative', false, [
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    testResult(true),
  ]),
  fixture('no-tests-after-final-change', 'edge', true, [
    testResult(true),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
  ]),

  fixture('success-claim-after-unresolved-failure', 'positive', true, [
    command('pnpm test', 1),
    { type: 'message.agent', payload: { content: 'Done and implemented.' } },
  ]),
  fixture('success-claim-after-unresolved-failure', 'negative', false, [
    command('pnpm test', 1),
    { type: 'message.agent', payload: { content: 'Done with the edit.' } },
    {
      type: 'message.agent',
      payload: { content: 'The work is not done; tests still fail.' },
    },
  ]),
  fixture('success-claim-after-unresolved-failure', 'edge', false, [
    command('pnpm test', 1),
    {
      type: 'message.agent',
      payload: { content: 'Not done; tests failed and I cannot complete it.' },
    },
  ]),

  fixture('repeated-identical-failed-command', 'positive', true, [
    command('pnpm test', 1),
    command('pnpm test', 1),
  ]),
  fixture('repeated-identical-failed-command', 'negative', false, [
    command('pnpm test', 1),
    command('pnpm lint', 1),
  ]),
  fixture('repeated-identical-failed-command', 'edge', true, [
    command('pnpm test "src/a test.ts"', 1),
    command("pnpm test 'src/a test.ts'", 1),
  ]),

  fixture('modified-file-without-observed-inspection', 'positive', true, [
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
  ]),
  fixture('modified-file-without-observed-inspection', 'negative', false, [
    { type: 'file.read', payload: { path: 'src/a.ts' } },
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
  ]),
  fixture('modified-file-without-observed-inspection', 'edge', true, [
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    { type: 'file.read', payload: { path: 'src/a.ts' } },
  ]),

  fixture('unresolved-error-at-session-end', 'positive', true, [
    {
      type: 'error',
      payload: { message: 'compiler crashed' },
      toolName: 'exec',
    },
    sessionCompleted(),
  ]),
  fixture('unresolved-error-at-session-end', 'negative', false, [
    command('pnpm test', 1),
    command('pnpm test', 0),
    sessionCompleted(),
  ]),
  fixture('unresolved-error-at-session-end', 'edge', true, [
    command('pnpm lint', 1),
    command('pnpm lint', 0),
    command('pnpm test', 1),
    sessionCompleted(),
  ]),

  fixture('pre-existing-versus-introduced-failure', 'positive', true, [
    testResult(true),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    testResult(false),
  ]),
  fixture('pre-existing-versus-introduced-failure', 'negative', false, [
    testResult(true),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    testResult(true),
  ]),
  fixture('pre-existing-versus-introduced-failure', 'edge', true, [
    testResult(false),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    testResult(false),
  ]),

  fixture('compaction-followed-by-user-correction', 'positive', true, [
    {
      type: 'context.compaction.completed',
      payload: { reason: 'Summary written.' },
    },
    { type: 'user.steered', payload: { content: 'Keep the API unchanged.' } },
  ]),
  fixture('compaction-followed-by-user-correction', 'negative', false, [
    { type: 'user.steered', payload: { content: 'Keep the API unchanged.' } },
    {
      type: 'context.compaction.completed',
      payload: { reason: 'Summary written.' },
    },
  ]),
  fixture('compaction-followed-by-user-correction', 'edge', true, [
    {
      type: 'context.compaction.started',
      payload: { reason: 'Window reached.' },
    },
    { type: 'user.steered', payload: { content: 'Try again.' } },
  ]),

  fixture('skill-instruction-contradiction-signal', 'positive', true, [
    { type: 'instruction.loaded', payload: { name: 'AGENTS.md' } },
    {
      type: 'user.steered',
      payload: { content: 'Do not change the public API; that was wrong.' },
    },
  ]),
  fixture('skill-instruction-contradiction-signal', 'negative', false, [
    { type: 'skill.loaded', payload: { name: 'frontend-design' } },
    { type: 'user.steered', payload: { content: 'Thanks, continue.' } },
  ]),
  fixture('skill-instruction-contradiction-signal', 'edge', false, [
    {
      type: 'user.steered',
      payload: { content: 'Do not change the public API.' },
    },
    { type: 'instruction.loaded', payload: { name: 'AGENTS.md' } },
  ]),

  fixture('repeated-tool-error-loop', 'positive', true, [
    tool('failed'),
    tool('failed'),
    tool('failed'),
  ]),
  fixture('repeated-tool-error-loop', 'negative', false, [
    tool('failed'),
    tool('failed'),
    tool('completed'),
    tool('failed'),
  ]),
  fixture('repeated-tool-error-loop', 'edge', true, [
    { type: 'error', payload: { message: 'timeout one' }, toolName: 'exec' },
    { type: 'error', payload: { message: 'timeout two' }, toolName: 'exec' },
    { type: 'error', payload: { message: 'timeout three' }, toolName: 'exec' },
  ]),

  fixture(
    'declined-approval-followed-by-equivalent-request',
    'positive',
    true,
    [
      approvalRequest('request-1', 'rm generated.txt'),
      declinedTool('rm generated.txt'),
      approvalRequest('request-2', 'rm generated.txt'),
    ],
  ),
  fixture(
    'declined-approval-followed-by-equivalent-request',
    'negative',
    false,
    [
      approvalRequest('request-1', 'rm generated.txt'),
      {
        type: 'permission.resolved',
        payload: { requestId: 'request-1', decision: 'declined' },
        status: 'declined',
      },
      approvalRequest('request-2', 'git status'),
    ],
  ),
  fixture('declined-approval-followed-by-equivalent-request', 'edge', false, [
    approvalRequest('request-1'),
    {
      type: 'permission.resolved',
      payload: { requestId: 'request-1', decision: 'declined' },
      status: 'declined',
    },
    approvalRequest('request-2'),
  ]),

  fixture('large-code-churn-relative-to-task', 'positive', true, [
    { type: 'message.user', payload: { content: 'Fix a typo.' } },
    {
      type: 'file.changed',
      payload: { path: 'src/a.ts', addedLines: 40, deletedLines: 40 },
    },
    {
      type: 'file.changed',
      payload: { path: 'src/b.ts', addedLines: 40, deletedLines: 40 },
    },
  ]),
  fixture('large-code-churn-relative-to-task', 'negative', false, [
    {
      type: 'message.user',
      payload: {
        content:
          'Please carefully update the authentication subsystem, preserve compatibility, add coverage, document migration behavior, and verify every affected integration path.',
      },
    },
    {
      type: 'file.changed',
      payload: { path: 'src/a.ts', addedLines: 20, deletedLines: 20 },
    },
    {
      type: 'file.changed',
      payload: { path: 'src/b.ts', addedLines: 20, deletedLines: 20 },
    },
  ]),
  fixture('large-code-churn-relative-to-task', 'edge', false, [
    { type: 'message.user', payload: { content: 'Fix it.' } },
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    { type: 'file.changed', payload: { path: 'src/b.ts' } },
  ]),

  fixture('test-before-final-change-without-rerun', 'positive', true, [
    testResult(true),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
  ]),
  fixture('test-before-final-change-without-rerun', 'negative', false, [
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    testResult(true),
  ]),
  fixture('test-before-final-change-without-rerun', 'edge', false, [
    testResult(false),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
    testResult(true),
  ]),

  fixture('user-correction-after-unsupported-success', 'positive', true, [
    {
      type: 'message.agent',
      payload: { content: 'Implemented and fixed it.' },
    },
    {
      type: 'user.steered' as EventType,
      payload: { content: 'Actually, this is wrong.' },
    },
  ]),
  fixture('user-correction-after-unsupported-success', 'negative', false, [
    {
      type: 'message.agent',
      payload: { content: 'Implemented and fixed it.' },
    },
    {
      type: 'user.steered' as EventType,
      payload: { content: 'Thanks, continue.' },
    },
  ]),
  fixture('user-correction-after-unsupported-success', 'edge', false, [
    {
      type: 'message.agent',
      payload: { content: 'Implemented and fixed it.' },
    },
    testResult(true),
    {
      type: 'user.steered' as EventType,
      payload: { content: 'Actually, this is wrong.' },
    },
  ]),

  fixture('excessive-search-with-little-state-change', 'positive', true, [
    search('rg auth src'),
    search('rg role src'),
    search('rg policy src'),
    search('rg permission src'),
    search('rg middleware src'),
  ]),
  fixture('excessive-search-with-little-state-change', 'negative', false, [
    search('rg auth src'),
    search('rg role src'),
    search('rg policy src'),
    search('rg permission src'),
  ]),
  fixture('excessive-search-with-little-state-change', 'edge', true, [
    search('rg auth src'),
    search('rg role src'),
    search('rg policy src'),
    search('rg permission src'),
    search('rg middleware src'),
    { type: 'file.changed', payload: { path: 'src/a.ts' } },
  ]),

  fixture('relevant-file-discovered-after-implementation', 'positive', true, [
    { type: 'file.changed', payload: { path: 'src/auth.ts' } },
    { type: 'file.read', payload: { path: 'src/auth.ts' } },
  ]),
  fixture('relevant-file-discovered-after-implementation', 'negative', false, [
    { type: 'file.read', payload: { path: 'src/auth.ts' } },
    { type: 'file.changed', payload: { path: 'src/auth.ts' } },
  ]),
  fixture('relevant-file-discovered-after-implementation', 'edge', false, [
    { type: 'file.changed', payload: { path: 'src/auth.ts' } },
    { type: 'file.read', payload: { path: 'src/other.ts' } },
  ]),
]);

export interface FixtureMetrics {
  readonly truePositive: number;
  readonly trueNegative: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
}

export interface PrecisionRecallReport extends FixtureMetrics {
  readonly fixtureCount: number;
  readonly byRule: Readonly<Record<DiagnosticRuleId, FixtureMetrics>>;
}

function metrics(values: readonly { expected: boolean; actual: boolean }[]) {
  const truePositive = values.filter(
    (value) => value.expected && value.actual,
  ).length;
  const trueNegative = values.filter(
    (value) => !value.expected && !value.actual,
  ).length;
  const falsePositive = values.filter(
    (value) => !value.expected && value.actual,
  ).length;
  const falseNegative = values.filter(
    (value) => value.expected && !value.actual,
  ).length;
  return {
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    precision:
      truePositive + falsePositive === 0
        ? 1
        : truePositive / (truePositive + falsePositive),
    recall:
      truePositive + falseNegative === 0
        ? 1
        : truePositive / (truePositive + falseNegative),
  };
}

/** Evaluate only the labeled synthetic corpus; this is not a field-quality claim. */
export function evaluateFixtureCorpus(
  fixtures: readonly DiagnosticFixture[] = DIAGNOSTIC_FIXTURES,
): PrecisionRecallReport {
  const values = fixtures.map((fixtureValue) => {
    const rule = DIAGNOSTIC_RULES.find(
      (candidate) => candidate.id === fixtureValue.ruleId,
    );
    if (!rule) throw new Error(`Missing rule ${fixtureValue.ruleId}.`);
    return {
      ruleId: fixtureValue.ruleId,
      expected: fixtureValue.expectedFinding,
      actual: analyzeSession(fixtureValue.events, [rule]).findings.length > 0,
    };
  });
  return {
    fixtureCount: fixtures.length,
    ...metrics(values),
    byRule: Object.fromEntries(
      DIAGNOSTIC_RULES.map((rule) => [
        rule.id,
        metrics(values.filter((value) => value.ruleId === rule.id)),
      ]),
    ) as Record<DiagnosticRuleId, FixtureMetrics>,
  };
}

export function renderPrecisionRecallReport(
  report = evaluateFixtureCorpus(),
): string {
  const rows = DIAGNOSTIC_RULES.map((rule) => {
    const value = report.byRule[rule.id];
    return `| ${rule.id} | ${value.truePositive} | ${value.trueNegative} | ${value.falsePositive} | ${value.falseNegative} | ${value.precision.toFixed(2)} | ${value.recall.toFixed(2)} |`;
  });
  return [
    '# Deterministic diagnostics fixture report',
    '',
    `Corpus: ${report.fixtureCount} synthetic positive, negative, and edge fixtures.`,
    '',
    '| Rule | TP | TN | FP | FN | Precision | Recall |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    `Overall precision: ${report.precision.toFixed(2)}. Overall recall: ${report.recall.toFixed(2)}.`,
    '',
    'This report measures only the committed deterministic fixture corpus; it is not a claim about real-world incidence or quality.',
    '',
  ].join('\n');
}
