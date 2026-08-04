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

/** Supported, deterministic synthetic trace narratives. */
export const SyntheticTraceScenarios = [
  'successful-edit',
  'failed-command',
  'retry-loop',
  'user-correction',
  'context-compaction',
  'subagent-activity',
  'code-change-tests',
] as const;

/** A named synthetic trace narrative. */
export type SyntheticTraceScenario = (typeof SyntheticTraceScenarios)[number];

/** Options for a deterministic synthetic trace. */
export interface CreateSyntheticTraceOptions {
  readonly eventCount: 100 | 1000 | 20000;
  readonly scenario: SyntheticTraceScenario;
  readonly seed: number;
}

/** Generated events plus their reproducible scenario signature. */
export interface SyntheticTrace {
  readonly events: readonly TraceEvent[];
  readonly scenario: SyntheticTraceScenario;
  readonly signature: string;
  readonly sessionId: string;
}

const FIXED_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const ADAPTER = 'vibetrace-synthetic';
const ADAPTER_VERSION = '0.1.0';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function scenarioEvent(
  scenario: SyntheticTraceScenario,
  sequence: number,
): { payload: JsonObject; source: EventSource; type: EventType } {
  const remainder = sequence % 12;
  const defaults: {
    payload: JsonObject;
    source: EventSource;
    type: EventType;
  }[] = [
    {
      payload: { content: `Request ${sequence}` },
      source: 'user',
      type: 'message.user',
    },
    { payload: { path: 'src/example.ts' }, source: 'tool', type: 'file.read' },
    { payload: { toolName: 'exec' }, source: 'tool', type: 'tool.started' },
    {
      payload: { command: 'pnpm test', category: 'test' },
      source: 'tool',
      type: 'command.started',
    },
    {
      payload: {
        command: 'pnpm test',
        category: 'test',
        output: 'tests running',
      },
      source: 'tool',
      type: 'command.output',
    },
    {
      payload: { command: 'pnpm test', category: 'test', exitCode: 0 },
      source: 'tool',
      type: 'command.completed',
    },
    {
      payload: { path: 'src/example.ts', diff: '+export const traced = true;' },
      source: 'agent',
      type: 'file.changed',
    },
    {
      payload: {
        command: 'pnpm test',
        category: 'test',
        kind: 'test',
        success: true,
        exitCode: 0,
        summary: 'passed',
      },
      source: 'tool',
      type: 'test.completed',
    },
    {
      payload: { content: `Completed step ${sequence}` },
      source: 'agent',
      type: 'message.agent',
    },
    {
      payload: { name: 'AGENTS.md' },
      source: 'harness',
      type: 'instruction.loaded',
    },
    {
      payload: {
        phase: 'baseline',
        rootHash: 'a'.repeat(64),
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
        dirtyPatchHash: 'b'.repeat(64),
        changedFiles: [],
      },
      source: 'vcs',
      type: 'git.snapshot',
    },
    {
      payload: { content: `Plan ${sequence}` },
      source: 'agent',
      type: 'message.plan',
    },
  ];
  const base = defaults[remainder] as {
    payload: JsonObject;
    source: EventSource;
    type: EventType;
  };

  if (scenario === 'subagent-activity' && sequence % 100 === 2) {
    return {
      payload: { subagentId: `subagent-${Math.floor(sequence / 100) + 1}` },
      source: 'harness',
      type: 'subagent.started',
    };
  }
  if (scenario === 'subagent-activity' && sequence % 100 === 3) {
    return {
      payload: { subagentId: `subagent-${Math.floor(sequence / 100) + 1}` },
      source: 'harness',
      type: 'subagent.completed',
    };
  }

  if (sequence === 2) {
    if (scenario === 'failed-command') {
      return {
        payload: { command: 'pnpm test', category: 'test', exitCode: 1 },
        source: 'tool',
        type: 'command.completed',
      };
    }
    if (scenario === 'retry-loop') {
      return {
        payload: { command: 'pnpm lint', category: 'lint', exitCode: 1 },
        source: 'tool',
        type: 'command.completed',
      };
    }
    if (scenario === 'user-correction') {
      return {
        payload: { content: 'Do not change the public API.' },
        source: 'user',
        type: 'user.steered',
      };
    }
    if (scenario === 'context-compaction') {
      return {
        payload: { reason: 'Context window reached.' },
        source: 'harness',
        type: 'context.compaction.started',
      };
    }
    if (scenario === 'code-change-tests') {
      return {
        payload: {
          path: 'src/feature.ts',
          diff: '+export const feature = true;',
        },
        source: 'agent',
        type: 'file.changed',
      };
    }
  }
  if (scenario === 'retry-loop' && sequence % 8 === 0) {
    return {
      payload: { command: 'pnpm lint', category: 'lint', exitCode: 1 },
      source: 'tool',
      type: 'command.completed',
    };
  }
  if (scenario === 'context-compaction' && sequence === 3) {
    return {
      payload: { reason: 'Summary written.' },
      source: 'harness',
      type: 'context.compaction.completed',
    };
  }
  return base;
}

/**
 * Create a byte-for-byte deterministic trace for a fixed seed and supported size.
 * The fixture is local sample data only; it does not represent live capture.
 */
export function createSyntheticTrace(
  options: CreateSyntheticTraceOptions,
): SyntheticTrace {
  const nextRandom = random(options.seed);
  const sourceSessionId = `${options.scenario}:${options.seed}`;
  const sessionId = createSessionId(ADAPTER, sourceSessionId);
  const events: TraceEvent[] = [];

  for (let index = 1; index <= options.eventCount; index += 1) {
    const scenarioData = scenarioEvent(options.scenario, index);
    const sourceEventId = `event-${index}`;
    const timestamp = new Date(FIXED_EPOCH + index * 1000).toISOString();
    const traceEvent = TraceEventSchema.parse({
      id: createEventId({
        adapter: ADAPTER,
        sourceEventId,
        sourceSequence: index,
        sourceSessionId,
        sourceVersion: ADAPTER_VERSION,
        type: scenarioData.type,
      }),
      payload: scenarioData.payload,
      provenance: {
        adapter: ADAPTER,
        adapterVersion: ADAPTER_VERSION,
        captureMode: 'standard',
        sourceVersion: ADAPTER_VERSION,
      },
      rawPayload: {
        sample: nextRandom(),
        sourceEventId,
        untrustedPreview:
          index === 1 ? '<synthetic-trace-content>' : `raw-${index}`,
      },
      schemaVersion: SCHEMA_VERSION,
      sequence: index,
      sessionId,
      source: scenarioData.source,
      timestamp,
      type: scenarioData.type,
    });
    events.push(traceEvent);
  }

  return Object.freeze({
    events: Object.freeze(events),
    scenario: options.scenario,
    sessionId,
    signature: `vibetrace-synthetic/${SCHEMA_VERSION}/${options.scenario}/${options.seed}/${options.eventCount}`,
  });
}

/** The dashboard's fixed static sample session. */
export const staticDashboardTrace = createSyntheticTrace({
  eventCount: 1000,
  scenario: 'code-change-tests',
  seed: 101,
});
