import { createHash } from 'node:crypto';

import { z } from 'zod';

/** The canonical schema version implemented by this package. */
export const SCHEMA_VERSION = '0.1.0' as const;

/** JSON-compatible scalar, array, or object data. */
export type JsonValue =
  boolean | JsonObject | JsonValue[] | null | number | string;

/** JSON-compatible object data. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

const isoUtcSchema = z.iso
  .datetime()
  .refine(
    (value) => value.endsWith('Z'),
    'Expected an ISO 8601 UTC timestamp.',
  );

const uuidV5Schema = z
  .string()
  .uuid()
  .refine(
    (value) => value[14] === '5',
    'Expected a UUID version 5 identifier.',
  );

/** Sources that may produce a canonical trace event. */
export const EventSourceSchema = z.enum([
  'user',
  'agent',
  'harness',
  'tool',
  'environment',
  'vcs',
  'vibetrace',
]);

/** Source-neutral canonical event types. */
export const EventTypeSchema = z.enum([
  'session.started',
  'session.completed',
  'turn.started',
  'turn.completed',
  'message.user',
  'message.agent',
  'message.plan',
  'reasoning.summary',
  'reasoning.exposed',
  'instruction.loaded',
  'skill.loaded',
  'subagent.started',
  'subagent.completed',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'permission.requested',
  'permission.resolved',
  'command.started',
  'command.output',
  'command.completed',
  'file.read',
  'file.changed',
  'git.snapshot',
  'test.completed',
  'build.completed',
  'lint.completed',
  'typecheck.completed',
  'context.compaction.started',
  'context.compaction.completed',
  'user.steered',
  'error',
  'capture.gap',
]);

/** A source system that emitted an event. */
export type EventSource = z.infer<typeof EventSourceSchema>;

/** A canonical event discriminator. */
export type EventType = z.infer<typeof EventTypeSchema>;

/** Deterministic classification of an observed command; it never implies execution. */
export const CommandCategorySchema = z.enum([
  'search',
  'read',
  'edit',
  'test',
  'lint',
  'build',
  'typecheck',
  'package-install',
  'git',
  'network',
  'unknown',
]);
export type CommandCategory = z.infer<typeof CommandCategorySchema>;
export const VerificationKindSchema = z.enum([
  'test',
  'lint',
  'build',
  'typecheck',
]);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;

/** Strict, serializable reproducibility metadata that never carries raw files or environment values. */
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const GitObjectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const RepositoryPhaseSchema = z.enum(['baseline', 'event', 'final']);
export const RepositoryFileChangeSchema = z
  .object({
    status: z.string().min(1),
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
  })
  .strict();
export const GitSnapshotPayloadSchema = z
  .object({
    phase: RepositoryPhaseSchema,
    rootHash: sha256Schema,
    baseCommit: GitObjectIdSchema,
    headCommit: GitObjectIdSchema,
    dirtyPatchHash: sha256Schema,
    changedFiles: z.array(RepositoryFileChangeSchema),
    diffArtifactId: z.string().min(1).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type RepositoryPhase = z.infer<typeof RepositoryPhaseSchema>;
export type RepositoryFileChange = z.infer<typeof RepositoryFileChangeSchema>;
export type GitSnapshotPayload = z.infer<typeof GitSnapshotPayloadSchema>;
export const FingerprintOmissionSchema = z.enum([
  'unsafe-file',
  'bounded-file-omitted',
  'unreadable-file',
  'unsafe-root',
  'unreadable-root',
  'unsafe-skill-directory',
  'bounded-directory-entries',
  'unreadable-skill-directory',
  'fingerprint-unavailable',
  'plugin-manifests-unavailable',
  'unrecognized-policy',
]);
export const RunFingerprintSchema = z
  .object({
    source: z.literal('codex'),
    clientSurface: z.enum(['cli', 'ide', 'app', 'app-server', 'exec', 'sdk']),
    codexVersion: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    modelProvider: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
    approvalPolicy: z.string().min(1).optional(),
    sandboxPolicy: z.string().min(1).optional(),
    networkPolicy: z.string().min(1).optional(),
    policyNames: z.array(z.string().min(1)).optional(),
    instructionHashes: z.array(
      z
        .object({
          kind: z.enum(['agents', 'skill', 'plugin']),
          sha256: sha256Schema,
        })
        .strict(),
    ),
    lockfileHashes: z.array(
      z.object({ name: z.string().min(1), sha256: sha256Schema }).strict(),
    ),
    captureOmissions: z.array(FingerprintOmissionSchema),
    configDigest: sha256Schema.optional(),
    mcpServerHashes: z.array(sha256Schema).optional(),
    os: z.string().min(1),
    architecture: z.string().min(1),
    runtimeVersions: z.record(z.string().min(1), z.string().min(1)),
    gitState: z
      .object({
        baseCommit: GitObjectIdSchema.optional(),
        headCommit: GitObjectIdSchema.optional(),
        rootHash: sha256Schema.optional(),
        dirtyPatchHash: sha256Schema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RunFingerprint = z.infer<typeof RunFingerprintSchema>;

/** Immutable source data retained before normalization. */
export const RawSourceEventSchema = z
  .object({
    adapter: z.string().min(1),
    adapterVersion: z.string().min(1),
    sourceVersion: z.string().min(1).optional(),
    sourceSessionId: z.string().min(1),
    sourceTurnId: z.string().min(1).optional(),
    sourceEventId: z.string().min(1).optional(),
    receivedAt: isoUtcSchema,
    payload: jsonObjectSchema,
  })
  .strict();

/** Immutable raw input received from an adapter. */
export type RawSourceEvent = z.infer<typeof RawSourceEventSchema>;

/** How completely the source was captured. */
export const CaptureModeSchema = z.enum([
  'full',
  'standard',
  'partial',
  'unknown',
]);

/** Data that the adapter could not observe. */
export const CaptureGapDataClassSchema = z.enum([
  'prompts',
  'messages',
  'plans',
  'reasoning',
  'toolInputs',
  'toolOutputs',
  'commands',
  'fileDiffs',
  'approvals',
  'compaction',
  'subagents',
  'tokenUsage',
  'repositoryState',
]);

/** Exact payload contract for a capture gap. */
export const CaptureGapPayloadSchema = z
  .object({
    dataClass: CaptureGapDataClassSchema,
    state: z.enum(['absent', 'partial', 'unknown']),
    reason: z.string().min(1),
    expectedSource: z.string().min(1).optional(),
    observedSources: z.array(z.string().min(1)).optional(),
    affectedEventTypes: z.array(EventTypeSchema).optional(),
  })
  .strict();

const textPayloadSchema = z.object({ content: z.string() }).passthrough();
const namedPayloadSchema = z.object({ name: z.string().min(1) }).passthrough();
const subagentPayloadSchema = z
  .object({ subagentId: z.string().min(1) })
  .passthrough();
const toolPayloadSchema = z
  .object({ toolName: z.string().min(1) })
  .passthrough();
const permissionPayloadSchema = z
  .object({ requestId: z.string().min(1) })
  .passthrough();
const commandPayloadSchema = z
  .object({ command: z.string().min(1), category: CommandCategorySchema })
  .passthrough();
const commandOutputPayloadSchema = commandPayloadSchema
  .extend({ output: z.string() })
  .passthrough();
const commandCompletedPayloadSchema = commandPayloadSchema
  .extend({
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative().optional(),
  })
  .passthrough();
const filePayloadSchema = z.object({ path: z.string().min(1) }).passthrough();
const verificationPayloadSchema = z
  .object({
    command: z.string().min(1),
    category: z.enum(['test', 'lint', 'build', 'typecheck']),
    kind: VerificationKindSchema,
    success: z.boolean(),
    exitCode: z.number().int(),
    summary: z.string(),
    framework: z.string().min(1).optional(),
    durationMs: z.number().nonnegative().optional(),
    rawOutputArtifactId: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine(({ category, kind }, context) => {
    if (category !== kind)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Verification category must match kind.',
        path: ['category'],
      });
  });
const compactionPayloadSchema = z
  .object({ reason: z.string().min(1) })
  .passthrough();
const errorPayloadSchema = z
  .object({ message: z.string().min(1) })
  .passthrough();
const genericPayloadSchema = z.object({}).passthrough();

/** Provenance that explains how a normalized event was produced. */
export const ProvenanceSchema = z
  .object({
    adapter: z.string().min(1),
    adapterVersion: z.string().min(1),
    sourceVersion: z.string().min(1).optional(),
    rawEventId: z.string().min(1).optional(),
    captureMode: CaptureModeSchema,
  })
  .strict();

const TraceEventBaseSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: uuidV5Schema,
    sessionId: uuidV5Schema,
    turnId: uuidV5Schema.optional(),
    parentEventId: uuidV5Schema.optional(),
    sourceEventId: z.string().min(1).optional(),
    sequence: z.number().int().positive(),
    timestamp: isoUtcSchema,
    monotonicNs: z.string().regex(/^\d+$/).optional(),
    sourceTimestamp: isoUtcSchema.optional(),
    source: EventSourceSchema,
    subtype: z.string().min(1).optional(),
    status: z
      .enum(['pending', 'running', 'completed', 'failed', 'declined'])
      .optional(),
    model: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    durationMs: z.number().nonnegative().finite().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        reasoningTokens: z.number().int().nonnegative().optional(),
        estimatedCostMicros: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    rawPayload: jsonObjectSchema,
    rawPayloadRef: z.string().min(1).optional(),
    sensitivity: z.enum(['public', 'internal', 'secret', 'unknown']).optional(),
    redactions: z
      .array(
        z
          .object({
            path: z.string().min(1),
            detector: z.string().min(1),
            replacement: z.string(),
          })
          .strict(),
      )
      .optional(),
    provenance: ProvenanceSchema,
  })
  .strict();

function eventVariant<TType extends EventType, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return TraceEventBaseSchema.extend({ payload, type: z.literal(type) });
}

/**
 * Runtime schema for canonical normalized events. Its discriminated variants keep
 * the type-specific payload contract visible to both Zod and emitted JSON Schema.
 */
export const TraceEventSchema = z.discriminatedUnion('type', [
  eventVariant('session.started', genericPayloadSchema),
  eventVariant('session.completed', genericPayloadSchema),
  eventVariant('turn.started', genericPayloadSchema),
  eventVariant('turn.completed', genericPayloadSchema),
  eventVariant('message.user', textPayloadSchema),
  eventVariant('message.agent', textPayloadSchema),
  eventVariant('message.plan', textPayloadSchema),
  eventVariant('reasoning.summary', textPayloadSchema),
  eventVariant('reasoning.exposed', textPayloadSchema),
  eventVariant('instruction.loaded', namedPayloadSchema),
  eventVariant('skill.loaded', namedPayloadSchema),
  eventVariant('subagent.started', subagentPayloadSchema),
  eventVariant('subagent.completed', subagentPayloadSchema),
  eventVariant('tool.requested', toolPayloadSchema),
  eventVariant('tool.started', toolPayloadSchema),
  eventVariant('tool.completed', toolPayloadSchema),
  eventVariant('permission.requested', permissionPayloadSchema),
  eventVariant('permission.resolved', permissionPayloadSchema),
  eventVariant('command.started', commandPayloadSchema),
  eventVariant('command.output', commandOutputPayloadSchema),
  eventVariant('command.completed', commandCompletedPayloadSchema),
  eventVariant('file.read', filePayloadSchema),
  eventVariant('file.changed', filePayloadSchema),
  eventVariant('git.snapshot', GitSnapshotPayloadSchema),
  eventVariant('test.completed', verificationPayloadSchema),
  eventVariant('build.completed', verificationPayloadSchema),
  eventVariant('lint.completed', verificationPayloadSchema),
  eventVariant('typecheck.completed', verificationPayloadSchema),
  eventVariant('context.compaction.started', compactionPayloadSchema),
  eventVariant('context.compaction.completed', compactionPayloadSchema),
  eventVariant('user.steered', textPayloadSchema),
  eventVariant('error', errorPayloadSchema),
  eventVariant('capture.gap', CaptureGapPayloadSchema),
]);

/** A normalized, append-only trace event. */
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** A stable, JSON Pointer-addressed validation failure. */
export interface ValidationProblem {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** Result of safely parsing an untrusted canonical event. */
export type TraceEventParseResult =
  | { readonly data: TraceEvent; readonly success: true }
  | {
      readonly problems: readonly ValidationProblem[];
      readonly success: false;
    };

function toJsonPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return '';
  }

  return `/${path
    .map((segment) =>
      String(segment).replaceAll('~', '~0').replaceAll('/', '~1'),
    )
    .join('/')}`;
}

/** Parse a canonical event, throwing Zod's validation error for invalid input. */
export function parseTraceEvent(input: unknown): TraceEvent {
  return TraceEventSchema.parse(input);
}

/** Safely parse an event and expose stable JSON Pointer validation problems. */
export function safeParseTraceEvent(input: unknown): TraceEventParseResult {
  const result = TraceEventSchema.safeParse(input);

  if (result.success) {
    return { data: result.data, success: true };
  }

  const problems: ValidationProblem[] = [];
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        problems.push({
          code: issue.code,
          message: issue.message,
          path: toJsonPointer([...issue.path, key]),
        });
      }
      continue;
    }

    problems.push({
      code: issue.code,
      message: issue.message,
      path: toJsonPointer(issue.path),
    });
  }

  return {
    problems,
    success: false,
  };
}

/** Emit the native Zod 4 JSON Schema for the canonical event envelope. */
export function getTraceEventJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TraceEventSchema) as Record<string, unknown>;
}

const DNS_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

/** Build a deterministic UUIDv5 from NFC-normalized, NUL-delimited components. */
export function createUuidV5(components: readonly string[]): string {
  const input = Buffer.from(
    components.map((component) => component.normalize('NFC')).join('\0'),
  );
  const digest = createHash('sha1')
    .update(DNS_NAMESPACE)
    .update(input)
    .digest();

  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Create a stable session ID without using ingest time. */
export function createSessionId(
  adapter: string,
  sourceSessionId: string,
): string {
  return createUuidV5(['vibetrace/session/0.1', adapter, sourceSessionId]);
}

/** Create a stable turn ID without using ingest time. */
export function createTurnId(
  adapter: string,
  sourceSessionId: string,
  sourceTurnId: string,
): string {
  return createUuidV5([
    'vibetrace/turn/0.1',
    adapter,
    sourceSessionId,
    sourceTurnId,
  ]);
}

/** Inputs used to create a stable event ID without using ingest time. */
export interface EventIdentityInput {
  readonly adapter: string;
  readonly sourceVersion?: string;
  readonly sourceSessionId: string;
  readonly sourceEventId?: string;
  readonly sourceSequence: number;
  readonly type: EventType;
}

/** Create a stable event ID from source identity, sequence fallback, and event type. */
export function createEventId(input: EventIdentityInput): string {
  return createUuidV5([
    'vibetrace/event/0.1',
    input.adapter,
    input.sourceVersion ?? '',
    input.sourceSessionId,
    input.sourceEventId ?? String(input.sourceSequence),
    input.type,
  ]);
}

/** One pure, forward-only normalized-schema migration. */
export interface TraceMigration {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly migrate: (input: unknown) => unknown;
}

/** A validated immutable migration registry. */
export interface MigrationRegistry {
  /** Known schema versions, in ascending order. */
  readonly versions: readonly string[];
  /** Migrate a cloned value along a validated forward-only route. */
  migrate(input: unknown, fromVersion: string, toVersion: string): unknown;
}

function parseVersion(version: string): readonly [number, number, number] {
  const parts = version.split('.').map(Number);

  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    throw new Error(
      'Migration versions must use numeric major.minor.patch format.',
    );
  }

  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(
      'Migration versions must use numeric major.minor.patch format.',
    );
  }
  return [major, minor, patch];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  const majorDifference = leftParts[0] - rightParts[0];
  if (majorDifference !== 0) {
    return majorDifference;
  }
  const minorDifference = leftParts[1] - rightParts[1];
  if (minorDifference !== 0) {
    return minorDifference;
  }
  const patchDifference = leftParts[2] - rightParts[2];
  if (patchDifference !== 0) {
    return patchDifference;
  }

  return 0;
}

function areAdjacentVersions(fromVersion: string, toVersion: string): boolean {
  const from = parseVersion(fromVersion);
  const to = parseVersion(toVersion);

  return (
    (from[0] === to[0] && from[1] === to[1] && to[2] === from[2] + 1) ||
    (from[0] === to[0] && to[1] === from[1] + 1 && to[2] === 0) ||
    (to[0] === from[0] + 1 && to[1] === 0 && to[2] === 0)
  );
}

/**
 * Create a migration registry. Routes must be unique, strictly forward, acyclic,
 * and contiguous across every declared version.
 */
export function createMigrationRegistry(
  migrations: readonly TraceMigration[],
  currentVersion: string = SCHEMA_VERSION,
): MigrationRegistry {
  const copiedMigrations = migrations.map((migration) => ({ ...migration }));
  const versions = new Set<string>([currentVersion]);
  const routes = new Map<string, TraceMigration>();

  for (const migration of copiedMigrations) {
    if (compareVersions(migration.fromVersion, migration.toVersion) >= 0) {
      throw new Error(
        `Migration ${migration.fromVersion} -> ${migration.toVersion} is not forward-only.`,
      );
    }
    if (!areAdjacentVersions(migration.fromVersion, migration.toVersion)) {
      throw new Error(
        `Noncontiguous migration route ${migration.fromVersion} -> ${migration.toVersion}.`,
      );
    }

    const key = `${migration.fromVersion}\0${migration.toVersion}`;
    if (routes.has(key)) {
      throw new Error(
        `Duplicate migration route ${migration.fromVersion} -> ${migration.toVersion}.`,
      );
    }

    routes.set(key, migration);
    versions.add(migration.fromVersion);
    versions.add(migration.toVersion);
  }

  const orderedVersions = [...versions].sort(compareVersions);
  for (let index = 0; index < orderedVersions.length - 1; index += 1) {
    const fromVersion = orderedVersions[index];
    const toVersion = orderedVersions[index + 1];
    if (fromVersion === undefined || toVersion === undefined) {
      continue;
    }
    if (!routes.has(`${fromVersion}\0${toVersion}`)) {
      throw new Error(
        `Noncontiguous migration route ${fromVersion} -> ${toVersion}.`,
      );
    }
  }

  return Object.freeze({
    migrate(input: unknown, fromVersion: string, toVersion: string): unknown {
      const fromIndex = orderedVersions.indexOf(fromVersion);
      const toIndex = orderedVersions.indexOf(toVersion);
      if (fromIndex === -1 || toIndex === -1) {
        throw new Error(
          `Unknown schema migration version ${fromIndex === -1 ? fromVersion : toVersion}.`,
        );
      }
      if (fromIndex > toIndex) {
        throw new Error(
          `Migration ${fromVersion} -> ${toVersion} is not forward-only.`,
        );
      }

      let value = structuredClone(input);
      for (let index = fromIndex; index < toIndex; index += 1) {
        const from = orderedVersions[index];
        const to = orderedVersions[index + 1];
        const migration = routes.get(`${from}\0${to}`);
        if (migration === undefined) {
          throw new Error(`Noncontiguous migration route ${from} -> ${to}.`);
        }
        value = migration.migrate(structuredClone(value));
      }
      return value;
    },
    versions: Object.freeze(orderedVersions),
  });
}

/** The v0.1 registry intentionally has no migrations. */
export const migrationRegistry = createMigrationRegistry([]);
