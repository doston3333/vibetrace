import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import {
  hardenSpool,
  readDescriptor,
  restrictDirectoryToCurrentUser,
  resolveStateDir,
  spoolPaths,
  SpoolSegmentSchema,
  writeSegment,
  type SpoolSegment,
} from '@vibetrace/daemon';
import {
  GitObjectIdSchema,
  SCHEMA_VERSION,
  TraceEventSchema,
  createEventId,
  createSessionId,
  createTurnId,
  type EventType,
  type JsonObject,
  type JsonValue,
  type TraceEvent,
} from '@vibetrace/schema';
import { z } from 'zod';
import {
  captureRepositoryState,
  classifyCommand,
  createRunFingerprint,
  hashFingerprintFiles,
  parseVerification,
  type CaptureRepositoryOptions,
  type FingerprintFileHashes,
  type RepositorySnapshot,
} from '@vibetrace/enrichment';
import { type RunFingerprint } from '@vibetrace/schema';

const execFile = promisify(execFileCallback);
const ADAPTER_ID = 'codex-hooks';
const MAX_HOOK_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 20_000;
const MAX_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
const MANIFEST_VERSION = 1;

/** Version of the VibeTrace Codex hook normalizer. */
export const CODEX_ADAPTER_VERSION = '0.1.0';

/** Oldest Codex CLI release accepted by this adapter. */
export const CODEX_MIN_VERSION = '0.144.3';

/** Lifecycle events covered by the current public Codex hook contract. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);
const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]);
const nonempty = z.string().min(1).max(8192);
const commonShape = {
  session_id: z.string().min(1).max(512),
  transcript_path: z.string().max(32_768).nullable(),
  cwd: nonempty,
  hook_event_name: z.enum(CODEX_HOOK_EVENTS),
  model: z.string().min(1).max(512),
};
const turnShape = {
  turn_id: z.string().min(1).max(512),
};
const permissionShape = {
  permission_mode: permissionModeSchema,
};
const hookSchema = z.discriminatedUnion('hook_event_name', [
  z
    .object({
      ...commonShape,
      ...permissionShape,
      hook_event_name: z.literal('SessionStart'),
      source: z.enum(['startup', 'resume', 'clear', 'compact']),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      hook_event_name: z.literal('SessionEnd'),
      reason: z.string().min(1).max(256),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('UserPromptSubmit'),
      prompt: z.string().max(MAX_HOOK_BYTES),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('PreToolUse'),
      tool_name: z.string().min(1).max(1024),
      tool_use_id: z.string().min(1).max(1024),
      tool_input: jsonValueSchema,
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('PermissionRequest'),
      tool_name: z.string().min(1).max(1024),
      tool_input: jsonValueSchema,
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('PostToolUse'),
      tool_name: z.string().min(1).max(1024),
      tool_use_id: z.string().min(1).max(1024),
      tool_input: jsonValueSchema,
      tool_response: jsonValueSchema,
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      hook_event_name: z.literal('PreCompact'),
      trigger: z.enum(['manual', 'auto']),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      hook_event_name: z.literal('PostCompact'),
      trigger: z.enum(['manual', 'auto']),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('SubagentStart'),
      agent_id: z.string().min(1).max(1024),
      agent_type: z.string().min(1).max(1024),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('SubagentStop'),
      agent_id: z.string().min(1).max(1024),
      agent_type: z.string().min(1).max(1024),
      agent_transcript_path: z.string().max(32_768).nullable(),
      stop_hook_active: z.boolean(),
      last_assistant_message: z.string().max(MAX_HOOK_BYTES).nullable(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      ...commonShape,
      ...turnShape,
      ...permissionShape,
      hook_event_name: z.literal('Stop'),
      stop_hook_active: z.boolean(),
      last_assistant_message: z.string().max(MAX_HOOK_BYTES).nullable(),
    })
    .catchall(jsonValueSchema),
]);

/** Validated, JSON-safe input supplied to a Codex command hook. */
export type CodexHookInput = z.infer<typeof hookSchema>;

/** Parse one untrusted Codex hook envelope and retain unknown JSON fields. */
export function parseCodexHook(input: unknown): CodexHookInput {
  return hookSchema.parse(input);
}

/** Observable command details extracted from a hook; this never executes the command. */
export interface ObservedCommandFact {
  readonly command: string;
  readonly category: ReturnType<typeof classifyCommand>;
  readonly output?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

/** Extract bounded command facts from validated PreToolUse/PostToolUse envelopes. */
export function extractObservedCommand(
  hook: CodexHookInput,
): ObservedCommandFact | undefined {
  if (
    hook.hook_event_name !== 'PreToolUse' &&
    hook.hook_event_name !== 'PostToolUse'
  )
    return undefined;
  const input = hook.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return undefined;
  const object = input as JsonObject;
  const candidate = object.cmd ?? object.command;
  const command =
    typeof candidate === 'string'
      ? candidate
      : Array.isArray(candidate) &&
          candidate.every((part) => typeof part === 'string')
        ? candidate.join(' ')
        : undefined;
  if (!command) return undefined;
  if (hook.hook_event_name === 'PreToolUse')
    return { command, category: classifyCommand(command) };
  const response = hook.tool_response;
  const data =
    response && typeof response === 'object' && !Array.isArray(response)
      ? (response as JsonObject)
      : {};
  const output =
    typeof response === 'string'
      ? response
      : ['output', 'stdout', 'stderr']
          .flatMap((key) => (typeof data[key] === 'string' ? [data[key]] : []))
          .join('\n');
  const exit = data.exit_code ?? data.exitCode ?? data.status;
  const duration = data.duration_ms ?? data.durationMs;
  return {
    command,
    category: classifyCommand(command),
    ...(output ? { output: output.slice(0, MAX_HOOK_BYTES) } : {}),
    ...(typeof exit === 'number' &&
    Number.isFinite(exit) &&
    Number.isInteger(exit)
      ? { exitCode: exit }
      : {}),
    ...(typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration >= 0
      ? { durationMs: duration }
      : {}),
  };
}

/** Derive command child segments while retaining the original hook segment unchanged. */
export function deriveCodexCommandSegments(
  hook: CodexHookInput,
  parent: SpoolSegment,
): readonly SpoolSegment[] {
  const fact = extractObservedCommand(hook);
  if (!fact) return [];
  const make = (
    type: EventType,
    payload: JsonObject,
    index: number,
    status?: TraceEvent['status'],
    artifacts?: SpoolSegment['artifacts'],
  ): SpoolSegment => {
    const sourceEventId = `${parent.raw.sourceEventId}:command:${index}`;
    const sequence = parent.event.sequence + index;
    const event = TraceEventSchema.parse({
      ...parent.event,
      sourceEventId,
      id: createEventId({
        adapter: ADAPTER_ID,
        sourceVersion: parent.raw.sourceVersion,
        sourceSessionId: parent.raw.sourceSessionId,
        sourceEventId,
        sourceSequence: sequence,
        type,
      }),
      parentEventId: parent.event.id,
      sequence,
      type,
      source: 'tool',
      ...(status ? { status } : {}),
      payload,
      rawPayload: parent.event.rawPayload,
    });
    return SpoolSegmentSchema.parse({
      ...parent,
      raw: { ...parent.raw, sourceEventId },
      event,
      ...(artifacts ? { artifacts } : {}),
    });
  };
  if (hook.hook_event_name === 'PreToolUse')
    return [
      make(
        'command.started',
        { command: fact.command, category: fact.category },
        1,
        'running',
      ),
    ];
  if (fact.exitCode === undefined)
    return [
      make(
        'capture.gap',
        {
          dataClass: 'commands',
          state: 'unknown',
          reason: 'Command exit status was not exposed.',
          affectedEventTypes: ['command.completed'],
        },
        1,
      ),
    ];
  const completed = make(
    'command.completed',
    {
      command: fact.command,
      category: fact.category,
      exitCode: fact.exitCode,
      ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
    },
    1,
    fact.exitCode === 0 ? 'completed' : 'failed',
  );
  const verification = parseVerification(
    fact.command,
    fact.exitCode,
    fact.output ?? '',
    fact.durationMs,
  );
  if (!verification) return [completed];
  const verificationSourceId = `${parent.raw.sourceEventId}:command:2`;
  const verificationEventId = createEventId({
    adapter: ADAPTER_ID,
    sourceVersion: parent.raw.sourceVersion,
    sourceSessionId: parent.raw.sourceSessionId,
    sourceEventId: verificationSourceId,
    sourceSequence: parent.event.sequence + 2,
    type: `${verification.kind}.completed` as EventType,
  });
  const artifactId = fact.output
    ? createEventId({
        adapter: ADAPTER_ID,
        sourceVersion: parent.raw.sourceVersion,
        sourceSessionId: parent.raw.sourceSessionId,
        sourceEventId: `${verificationSourceId}:output`,
        sourceSequence: parent.event.sequence + 2,
        type: 'command.completed',
      })
    : undefined;
  return [
    completed,
    make(
      `${verification.kind}.completed` as EventType,
      {
        command: fact.command,
        category: verification.kind,
        kind: verification.kind,
        success: verification.success,
        exitCode: fact.exitCode,
        summary: verification.summary,
        ...(artifactId ? { rawOutputArtifactId: artifactId } : {}),
        ...(verification.framework
          ? { framework: verification.framework }
          : {}),
        ...(verification.durationMs === undefined
          ? {}
          : { durationMs: verification.durationMs }),
      },
      2,
      verification.success ? 'completed' : 'failed',
      artifactId && fact.output
        ? [
            {
              id: artifactId,
              kind: 'verification-output',
              eventId: verificationEventId,
              content: fact.output,
              contentHash: hashText(fact.output),
              mediaType: 'text/plain',
              metadata: { summary: verification.summary },
            },
          ]
        : undefined,
    ),
  ];
}

/** Record the hook contract's missing post-prompt approval decision explicitly. */
export function deriveCodexApprovalCoverageSegment(
  hook: CodexHookInput,
  parent: SpoolSegment,
): SpoolSegment | undefined {
  if (hook.hook_event_name !== 'PermissionRequest') return undefined;
  const sourceEventId = `${parent.raw.sourceEventId}:permission-resolution-gap`;
  const sequence = parent.event.sequence + 1;
  const parentEvent = { ...parent.event };
  delete parentEvent.status;
  const event = TraceEventSchema.parse({
    ...parentEvent,
    id: createEventId({
      adapter: ADAPTER_ID,
      sourceVersion: parent.raw.sourceVersion,
      sourceSessionId: parent.raw.sourceSessionId,
      sourceEventId,
      sourceSequence: sequence,
      type: 'capture.gap',
    }),
    parentEventId: parent.event.id,
    sequence,
    source: 'vibetrace',
    type: 'capture.gap',
    subtype: 'codex-hook.permission-resolution',
    payload: {
      dataClass: 'approvals',
      state: 'partial',
      reason:
        'PermissionRequest runs before the user decision; the Codex hook payload does not expose the eventual resolution.',
      expectedSource: 'codex-approval-resolution',
      observedSources: ['codex-hook:PermissionRequest'],
      affectedEventTypes: ['permission.resolved'],
    },
    provenance: { ...parent.event.provenance, captureMode: 'partial' },
  });
  return SpoolSegmentSchema.parse({
    ...parent,
    session: { ...parent.session, captureMode: 'partial' },
    raw: { ...parent.raw, sourceEventId },
    event,
    normalizerId: `codex-hook-coverage-${CODEX_ADAPTER_VERSION}`,
  });
}

/** Repository children reserve offsets 100+ so command children at 1–2 never collide. */
export function deriveCodexRepositorySegments(
  parent: SpoolSegment,
  snapshot: RepositorySnapshot,
  fingerprint?: RunFingerprint,
): readonly SpoolSegment[] {
  const make = (
    type: EventType,
    payload: JsonObject,
    offset: number,
    source: TraceEvent['source'],
    parentEventId: string,
    session: SpoolSegment['session'],
    artifacts?: SpoolSegment['artifacts'],
  ): SpoolSegment => {
    const sourceEventId = `${parent.raw.sourceEventId}:repository:${offset}`;
    const sequence = parent.event.sequence + offset;
    const event = TraceEventSchema.parse({
      ...parent.event,
      id: createEventId({
        adapter: ADAPTER_ID,
        sourceVersion: parent.raw.sourceVersion,
        sourceSessionId: parent.raw.sourceSessionId,
        sourceEventId,
        sourceSequence: sequence,
        type,
      }),
      sourceEventId,
      parentEventId,
      sequence,
      source,
      type,
      payload,
    });
    return SpoolSegmentSchema.parse({
      ...parent,
      session,
      raw: { ...parent.raw, sourceEventId },
      event,
      ...(artifacts ? { artifacts } : {}),
    });
  };
  if (snapshot.kind === 'gap')
    return [
      make(
        'capture.gap',
        {
          dataClass: 'repositoryState',
          state: 'unknown',
          reason: snapshot.reason,
          affectedEventTypes: ['git.snapshot', 'file.changed'],
        },
        100,
        'vcs',
        parent.event.id,
        snapshot.phase === 'baseline' && fingerprint
          ? {
              ...parent.session,
              runFingerprint: fingerprint,
            }
          : parent.session,
      ),
    ];
  const sessionBase = Object.fromEntries(
    Object.entries(parent.session).filter(
      ([key]) => !['baseCommit', 'finalCommit', 'runFingerprint'].includes(key),
    ),
  ) as Omit<
    SpoolSegment['session'],
    'baseCommit' | 'finalCommit' | 'runFingerprint'
  >;
  const session = {
    ...sessionBase,
    ...(snapshot.phase === 'baseline'
      ? {
          baseCommit: snapshot.baseCommit,
          ...(fingerprint ? { runFingerprint: fingerprint } : {}),
        }
      : {}),
    ...(snapshot.phase === 'final' ? { finalCommit: snapshot.headCommit } : {}),
  };
  const snapshotSourceId = `${parent.raw.sourceEventId}:repository:100`;
  const snapshotEventId = createEventId({
    adapter: ADAPTER_ID,
    sourceVersion: parent.raw.sourceVersion,
    sourceSessionId: parent.raw.sourceSessionId,
    sourceEventId: snapshotSourceId,
    sourceSequence: parent.event.sequence + 100,
    type: 'git.snapshot',
  });
  const artifactId = snapshot.cumulativeDiff
    ? createEventId({
        adapter: ADAPTER_ID,
        sourceVersion: parent.raw.sourceVersion,
        sourceSessionId: parent.raw.sourceSessionId,
        sourceEventId: `${snapshotSourceId}:diff`,
        sourceSequence: parent.event.sequence + 100,
        type: 'git.snapshot',
      })
    : undefined;
  const git = make(
    'git.snapshot',
    {
      phase: snapshot.phase,
      rootHash: snapshot.rootHash,
      baseCommit: snapshot.baseCommit,
      headCommit: snapshot.headCommit,
      dirtyPatchHash: snapshot.dirtyPatchHash,
      changedFiles: snapshot.changedFiles.map((file) => ({
        status: file.status,
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      })),
      truncated: snapshot.truncated,
      ...(artifactId ? { diffArtifactId: artifactId } : {}),
    },
    100,
    'vcs',
    parent.event.id,
    session,
    artifactId
      ? [
          {
            id: artifactId,
            kind: 'git-diff',
            eventId: snapshotEventId,
            content: snapshot.cumulativeDiff,
            contentHash: hashText(snapshot.cumulativeDiff),
            mediaType: 'text/plain',
            metadata: { truncated: snapshot.truncated },
          },
        ]
      : undefined,
  );
  const files = [...snapshot.changedFiles]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file, index) =>
      make(
        'file.changed',
        {
          path: file.path,
          status: file.status,
          ...(file.previousPath ? { previousPath: file.previousPath } : {}),
          observation: 'cumulative',
          repositorySnapshotEventId: git.event.id,
        },
        101 + index,
        'vcs',
        git.event.id,
        session,
      ),
    );
  const boundedGap = snapshot.truncated
    ? make(
        'capture.gap',
        {
          dataClass: 'fileDiffs',
          state: 'partial',
          reason: 'repository-capture-bounded',
          affectedEventTypes: ['git.snapshot', 'file.changed'],
        },
        901,
        'vcs',
        git.event.id,
        session,
      )
    : undefined;
  return boundedGap ? [git, ...files, boundedGap] : [git, ...files];
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key] ?? null)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

function hashJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedSourceVersion(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 128 ? trimmed : 'unknown';
}

function observedToolStatus(
  response: JsonValue,
): 'completed' | 'failed' | 'declined' {
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response)
  )
    return 'completed';
  const value = response as JsonObject;
  const status = [value.status, value.outcome, value.decision].find(
    (candidate) => typeof candidate === 'string',
  );
  if (
    typeof status === 'string' &&
    /^(?:declined|denied|rejected|cancelled|canceled)$/i.test(status)
  )
    return 'declined';
  if (
    typeof status === 'string' &&
    /^(?:failed|failure|error|errored|timeout|timed_out)$/i.test(status)
  )
    return 'failed';
  const exitCode = value.exit_code ?? value.exitCode;
  if (
    (typeof exitCode === 'number' && exitCode !== 0) ||
    value.isError === true ||
    value.is_error === true ||
    value.success === false ||
    value.ok === false
  )
    return 'failed';
  return 'completed';
}

function mapping(input: CodexHookInput): {
  readonly type: EventType;
  readonly source: TraceEvent['source'];
  readonly payload: JsonObject;
  readonly status?: TraceEvent['status'];
} {
  const raw = input as JsonObject;
  switch (input.hook_event_name) {
    case 'SessionStart':
      return {
        type: 'session.started',
        source: 'harness',
        payload: raw,
        status: 'running',
      };
    case 'SessionEnd':
      return {
        type: 'session.completed',
        source: 'harness',
        payload: raw,
        status: 'completed',
      };
    case 'UserPromptSubmit':
      return {
        type: 'message.user',
        source: 'user',
        payload: { ...raw, content: input.prompt },
      };
    case 'PreToolUse':
      return {
        type: 'tool.started',
        source: 'tool',
        payload: { ...raw, toolName: input.tool_name },
        status: 'running',
      };
    case 'PermissionRequest':
      return {
        type: 'permission.requested',
        source: 'harness',
        payload: {
          ...raw,
          requestId: hashJson(raw).slice(0, 32),
        },
        status: 'pending',
      };
    case 'PostToolUse':
      return {
        type: 'tool.completed',
        source: 'tool',
        payload: { ...raw, toolName: input.tool_name },
        status: observedToolStatus(input.tool_response),
      };
    case 'PreCompact':
      return {
        type: 'context.compaction.started',
        source: 'harness',
        payload: { ...raw, reason: input.trigger },
        status: 'running',
      };
    case 'PostCompact':
      return {
        type: 'context.compaction.completed',
        source: 'harness',
        payload: { ...raw, reason: input.trigger },
        status: 'completed',
      };
    case 'SubagentStart':
      return {
        type: 'subagent.started',
        source: 'harness',
        payload: { ...raw, subagentId: input.agent_id },
        status: 'running',
      };
    case 'SubagentStop':
      return {
        type: 'subagent.completed',
        source: 'harness',
        payload: { ...raw, subagentId: input.agent_id },
        status: 'completed',
      };
    case 'Stop':
      return input.last_assistant_message === null
        ? {
            type: 'turn.completed',
            source: 'harness',
            payload: raw,
            status: 'completed',
          }
        : {
            type: 'message.agent',
            source: 'agent',
            payload: { ...raw, content: input.last_assistant_message },
          };
  }
}

function sourceIdentity(input: CodexHookInput, receivedAt: string): string {
  const raw = input as JsonObject;
  const stable =
    input.hook_event_name === 'PreToolUse' ||
    input.hook_event_name === 'PostToolUse'
      ? input.tool_use_id
      : input.hook_event_name === 'SubagentStart' ||
          input.hook_event_name === 'SubagentStop'
        ? input.agent_id
        : 'turn_id' in input
          ? input.turn_id
          : receivedAt;
  return `${input.hook_event_name}:${stable}:${receivedAt}:${hashJson(raw).slice(0, 20)}`;
}

function sequenceFor(timestamp: string, identity: string): number {
  return (
    Date.parse(timestamp) * 2048 +
    (Number.parseInt(hashText(identity).slice(0, 6), 16) % 1024)
  );
}

interface SegmentContext {
  readonly sourceSessionId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly sourceVersion: string;
  readonly timestamp: string;
  readonly invocationId?: string;
}

function baseSegment(
  context: SegmentContext,
  rawPayload: JsonObject,
  sourceEventId: string,
  type: EventType,
  source: TraceEvent['source'],
  payload: JsonObject,
  options: {
    readonly turnId?: string;
    readonly toolName?: string;
    readonly status?: TraceEvent['status'];
    readonly captureMode?: 'partial' | 'standard';
    readonly subtype?: string;
    readonly normalizerId?: string;
  } = {},
): SpoolSegment {
  const captureMode = options.captureMode ?? 'standard';
  const sessionId = createSessionId(ADAPTER_ID, context.sourceSessionId);
  const sequence = sequenceFor(context.timestamp, sourceEventId);
  const event = TraceEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createEventId({
      adapter: ADAPTER_ID,
      sourceVersion: context.sourceVersion,
      sourceSessionId: context.sourceSessionId,
      sourceEventId,
      sourceSequence: sequence,
      type,
    }),
    sessionId,
    ...(options.turnId
      ? {
          turnId: createTurnId(
            ADAPTER_ID,
            context.sourceSessionId,
            options.turnId,
          ),
        }
      : {}),
    sequence,
    timestamp: context.timestamp,
    source,
    type,
    ...(options.subtype ? { subtype: options.subtype } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(context.model ? { model: context.model } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    payload,
    rawPayload,
    sensitivity: 'unknown',
    provenance: {
      adapter: ADAPTER_ID,
      adapterVersion: CODEX_ADAPTER_VERSION,
      sourceVersion: context.sourceVersion,
      captureMode,
    },
  });
  return SpoolSegmentSchema.parse({
    version: 1,
    project: {
      projectId: `codex-${hashText(context.cwd).slice(0, 40)}`,
      displayName: basename(context.cwd) || 'Codex workspace',
      pathHash: hashText(context.cwd),
    },
    session: {
      source: ADAPTER_ID,
      sourceSessionId: context.sourceSessionId,
      startedAt: context.timestamp,
      status: type === 'session.completed' ? 'completed' : 'active',
      captureMode,
      ...(context.model ? { model: context.model } : {}),
      sourceVersion: context.sourceVersion,
    },
    raw: {
      adapter: ADAPTER_ID,
      adapterVersion: CODEX_ADAPTER_VERSION,
      sourceVersion: context.sourceVersion,
      sourceSessionId: context.sourceSessionId,
      ...(options.turnId ? { sourceTurnId: options.turnId } : {}),
      sourceEventId,
      receivedAt: context.timestamp,
      payload: rawPayload,
    },
    event,
    normalizerId:
      options.normalizerId ?? `codex-hooks-${CODEX_ADAPTER_VERSION}`,
  });
}

/** Normalize one source-exposed hook payload into a sealed spool segment. */
export function normalizeCodexHook(
  input: unknown,
  options: {
    readonly clock?: () => Date;
    readonly sourceVersion?: string;
  } = {},
): SpoolSegment {
  const hook = parseCodexHook(input);
  const timestamp = (options.clock ?? (() => new Date()))().toISOString();
  const sourceVersion = normalizedSourceVersion(options.sourceVersion);
  const mapped = mapping(hook);
  const rawPayload = hook as JsonObject;
  const turnId = typeof hook.turn_id === 'string' ? hook.turn_id : undefined;
  const toolName =
    typeof hook.tool_name === 'string' ? hook.tool_name : undefined;
  return baseSegment(
    {
      sourceSessionId: hook.session_id,
      cwd: hook.cwd,
      model: hook.model,
      sourceVersion,
      timestamp,
    },
    rawPayload,
    sourceIdentity(hook, timestamp),
    mapped.type,
    mapped.source,
    mapped.payload,
    {
      ...(turnId ? { turnId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(mapped.status ? { status: mapped.status } : {}),
      subtype: hook.hook_event_name,
    },
  );
}

const manifestHandlerSchema = z
  .object({
    event: z.enum(CODEX_HOOK_EVENTS),
    handlerHash: z.string().regex(/^[a-f0-9]{64}$/),
    groupHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    adapterVersion: z.literal(CODEX_ADAPTER_VERSION),
    installationId: z.string().uuid(),
    installedAt: z.iso.datetime(),
    hookPath: z.string().min(1),
    codexVersion: z.string().min(1).max(128),
    backupPath: z.string().min(1).optional(),
    handlers: z.array(manifestHandlerSchema).length(CODEX_HOOK_EVENTS.length),
  })
  .strict();

/** Exact ownership record written outside Codex configuration. */
export type CodexInstallManifest = z.infer<typeof manifestSchema>;

function manifestPath(stateDir: string): string {
  return join(stateDir, 'integrations', 'codex.json');
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertOptionalRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`Unsafe file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function safeDirectory(path: string, create: boolean): Promise<boolean> {
  let exists = true;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) {
    if (!create) return false;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`Unsafe directory: ${path}`);
  if (create) await chmod(path, 0o700);
  return true;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every supported platform.
  }
}

async function durableAtomicWrite(
  path: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Opaque, privacy-safe baseline metadata retained between Codex hooks. */
export interface CodexBaselinePointer {
  readonly version: 1;
  readonly baseCommit: string;
  readonly rootHash: string;
}

function baselinePointerPath(
  stateDir: string,
  sourceSessionId: string,
): string {
  const name = createHash('sha256').update(sourceSessionId).digest('hex');
  return join(stateDir, 'capture', 'codex', `${name}.json`);
}

function validBaseline(value: unknown): value is CodexBaselinePointer {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.version === 1 &&
    GitObjectIdSchema.safeParse(record.baseCommit).success &&
    /^[a-f0-9]{64}$/i.test(String(record.rootHash))
  );
}

/** Write an opaque session baseline; the raw session ID and cwd are never persisted. */
export async function writeCodexBaselinePointer(
  stateDir: string,
  sourceSessionId: string,
  pointer: CodexBaselinePointer,
): Promise<boolean> {
  try {
    if (!sourceSessionId || !validBaseline(pointer)) return false;
    const parent = dirname(baselinePointerPath(stateDir, sourceSessionId));
    await safeDirectory(join(stateDir, 'capture'), true);
    await safeDirectory(parent, true);
    const path = baselinePointerPath(stateDir, sourceSessionId);
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    await durableAtomicWrite(path, JSON.stringify(pointer));
    return true;
  } catch {
    return false;
  }
}

/** Read an opaque baseline pointer; unsafe, malformed, or absent data is unavailable. */
export async function readCodexBaselinePointer(
  stateDir: string,
  sourceSessionId: string,
): Promise<CodexBaselinePointer | undefined> {
  try {
    const path = baselinePointerPath(stateDir, sourceSessionId);
    if (!(await regularFile(path))) return undefined;
    const metadata = await lstat(path);
    if (metadata.size > 4096) return undefined;
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validBaseline(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Remove only the exact regular pointer file for this source session. */
export async function removeCodexBaselinePointer(
  stateDir: string,
  sourceSessionId: string,
): Promise<boolean> {
  try {
    const path = baselinePointerPath(stateDir, sourceSessionId);
    if (!(await regularFile(path))) return false;
    await rm(path);
    await syncDirectory(dirname(path));
    return true;
  } catch {
    return false;
  }
}

async function durableBackup(path: string, contents: string): Promise<string> {
  const backup = `${path}.vibetrace-backup-${new Date()
    .toISOString()
    .replaceAll(':', '-')}-${randomUUID()}`;
  if (await regularFile(backup)) throw new Error('Backup path collision.');
  await durableAtomicWrite(backup, contents);
  return backup;
}

/** Read a valid install manifest without following a manifest symlink. */
export async function readCodexInstallManifest(
  stateDir = resolveStateDir(),
): Promise<CodexInstallManifest | undefined> {
  const path = manifestPath(stateDir);
  if (!(await regularFile(path))) return undefined;
  return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** Resolve CODEX_HOME without mutating it. */
export function resolveCodexHome(value = process.env.CODEX_HOME): string {
  const path = value ?? join(homedir(), '.codex');
  if (!isAbsolute(path))
    throw new Error('CODEX_HOME must be an absolute path.');
  return path;
}

function parseVersion(
  value: string,
): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\s|$)/.exec(
    value,
  );
  if (!match) return undefined;
  const parts = match.slice(1, 4).map(Number);
  return parts.length === 3
    ? [parts[0] as number, parts[1] as number, parts[2] as number]
    : undefined;
}

function extractVersion(value: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(value)?.[1];
}

function atLeast(value: string, minimum: string): boolean {
  const actual = parseVersion(value);
  const expected = parseVersion(minimum);
  if (!actual || !expected) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (expected[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** Probe Codex with an argument-only subprocess invocation. */
export async function detectCodexVersion(
  command = process.platform === 'win32' ? 'codex.exe' : 'codex',
): Promise<string | undefined> {
  try {
    const result = await execFile(command, ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return extractVersion(output);
  } catch {
    return undefined;
  }
}

interface HookHandler extends JsonObject {
  readonly type: 'command';
  readonly command: string;
  readonly commandWindows: string;
  readonly timeout: number;
}

function installedHandler(installationId: string): HookHandler {
  return {
    type: 'command',
    command: `vibetrace hook collect --installation ${installationId}`,
    commandWindows: `vibetrace.cmd hook collect --installation ${installationId}`,
    timeout: 3,
  };
}

function readKnownGroups(
  hooks: JsonObject,
  event: CodexHookEvent,
): JsonObject[] {
  const value = hooks[event];
  if (value === undefined) return [];
  const parsed = z.array(jsonObjectSchema).safeParse(value);
  if (!parsed.success)
    throw new Error(`Codex hooks.json /hooks/${event} must be an array.`);
  for (const [index, group] of parsed.data.entries()) {
    if (!Array.isArray(group.hooks))
      throw new Error(
        `Codex hooks.json /hooks/${event}/${index}/hooks must be an array.`,
      );
    z.array(jsonObjectSchema).parse(group.hooks);
  }
  return parsed.data;
}

function parseHooksDocument(text: string | undefined): JsonObject {
  if (text === undefined) return {};
  const document = jsonObjectSchema.parse(JSON.parse(text));
  if (document.hooks !== undefined) jsonObjectSchema.parse(document.hooks);
  return document;
}

function buildManifest(
  installationId: string,
  hookPath: string,
  codexVersion: string,
  backupPath: string | undefined,
  handler: HookHandler,
): CodexInstallManifest {
  const group = { hooks: [handler] } satisfies JsonObject;
  return {
    version: MANIFEST_VERSION,
    adapterVersion: CODEX_ADAPTER_VERSION,
    installationId,
    installedAt: new Date().toISOString(),
    hookPath,
    codexVersion,
    ...(backupPath ? { backupPath } : {}),
    handlers: CODEX_HOOK_EVENTS.map((event) => ({
      event,
      handlerHash: hashJson(handler),
      groupHash: hashJson(group),
    })),
  };
}

export interface HookChangeResult {
  readonly changed: boolean;
  readonly preview: string;
  readonly warnings: readonly string[];
}

/** Add an isolated, manifest-owned collector to every documented Codex event. */
export async function installCodexHooks(
  options: {
    readonly codexHome?: string;
    readonly stateDir?: string;
    readonly dryRun?: boolean;
    readonly codexVersion?: string;
    readonly installationId?: string;
  } = {},
): Promise<HookChangeResult> {
  const home = resolveCodexHome(options.codexHome);
  const state = resolveStateDir(options.stateDir);
  const path = join(home, 'hooks.json');
  const homeExists = await safeDirectory(home, false);
  if (homeExists && (await regularFile(path)) === false) {
    try {
      const unsafe = await lstat(path);
      if (!unsafe.isFile() || unsafe.isSymbolicLink())
        throw new Error('Codex hooks.json is unsafe.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const originalText = (await assertOptionalRegularFile(path))
    ? await readFile(path, 'utf8')
    : undefined;
  const original = parseHooksDocument(originalText);
  const existingManifest = await readCodexInstallManifest(state);
  if (existingManifest && existingManifest.hookPath !== path)
    throw new Error(
      'VibeTrace is installed in a different CODEX_HOME; uninstall it first.',
    );
  const installationId =
    existingManifest?.installationId ?? options.installationId ?? randomUUID();
  const handler = installedHandler(installationId);
  const expectedHandlerHash = hashJson(handler);
  const originalHooks = (original.hooks ?? {}) as JsonObject;
  const nextHooks = structuredClone(originalHooks) as Record<string, JsonValue>;
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = readKnownGroups(nextHooks, event);
    const present = groups.some((group) =>
      (group.hooks as JsonObject[]).some(
        (candidate) => hashJson(candidate) === expectedHandlerHash,
      ),
    );
    if (!present) groups.push({ hooks: [handler] });
    nextHooks[event] = groups;
  }
  const next: JsonObject = { ...original, hooks: nextHooks };
  const changed = canonicalJson(original) !== canonicalJson(next);
  const codexVersion = normalizedSourceVersion(
    options.codexVersion ?? (await detectCodexVersion()),
  );
  const warnings = [
    ...(codexVersion === 'unknown'
      ? ['Codex version could not be detected; doctor will report it.']
      : []),
    ...(codexVersion !== 'unknown' && !atLeast(codexVersion, CODEX_MIN_VERSION)
      ? [
          `Codex ${codexVersion} is older than the supported ${CODEX_MIN_VERSION} minimum.`,
        ]
      : []),
    'Review and trust the VibeTrace handlers with /hooks before capture.',
  ];
  const preview = JSON.stringify(
    { path, before: original, after: next, warnings },
    null,
    2,
  );
  if (options.dryRun) return { changed, preview, warnings };

  await safeDirectory(home, true);
  await safeDirectory(state, true);
  await restrictDirectoryToCurrentUser(home);
  await restrictDirectoryToCurrentUser(state);
  await safeDirectory(join(state, 'integrations'), true);
  await hardenSpool(spoolPaths(state));
  await assertOptionalRegularFile(manifestPath(state));
  let backupPath: string | undefined;
  try {
    if (changed && originalText !== undefined)
      backupPath = await durableBackup(path, originalText);
    if (changed)
      await durableAtomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    const manifest = buildManifest(
      installationId,
      path,
      codexVersion,
      backupPath ?? existingManifest?.backupPath,
      handler,
    );
    await durableAtomicWrite(
      manifestPath(state),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } catch (error) {
    if (changed) {
      if (originalText === undefined) await rm(path, { force: true });
      else await durableAtomicWrite(path, originalText);
    }
    throw error;
  }
  return { changed, preview, warnings };
}

function handlerInstallation(value: JsonObject): string | undefined {
  const command = value.command;
  if (typeof command !== 'string') return undefined;
  return /vibetrace hook collect --installation ([0-9a-f-]{36})/.exec(
    command,
  )?.[1];
}

/** Remove only handlers whose exact semantic hashes are recorded in the manifest. */
export async function uninstallCodexHooks(
  options: {
    readonly codexHome?: string;
    readonly stateDir?: string;
    readonly dryRun?: boolean;
  } = {},
): Promise<HookChangeResult> {
  const home = resolveCodexHome(options.codexHome);
  const state = resolveStateDir(options.stateDir);
  const path = join(home, 'hooks.json');
  const manifest = await readCodexInstallManifest(state);
  if (!manifest)
    return {
      changed: false,
      preview: 'No VibeTrace Codex install manifest was found.',
      warnings: [
        'Nothing was removed because handler ownership could not be proven.',
      ],
    };
  if (manifest.hookPath !== path)
    throw new Error('Install manifest does not belong to this CODEX_HOME.');
  if (!(await regularFile(path)))
    return {
      changed: false,
      preview: 'Codex hooks.json is absent.',
      warnings: ['The install manifest was retained for manual recovery.'],
    };
  const originalText = await readFile(path, 'utf8');
  const original = parseHooksDocument(originalText);
  const originalHooks = (original.hooks ?? {}) as JsonObject;
  const nextHooks = structuredClone(originalHooks) as Record<string, JsonValue>;
  const warnings: string[] = [];
  let removed = 0;
  let modified = 0;
  for (const ownership of manifest.handlers) {
    const groups = readKnownGroups(nextHooks, ownership.event);
    const retainedGroups: JsonObject[] = [];
    for (const group of groups) {
      const handlers = group.hooks as JsonObject[];
      const retained: JsonObject[] = [];
      for (const candidate of handlers) {
        if (hashJson(candidate) === ownership.handlerHash) {
          removed += 1;
          continue;
        }
        if (handlerInstallation(candidate) === manifest.installationId)
          modified += 1;
        retained.push(candidate);
      }
      if (retained.length > 0)
        retainedGroups.push({ ...group, hooks: retained });
      else if (hashJson(group) !== ownership.groupHash)
        retainedGroups.push({ ...group, hooks: retained });
    }
    nextHooks[ownership.event] = retainedGroups;
  }
  if (modified > 0)
    warnings.push(
      `${modified} user-modified VibeTrace handler(s) were preserved for manual review.`,
    );
  const next: JsonObject = { ...original, hooks: nextHooks };
  const changed = canonicalJson(original) !== canonicalJson(next);
  const preview = JSON.stringify(
    { path, before: original, after: next, removed, modified, warnings },
    null,
    2,
  );
  if (options.dryRun) return { changed, preview, warnings };
  if (changed) {
    await durableBackup(path, originalText);
    try {
      await durableAtomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      await durableAtomicWrite(path, originalText);
      throw error;
    }
  }
  if (modified === 0) await rm(manifestPath(state), { force: true });
  return { changed, preview, warnings };
}

const rolloutRowSchema = z
  .object({
    timestamp: z.iso.datetime(),
    type: z.string().min(1),
    payload: jsonObjectSchema,
  })
  .catchall(jsonValueSchema);
const sessionMetaPayloadSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string().min(1),
    cli_version: z.string().min(1),
  })
  .catchall(jsonValueSchema);
const assistantPayloadSchema = z
  .object({
    type: z.literal('message'),
    role: z.literal('assistant'),
    content: z.array(
      z
        .object({ type: z.literal('output_text'), text: z.string() })
        .catchall(jsonValueSchema),
    ),
  })
  .catchall(jsonValueSchema);

function transcriptGap(
  context: SegmentContext,
  code: string,
  reason: string,
  state: 'absent' | 'partial' | 'unknown' = 'unknown',
): SpoolSegment {
  const raw = { transcript: { code, parser: 'codex-rollout-jsonl-v1' } };
  return baseSegment(
    context,
    raw,
    `transcript-gap:${code}:${context.invocationId ?? context.timestamp}`,
    'capture.gap',
    'vibetrace',
    {
      dataClass: 'messages',
      state,
      reason,
      expectedSource: 'codex-rollout-jsonl-v1',
      observedSources: ['codex-hook'],
      affectedEventTypes: ['message.agent'],
    },
    {
      captureMode: 'partial',
      subtype: `transcript.${code}`,
      normalizerId: `codex-transcript-rollout-v1-${CODEX_ADAPTER_VERSION}`,
    },
  );
}

export interface TranscriptEnrichmentContext {
  readonly sourceSessionId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly sourceVersion?: string;
  readonly clock?: () => Date;
  readonly invocationId?: string;
}

/**
 * Read only exposed assistant messages from the bounded rollout-v1 JSONL shape.
 * Unsupported or partial data is represented by a capture-gap segment.
 */
export async function enrichCodexTranscript(
  path: string | null | undefined,
  input: TranscriptEnrichmentContext,
): Promise<readonly SpoolSegment[]> {
  const timestamp = (input.clock ?? (() => new Date()))().toISOString();
  const initialContext: SegmentContext = {
    sourceSessionId: input.sourceSessionId,
    cwd: input.cwd,
    model: input.model,
    sourceVersion: normalizedSourceVersion(input.sourceVersion),
    timestamp,
    invocationId: input.invocationId,
  };
  if (!path)
    return [
      transcriptGap(
        initialContext,
        'missing',
        'Codex did not expose a transcript path.',
        'absent',
      ),
    ];
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      return [
        transcriptGap(
          initialContext,
          'unsafe',
          'The transcript path was not a regular non-symlink file.',
        ),
      ];
    if (metadata.size > MAX_TRANSCRIPT_BYTES)
      return [
        transcriptGap(
          initialContext,
          'oversize',
          'The transcript exceeded the bounded 8 MiB enrichment limit.',
          'partial',
        ),
      ];
    const text = await readFile(path, 'utf8');
    const lines = text.split('\n');
    if (lines.length > MAX_TRANSCRIPT_LINES)
      return [
        transcriptGap(
          initialContext,
          'too-many-lines',
          'The transcript exceeded the bounded 20,000-line enrichment limit.',
          'partial',
        ),
      ];
    const rows: Array<{
      readonly line: number;
      readonly row: z.infer<typeof rolloutRowSchema>;
    }> = [];
    let malformed = false;
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_TRANSCRIPT_LINE_BYTES) {
        malformed = true;
        continue;
      }
      try {
        rows.push({
          line: index + 1,
          row: rolloutRowSchema.parse(JSON.parse(line)),
        });
      } catch {
        malformed = true;
      }
    }
    const first = rows[0]?.row;
    if (!first || first.type !== 'session_meta')
      return [
        transcriptGap(
          initialContext,
          'unsupported',
          'Transcript did not begin with Codex rollout-v1 session metadata.',
        ),
      ];
    const metadataPayload = sessionMetaPayloadSchema.safeParse(first.payload);
    if (
      !metadataPayload.success ||
      metadataPayload.data.id !== input.sourceSessionId
    )
      return [
        transcriptGap(
          initialContext,
          'metadata-mismatch',
          'Transcript metadata was missing, unsupported, or belonged to another session.',
        ),
      ];
    const sourceVersion = normalizedSourceVersion(
      metadataPayload.data.cli_version,
    );
    if (!atLeast(sourceVersion, CODEX_MIN_VERSION))
      return [
        transcriptGap(
          { ...initialContext, sourceVersion },
          'unsupported-version',
          `Transcript source version is older than ${CODEX_MIN_VERSION}.`,
        ),
      ];
    const context = { ...initialContext, sourceVersion };
    const events: SpoolSegment[] = [];
    for (const entry of rows) {
      if (entry.row.type !== 'response_item') continue;
      const assistant = assistantPayloadSchema.safeParse(entry.row.payload);
      if (!assistant.success) continue;
      const content = assistant.data.content.map((item) => item.text).join('');
      const raw = entry.row as JsonObject;
      const sourceEventId = `transcript:${entry.line}:${hashJson(raw).slice(0, 20)}`;
      events.push(
        baseSegment(
          { ...context, timestamp: entry.row.timestamp },
          raw,
          sourceEventId,
          'message.agent',
          'agent',
          { content },
          {
            captureMode: 'partial',
            subtype: 'transcript.rollout-v1',
            normalizerId: `codex-transcript-rollout-v1-${CODEX_ADAPTER_VERSION}`,
          },
        ),
      );
    }
    if (malformed)
      events.push(
        transcriptGap(
          context,
          'malformed-line',
          'One or more transcript lines were malformed or oversized.',
          'partial',
        ),
      );
    if (events.length === 0)
      events.push(
        transcriptGap(
          context,
          'no-assistant-messages',
          'No exposed assistant messages were present in the supported transcript.',
          'absent',
        ),
      );
    return events;
  } catch {
    return [
      transcriptGap(
        initialContext,
        'unreadable',
        'The transcript could not be read safely.',
      ),
    ];
  }
}

export interface CollectCodexHookOptions {
  readonly stateDir?: string;
  readonly clock?: () => Date;
  readonly sourceVersion?: string;
  readonly enrichTranscript?: boolean;
  /** Enable bounded repository/fingerprint enrichment when available. */
  readonly enrichRepository?: boolean;
  /** Test seam for bounded, argument-only repository inspection. */
  readonly captureRepository?: typeof captureRepositoryState;
  /** Test seam for bounded project fingerprint hashing. */
  readonly hashFingerprint?: typeof hashFingerprintFiles;
}

const EMPTY_FINGERPRINT_FILES: FingerprintFileHashes = {
  instructions: [],
  lockfiles: [],
  omissions: ['fingerprint-unavailable'],
};

const APPROVAL_POLICIES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
  'untrusted',
  'on-failure',
  'on-request',
  'never',
]);
const SANDBOX_POLICIES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const NETWORK_POLICIES = new Set(['restricted', 'enabled', 'disabled']);

function safePolicy(
  value: JsonValue | undefined,
  allowed: ReadonlySet<string>,
): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

async function writeRepositoryEnrichment(
  parsed: CodexHookInput,
  parent: SpoolSegment,
  stateDir: string,
  paths: ReturnType<typeof spoolPaths>,
  sourceVersion: string,
  options: CollectCodexHookOptions,
): Promise<void> {
  const phase =
    parsed.hook_event_name === 'SessionStart'
      ? 'baseline'
      : parsed.hook_event_name === 'SessionEnd'
        ? 'final'
        : parsed.hook_event_name === 'PostToolUse' ||
            parsed.hook_event_name === 'Stop'
          ? 'event'
          : undefined;
  if (phase === undefined || options.enrichRepository === false) return;

  const pointer =
    phase === 'baseline'
      ? undefined
      : await readCodexBaselinePointer(stateDir, parsed.session_id);
  const capture = options.captureRepository ?? captureRepositoryState;
  let snapshot: RepositorySnapshot;
  try {
    snapshot = await capture(parsed.cwd, {
      phase,
      ...(pointer ? { baseCommit: pointer.baseCommit } : {}),
    } satisfies CaptureRepositoryOptions);
  } catch {
    snapshot = {
      kind: 'gap',
      phase,
      reason: 'git-unavailable-or-timeout',
      message: 'Repository enrichment failed safely.',
    };
  }

  if (
    pointer &&
    snapshot.kind === 'snapshot' &&
    pointer.rootHash !== snapshot.rootHash
  )
    snapshot = {
      kind: 'gap',
      phase,
      reason: 'invalid-output',
      message: 'Repository baseline does not match the current worktree.',
    };

  if (snapshot.kind === 'snapshot' && snapshot.changedFiles.length > 800) {
    snapshot = {
      ...snapshot,
      changedFiles: snapshot.changedFiles.slice(0, 800),
      truncated: true,
    };
  }

  let fingerprint: RunFingerprint | undefined;
  if (phase === 'baseline') {
    let fileHashes = EMPTY_FINGERPRINT_FILES;
    try {
      fileHashes = await (options.hashFingerprint ?? hashFingerprintFiles)(
        parsed.cwd,
      );
    } catch {
      // A fingerprint omission is safer than failing the source hook.
    }
    const raw = parsed as JsonObject;
    const approvalValues = [raw.approval_policy, raw.permission_mode];
    const approvalPolicy = approvalValues
      .map((value) => safePolicy(value, APPROVAL_POLICIES))
      .find((value) => value !== undefined);
    const sandboxPolicy = safePolicy(raw.sandbox_policy, SANDBOX_POLICIES);
    const networkPolicy = safePolicy(raw.network_policy, NETWORK_POLICIES);
    const unrecognizedPolicy = [
      ...approvalValues.map((value) => [value, APPROVAL_POLICIES] as const),
      [raw.sandbox_policy, SANDBOX_POLICIES] as const,
      [raw.network_policy, NETWORK_POLICIES] as const,
    ].some(
      ([value, allowed]) =>
        value !== undefined && safePolicy(value, allowed) === undefined,
    );
    const policyNames = [approvalPolicy, sandboxPolicy, networkPolicy]
      .filter((value): value is string => value !== undefined)
      .sort();
    const safeFileHashes = unrecognizedPolicy
      ? {
          ...fileHashes,
          omissions: [...fileHashes.omissions, 'unrecognized-policy'],
        }
      : fileHashes;
    fingerprint = createRunFingerprint({
      clientSurface: 'cli',
      fileHashes: safeFileHashes,
      model: parsed.model,
      codexVersion: sourceVersion,
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(networkPolicy ? { networkPolicy } : {}),
      policyNames,
      ...(snapshot.kind === 'snapshot' ? { git: snapshot } : {}),
    });
  }

  const derived = deriveCodexRepositorySegments(parent, snapshot, fingerprint);
  for (const segment of derived) await writeSegment(paths, segment);

  if (phase === 'baseline' && snapshot.kind === 'snapshot')
    await writeCodexBaselinePointer(stateDir, parsed.session_id, {
      version: 1,
      baseCommit: snapshot.baseCommit,
      rootHash: snapshot.rootHash,
    });
  if (phase === 'final')
    await removeCodexBaselinePointer(stateDir, parsed.session_id);
}

/**
 * Collect one bounded hook without stdout or daemon/network dependencies.
 * Every failure is contained so Codex behavior is never blocked by capture.
 */
export async function collectCodexHook(
  text: string,
  options: CollectCodexHookOptions = {},
): Promise<boolean> {
  if (Buffer.byteLength(text, 'utf8') > MAX_HOOK_BYTES) return false;
  let parsed: CodexHookInput;
  let segment: SpoolSegment;
  let state: string;
  let sourceVersion: string;
  let paths: ReturnType<typeof spoolPaths>;
  try {
    state = resolveStateDir(options.stateDir);
    const manifest = await readCodexInstallManifest(state).catch(
      () => undefined,
    );
    sourceVersion = normalizedSourceVersion(
      options.sourceVersion ?? manifest?.codexVersion,
    );
    parsed = parseCodexHook(JSON.parse(text));
    segment = normalizeCodexHook(parsed, {
      clock: options.clock,
      sourceVersion,
    });
    paths = spoolPaths(state);
    await writeSegment(paths, segment);
  } catch {
    return false;
  }

  // Original capture is sealed first. Every following operation is
  // observational and cannot change Codex hook success semantics.
  try {
    if (
      parsed.hook_event_name === 'PreToolUse' ||
      parsed.hook_event_name === 'PostToolUse'
    )
      for (const derived of deriveCodexCommandSegments(parsed, segment))
        await writeSegment(paths, derived);
  } catch {
    // Deliberately silent: command enrichment is best-effort only.
  }

  try {
    const coverage = deriveCodexApprovalCoverageSegment(parsed, segment);
    if (coverage) await writeSegment(paths, coverage);
  } catch {
    // Coverage metadata is best-effort and cannot block Codex.
  }

  try {
    await writeRepositoryEnrichment(
      parsed,
      segment,
      state,
      paths,
      sourceVersion,
      options,
    );
  } catch {
    // Repository enrichment is bounded, best-effort evidence.
  }

  try {
    if (
      parsed.hook_event_name === 'Stop' &&
      segment.event.type === 'message.agent'
    )
      await writeSegment(
        paths,
        baseSegment(
          {
            sourceSessionId: parsed.session_id,
            cwd: parsed.cwd,
            model: parsed.model,
            sourceVersion,
            timestamp: segment.raw.receivedAt,
          },
          parsed as JsonObject,
          `${segment.raw.sourceEventId}:turn-completed`,
          'turn.completed',
          'harness',
          parsed as JsonObject,
          {
            turnId: parsed.turn_id,
            status: 'completed',
            subtype: 'Stop',
          },
        ),
      );
  } catch {
    // Turn completion enrichment cannot block Codex.
  }

  try {
    if (
      options.enrichTranscript !== false &&
      (parsed.hook_event_name === 'Stop' ||
        parsed.hook_event_name === 'SessionEnd')
    ) {
      const enrichment = await enrichCodexTranscript(parsed.transcript_path, {
        sourceSessionId: parsed.session_id,
        cwd: parsed.cwd,
        model: parsed.model,
        sourceVersion,
        clock: options.clock,
        invocationId: segment.raw.sourceEventId,
      });
      for (const item of enrichment) await writeSegment(paths, item);
    }
  } catch {
    // Transcript enrichment is explicitly non-canonical and best effort.
  }
  return true;
}

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly remediation?: string;
}

export interface CodexDoctorReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DoctorCheck[];
}

function doctorCheck(
  id: string,
  status: DoctorStatus,
  message: string,
  remediation?: string,
): DoctorCheck {
  return { id, status, message, ...(remediation ? { remediation } : {}) };
}

async function probeSpool(stateDir: string): Promise<void> {
  await safeDirectory(stateDir, true);
  await restrictDirectoryToCurrentUser(stateDir);
  const paths = spoolPaths(stateDir);
  await hardenSpool(paths);
  const probe = join(paths.incoming, `.doctor-${randomUUID()}.tmp`);
  const handle = await open(probe, 'wx', 0o600);
  try {
    await handle.writeFile('vibetrace-doctor\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
    await rm(probe, { force: true });
  }
}

function configOwnership(
  document: JsonObject,
  manifest: CodexInstallManifest,
): { readonly exact: number; readonly modified: number } {
  const hooks = (document.hooks ?? {}) as JsonObject;
  let exact = 0;
  let modified = 0;
  for (const ownership of manifest.handlers) {
    for (const group of readKnownGroups(hooks, ownership.event)) {
      for (const handler of group.hooks as JsonObject[]) {
        if (hashJson(handler) === ownership.handlerHash) exact += 1;
        else if (handlerInstallation(handler) === manifest.installationId)
          modified += 1;
      }
    }
  }
  return { exact, modified };
}

/** Run local Codex integration diagnostics without exposing credentials. */
export async function doctorCodex(
  options: {
    readonly stateDir?: string;
    readonly codexHome?: string;
    readonly fetch?: typeof fetch;
    readonly detectVersion?: () => Promise<string | undefined>;
    readonly clock?: () => Date;
  } = {},
): Promise<CodexDoctorReport> {
  const state = resolveStateDir(options.stateDir);
  const home = resolveCodexHome(options.codexHome);
  const checks: DoctorCheck[] = [];
  const codexVersion = await (options.detectVersion ?? detectCodexVersion)();
  if (!codexVersion)
    checks.push(
      doctorCheck(
        'codex-version',
        'fail',
        'Codex executable/version could not be detected.',
        'Install Codex and ensure the codex executable is on PATH.',
      ),
    );
  else if (!atLeast(codexVersion, CODEX_MIN_VERSION))
    checks.push(
      doctorCheck(
        'codex-version',
        'fail',
        `Codex ${codexVersion} is older than ${CODEX_MIN_VERSION}.`,
        `Upgrade Codex to ${CODEX_MIN_VERSION} or later.`,
      ),
    );
  else
    checks.push(
      doctorCheck(
        'codex-version',
        'pass',
        `Codex ${codexVersion} is supported.`,
      ),
    );

  const manifest = await readCodexInstallManifest(state).catch(() => undefined);
  const hookPath = join(home, 'hooks.json');
  if (!manifest)
    checks.push(
      doctorCheck(
        'hook-config',
        'fail',
        'VibeTrace Codex install manifest is missing or invalid.',
        'Run vibetrace init codex, then review the handlers with /hooks.',
      ),
    );
  else if (manifest.hookPath !== hookPath || !(await regularFile(hookPath)))
    checks.push(
      doctorCheck(
        'hook-config',
        'fail',
        'Manifest and Codex hooks.json do not point to the same safe file.',
        'Run vibetrace uninstall codex for the recorded home, then reinstall.',
      ),
    );
  else {
    try {
      const document = parseHooksDocument(await readFile(hookPath, 'utf8'));
      const ownership = configOwnership(document, manifest);
      if (
        ownership.exact !== CODEX_HOOK_EVENTS.length ||
        ownership.modified > 0
      )
        checks.push(
          doctorCheck(
            'hook-config',
            'fail',
            `Expected ${CODEX_HOOK_EVENTS.length} exact handlers; found ${ownership.exact} exact and ${ownership.modified} modified.`,
            'Run vibetrace init codex and review the updated definitions with /hooks.',
          ),
        );
      else
        checks.push(
          doctorCheck(
            'hook-config',
            'pass',
            `All ${CODEX_HOOK_EVENTS.length} manifest-owned handlers are intact.`,
          ),
        );
    } catch {
      checks.push(
        doctorCheck(
          'hook-config',
          'fail',
          'Codex hooks.json is malformed or unsafe.',
          'Restore the VibeTrace backup or repair hooks.json before reinstalling.',
        ),
      );
    }
  }

  try {
    await probeSpool(state);
    await access(spoolPaths(state).incoming);
    checks.push(
      doctorCheck(
        'spool-capture',
        'pass',
        'A bounded capture probe was durably written and removed.',
      ),
    );
  } catch {
    checks.push(
      doctorCheck(
        'spool-capture',
        'fail',
        'The local spool is not safely writable.',
        'Fix VIBETRACE_HOME ownership/permissions, then rerun doctor.',
      ),
    );
  }

  const descriptor = await readDescriptor(state);
  if (!descriptor)
    checks.push(
      doctorCheck(
        'daemon',
        'warn',
        'The daemon is not running; encrypted database health was not verified.',
        'Run vibetrace start, then rerun doctor.',
      ),
    );
  else {
    try {
      const tokenPath = join(state, 'auth-token');
      if (!(await regularFile(tokenPath))) throw new Error('unsafe token');
      const token = (await readFile(tokenPath, 'utf8')).trim();
      const response = await (options.fetch ?? fetch)(
        `${descriptor.origin}/api/v1/health`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(750),
        },
      );
      const body = (await response.json()) as {
        ok?: unknown;
        instanceId?: unknown;
      };
      if (
        !response.ok ||
        body.ok !== true ||
        body.instanceId !== descriptor.instanceId
      )
        throw new Error('health mismatch');
      checks.push(
        doctorCheck(
          'daemon',
          'pass',
          'Daemon authentication and encrypted database health passed.',
        ),
      );
    } catch {
      checks.push(
        doctorCheck(
          'daemon',
          'fail',
          'Daemon descriptor exists but authenticated health failed.',
          'Run vibetrace stop, then vibetrace start, and rerun doctor.',
        ),
      );
    }
  }

  if (codexVersion === '0.144.3' || codexVersion === '0.144.4')
    checks.push(
      doctorCheck(
        'session-end-coverage',
        'warn',
        'This Codex release predates the documented SessionEnd schema; VibeTrace enriches from Stop as a fallback.',
        'Upgrade Codex when a later stable release is available for SessionEnd capture.',
      ),
    );
  return {
    ok: !checks.some((check) => check.status === 'fail'),
    checkedAt: (options.clock ?? (() => new Date()))().toISOString(),
    checks,
  };
}

/** Public safety limits used by deterministic performance and boundary tests. */
export const codexAdapterLimits = {
  maxHookBytes: MAX_HOOK_BYTES,
  maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
  maxTranscriptLines: MAX_TRANSCRIPT_LINES,
  maxTranscriptLineBytes: MAX_TRANSCRIPT_LINE_BYTES,
} as const;

export {
  CODEX_0_144_3_SESSION_FIXTURES,
  CODEX_CURRENT_SESSION_END_FIXTURE,
  CODEX_ROLLOUT_V1_FIXTURE,
} from './fixtures.js';
