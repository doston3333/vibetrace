import { createHash } from 'node:crypto';

import type { JsonObject, TraceEvent } from '@vibetrace/schema';
import type { StoredEvalRun } from '@vibetrace/storage';
import { z } from 'zod';

export const COMPARISON_DIMENSIONS = [
  'model',
  'reasoningEffort',
  'approvalPolicy',
  'sandboxPolicy',
  'networkPolicy',
  'instructionSet',
  'skillSet',
  'environmentFingerprint',
  'repetition',
] as const;
export type ComparisonDimension = (typeof COMPARISON_DIMENSIONS)[number];

/** Reviewable matrix controls; unknown extension fields remain opaque metadata. */
export const ComparisonMatrixConfigurationSchema = z
  .object({
    dimensions: z.array(z.enum(COMPARISON_DIMENSIONS)).max(16).optional(),
    repetitions: z.number().int().min(1).max(100).optional(),
    controlRunId: z.string().uuid().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.dimensions === undefined) return;
    const unique = new Set(value.dimensions);
    if (unique.size !== value.dimensions.length)
      context.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'Comparison dimensions must be unique.',
      });
  });
export type ComparisonMatrixConfiguration = z.infer<
  typeof ComparisonMatrixConfigurationSchema
>;

export interface ComparableEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly source: string;
  readonly status?: string;
  readonly toolName?: string;
  readonly payload: JsonObject;
}

export interface FirstDivergence {
  readonly index: number;
  readonly reason:
    | 'missing-left'
    | 'missing-right'
    | 'type'
    | 'source'
    | 'status'
    | 'tool'
    | 'payload';
  readonly leftEventId?: string;
  readonly rightEventId?: string;
  readonly left?: ComparableEvent;
  readonly right?: ComparableEvent;
}

export interface ComparisonSummary {
  readonly runCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
  readonly successRate: number | null;
  readonly durationMs: {
    readonly median: number | null;
    readonly p95: number | null;
  };
  readonly toolCount: {
    readonly median: number | null;
    readonly p95: number | null;
  };
  readonly diffFileCount: {
    readonly median: number | null;
    readonly p95: number | null;
  };
  readonly tokenCount: {
    readonly median: number | null;
    readonly p95: number | null;
  };
  readonly estimatedCostMicros: {
    readonly median: number | null;
    readonly p95: number | null;
  };
  readonly firstDivergence?: FirstDivergence;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventView(event: TraceEvent): ComparableEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    source: event.source,
    ...(event.status ? { status: event.status } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    payload: event.payload as JsonObject,
  };
}

/** Compare observable event meaning while intentionally ignoring timestamps and raw transport IDs. */
export function firstDivergence(
  left: readonly TraceEvent[],
  right: readonly TraceEvent[],
): FirstDivergence | undefined {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const leftEvent = left[index] ? eventView(left[index]!) : undefined;
    const rightEvent = right[index] ? eventView(right[index]!) : undefined;
    if (!leftEvent)
      return {
        index,
        reason: 'missing-left',
        rightEventId: rightEvent?.id,
        right: rightEvent,
      };
    if (!rightEvent)
      return {
        index,
        reason: 'missing-right',
        leftEventId: leftEvent.id,
        left: leftEvent,
      };
    const reason =
      leftEvent.type !== rightEvent.type
        ? 'type'
        : leftEvent.source !== rightEvent.source
          ? 'source'
          : leftEvent.status !== rightEvent.status
            ? 'status'
            : leftEvent.toolName !== rightEvent.toolName
              ? 'tool'
              : canonicalJson(leftEvent.payload) !==
                  canonicalJson(rightEvent.payload)
                ? 'payload'
                : undefined;
    if (reason)
      return {
        index,
        reason,
        leftEventId: leftEvent.id,
        rightEventId: rightEvent.id,
        left: leftEvent,
        right: rightEvent,
      };
  }
  return undefined;
}

function percentile(
  values: readonly number[],
  percentileValue: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.ceil(percentileValue * sorted.length) - 1,
  );
  return sorted[Math.max(0, rank)] ?? null;
}

function metric(run: StoredEvalRun, key: string): number | undefined {
  const value = run.metrics?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Aggregate deterministic outcome/operational metrics without a universal quality score. */
export function summarizeRuns(
  runs: readonly StoredEvalRun[],
  divergence?: FirstDivergence,
): ComparisonSummary {
  const passedCount = runs.filter(
    (run) => run.outcome?.success === true,
  ).length;
  const failedCount = runs.filter(
    (run) => run.outcome?.success === false,
  ).length;
  const pendingCount = runs.length - passedCount - failedCount;
  const definitive = passedCount + failedCount;
  const durations = runs
    .map((run) => metric(run, 'durationMs'))
    .filter((value): value is number => value !== undefined);
  const tools = runs
    .map((run) => metric(run, 'toolCount'))
    .filter((value): value is number => value !== undefined);
  const diffs = runs
    .map((run) => metric(run, 'diffFileCount'))
    .filter((value): value is number => value !== undefined);
  const tokens = runs
    .map((run) => metric(run, 'tokenCount'))
    .filter((value): value is number => value !== undefined);
  const costs = runs
    .map((run) => metric(run, 'estimatedCostMicros'))
    .filter((value): value is number => value !== undefined);
  return {
    runCount: runs.length,
    passedCount,
    failedCount,
    pendingCount,
    successRate: definitive === 0 ? null : passedCount / definitive,
    durationMs: {
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    toolCount: { median: percentile(tools, 0.5), p95: percentile(tools, 0.95) },
    diffFileCount: {
      median: percentile(diffs, 0.5),
      p95: percentile(diffs, 0.95),
    },
    tokenCount: {
      median: percentile(tokens, 0.5),
      p95: percentile(tokens, 0.95),
    },
    estimatedCostMicros: {
      median: percentile(costs, 0.5),
      p95: percentile(costs, 0.95),
    },
    ...(divergence ? { firstDivergence: divergence } : {}),
  };
}

/** Stable digest for a comparison summary used by API/cache consumers. */
export function hashSummary(summary: ComparisonSummary): string {
  return createHash('sha256').update(canonicalJson(summary)).digest('hex');
}
