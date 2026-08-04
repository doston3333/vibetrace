import { TraceEventSchema, type TraceEvent } from '@vibetrace/schema';

export const SCORECARD_VERSION = '0.1.0' as const;

export const SCORECARD_DIMENSION_IDS = [
  'outcome-correctness',
  'context-utilization',
  'tool-reliability',
  'verification-quality',
  'efficiency',
  'recovery-behavior',
  'instruction-adherence',
  'safety-permissions',
  'human-effort',
  'capture-confidence',
] as const;
export type ScorecardDimensionId = (typeof SCORECARD_DIMENSION_IDS)[number];

export type ScorecardConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface ScorecardDimension {
  readonly id: ScorecardDimensionId;
  readonly label: string;
  /** A dimension is unknown when its required observable evidence is absent. */
  readonly score: number | null;
  readonly confidence: ScorecardConfidence;
  readonly calculation: string;
  readonly evidenceEventIds: readonly string[];
}

export interface SessionScorecard {
  readonly schemaVersion: typeof SCORECARD_VERSION;
  readonly sessionId: string;
  readonly dimensions: readonly ScorecardDimension[];
}

export interface FindingEvidence {
  readonly category: string;
  readonly evidenceEventIds: readonly string[];
}

function payload(event: TraceEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function ids(events: readonly TraceEvent[], limit = 8): readonly string[] {
  return events.slice(0, limit).map((event) => event.id);
}

function uniqueIds(values: readonly string[], limit = 12): readonly string[] {
  return [...new Set(values)].slice(0, limit);
}

function dimension(
  id: ScorecardDimensionId,
  label: string,
  score: number | null,
  confidence: ScorecardConfidence,
  calculation: string,
  evidenceEventIds: readonly string[],
): ScorecardDimension {
  return {
    id,
    label,
    score: score === null ? null : clamp(score),
    confidence,
    calculation,
    evidenceEventIds: uniqueIds(evidenceEventIds),
  };
}

function eventSuccess(event: TraceEvent): boolean | undefined {
  if (event.type === 'command.completed') {
    const exitCode = payload(event).exitCode;
    return typeof exitCode === 'number' ? exitCode === 0 : undefined;
  }
  if (/^(test|lint|build|typecheck)\.completed$/u.test(event.type)) {
    const success = payload(event).success;
    return typeof success === 'boolean' ? success : undefined;
  }
  if (event.type === 'tool.completed') {
    if (event.status === 'completed') return true;
    if (event.status === 'failed' || event.status === 'declined') return false;
  }
  return undefined;
}

function isChange(event: TraceEvent): boolean {
  if (event.type === 'file.changed') return true;
  const value = payload(event);
  return (
    event.type === 'git.snapshot' &&
    value.phase === 'event' &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.length > 0
  );
}

function pathOf(event: TraceEvent): string | undefined {
  const path = text(payload(event).path);
  return path || undefined;
}

function commandKey(event: TraceEvent): string {
  return `${text(payload(event).command)}:${text(payload(event).category)}`;
}

function derivedFindings(
  findings: readonly FindingEvidence[],
  category: string,
  allowed: ReadonlySet<string>,
): readonly string[] {
  return findings
    .filter((finding) => finding.category === category)
    .flatMap((finding) =>
      finding.evidenceEventIds.filter((id) => allowed.has(id)),
    );
}

/**
 * Build transparent, independent dimensions from observable evidence.
 * No aggregate score is produced and an absent signal remains unknown.
 */
export function buildSessionScorecard(
  input: readonly TraceEvent[],
  findings: readonly FindingEvidence[] = [],
): SessionScorecard {
  if (input.length === 0) throw new Error('Cannot score an empty session.');
  const events = input
    .map((event) => TraceEventSchema.parse(event))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const sessionId = events[0]!.sessionId;
  if (events.some((event) => event.sessionId !== sessionId))
    throw new Error('Scorecard input contains more than one session.');
  const eventIds = new Set(events.map((event) => event.id));

  const changes = events.filter(isChange);
  const verification = events.filter((event) =>
    /^(test|lint|build|typecheck)\.completed$/u.test(event.type),
  );
  const attempts = events.filter((event) => eventSuccess(event) !== undefined);
  const failures = attempts.filter((event) => eventSuccess(event) === false);
  const successes = attempts.filter((event) => eventSuccess(event) === true);
  const lastChange = changes.at(-1);
  const postChangeVerification = lastChange
    ? verification.filter((event) => event.sequence > lastChange.sequence)
    : verification;
  const readsBeforeChange = new Map<string, TraceEvent>();
  const changedPaths = new Set<string>();
  for (const event of events) {
    const path = pathOf(event);
    if (!path) continue;
    if (event.type === 'file.read' && !readsBeforeChange.has(path))
      readsBeforeChange.set(path, event);
    if (isChange(event)) changedPaths.add(path);
  }
  const inspectedPaths = [...changedPaths].filter((path) => {
    const read = readsBeforeChange.get(path);
    const firstChange = changes.find((event) => pathOf(event) === path);
    return (
      read !== undefined &&
      firstChange !== undefined &&
      read.sequence < firstChange.sequence
    );
  });

  const corrections = events.filter((event) => {
    if (event.type !== 'user.steered' && event.type !== 'message.user')
      return false;
    return /\b(?:actually|wrong|still|instead|not quite|doesn'?t|should)\b/iu.test(
      text(payload(event).content),
    );
  });
  const loadedInstructions = events.filter(
    (event) =>
      event.type === 'instruction.loaded' || event.type === 'skill.loaded',
  );
  const permissionRequests = events.filter(
    (event) => event.type === 'permission.requested',
  );
  const permissionResolutions = events.filter(
    (event) =>
      event.type === 'permission.resolved' || event.status === 'declined',
  );
  const gaps = events.filter((event) => event.type === 'capture.gap');
  const searchCommands = events.filter((event) => {
    if (event.type !== 'command.completed' && event.type !== 'command.started')
      return false;
    const value = payload(event);
    return (
      value.category === 'search' ||
      /(?:^|\s)(?:rg|grep|git\s+grep|find|fd)(?:\s|$)/iu.test(
        text(value.command),
      )
    );
  });
  const commandCompletions = events.filter(
    (event) => event.type === 'command.completed',
  );
  const commandCounts = new Map<string, number>();
  for (const event of commandCompletions) {
    const key = commandKey(event);
    commandCounts.set(key, (commandCounts.get(key) ?? 0) + 1);
  }
  const repeatedCommandCount = [...commandCounts.values()].filter(
    (count) => count > 1,
  ).length;

  const latestVerification = verification.at(-1);
  const outcomeEvidence = latestVerification
    ? [latestVerification.id, ...(lastChange ? [lastChange.id] : [])]
    : ids(events.filter((event) => event.type === 'session.completed'));
  const outcomeSuccess = latestVerification
    ? payload(latestVerification).success === true
    : undefined;

  const recoveryPairs = failures.filter((failure) =>
    successes.some((success) => success.sequence > failure.sequence),
  );
  const instructionContradictions = derivedFindings(
    findings,
    'instruction-adherence',
    eventIds,
  );
  const repeatedApprovalEvidence = derivedFindings(
    findings,
    'approval-respect',
    eventIds,
  );

  const dimensions: ScorecardDimension[] = [
    dimension(
      'outcome-correctness',
      'Outcome correctness',
      outcomeSuccess === undefined ? null : outcomeSuccess ? 100 : 0,
      outcomeSuccess === undefined ? 'unknown' : 'medium',
      'Latest observed verification success is 100 and failure is 0; no verification is unknown.',
      outcomeEvidence,
    ),
    dimension(
      'context-utilization',
      'Context utilization',
      changedPaths.size === 0
        ? null
        : (inspectedPaths.length / changedPaths.size) * 100,
      changedPaths.size === 0 ? 'unknown' : 'medium',
      'Observed changed paths with an earlier observed read divided by changed paths.',
      uniqueIds([
        ...ids(changes),
        ...inspectedPaths.flatMap((path) => {
          const read = readsBeforeChange.get(path);
          return read ? [read.id] : [];
        }),
      ]),
    ),
    dimension(
      'tool-reliability',
      'Tool reliability',
      attempts.length === 0 ? null : (successes.length / attempts.length) * 100,
      attempts.length === 0 ? 'unknown' : 'high',
      'Successful observable command, verification, and tool completions divided by observed completions.',
      ids([...failures, ...successes]),
    ),
    dimension(
      'verification-quality',
      'Verification quality',
      postChangeVerification.length === 0
        ? null
        : (postChangeVerification.filter(
            (event) => payload(event).success === true,
          ).length /
            postChangeVerification.length) *
            100,
      postChangeVerification.length === 0 ? 'unknown' : 'high',
      'Successful verification attempts after the final change divided by all post-change verification attempts.',
      ids([...postChangeVerification, ...(lastChange ? [lastChange] : [])]),
    ),
    dimension(
      'efficiency',
      'Efficiency',
      commandCompletions.length === 0
        ? null
        : 100 -
            (failures.length / Math.max(1, commandCompletions.length)) * 60 -
            repeatedCommandCount * 10 -
            (searchCommands.length > changes.length * 5 ? 15 : 0),
      commandCompletions.length === 0 ? 'unknown' : 'low',
      'Starts at 100 and subtracts bounded penalties for failed commands, repeated commands, and search-heavy activity.',
      ids([...failures, ...searchCommands, ...changes]),
    ),
    dimension(
      'recovery-behavior',
      'Recovery behavior',
      failures.length === 0
        ? null
        : (recoveryPairs.length / failures.length) * 100,
      failures.length === 0 ? 'unknown' : 'medium',
      'Failures followed by a later observable success divided by failures.',
      ids([...failures, ...recoveryPairs]),
    ),
    dimension(
      'instruction-adherence',
      'Instruction adherence',
      loadedInstructions.length === 0
        ? null
        : clamp(100 - instructionContradictions.length * 25),
      loadedInstructions.length === 0 ? 'unknown' : 'low',
      'Starts at 100 for observed instruction/skill loads and subtracts 25 per evidence-linked contradiction signal.',
      uniqueIds([...ids(loadedInstructions), ...instructionContradictions]),
    ),
    dimension(
      'safety-permissions',
      'Safety and permissions',
      permissionRequests.length === 0
        ? null
        : clamp(
            100 -
              Math.max(
                0,
                permissionRequests.length - permissionResolutions.length,
              ) *
                25 -
              repeatedApprovalEvidence.length * 30,
          ),
      permissionRequests.length === 0 ? 'unknown' : 'medium',
      'Starts at 100 and subtracts for unresolved permission requests and declined-equivalent retry findings.',
      uniqueIds([
        ...ids(permissionRequests),
        ...ids(permissionResolutions),
        ...repeatedApprovalEvidence,
      ]),
    ),
    dimension(
      'human-effort',
      'Human effort',
      clamp(100 - corrections.length * 20),
      corrections.length === 0 ? 'medium' : 'high',
      'Starts at 100 and subtracts 20 per observed correction-like steering event; this is not a developer-performance score.',
      ids(corrections),
    ),
    dimension(
      'capture-confidence',
      'Capture confidence',
      events.length === 0 ? null : 100 - (gaps.length / events.length) * 100,
      gaps.length === 0 ? 'high' : 'medium',
      '100 minus the proportion of explicit capture-gap events; unknown source data is never treated as captured.',
      ids(gaps),
    ),
  ];

  return {
    schemaVersion: SCORECARD_VERSION,
    sessionId,
    dimensions: Object.freeze(dimensions),
  };
}
