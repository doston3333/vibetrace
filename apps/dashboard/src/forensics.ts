import type { JsonObject, JsonValue, TraceEvent } from '@vibetrace/schema';

import type { StoredEvent } from './api.js';

export const TIMELINE_LANES = [
  'conversation',
  'context',
  'tools',
  'code',
  'verification',
] as const;
export type TimelineLane = (typeof TIMELINE_LANES)[number];

export interface TimelineItem {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly lane: TimelineLane;
  readonly title: string;
  readonly detail: string;
  readonly tone: 'neutral' | 'success' | 'failure' | 'gap';
  readonly stored: StoredEvent;
}

const ANSI_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`,
  'gu',
);

export function laneFor(type: string): TimelineLane {
  if (/^(message\.|turn\.|session\.)/.test(type)) return 'conversation';
  if (/^(instruction\.|skill\.|context\.|subagent\.)/.test(type))
    return 'context';
  if (/^(file\.|git\.)/.test(type)) return 'code';
  if (/^(test|lint|build|typecheck)\./.test(type)) return 'verification';
  return 'tools';
}

function plain(value: unknown, limit = 180): string {
  const text =
    typeof value === 'string'
      ? value
      : value === undefined
        ? ''
        : JSON.stringify(value);
  return text
    .replaceAll(ANSI_SEQUENCE, '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function safeDisplayText(value: unknown, limit = 200_000): string {
  const text =
    typeof value === 'string'
      ? value
      : value === undefined
        ? ''
        : JSON.stringify(value, null, 2);
  return text
    .replaceAll(ANSI_SEQUENCE, '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join('')
    .slice(0, limit);
}

function payload(event: TraceEvent): JsonObject {
  return event.payload as JsonObject;
}

export function eventTitle(event: TraceEvent): string {
  const value = payload(event);
  switch (event.type) {
    case 'message.user':
      return 'User prompt';
    case 'message.agent':
      return 'Agent response';
    case 'command.started':
      return 'Command started';
    case 'command.completed':
      return Number(value.exitCode) === 0 ? 'Command passed' : 'Command failed';
    case 'file.read':
      return 'File observed';
    case 'file.changed':
      return 'File changed';
    case 'git.snapshot':
      return `${plain(value.phase) || 'Repository'} snapshot`;
    case 'capture.gap':
      return 'Capture gap';
    case 'context.compaction.started':
      return 'Context compaction started';
    case 'context.compaction.completed':
      return 'Context compaction completed';
    case 'permission.requested':
      return 'Approval requested';
    case 'permission.resolved':
      return 'Approval resolved';
    case 'test.completed':
      return value.success === true ? 'Tests passed' : 'Tests failed';
    case 'lint.completed':
      return value.success === true ? 'Lint passed' : 'Lint failed';
    case 'build.completed':
      return value.success === true ? 'Build passed' : 'Build failed';
    case 'typecheck.completed':
      return value.success === true ? 'Typecheck passed' : 'Typecheck failed';
    default:
      return event.type.replaceAll('.', ' ');
  }
}

export function eventDetail(event: TraceEvent): string {
  const value = payload(event);
  for (const candidate of [
    value.content,
    value.command,
    value.path,
    value.summary,
    value.reason,
    value.toolName,
  ]) {
    const text = plain(candidate);
    if (text) return text;
  }
  switch (event.type) {
    case 'session.started':
      return 'Codex started this captured session.';
    case 'session.completed':
      return 'Codex ended this captured session.';
    case 'turn.completed':
      return 'Codex finished this turn.';
    case 'tool.started':
      return `${event.toolName ?? 'Tool'} invocation began.`;
    case 'tool.completed':
      return `${event.toolName ?? 'Tool'} returned control to Codex.`;
    default:
      return 'No human-readable summary is available. Open Raw for the preserved source payload.';
  }
}

export function eventTone(event: TraceEvent): TimelineItem['tone'] {
  if (event.type === 'capture.gap') return 'gap';
  const value = payload(event);
  if (
    event.status === 'failed' ||
    (typeof value.exitCode === 'number' && value.exitCode !== 0) ||
    value.success === false
  )
    return 'failure';
  if (
    event.status === 'completed' ||
    value.success === true ||
    value.exitCode === 0
  )
    return 'success';
  return 'neutral';
}

/** Build a compact immutable timeline model in one linear pass. */
export function buildTimelineModel(
  events: readonly StoredEvent[],
): readonly TimelineItem[] {
  return events
    .filter(
      (stored) =>
        !(
          stored.event.type === 'message.agent' &&
          Object.hasOwn(stored.event.payload, 'duplicateOfEventId')
        ),
    )
    .map((stored) => ({
      id: stored.id,
      sequence: stored.sequence,
      timestamp: stored.timestamp,
      type: stored.type,
      lane: laneFor(stored.type),
      title: eventTitle(stored.event),
      detail: eventDetail(stored.event),
      tone: eventTone(stored.event),
      stored,
    }));
}

export function matchesEvent(
  item: TimelineItem,
  filters: {
    readonly search: string;
    readonly lane: TimelineLane | 'all';
    readonly status: 'all' | 'failed' | 'gaps';
  },
): boolean {
  if (filters.lane !== 'all' && item.lane !== filters.lane) return false;
  if (filters.status === 'failed' && item.tone !== 'failure') return false;
  if (filters.status === 'gaps' && item.tone !== 'gap') return false;
  const search = filters.search.trim().toLocaleLowerCase();
  return (
    !search ||
    `${item.title} ${item.detail} ${item.type}`
      .toLocaleLowerCase()
      .includes(search)
  );
}

export function relatedEvents(
  selected: StoredEvent,
  events: readonly StoredEvent[],
): readonly StoredEvent[] {
  const parent = selected.event.parentEventId;
  const source = selected.event.sourceEventId;
  return events.filter(
    (candidate) =>
      candidate.id !== selected.id &&
      (candidate.id === parent ||
        candidate.event.parentEventId === selected.id ||
        (source !== undefined && candidate.event.sourceEventId === source)),
  );
}

export function eventDiff(event: TraceEvent): string | undefined {
  const value = payload(event).diff;
  return typeof value === 'string' ? safeDisplayText(value) : undefined;
}

const SENSITIVE_KEY =
  /token|secret|password|authorization|cookie|connection|string|private|key/i;

function redact(value: JsonValue, key?: string): JsonValue {
  if (key && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ]),
    );
  if (
    typeof value === 'string' &&
    value.length >= 32 &&
    /^[A-Za-z0-9_./+=-]+$/.test(value)
  )
    return '[redacted: high-entropy value]';
  return value;
}

export function redactionPreview(event: TraceEvent): JsonValue {
  return redact(event.rawPayload);
}

export function formatClock(timestamp: string): string {
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime())
    ? 'time unknown'
    : value.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

export function formatDuration(startedAt: string, endedAt?: string): string {
  if (!endedAt) return 'In progress';
  const milliseconds = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unknown';
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
