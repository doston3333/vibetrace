import type { TraceEvent } from '@vibetrace/schema';

const EVENT_COUNT = 1000;
const FIXED_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = '7a889e3d-2c42-5d09-8fdb-0e7e9f1a0101';

function fixtureEventId(sequence: number): string {
  return `00000000-0000-5000-8000-${sequence.toString().padStart(12, '0')}`;
}

function createStaticEvent(sequence: number): TraceEvent {
  const timestamp = new Date(FIXED_EPOCH + sequence * 1000).toISOString();
  const cycle = sequence % 6;
  const event: {
    readonly payload: TraceEvent['payload'];
    readonly source: TraceEvent['source'];
    readonly type: TraceEvent['type'];
  } =
    cycle === 0
      ? {
          payload: { command: 'pnpm test', success: true },
          source: 'tool' as const,
          type: 'test.completed' as const,
        }
      : cycle === 1
        ? {
            payload: { path: 'src/feature.ts' },
            source: 'tool' as const,
            type: 'file.read' as const,
          }
        : cycle === 2
          ? {
              payload: {
                diff: '+export const fixture = true;',
                path: 'src/feature.ts',
              },
              source: 'agent' as const,
              type: 'file.changed' as const,
            }
          : cycle === 3
            ? {
                payload: { command: 'pnpm test' },
                source: 'tool' as const,
                type: 'command.started' as const,
              }
            : cycle === 4
              ? {
                  payload: { command: 'pnpm test', exitCode: 0 },
                  source: 'tool' as const,
                  type: 'command.completed' as const,
                }
              : {
                  payload: { content: `Verified fixture step ${sequence}` },
                  source: 'agent' as const,
                  type: 'message.agent' as const,
                };

  return {
    id: fixtureEventId(sequence),
    payload: event.payload,
    provenance: {
      adapter: 'vibetrace-synthetic',
      adapterVersion: '0.1.0',
      captureMode: 'standard',
      sourceVersion: '0.1.0',
    },
    rawPayload: {
      sourceEventId: `event-${sequence}`,
      untrustedPreview:
        sequence === 1 ? '<synthetic-trace-content>' : `raw-${sequence}`,
    },
    schemaVersion: '0.1.0',
    sequence,
    sessionId: SESSION_ID,
    source: event.source,
    timestamp,
    type: event.type,
  } as TraceEvent;
}

/** Browser-safe deterministic sample data for the Milestone-0 static dashboard. */
export const staticDashboardTrace = Object.freeze({
  events: Object.freeze(
    Array.from({ length: EVENT_COUNT }, (_, index) =>
      createStaticEvent(index + 1),
    ),
  ),
  scenario: 'code-change-tests',
  sessionId: SESSION_ID,
  signature: 'vibetrace-synthetic/0.1.0/code-change-tests/101/1000',
});
