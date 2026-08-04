import {
  classifyVerificationHistory,
  tokenizeCommand,
} from '@vibetrace/enrichment';
import {
  TraceEventSchema,
  createUuidV5,
  type JsonObject,
  type TraceEvent,
  type VerificationKind,
} from '@vibetrace/schema';
import type {
  FindingInput,
  Storage,
  StoredNormalizedEvent,
} from '@vibetrace/storage';

export {
  buildSessionScorecard,
  SCORECARD_DIMENSION_IDS,
  SCORECARD_VERSION,
  type ScorecardConfidence,
  type ScorecardDimension,
  type ScorecardDimensionId,
  type SessionScorecard,
  type FindingEvidence,
} from './scorecard.js';

export const DIAGNOSTICS_VERSION = '0.1.0' as const;

export const DIAGNOSTIC_RULE_IDS = [
  'no-tests-after-final-change',
  'success-claim-after-unresolved-failure',
  'repeated-identical-failed-command',
  'modified-file-without-observed-inspection',
  'unresolved-error-at-session-end',
  'pre-existing-versus-introduced-failure',
  'compaction-followed-by-user-correction',
  'skill-instruction-contradiction-signal',
  'repeated-tool-error-loop',
  'declined-approval-followed-by-equivalent-request',
  'large-code-churn-relative-to-task',
  'test-before-final-change-without-rerun',
  'user-correction-after-unsupported-success',
  'excessive-search-with-little-state-change',
  'relevant-file-discovered-after-implementation',
] as const;
export type DiagnosticRuleId = (typeof DIAGNOSTIC_RULE_IDS)[number];

export interface RuleContext {
  readonly sessionId: string;
  readonly events: readonly TraceEvent[];
}

export interface RuleFindingDraft {
  readonly key: string;
  readonly category: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high';
  readonly title: string;
  readonly explanation: string;
  readonly recommendation: string;
  readonly evidenceEventIds: readonly string[];
  readonly counterevidenceEventIds?: readonly string[];
}

export interface DiagnosticRule {
  readonly id: DiagnosticRuleId;
  readonly version: string;
  evaluate(context: RuleContext): readonly RuleFindingDraft[];
}

export interface DiagnosticFinding extends FindingInput {
  readonly state: 'open';
}

export interface AnalysisResult {
  readonly analyzerVersion: string;
  readonly sessionId: string;
  readonly evaluatedRuleIds: readonly DiagnosticRuleId[];
  readonly findings: readonly DiagnosticFinding[];
}

/** Define one pure, versioned rule. Output evidence is validated by the SDK. */
export function defineRule(rule: DiagnosticRule): DiagnosticRule {
  if (!DIAGNOSTIC_RULE_IDS.includes(rule.id))
    throw new Error(`Unknown diagnostic rule ID: ${rule.id}.`);
  if (!/^\d+\.\d+\.\d+$/.test(rule.version))
    throw new Error(`Rule ${rule.id} must use a semantic version.`);
  return Object.freeze(rule);
}

function payload(event: TraceEvent): JsonObject {
  return event.payload as JsonObject;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function canonicalCommand(value: unknown): string {
  return tokenizeCommand(text(value)).join(' ');
}

function commandKey(event: TraceEvent): string | undefined {
  const value = payload(event);
  const command = canonicalCommand(value.command);
  const category = text(value.category);
  if (!command) return undefined;
  return ['test', 'lint', 'build', 'typecheck'].includes(category)
    ? `verification:${category}:${command}`
    : `command:${command}`;
}

function verificationKey(event: TraceEvent): string | undefined {
  if (!/^(test|lint|build|typecheck)\.completed$/.test(event.type))
    return undefined;
  const value = payload(event);
  const kind = text(value.kind);
  const command = canonicalCommand(value.command);
  return kind && command ? `verification:${kind}:${command}` : undefined;
}

function toolKey(event: TraceEvent): string | undefined {
  const name = event.toolName ?? text(payload(event).toolName);
  return name ? `tool:${name.toLocaleLowerCase()}` : undefined;
}

function failureKey(event: TraceEvent): string | undefined {
  if (
    event.type === 'command.completed' &&
    Number(payload(event).exitCode) !== 0
  )
    return commandKey(event);
  if (
    /^(test|lint|build|typecheck)\.completed$/.test(event.type) &&
    payload(event).success === false
  )
    return verificationKey(event);
  if (event.type === 'tool.completed' && event.status === 'failed')
    return toolKey(event);
  if (event.type === 'error') {
    const code = text(payload(event).code);
    const message = text(payload(event).message)
      .toLocaleLowerCase()
      .replaceAll(/\s+/g, ' ')
      .slice(0, 160);
    return `error:${code || message}`;
  }
  return undefined;
}

function successKey(event: TraceEvent): string | undefined {
  if (
    event.type === 'command.completed' &&
    Number(payload(event).exitCode) === 0
  )
    return commandKey(event);
  if (
    /^(test|lint|build|typecheck)\.completed$/.test(event.type) &&
    payload(event).success === true
  )
    return verificationKey(event);
  if (event.type === 'tool.completed' && event.status === 'completed')
    return toolKey(event);
  return undefined;
}

function isTestAttempt(event: TraceEvent): boolean {
  return (
    event.type === 'test.completed' ||
    (event.type === 'command.completed' && payload(event).category === 'test')
  );
}

function isChange(event: TraceEvent): boolean {
  if (event.type === 'file.changed') return true;
  const value = payload(event);
  return (
    event.type === 'git.snapshot' &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.length > 0 &&
    value.phase === 'event'
  );
}

function lineCount(
  event: TraceEvent,
  key: 'addedLines' | 'deletedLines',
): number {
  const candidate = payload(event)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : 0;
}

function changedLineCount(event: TraceEvent): number {
  const value = payload(event);
  const explicit =
    lineCount(event, 'addedLines') + lineCount(event, 'deletedLines');
  if (explicit > 0) return explicit;
  const diff = text(value.diff);
  if (!diff) return 0;
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---')),
    ).length;
}

function searchCommand(event: TraceEvent): boolean {
  if (event.type !== 'command.completed' && event.type !== 'command.started')
    return false;
  const value = payload(event);
  if (value.category === 'search') return true;
  return /(?:^|\s)(?:rg|grep|git\s+grep|find|fd|ag|ack)(?:\s|$)/iu.test(
    text(value.command),
  );
}

function correctionEvent(event: TraceEvent): boolean {
  if (event.type !== 'user.steered' && event.type !== 'message.user')
    return false;
  return /\b(?:actually|wrong|no,?|not quite|still|instead|that is not|doesn'?t|should have|you need to)\b/iu.test(
    text(payload(event).content),
  );
}

const SUCCESS_CLAIM =
  /\b(?:completed|done|fixed|implemented|resolved|successful|succeeded|all (?:tests|checks) pass(?:ed)?)\b/i;
const NEGATED_SUCCESS =
  /\b(?:not|never|failed|unable|cannot|can't|did not|didn't)\b.{0,36}\b(?:completed|done|fixed|implemented|resolved|successful|succeeded|pass(?:ed)?)\b/i;

function isSuccessClaim(event: TraceEvent): boolean {
  if (event.type !== 'message.agent') return false;
  const content = text(payload(event).content);
  return SUCCESS_CLAIM.test(content) && !NEGATED_SUCCESS.test(content);
}

function pathOf(event: TraceEvent): string | undefined {
  const path = text(payload(event).path);
  return path || undefined;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const noTestsAfterFinalChange = defineRule({
  id: 'no-tests-after-final-change',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const finalChange = [...events].reverse().find(isChange);
    if (!finalChange) return [];
    if (
      events.some(
        (event) =>
          event.sequence > finalChange.sequence && isTestAttempt(event),
      )
    )
      return [];
    const priorTest = [...events]
      .reverse()
      .find(
        (event) =>
          event.sequence < finalChange.sequence && isTestAttempt(event),
      );
    return [
      {
        key: 'session',
        category: 'verification',
        severity: 'high',
        title: 'No tests observed after the final change',
        explanation:
          'The last observed code change is not followed by a test attempt in the captured session.',
        recommendation:
          'Run the relevant tests after the final change and retain the resulting evidence.',
        evidenceEventIds: [finalChange.id],
        counterevidenceEventIds: priorTest ? [priorTest.id] : [],
      },
    ];
  },
});

const successClaimAfterFailure = defineRule({
  id: 'success-claim-after-unresolved-failure',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const finalMessage = [...events]
      .reverse()
      .find((event) => event.type === 'message.agent');
    if (!finalMessage || !isSuccessClaim(finalMessage)) return [];
    const unresolvedByKey = new Map<string, TraceEvent>();
    for (const event of events) {
      if (event.sequence > finalMessage.sequence) break;
      const failed = failureKey(event);
      if (failed) unresolvedByKey.set(failed, event);
      const succeeded = successKey(event);
      if (succeeded) unresolvedByKey.delete(succeeded);
    }
    const unresolved = [...unresolvedByKey.values()].sort(
      (left, right) => right.sequence - left.sequence,
    )[0];
    if (!unresolved) return [];
    const key = failureKey(unresolved)!;
    const laterResolution = events.find(
      (event) =>
        event.sequence > finalMessage.sequence && successKey(event) === key,
    );
    return [
      {
        key,
        category: 'claim-evidence',
        severity: 'high',
        title: 'Success was claimed after an unresolved failure',
        explanation:
          'The final observed agent message makes a success-like claim after a captured failure without matching successful counter-evidence at claim time.',
        recommendation:
          'Resolve the failure and cite the matching successful command or verification before claiming completion.',
        evidenceEventIds: [unresolved.id, finalMessage.id],
        counterevidenceEventIds: laterResolution ? [laterResolution.id] : [],
      },
    ];
  },
});

const repeatedFailedCommand = defineRule({
  id: 'repeated-identical-failed-command',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const failures = new Map<string, TraceEvent[]>();
    for (const event of events) {
      if (
        event.type !== 'command.completed' ||
        Number(payload(event).exitCode) === 0
      )
        continue;
      const command = canonicalCommand(payload(event).command);
      if (command)
        failures.set(command, [...(failures.get(command) ?? []), event]);
    }
    return [...failures.entries()]
      .filter(([, values]) => values.length >= 2)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([command, values]) => ({
        key: command,
        category: 'tool-loop',
        severity: 'medium' as const,
        title: 'The same failed command was repeated',
        explanation:
          'An identical tokenized command failed at least twice without an observable change to the command.',
        recommendation:
          'Inspect the first failure and change the command or underlying state before retrying.',
        evidenceEventIds: values.map((event) => event.id),
      }));
  },
});

const modifiedWithoutInspection = defineRule({
  id: 'modified-file-without-observed-inspection',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const inspected = new Set<string>();
    const changed = new Set<string>();
    const uninspected = new Map<
      string,
      { readonly change: TraceEvent; readonly laterReadIds: string[] }
    >();
    for (const event of events) {
      const path = pathOf(event);
      if (!path) continue;
      if (event.type === 'file.read') {
        inspected.add(path);
        uninspected.get(path)?.laterReadIds.push(event.id);
        continue;
      }
      if (event.type !== 'file.changed' || changed.has(path)) continue;
      changed.add(path);
      if (!inspected.has(path))
        uninspected.set(path, { change: event, laterReadIds: [] });
    }
    return [...uninspected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, value]) => ({
        key: path,
        category: 'code-understanding',
        severity: 'medium' as const,
        title: 'A modified file was not observed before editing',
        explanation:
          'The captured timeline contains a file change without an earlier read of the same exact path.',
        recommendation:
          'Inspect the current file and its relevant callers before making or extending the change.',
        evidenceEventIds: [value.change.id],
        counterevidenceEventIds: value.laterReadIds,
      }));
  },
});

const unresolvedErrorAtEnd = defineRule({
  id: 'unresolved-error-at-session-end',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const sessionEnd = [...events]
      .reverse()
      .find((event) => event.type === 'session.completed');
    if (!sessionEnd) return [];
    const resolvedKeys = new Set<string>();
    let last: TraceEvent | undefined;
    for (const event of [...events]
      .filter((candidate) => candidate.sequence <= sessionEnd.sequence)
      .reverse()) {
      const succeeded = successKey(event);
      if (succeeded) resolvedKeys.add(succeeded);
      const failed = failureKey(event);
      if (failed && !resolvedKeys.has(failed)) {
        last = event;
        break;
      }
    }
    if (!last) return [];
    return [
      {
        key: failureKey(last)!,
        category: 'unresolved-failure',
        severity: 'high',
        title: 'An error remained unresolved at session end',
        explanation:
          'The final matching state for a captured failure has no successful resolution in the observed timeline.',
        recommendation:
          'Resolve or explicitly acknowledge the failure before ending the session.',
        evidenceEventIds: [last.id, sessionEnd.id],
      },
    ];
  },
});

function verificationEvidence(event: TraceEvent):
  | {
      eventId: string;
      sequence: number;
      command: string;
      kind: VerificationKind;
      success: boolean;
    }
  | undefined {
  const value = payload(event);
  if (/^(test|lint|build|typecheck)\.completed$/.test(event.type))
    return {
      eventId: event.id,
      sequence: event.sequence,
      command: text(value.command),
      kind: text(value.kind) as VerificationKind,
      success: value.success === true,
    };
  if (event.type === 'command.completed') {
    const category = text(value.category);
    if (!['test', 'lint', 'build', 'typecheck'].includes(category))
      return undefined;
    return {
      eventId: event.id,
      sequence: event.sequence,
      command: text(value.command),
      kind: category as VerificationKind,
      success: Number(value.exitCode) === 0,
    };
  }
  return undefined;
}

const preExistingVersusIntroduced = defineRule({
  id: 'pre-existing-versus-introduced-failure',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const firstChange = events.find(isChange);
    if (!firstChange) return [];
    const history = classifyVerificationHistory(
      events.map(verificationEvidence).filter((value) => value !== undefined),
      firstChange.sequence,
    );
    return history
      .filter(
        (item) =>
          item.status === 'introduced' || item.status === 'pre-existing',
      )
      .map((item) => ({
        key: `${item.kind}:${item.command}`,
        category: 'failure-origin',
        severity:
          item.status === 'introduced' ? ('high' as const) : ('info' as const),
        title:
          item.status === 'introduced'
            ? 'A verification failure was introduced after changes'
            : 'A verification failure predates the recorded changes',
        explanation:
          item.status === 'introduced'
            ? 'The same verification passed before the first observed change and failed afterward.'
            : 'The same verification failed both before and after the first observed change.',
        recommendation:
          item.status === 'introduced'
            ? 'Inspect the first change and the failing verification evidence for a regression.'
            : 'Separate the pre-existing failure from regressions introduced by this session.',
        evidenceEventIds: item.evidenceIds.filter(
          (id) => !item.counterevidenceIds.includes(id),
        ),
        counterevidenceEventIds: item.counterevidenceIds,
      }));
  },
});

const compactionThenCorrection = defineRule({
  id: 'compaction-followed-by-user-correction',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const correction = events.find(
      (event) =>
        event.type === 'user.steered' &&
        events.some(
          (candidate) =>
            /^context\.compaction\.(?:started|completed)$/.test(
              candidate.type,
            ) && candidate.sequence < event.sequence,
        ),
    );
    if (!correction) return [];
    const compaction = [...events]
      .reverse()
      .find(
        (event) =>
          /^context\.compaction\.(?:started|completed)$/.test(event.type) &&
          event.sequence < correction.sequence,
      )!;
    return [
      {
        key: 'session',
        category: 'context-retention',
        severity: 'medium',
        title: 'A user correction followed context compaction',
        explanation:
          'A semantic user steering event occurs after the captured context-compaction boundary.',
        recommendation:
          'Review the compacted requirements and verify the correction is reflected in subsequent work.',
        evidenceEventIds: [compaction.id, correction.id],
      },
    ];
  },
});

const CONTRADICTION_SIGNAL =
  /\b(?:do not|don't|must not|should not|wrong|contrary|ignored|instead|stop)\b/i;

const instructionContradiction = defineRule({
  id: 'skill-instruction-contradiction-signal',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    for (const correction of events.filter(
      (event) =>
        event.type === 'user.steered' &&
        CONTRADICTION_SIGNAL.test(text(payload(event).content)),
    )) {
      const loaded = [...events]
        .reverse()
        .find(
          (event) =>
            (event.type === 'instruction.loaded' ||
              event.type === 'skill.loaded') &&
            event.sequence < correction.sequence,
        );
      if (!loaded) continue;
      return [
        {
          key: `${loaded.type}:${text(payload(loaded).name)}`,
          category: 'instruction-adherence',
          severity: 'medium',
          title: 'A correction signals a possible instruction contradiction',
          explanation:
            'A contradiction-like user steering message follows a captured instruction or skill load. This is a signal, not proof of violation.',
          recommendation:
            'Compare the correction with the loaded instruction or skill before continuing.',
          evidenceEventIds: [loaded.id, correction.id],
        },
      ];
    }
    return [];
  },
});

const repeatedToolErrorLoop = defineRule({
  id: 'repeated-tool-error-loop',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const runs = new Map<string, TraceEvent[]>();
    const findings = new Map<string, TraceEvent[]>();
    for (const event of events) {
      const key = toolKey(event);
      if (!key) continue;
      const failed =
        (event.type === 'tool.completed' && event.status === 'failed') ||
        event.type === 'error';
      const succeeded =
        event.type === 'tool.completed' && event.status === 'completed';
      if (succeeded) runs.set(key, []);
      else if (failed) {
        const run = [...(runs.get(key) ?? []), event];
        runs.set(key, run);
        if (run.length >= 3 && !findings.has(key)) findings.set(key, run);
      }
    }
    return [...findings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, run]) => ({
        key,
        category: 'tool-loop',
        severity: 'high' as const,
        title: 'A repeated tool-error loop was observed',
        explanation:
          'The same tool produced at least three failure events without an intervening successful completion.',
        recommendation:
          'Stop retrying, inspect the earliest error, and change the tool input or environment.',
        evidenceEventIds: run.map((event) => event.id),
      }));
  },
});

function approvalSignature(event: TraceEvent): string | undefined {
  const value = payload(event);
  const toolName = event.toolName ?? text(value.toolName ?? value.tool_name);
  const toolInput = value.toolInput ?? value.tool_input ?? value.input;
  if (toolName && toolInput !== undefined)
    return stableJson({ toolName: toolName.toLocaleLowerCase(), toolInput });
  const command = text(value.command);
  return toolName && command
    ? stableJson({ command, toolName: toolName.toLocaleLowerCase() })
    : undefined;
}

function isDeclined(event: TraceEvent): boolean {
  if (event.type === 'tool.completed' && event.status === 'declined')
    return true;
  if (event.type !== 'permission.resolved') return false;
  if (event.status === 'declined') return true;
  const value = payload(event);
  return [value.decision, value.outcome, value.result, value.status].some(
    (candidate) =>
      typeof candidate === 'string' &&
      /^(?:declined|denied|rejected)$/i.test(candidate),
  );
}

const declinedApprovalRepeated = defineRule({
  id: 'declined-approval-followed-by-equivalent-request',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const requests = events.filter(
      (event) => event.type === 'permission.requested',
    );
    for (const declined of events.filter(isDeclined)) {
      const requestId = text(payload(declined).requestId);
      const declinedSignature = approvalSignature(declined);
      const original = [...requests]
        .reverse()
        .find(
          (event) =>
            event.sequence < declined.sequence &&
            ((requestId && text(payload(event).requestId) === requestId) ||
              (declinedSignature !== undefined &&
                approvalSignature(event) === declinedSignature)),
        );
      if (!original) continue;
      const signature = approvalSignature(original);
      if (!signature) continue;
      const repeated = requests.find(
        (event) =>
          event.sequence > declined.sequence &&
          approvalSignature(event) === signature,
      );
      if (!repeated) continue;
      return [
        {
          key: signature,
          category: 'approval-respect',
          severity: 'high',
          title: 'A declined approval was followed by an equivalent request',
          explanation:
            'A later approval request has the same nonvolatile payload as a request the user declined.',
          recommendation:
            'Respect the decline and choose a materially different, permitted approach.',
          evidenceEventIds: [original.id, declined.id, repeated.id],
        },
      ];
    }
    return [];
  },
});

const largeCodeChurn = defineRule({
  id: 'large-code-churn-relative-to-task',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const prompt = events.find((event) => event.type === 'message.user');
    const promptText = prompt ? text(payload(prompt).content).trim() : '';
    const taskWords = promptText ? promptText.split(/\s+/u).length : 0;
    const threshold = Math.max(40, taskWords * 10);
    const changes = events.filter(isChange);
    const churn = changes.reduce(
      (total, event) => total + changedLineCount(event),
      0,
    );
    if (changes.length < 2 || churn <= threshold) return [];
    const evidence = [
      ...(prompt ? [prompt.id] : []),
      ...changes.slice(0, 12).map((event) => event.id),
    ];
    return [
      {
        key: `churn:${churn}:${threshold}`,
        category: 'efficiency',
        severity: 'medium',
        title: 'Code churn was large relative to the task signal',
        explanation: `The observed changes contain ${churn} added or deleted lines against a prompt of approximately ${taskWords} words (threshold ${threshold}).`,
        recommendation:
          'Break the work into smaller verified changes and confirm the task boundary before expanding the diff.',
        evidenceEventIds: evidence,
      },
    ];
  },
});

const testBeforeFinalChangeWithoutRerun = defineRule({
  id: 'test-before-final-change-without-rerun',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const finalChange = [...events].reverse().find(isChange);
    if (!finalChange) return [];
    const priorTest = [...events]
      .reverse()
      .find(
        (event) =>
          event.sequence < finalChange.sequence && isTestAttempt(event),
      );
    const laterTest = events.some(
      (event) => event.sequence > finalChange.sequence && isTestAttempt(event),
    );
    if (!priorTest || laterTest) return [];
    return [
      {
        key: finalChange.id,
        category: 'verification',
        severity: 'high',
        title: 'Tests ran before the final change but were not rerun',
        explanation:
          'The session records a test attempt before its last observed change and no subsequent test attempt.',
        recommendation:
          'Rerun the relevant test suite after the final change so the result covers the delivered state.',
        evidenceEventIds: [priorTest.id, finalChange.id],
      },
    ];
  },
});

const userCorrectionAfterUnsupportedSuccess = defineRule({
  id: 'user-correction-after-unsupported-success',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    for (const [index, event] of events.entries()) {
      if (!isSuccessClaim(event)) continue;
      const correction = events
        .slice(index + 1)
        .find(
          (candidate) =>
            candidate.sequence - event.sequence <= 3 &&
            correctionEvent(candidate),
        );
      if (!correction) continue;
      const verification = events.find(
        (candidate) =>
          candidate.sequence > event.sequence &&
          candidate.sequence < correction.sequence &&
          /^(?:test|lint|build|typecheck)\.completed$/.test(candidate.type) &&
          payload(candidate).success === true,
      );
      if (verification) continue;
      return [
        {
          key: `${event.id}:${correction.id}`,
          category: 'human-intervention',
          severity: 'high',
          title: 'A user correction followed an unsupported success claim',
          explanation:
            'A correction-like user message arrived immediately after a success claim without an intervening successful verification.',
          recommendation:
            'Treat the claim as provisional and require evidence that addresses the user correction before closing the task.',
          evidenceEventIds: [event.id, correction.id],
          counterevidenceEventIds: [],
        },
      ];
    }
    return [];
  },
});

const excessiveSearchLittleStateChange = defineRule({
  id: 'excessive-search-with-little-state-change',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const searches = events.filter(searchCommand);
    const changes = events.filter(isChange);
    if (searches.length < 5 || changes.length > 1) return [];
    return [
      {
        key: `searches:${searches.length}:changes:${changes.length}`,
        category: 'context-utilization',
        severity: 'medium',
        title: 'Search activity was excessive relative to state change',
        explanation: `The session records ${searches.length} search commands but only ${changes.length} observed code changes.`,
        recommendation:
          'Turn search results into a concrete inspection or implementation step, then verify the chosen path.',
        evidenceEventIds: [
          ...searches.slice(0, 8).map((event) => event.id),
          ...changes.map((event) => event.id),
        ],
      },
    ];
  },
});

const relevantFileDiscoveredAfterImplementation = defineRule({
  id: 'relevant-file-discovered-after-implementation',
  version: DIAGNOSTICS_VERSION,
  evaluate: ({ events }) => {
    const firstChange = events.find(isChange);
    if (!firstChange) return [];
    const changedPaths = new Set(
      events
        .filter(
          (event) => isChange(event) && event.sequence >= firstChange.sequence,
        )
        .map(pathOf)
        .filter((value): value is string => value !== undefined),
    );
    for (const read of events.filter(
      (event) =>
        event.type === 'file.read' && event.sequence > firstChange.sequence,
    )) {
      const path = pathOf(read);
      if (!path || !changedPaths.has(path)) continue;
      const earlierRead = events.some(
        (event) =>
          event.type === 'file.read' &&
          pathOf(event) === path &&
          event.sequence < firstChange.sequence,
      );
      if (earlierRead) continue;
      const change = events.find(
        (event) => isChange(event) && pathOf(event) === path,
      );
      if (!change) continue;
      return [
        {
          key: path,
          category: 'context-utilization',
          severity: 'medium',
          title: 'A relevant file was discovered after implementation began',
          explanation:
            'The timeline shows the file being changed before its first observed inspection.',
          recommendation:
            'Inspect relevant files and their callers before implementing changes that depend on them.',
          evidenceEventIds: [change.id, read.id],
        },
      ];
    }
    return [];
  },
});

export const DIAGNOSTIC_RULES: readonly DiagnosticRule[] = Object.freeze([
  noTestsAfterFinalChange,
  successClaimAfterFailure,
  repeatedFailedCommand,
  modifiedWithoutInspection,
  unresolvedErrorAtEnd,
  preExistingVersusIntroduced,
  compactionThenCorrection,
  instructionContradiction,
  repeatedToolErrorLoop,
  declinedApprovalRepeated,
  largeCodeChurn,
  testBeforeFinalChangeWithoutRerun,
  userCorrectionAfterUnsupportedSuccess,
  excessiveSearchLittleStateChange,
  relevantFileDiscoveredAfterImplementation,
]);

function validateDraft(
  rule: DiagnosticRule,
  draft: RuleFindingDraft,
  eventIds: ReadonlySet<string>,
): void {
  for (const [field, value] of Object.entries({
    key: draft.key,
    category: draft.category,
    severity: draft.severity,
    title: draft.title,
    explanation: draft.explanation,
    recommendation: draft.recommendation,
  }))
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`Rule ${rule.id} emitted an empty ${field}.`);
  if (draft.evidenceEventIds.length === 0)
    throw new Error(`Rule ${rule.id} emitted a finding without evidence.`);
  const evidence = new Set(draft.evidenceEventIds);
  if (evidence.size !== draft.evidenceEventIds.length)
    throw new Error(`Rule ${rule.id} emitted duplicate evidence IDs.`);
  for (const id of [
    ...draft.evidenceEventIds,
    ...(draft.counterevidenceEventIds ?? []),
  ])
    if (!eventIds.has(id))
      throw new Error(`Rule ${rule.id} referenced an unknown event ID: ${id}.`);
  for (const id of draft.counterevidenceEventIds ?? [])
    if (evidence.has(id))
      throw new Error(`Rule ${rule.id} reused evidence as counter-evidence.`);
  if (
    new Set(draft.counterevidenceEventIds ?? []).size !==
    (draft.counterevidenceEventIds ?? []).length
  )
    throw new Error(`Rule ${rule.id} emitted duplicate counter-evidence IDs.`);
}

/** Run rules in a stable order and reject every invalid evidence reference. */
export function analyzeSession(
  input: readonly TraceEvent[],
  rules: readonly DiagnosticRule[] = DIAGNOSTIC_RULES,
): AnalysisResult {
  if (input.length === 0) throw new Error('Cannot analyze an empty session.');
  const events = input
    .map((event) => TraceEventSchema.parse(event))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const sessionId = events[0]!.sessionId;
  if (events.some((event) => event.sessionId !== sessionId))
    throw new Error('Diagnostic input contains more than one session.');
  const eventIds = new Set(events.map((event) => event.id));
  if (eventIds.size !== events.length)
    throw new Error('Diagnostic input contains duplicate event IDs.');
  const eventOrder = new Map(
    events.map((event, index) => [event.id, index] as const),
  );
  const orderIds = (ids: readonly string[]): readonly string[] =>
    [...ids].sort(
      (left, right) => eventOrder.get(left)! - eventOrder.get(right)!,
    );
  const ruleIds = new Set<DiagnosticRuleId>();
  const findingIds = new Set<string>();
  const findings: DiagnosticFinding[] = [];
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate rule ID: ${rule.id}.`);
    ruleIds.add(rule.id);
    const drafts = rule.evaluate({ sessionId, events });
    for (const draft of drafts) {
      validateDraft(rule, draft, eventIds);
      const id = createUuidV5([
        'vibetrace/finding/0.1',
        sessionId,
        rule.id,
        rule.version,
        draft.key,
        ...orderIds(unique(draft.evidenceEventIds)),
        'counter-evidence',
        ...orderIds(unique(draft.counterevidenceEventIds ?? [])),
      ]);
      if (findingIds.has(id))
        throw new Error(`Rule ${rule.id} emitted a duplicate finding key.`);
      findingIds.add(id);
      findings.push({
        id,
        sessionId,
        ruleId: rule.id,
        detectorVersion: rule.version,
        category: draft.category,
        severity: draft.severity,
        title: draft.title,
        explanation: draft.explanation,
        recommendation: draft.recommendation,
        evidenceEventIds: orderIds(unique(draft.evidenceEventIds)),
        counterevidenceEventIds: orderIds(
          unique(draft.counterevidenceEventIds ?? []),
        ),
        state: 'open',
      });
    }
  }
  findings.sort(
    (left, right) =>
      DIAGNOSTIC_RULE_IDS.indexOf(left.ruleId as DiagnosticRuleId) -
        DIAGNOSTIC_RULE_IDS.indexOf(right.ruleId as DiagnosticRuleId) ||
      left.id.localeCompare(right.id),
  );
  return Object.freeze({
    analyzerVersion: DIAGNOSTICS_VERSION,
    sessionId,
    evaluatedRuleIds: Object.freeze([...ruleIds]),
    findings: Object.freeze(findings),
  });
}

function storedEvents(storage: Storage, sessionId: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let cursor: Pick<StoredNormalizedEvent, 'id' | 'sequence'> | undefined;
  do {
    const page = storage.listEvents({
      sessionId,
      limit: 10_000,
      ...(cursor ? { afterSequence: cursor.sequence, afterId: cursor.id } : {}),
    });
    events.push(...page.map((item) => item.event));
    cursor = page.length === 10_000 ? page.at(-1) : undefined;
  } while (cursor);
  return events;
}

/** Analyze one stored session and atomically replace analyzer-owned findings. */
export function analyzeAndPersist(
  storage: Storage,
  sessionId: string,
  rules: readonly DiagnosticRule[] = DIAGNOSTIC_RULES,
): AnalysisResult {
  const result = analyzeSession(storedEvents(storage, sessionId), rules);
  storage.replaceFindings(sessionId, result.evaluatedRuleIds, result.findings);
  return result;
}
