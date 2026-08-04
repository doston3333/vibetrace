import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';
import {
  ExportProfileSchema,
  createBundlePreview,
  exportBundle,
  importBundle,
  type BundleImportResult,
  type BundlePreview,
  type ExportBundleOptions,
  type ImportBundleOptions,
} from '@vibetrace/bundle';
import {
  analyzeAndPersist,
  buildSessionScorecard,
} from '@vibetrace/diagnostics';
import { captureOtelJson } from '@vibetrace/adapter-otel';
import { AiHypothesisSchema, verifyHypotheses } from '@vibetrace/analyzer-ai';
import {
  ComparisonMatrixConfigurationSchema,
  firstDivergence,
  summarizeRuns,
  type FirstDivergence,
} from '@vibetrace/eval-compare';
import {
  hashEvalJson,
  manifestFromSession,
  parseEvalManifest,
  SuccessAssertionSchema,
  type EvalManifest,
} from '@vibetrace/eval-spec';
import {
  EVAL_RUN_STATUSES,
  Storage,
  type EvalRunUpdate,
  restrictDirectoryToCurrentUser,
  type StoredNormalizedEvent,
} from '@vibetrace/storage';
import {
  CaptureProfilePolicySchema,
  createUuidV5,
  captureProfilePolicy,
  TraceEventSchema,
  type CaptureProfilePolicy,
  type JsonObject,
  type TraceEvent,
} from '@vibetrace/schema';
import { z } from 'zod';

import {
  hardenSpool,
  inspectSpool,
  importSegments,
  spoolPaths,
  type SpoolImportOptions,
} from './spool.js';
export { restrictDirectoryToCurrentUser } from '@vibetrace/storage';

export {
  SpoolSegmentSchema,
  ensureSpool,
  hardenSpool,
  inspectSpool,
  spoolPaths,
  writeSegment,
  type SpoolHealth,
  type SpoolRetentionPolicy,
  type SpoolPaths,
  type SpoolSegment,
} from './spool.js';

const API_VERSION = 'v1';
const TOKEN_BYTES = 32;
const ticketSchema = z
  .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const browserSessionSchema = z
  .object({ handoffToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const annotationSchema = z
  .object({
    targetType: z.string().min(1).max(64),
    targetId: z.string().min(1).max(512),
    label: z.string().max(256).optional(),
    note: z.string().max(16_384).optional(),
  })
  .strict();
const sessionIdSchema = z.string().min(1).max(128);
const sessionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
    project: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(512).optional(),
    result: z.string().min(1).max(128).optional(),
    category: z.string().min(1).max(128).optional(),
    captureMode: z.string().min(1).max(128).optional(),
  })
  .strict();
const eventListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(2_000).default(500),
    type: z.string().min(1).max(128).optional(),
    toolName: z.string().min(1).max(1_024).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    afterSequence: z.coerce.number().int().positive().optional(),
    afterId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.afterSequence === undefined) === (value.afterId === undefined),
    { message: 'Cursor fields must be supplied together.' },
  );
const eventSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(512),
    limit: z.coerce.number().int().min(1).max(1_000).default(200),
  })
  .strict();
const eventStreamQuerySchema = eventListQuerySchema
  .extend({ once: z.coerce.boolean().default(false) })
  .strict();
const annotationListQuerySchema = z
  .object({
    targetType: z.string().min(1).max(64).optional(),
    targetId: z.string().min(1).max(512).optional(),
  })
  .strict();
const findingReviewSchema = z
  .object({
    decision: z.enum(['open', 'confirmed', 'rejected']).optional(),
    categoryOverride: z.string().min(1).max(128).optional(),
    note: z.string().max(16_384).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.decision !== undefined ||
      value.categoryOverride !== undefined ||
      value.note !== undefined,
    { message: 'At least one review field is required.' },
  );
const bundlePassphraseSchema = z.string().min(10).max(1_024);
const bundlePreviewSchema = z
  .object({
    sessionId: sessionIdSchema,
    profile: ExportProfileSchema,
  })
  .strict();
const bundleExportSchema = bundlePreviewSchema
  .extend({
    destination: z.string().min(1).max(32_768),
    passphrase: bundlePassphraseSchema,
    expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const bundleImportSchema = z
  .object({
    source: z.string().min(1).max(32_768),
    passphrase: bundlePassphraseSchema,
  })
  .strict();
const evalManifestCreateSchema = z.object({ manifest: z.unknown() }).strict();
const evalManifestFromSessionSchema = z
  .object({
    name: z.string().min(1).max(512),
    successAssertions: z.array(z.unknown()).max(10_000).optional(),
  })
  .strict();
const evalRunCreateSchema = z
  .object({
    id: z.string().uuid().optional(),
    configuration: z.record(z.string(), z.unknown()),
    worktreeFingerprintHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(EVAL_RUN_STATUSES).default('queued'),
    sourceSessionId: z.string().uuid().optional(),
  })
  .strict();
const evalRunUpdateSchema = z
  .object({
    sourceSessionId: z.string().uuid().optional(),
    status: z.enum(EVAL_RUN_STATUSES).optional(),
    outcome: z.record(z.string(), z.unknown()).optional(),
    metrics: z.record(z.string(), z.unknown()).optional(),
    outputBlobHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
  })
  .strict();
const evalComparisonCreateSchema = z
  .object({
    id: z.string().uuid().optional(),
    evalCaseId: z.string().uuid(),
    name: z.string().min(1).max(512),
    configuration: z.record(z.string(), z.unknown()),
  })
  .strict();
const evalComparisonResultSchema = z
  .object({
    evalRunId: z.string().uuid(),
    ordinal: z.number().int().nonnegative(),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();
const evalComparisonDivergenceSchema = z
  .object({
    leftRunId: z.string().uuid(),
    rightRunId: z.string().uuid(),
    leftEvents: z.array(z.unknown()).max(20_000),
    rightEvents: z.array(z.unknown()).max(20_000),
  })
  .strict()
  .refine((value) => value.leftRunId !== value.rightRunId, {
    message: 'Compared runs must be different.',
  });
const evalEventCaptureSchema = z
  .object({ events: z.array(TraceEventSchema).max(20_000) })
  .strict();
const comparableEventSchema = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1),
    source: z.string().min(1),
    status: z.string().optional(),
    toolName: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
const persistedDivergenceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    reason: z.enum([
      'missing-left',
      'missing-right',
      'type',
      'source',
      'status',
      'tool',
      'payload',
    ]),
    leftEventId: z.string().optional(),
    rightEventId: z.string().optional(),
    left: comparableEventSchema.optional(),
    right: comparableEventSchema.optional(),
  })
  .strict();
const captureProfileSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(256),
    mode: z.enum(['minimal', 'standard', 'full']),
    settings: z
      .record(z.string().min(1).max(128), z.unknown())
      .refine((value) => Object.keys(value).length <= 64, {
        message: 'Capture profile settings contain too many keys.',
      })
      .refine((value) => JSON.stringify(value).length <= 16_384, {
        message: 'Capture profile settings exceed the 16 KiB limit.',
      }),
    activate: z.boolean().default(false),
  })
  .strict();
const retentionPolicySchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(256),
    retentionDays: z.number().int().min(1).max(36_500),
    maxSessions: z.number().int().min(1).max(1_000_000).optional(),
    apply: z.boolean().default(false),
  })
  .strict();
const aiFindingSubmissionSchema = z
  .object({
    analyzerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    hypotheses: z.array(AiHypothesisSchema).max(1_000),
  })
  .strict();
const SAFE_ARTIFACT_MEDIA_TYPES = new Set([
  'application/json',
  'text/csv',
  'text/plain',
  'text/x-diff',
  'text/x-patch',
]);

/** The on-disk, secret-free description of one daemon instance. */
export interface DaemonDescriptor {
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly instanceId: string;
  readonly apiVersion: string;
  readonly startedAt: string;
}

/** Clock injection makes ticket expiry and lifecycle tests deterministic. */
export interface DaemonClock {
  now(): Date;
}

/** Optional collaborators for in-process tests and non-browser CLI integration. */
export interface DaemonOptions {
  readonly stateDir?: string;
  readonly storage?: Storage;
  readonly storagePassphrase?: string;
  readonly clock?: DaemonClock;
  readonly dashboardDir?: string;
  readonly spoolFaults?: SpoolImportOptions;
  readonly bundleOperations?: BundleOperations;
  readonly otel?: {
    readonly enabled: boolean;
    readonly allowPromptContent?: boolean;
  };
}

/** Test seam around CPU-heavy encryption while preserving route validation. */
export interface BundleOperations {
  preview(
    storage: Storage,
    sessionId: string,
    profile: ExportBundleOptions['profile'],
  ): Promise<BundlePreview>;
  export(
    storage: Storage,
    options: ExportBundleOptions,
  ): Promise<BundlePreview>;
  import(
    storage: Storage,
    options: ImportBundleOptions,
  ): Promise<BundleImportResult>;
}

/** Injectable fetch boundary used to verify descriptor checks never leak tokens. */
export type DaemonFetch = typeof fetch;

export interface RunningDaemon {
  readonly app: FastifyInstance;
  readonly descriptor: DaemonDescriptor;
  readonly stateDir: string;
  readonly token: string;
  close(): Promise<void>;
}

interface Ticket {
  readonly expiresAt: number;
  used: boolean;
}

interface BrowserHandoff {
  readonly ticketId: string;
  readonly expiresAt: number;
  used: boolean;
}

export type CoverageState = 'captured' | 'partial' | 'absent' | 'unknown';
export interface CoverageDatum {
  readonly dataClass:
    'conversation' | 'context' | 'tools' | 'code' | 'verification';
  readonly state: CoverageState;
  readonly sources: readonly string[];
  readonly gaps: readonly {
    eventId: string;
    state: string;
    reason: string;
    adapter: string;
  }[];
}

const COVERAGE_CLASSES = [
  'conversation',
  'context',
  'tools',
  'code',
  'verification',
] as const;
type CoverageClass = (typeof COVERAGE_CLASSES)[number];

function eventCoverageClass(type: string): CoverageClass | undefined {
  if (/^(message\.|turn\.|session\.)/.test(type)) return 'conversation';
  if (/^(instruction\.|skill\.|context\.|subagent\.)/.test(type))
    return 'context';
  if (/^(tool\.|command\.|permission\.)/.test(type)) return 'tools';
  if (/^(file\.|git\.)/.test(type)) return 'code';
  if (/^(test|lint|build|typecheck)\./.test(type)) return 'verification';
  return undefined;
}

function gapCoverageClass(value: unknown): CoverageClass | undefined {
  if (typeof value !== 'string') return undefined;
  if (/prompt|message|conversation|turn/i.test(value)) return 'conversation';
  if (
    /instruction|skill|context|reason|plan|subagent|token|transcript/i.test(
      value,
    )
  )
    return 'context';
  if (/tool|command|permission|approval|terminal/i.test(value)) return 'tools';
  if (/file|diff|repository|git/i.test(value)) return 'code';
  if (/test|lint|build|typecheck|verification/i.test(value))
    return 'verification';
  return undefined;
}

function bundleFailure(error: unknown): {
  readonly status: 400 | 404 | 409;
  readonly code: string;
} {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Session was not found.')
    return { status: 404, code: 'NOT_FOUND' };
  if (message.includes('preview is stale'))
    return { status: 409, code: 'BUNDLE_PREVIEW_STALE' };
  if (message.includes('already exists'))
    return { status: 409, code: 'BUNDLE_DESTINATION_EXISTS' };
  if (message.includes('collision'))
    return { status: 409, code: 'BUNDLE_ID_COLLISION' };
  return { status: 400, code: 'INVALID_BUNDLE_OR_PASSPHRASE' };
}

/** Read a decrypted blob only when a route has an explicit bounded size contract. */
async function readBoundedBlob(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of stream) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        stream.destroy();
        throw new Error('Blob exceeds the route size limit.');
      }
      chunks.push(value);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, byteLength);
}

const MAX_COMPARISON_EVENT_BYTES = 32 * 1024 * 1024;

function parseComparisonEvents(
  values: readonly unknown[],
): readonly TraceEvent[] | undefined {
  let byteLength = 0;
  const events: TraceEvent[] = [];
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    byteLength += Buffer.byteLength(serialized, 'utf8');
    if (byteLength > MAX_COMPARISON_EVENT_BYTES) return undefined;
    const parsed = TraceEventSchema.safeParse(value);
    if (!parsed.success) return undefined;
    events.push(parsed.data);
  }
  return events;
}

/** Derive comparable operational metrics from one captured eval stream. */
function evalEventMetrics(events: readonly TraceEvent[]): JsonObject {
  const timestamps = events
    .map((event) => Date.parse(event.timestamp))
    .filter((value) => Number.isFinite(value));
  const diffPaths = new Set<string>();
  let toolCount = 0;
  let tokenCount = 0;
  let estimatedCostMicros = 0;
  let hasTokenUsage = false;
  let verificationCount = 0;
  let verificationFailureCount = 0;
  for (const event of events) {
    if (
      event.type === 'tool.started' ||
      event.type === 'tool.requested' ||
      event.type === 'command.started'
    )
      toolCount += 1;
    if (event.type === 'file.changed') {
      const path = (event.payload as Record<string, unknown>).path;
      if (typeof path === 'string' && path.length > 0) diffPaths.add(path);
    }
    if (event.type === 'git.snapshot') {
      const changedFiles = (event.payload as Record<string, unknown>)
        .changedFiles;
      if (Array.isArray(changedFiles))
        for (const item of changedFiles) {
          const path =
            item && typeof item === 'object'
              ? (item as Record<string, unknown>).path
              : undefined;
          if (typeof path === 'string' && path.length > 0) diffPaths.add(path);
        }
    }
    if (/^(test|lint|build|typecheck)\.completed$/u.test(event.type)) {
      verificationCount += 1;
      if ((event.payload as Record<string, unknown>).success === false)
        verificationFailureCount += 1;
    }
    if (event.usage) {
      hasTokenUsage = true;
      tokenCount +=
        (event.usage.inputTokens ?? 0) +
        (event.usage.cachedInputTokens ?? 0) +
        (event.usage.outputTokens ?? 0) +
        (event.usage.reasoningTokens ?? 0);
      estimatedCostMicros += event.usage.estimatedCostMicros ?? 0;
    }
  }
  return {
    ...(timestamps.length > 1
      ? {
          durationMs: Math.max(
            0,
            Math.max(...timestamps) - Math.min(...timestamps),
          ),
        }
      : {}),
    toolCount,
    diffFileCount: diffPaths.size,
    verificationCount,
    verificationFailureCount,
    ...(hasTokenUsage ? { tokenCount, estimatedCostMicros } : {}),
  };
}

function comparisonDivergence(
  results: readonly { readonly result: JsonObject }[],
): FirstDivergence | undefined {
  for (const item of results) {
    const candidate = item.result.firstDivergence;
    const parsed = persistedDivergenceSchema.safeParse(candidate);
    if (parsed.success) return parsed.data as unknown as FirstDivergence;
  }
  return undefined;
}

/** Derive evidence-only coverage; absence is never inferred as a successful capture. */
export function deriveCaptureCoverage(
  events: readonly StoredNormalizedEvent[],
): readonly CoverageDatum[] {
  const observed = new Map<CoverageClass, Set<string>>();
  const gaps = new Map<CoverageClass, CoverageDatum['gaps'][number][]>();
  for (const stored of events) {
    const event = stored.event;
    if (event.type === 'capture.gap') {
      const payload = event.payload as Record<string, unknown>;
      const dataClass = gapCoverageClass(payload.dataClass);
      if (!dataClass) continue;
      const sources = observed.get(dataClass) ?? new Set<string>();
      if (Array.isArray(payload.observedSources))
        for (const source of payload.observedSources)
          if (typeof source === 'string' && source.length > 0)
            sources.add(source.slice(0, 256));
      if (sources.size > 0) observed.set(dataClass, sources);
      const values = gaps.get(dataClass) ?? [];
      values.push({
        eventId: event.id,
        state:
          typeof payload.state === 'string'
            ? payload.state.slice(0, 64)
            : 'unknown',
        reason:
          typeof payload.reason === 'string'
            ? payload.reason.slice(0, 512)
            : 'Capture source did not provide a safe reason.',
        adapter: event.provenance.adapter,
      });
      gaps.set(dataClass, values);
      continue;
    }
    const dataClass = eventCoverageClass(event.type);
    if (!dataClass) continue;
    const sources = observed.get(dataClass) ?? new Set<string>();
    sources.add(`${event.source} · ${event.provenance.adapter}`);
    observed.set(dataClass, sources);
  }
  return COVERAGE_CLASSES.map((dataClass) => {
    const sources = [...(observed.get(dataClass) ?? [])].sort();
    const classGaps = gaps.get(dataClass) ?? [];
    const state: CoverageState =
      sources.length > 0 && classGaps.length === 0
        ? 'captured'
        : sources.length > 0
          ? 'partial'
          : classGaps.some((gap) => gap.state === 'partial')
            ? 'partial'
            : classGaps.some((gap) => gap.state === 'absent')
              ? 'absent'
              : 'unknown';
    return { dataClass, state, sources, gaps: classGaps };
  });
}

/** Resolve the only supported state directory shape; relative overrides are unsafe. */
export function resolveStateDir(value = process.env.VIBETRACE_HOME): string {
  if (value !== undefined) {
    if (!isAbsolute(value))
      throw new Error('VIBETRACE_HOME must be an absolute path.');
    return value;
  }
  return join(homedir(), '.vibetrace');
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function bearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return match?.[1];
}

async function restrictedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('VibeTrace state directory is unsafe.');
  await restrictDirectoryToCurrentUser(path);
}

async function writeAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
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
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const CAPTURE_POLICY_FILENAME = 'capture-policy.json';

function capturePolicyPath(stateDir: string): string {
  return join(stateDir, CAPTURE_POLICY_FILENAME);
}

async function persistCapturePolicy(
  stateDir: string,
  mode: 'minimal' | 'standard' | 'full',
  settings: Record<string, unknown>,
): Promise<CaptureProfilePolicy> {
  const policy = CaptureProfilePolicySchema.parse(
    captureProfilePolicy(mode, settings),
  );
  await writeAtomic(
    capturePolicyPath(stateDir),
    `${JSON.stringify(policy)}\n`,
    0o600,
  );
  return policy;
}

async function ensureCapturePolicy(stateDir: string): Promise<void> {
  try {
    const path = capturePolicyPath(stateDir);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024
    )
      throw new Error('Invalid capture policy.');
    CaptureProfilePolicySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    await persistCapturePolicy(stateDir, 'standard', {});
  }
}

/** Read the effective source-boundary policy for adapters hosted by the daemon. */
export async function readCaptureProfilePolicy(
  stateDir: string,
): Promise<CaptureProfilePolicy> {
  try {
    const path = capturePolicyPath(stateDir);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024
    )
      throw new Error('Invalid capture policy.');
    return CaptureProfilePolicySchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
  } catch {
    return CaptureProfilePolicySchema.parse(captureProfilePolicy('standard'));
  }
}

async function loadOrCreateToken(stateDir: string): Promise<string> {
  const path = join(stateDir, 'auth-token');
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('VibeTrace token path is unsafe.');
    const token = (await readFile(path, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('VibeTrace token file is invalid.');
    await chmod(path, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return loadOrCreateToken(stateDir);
  }
}

/** Read an optional descriptor without interpreting its contents as trusted. */
export async function readDescriptor(
  stateDir: string,
): Promise<DaemonDescriptor | undefined> {
  try {
    const path = join(stateDir, 'daemon.json');
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const descriptor = z
      .object({
        pid: z.number().int().positive(),
        port: z.number().int().min(1).max(65535),
        origin: z.string().url(),
        instanceId: z.string().uuid(),
        apiVersion: z.literal(API_VERSION),
        startedAt: z.string().datetime(),
      })
      .strict()
      .parse(JSON.parse(await readFile(path, 'utf8')));
    const origin = new URL(descriptor.origin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.port !== String(descriptor.port) ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== ''
    )
      return undefined;
    return descriptor;
  } catch {
    return undefined;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function descriptorIsHealthy(
  stateDir: string,
  descriptor: DaemonDescriptor,
  request: DaemonFetch = fetch,
): Promise<boolean> {
  try {
    const token = (await readFile(join(stateDir, 'auth-token'), 'utf8')).trim();
    const response = await request(`${descriptor.origin}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    const body = (await response.json()) as { instanceId?: unknown };
    return response.ok && body.instanceId === descriptor.instanceId;
  } catch {
    return false;
  }
}

/** Clear only unusable local state; it never signals or kills the recorded PID. */
export async function recoverStaleState(
  stateDir: string,
  request: DaemonFetch = fetch,
): Promise<boolean> {
  const descriptor = await readDescriptor(stateDir);
  if (descriptor && (await descriptorIsHealthy(stateDir, descriptor, request)))
    return false;
  // The PID probe deliberately has no side effect. A mismatched/unhealthy instance
  // may be an unrelated process with a recycled PID and must never be terminated.
  if (descriptor) void pidExists(descriptor.pid);
  await rm(join(stateDir, 'daemon.json'), { force: true });
  await rm(join(stateDir, 'daemon.lock'), { force: true, recursive: true });
  return true;
}

/** Start an authenticated loopback-only daemon. It never logs credentials or trace data. */
export async function startDaemon(
  options: DaemonOptions = {},
): Promise<RunningDaemon> {
  const stateDir = resolveStateDir(options.stateDir);
  await restrictedDirectory(stateDir);
  await ensureCapturePolicy(stateDir);
  const lockPath = join(stateDir, 'daemon.lock');
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch {
    if (!(await recoverStaleState(stateDir)))
      throw new Error('A VibeTrace daemon lock already exists.');
    await mkdir(lockPath, { mode: 0o700 });
  }
  const clock = options.clock ?? { now: () => new Date() };
  const instanceId = randomUUID();
  const ownStorage = options.storage === undefined;
  let openedStorage: Storage | undefined;
  let app: FastifyInstance | undefined;
  let importTimer: NodeJS.Timeout | undefined;
  try {
    const storage =
      options.storage ??
      (await Storage.open({
        stateDir,
        ...(options.storagePassphrase
          ? { passphrase: options.storagePassphrase }
          : {}),
      }));
    openedStorage = storage;
    const bundleOperations: BundleOperations = options.bundleOperations ?? {
      preview: createBundlePreview,
      export: exportBundle,
      import: importBundle,
    };
    const token = await loadOrCreateToken(stateDir);
    await hardenSpool(spoolPaths(stateDir));
    app = fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    await app.register(cookie);
    let dashboardAvailable = false;
    {
      const dashboardCandidates = options.dashboardDir
        ? [options.dashboardDir]
        : [
            fileURLToPath(new URL('./dashboard', import.meta.url)),
            join(
              fileURLToPath(new URL('../../..', import.meta.url)),
              'apps',
              'dashboard',
              'dist',
            ),
          ];
      for (const dashboardDir of dashboardCandidates) {
        const dashboard = await lstat(dashboardDir).catch(() => undefined);
        if (!dashboard?.isDirectory() || dashboard.isSymbolicLink()) continue;
        await app.register(fastifyStatic, {
          root: dashboardDir,
          prefix: '/',
          index: false,
          wildcard: false,
        });
        dashboardAvailable = true;
        break;
      }
    }
    const tickets = new Map<string, Ticket>();
    const browserHandoffs = new Map<string, BrowserHandoff>();
    const sessions = new Set<string>();
    const importer = {
      status: 'idle' as 'idle' | 'error',
      lastImportedAt: undefined as string | undefined,
      lastErrorCode: undefined as string | undefined,
    };
    const pendingAnalysis = new Set<string>();
    let importing: Promise<void> | undefined;
    const importOnce = async (): Promise<void> => {
      if (importing) return importing;
      importing = (async () => {
        try {
          const spoolOptions = options.spoolFaults;
          const result = await importSegments(storage, spoolPaths(stateDir), {
            ...spoolOptions,
            onCommittedSession(sessionId) {
              spoolOptions?.onCommittedSession?.(sessionId);
              pendingAnalysis.add(sessionId);
            },
          });
          for (const sessionId of pendingAnalysis) {
            analyzeAndPersist(storage, sessionId);
            pendingAnalysis.delete(sessionId);
          }
          importer.status = 'idle';
          importer.lastErrorCode = undefined;
          if (result.imported > 0 || result.quarantined > 0)
            importer.lastImportedAt = clock.now().toISOString();
        } catch {
          importer.status = 'error';
          importer.lastErrorCode = 'IMPORT_FAILED';
        } finally {
          importing = undefined;
        }
      })();
      return importing;
    };
    await importOnce();
    importTimer = setInterval(() => {
      void importOnce();
    }, 1_000);
    importTimer.unref();
    let origin = '';
    const exactOrigin = (): string => origin;
    const authenticated = (request: {
      headers: Record<string, unknown>;
      cookies: Record<string, string | undefined>;
    }): 'bearer' | 'cookie' | undefined => {
      const supplied = bearer(request.headers.authorization);
      if (supplied && constantTimeEquals(supplied, token)) return 'bearer';
      const session = request.cookies.vibetrace_session;
      return typeof session === 'string' && sessions.has(session)
        ? 'cookie'
        : undefined;
    };
    const prune = (): void => {
      const now = clock.now().getTime();
      for (const [id, ticket] of tickets)
        if (ticket.used || ticket.expiresAt <= now) tickets.delete(id);
      for (const [id, handoff] of browserHandoffs)
        if (handoff.used || handoff.expiresAt <= now)
          browserHandoffs.delete(id);
      while (tickets.size > 128)
        tickets.delete(tickets.keys().next().value as string);
      while (browserHandoffs.size > 128)
        browserHandoffs.delete(browserHandoffs.keys().next().value as string);
      while (sessions.size > 128)
        sessions.delete(sessions.values().next().value as string);
    };
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/v1')) return;
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin !== exactOrigin())
        return reply.code(403).send({ code: 'FOREIGN_ORIGIN' });
      if (
        request.url === '/api/v1/auth/session' ||
        request.url === '/api/v1/auth/browser-session'
      )
        return;
      const method = request.method;
      const mode = authenticated(request);
      if (!mode) return reply.code(401).send({ code: 'UNAUTHORIZED' });
      if (
        mode === 'cookie' &&
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
        origin !== exactOrigin()
      )
        return reply.code(403).send({ code: 'ORIGIN_REQUIRED' });
    });
    app.get('/api/v1/health', async () => ({
      ok: true,
      instanceId,
      apiVersion: API_VERSION,
      importer,
      spool: await inspectSpool(spoolPaths(stateDir)),
    }));
    app.post('/api/v1/auth/tickets', async (request, reply) => {
      const supplied = bearer(request.headers.authorization);
      if (!supplied || !constantTimeEquals(supplied, token))
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      prune();
      const ticket = randomBytes(TOKEN_BYTES).toString('base64url');
      tickets.set(hashTicket(ticket), {
        expiresAt: clock.now().getTime() + 60_000,
        used: false,
      });
      return {
        ticket,
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      };
    });
    app.post('/api/v1/auth/browser-handoff', async (request, reply) => {
      const supplied = bearer(request.headers.authorization);
      if (!supplied || !constantTimeEquals(supplied, token))
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      const parsed = ticketSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_TICKET' });
      const ticketId = hashTicket(parsed.data.ticket);
      const record = tickets.get(ticketId);
      if (!record || record.used || record.expiresAt <= clock.now().getTime())
        return reply.code(400).send({ code: 'INVALID_TICKET' });
      const handoffToken = randomBytes(TOKEN_BYTES).toString('base64url');
      browserHandoffs.set(hashTicket(handoffToken), {
        ticketId,
        expiresAt: record.expiresAt,
        used: false,
      });
      prune();
      return {
        ok: true,
        handoffToken,
        expiresAt: new Date(record.expiresAt).toISOString(),
      };
    });
    app.post('/api/v1/auth/session', async (request, reply) => {
      if (request.headers.origin !== exactOrigin())
        return reply.code(403).send({ code: 'FOREIGN_ORIGIN' });
      const parsed = ticketSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_TICKET' });
      const record = tickets.get(hashTicket(parsed.data.ticket));
      if (!record || record.used || record.expiresAt <= clock.now().getTime())
        return reply.code(401).send({ code: 'INVALID_TICKET' });
      record.used = true;
      const session = randomBytes(TOKEN_BYTES).toString('base64url');
      sessions.add(session);
      prune();
      reply.setCookie('vibetrace_session', session, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
      return { ok: true };
    });
    app.post('/api/v1/auth/browser-session', async (request, reply) => {
      if (request.headers.origin !== exactOrigin())
        return reply.code(403).send({ code: 'FOREIGN_ORIGIN' });
      const parsed = browserSessionSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_HANDOFF' });
      const handoffId = hashTicket(parsed.data.handoffToken);
      const handoff = browserHandoffs.get(handoffId);
      if (
        !handoff ||
        handoff.used ||
        handoff.expiresAt <= clock.now().getTime()
      )
        return reply.code(401).send({ code: 'INVALID_TICKET' });
      handoff.used = true;
      const record = tickets.get(handoff.ticketId);
      if (!record || record.used || record.expiresAt <= clock.now().getTime())
        return reply.code(401).send({ code: 'INVALID_TICKET' });
      record.used = true;
      const session = randomBytes(TOKEN_BYTES).toString('base64url');
      sessions.add(session);
      prune();
      reply.setCookie('vibetrace_session', session, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
      return { ok: true };
    });
    if (options.otel?.enabled) {
      app.post('/api/v1/otel/v1/logs', async (request, reply) => {
        const header = request.headers['x-vibetrace-source-session'];
        const sourceSessionId =
          typeof header === 'string' && /^[A-Za-z0-9._:-]{1,512}$/.test(header)
            ? header
            : undefined;
        if (!sourceSessionId)
          return reply
            .code(400)
            .send({ code: 'SOURCE_SESSION_HEADER_REQUIRED' });
        try {
          const capturePolicy = await readCaptureProfilePolicy(stateDir);
          const mapped = captureOtelJson({
            body: request.body,
            context: {
              sourceSessionId,
              allowPromptContent:
                options.otel?.allowPromptContent === true &&
                capturePolicy.capturePrompts,
              captureProfile: capturePolicy,
            },
          });
          for (const item of mapped)
            storage.importEvent({
              project: { id: 'otel', displayName: 'OpenTelemetry' },
              session: {
                id: item.event.sessionId,
                projectId: 'otel',
                source: 'opentelemetry',
                sourceSessionId,
                startedAt: item.event.timestamp,
                status: 'active',
                captureMode: 'partial',
              },
              raw: item.raw,
              event: item.event,
              normalizerId: `${item.raw.adapter}/${item.raw.adapterVersion}`,
            });
          return {
            accepted: mapped.length,
            gaps: mapped.filter((item) => item.event.type === 'capture.gap')
              .length,
          };
        } catch {
          return reply.code(400).send({ code: 'INVALID_OTEL_PAYLOAD' });
        }
      });
    }
    app.get('/api/v1/privacy/capture-profiles', async () => ({
      profiles: storage.listCaptureProfiles(),
    }));
    app.get('/api/v1/privacy/capture-profile', async (_request, reply) => {
      try {
        return {
          policy: CaptureProfilePolicySchema.parse(
            JSON.parse(await readFile(capturePolicyPath(stateDir), 'utf8')),
          ),
        };
      } catch {
        return reply.code(503).send({ code: 'CAPTURE_POLICY_UNAVAILABLE' });
      }
    });
    app.post('/api/v1/privacy/capture-profiles', async (request, reply) => {
      const parsed = captureProfileSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_CAPTURE_PROFILE' });
      try {
        const id = parsed.data.id ?? randomUUID();
        storage.createCaptureProfile({
          id,
          name: parsed.data.name,
          mode: parsed.data.mode,
          settings: parsed.data.settings as JsonObject,
        });
        if (parsed.data.activate)
          await persistCapturePolicy(
            stateDir,
            parsed.data.mode,
            parsed.data.settings,
          );
        return reply.code(201).send({
          profile: storage.getCaptureProfile(id),
          active: parsed.data.activate,
        });
      } catch {
        return reply.code(409).send({ code: 'CAPTURE_PROFILE_CONFLICT' });
      }
    });
    app.post(
      '/api/v1/privacy/capture-profiles/:id/activate',
      async (request, reply) => {
        const parsed = z
          .object({ id: z.string().min(1).max(128) })
          .safeParse(request.params);
        if (!parsed.success)
          return reply.code(400).send({ code: 'INVALID_CAPTURE_PROFILE' });
        const profile = storage.getCaptureProfile(parsed.data.id);
        if (!profile) return reply.code(404).send({ code: 'NOT_FOUND' });
        try {
          const policy = await persistCapturePolicy(
            stateDir,
            profile.mode,
            profile.settings,
          );
          return { profile, policy, active: true };
        } catch {
          return reply.code(400).send({ code: 'INVALID_CAPTURE_PROFILE' });
        }
      },
    );
    app.get('/api/v1/privacy/retention', async () => ({
      policies: storage.listRetentionPolicies(),
    }));
    app.post('/api/v1/privacy/retention', async (request, reply) => {
      const parsed = retentionPolicySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_RETENTION_POLICY' });
      try {
        const id = parsed.data.id ?? randomUUID();
        storage.createRetentionPolicy({
          id,
          name: parsed.data.name,
          retentionDays: parsed.data.retentionDays,
          ...(parsed.data.maxSessions === undefined
            ? {}
            : { maxSessions: parsed.data.maxSessions }),
        });
        const before = new Date(
          clock.now().getTime() - parsed.data.retentionDays * 86_400_000,
        ).toISOString();
        const eligible = storage.countRetentionEligible(
          before,
          parsed.data.maxSessions,
        );
        const removed = parsed.data.apply
          ? storage.applyRetention(before, parsed.data.maxSessions)
          : 0;
        return reply.code(201).send({
          policy: storage
            .listRetentionPolicies()
            .find((item) => item.id === id),
          preview: {
            before,
            eligibleSessions: eligible,
            appliedSessions: removed,
          },
        });
      } catch {
        return reply.code(409).send({ code: 'RETENTION_POLICY_CONFLICT' });
      }
    });
    const sessionId = (request: { params: unknown }): string | undefined => {
      const parsed = z
        .object({ id: sessionIdSchema })
        .safeParse(request.params);
      return parsed.success ? parsed.data.id : undefined;
    };
    app.get('/api/v1/sessions', async (request, reply) => {
      const parsed = sessionListQuerySchema.safeParse(request.query);
      return parsed.success
        ? {
            sessions: storage.listSessions(false, parsed.data.limit, {
              project: parsed.data.project,
              model: parsed.data.model,
              result: parsed.data.result,
              category: parsed.data.category,
              captureMode: parsed.data.captureMode,
            }),
          }
        : reply.code(400).send({ code: 'INVALID_QUERY' });
    });
    app.get('/api/v1/sessions/:id', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      const session = storage.getSession(id);
      return session
        ? { session }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.delete('/api/v1/sessions/:id', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.deleteSession(id)
        ? reply.code(204).send()
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    const evalCaseId = (request: { params: unknown }): string | undefined => {
      const parsed = z
        .object({ id: z.string().uuid() })
        .strict()
        .safeParse(request.params);
      return parsed.success ? parsed.data.id : undefined;
    };
    const evalRunId = (request: { params: unknown }): string | undefined => {
      const parsed = z
        .object({ id: z.string().uuid() })
        .strict()
        .safeParse(request.params);
      return parsed.success ? parsed.data.id : undefined;
    };
    const evalComparisonId = (request: {
      params: unknown;
    }): string | undefined => {
      const parsed = z
        .object({ id: z.string().uuid() })
        .strict()
        .safeParse(request.params);
      return parsed.success ? parsed.data.id : undefined;
    };
    const loadEvalManifest = async (id: string): Promise<EvalManifest> => {
      const stored = storage.getEvalCase(id);
      if (!stored) throw new Error('Evaluation case was not found.');
      const stream = await storage.blobs.open(stored.manifestBlobHash);
      const bytes = await readBoundedBlob(stream, 2 * 1024 * 1024);
      const manifest = parseEvalManifest(JSON.parse(bytes.toString('utf8')));
      if (hashEvalJson(manifest) !== stored.manifestHash)
        throw new Error('Evaluation manifest integrity check failed.');
      return manifest;
    };
    app.get('/api/v1/eval/cases', async (request, reply) => {
      const parsed = z
        .object({
          limit: z.coerce.number().int().min(1).max(10_000).default(500),
        })
        .strict()
        .safeParse(request.query);
      return parsed.success
        ? { cases: storage.listEvalCases(parsed.data.limit) }
        : reply.code(400).send({ code: 'INVALID_QUERY' });
    });
    app.post('/api/v1/eval/cases', async (request, reply) => {
      const parsed = evalManifestCreateSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_EVAL_MANIFEST' });
      let manifest: EvalManifest;
      try {
        manifest = parseEvalManifest(parsed.data.manifest);
      } catch {
        return reply.code(400).send({ code: 'INVALID_EVAL_MANIFEST' });
      }
      try {
        const blob = await storage.blobs.put(
          Readable.from([Buffer.from(JSON.stringify(manifest), 'utf8')]),
        );
        storage.recordBlob(blob);
        const id = storage.createEvalCase({
          id: manifest.id,
          name: manifest.name,
          manifestBlobHash: blob.address,
          manifestHash: hashEvalJson(manifest),
          schemaVersion: manifest.schemaVersion,
          ...(manifest.sourceSessionId
            ? { sourceSessionId: manifest.sourceSessionId }
            : {}),
        });
        return reply.code(201).send({ case: storage.getEvalCase(id) });
      } catch {
        return reply.code(409).send({ code: 'EVAL_CASE_CONFLICT' });
      }
    });
    app.post('/api/v1/eval/cases/from-session/:id', async (request, reply) => {
      const sessionId = sessionIdSchema.safeParse(
        (request.params as { id?: unknown }).id,
      );
      const parsed = evalManifestFromSessionSchema.safeParse(request.body);
      if (!sessionId.success || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_EVAL_SOURCE_SESSION' });
      const session = storage.getSession(sessionId.data);
      if (!session) return reply.code(404).send({ code: 'NOT_FOUND' });
      if (!session.baseCommit)
        return reply.code(409).send({ code: 'EVAL_BASE_COMMIT_REQUIRED' });
      const events: TraceEvent[] = [];
      let cursor: { afterSequence: number; afterId: string } | undefined;
      do {
        const page = storage.listEvents({
          sessionId: sessionId.data,
          limit: 10_000,
          ...(cursor ?? {}),
        });
        events.push(...page.map((item) => item.event));
        if (events.length > 20_000)
          return reply.code(413).send({ code: 'EVAL_SOURCE_EVENT_LIMIT' });
        const last = page.at(-1);
        cursor =
          page.length === 10_000 && last
            ? { afterSequence: last.sequence, afterId: last.id }
            : undefined;
      } while (cursor);
      if (events.length === 0)
        return reply.code(409).send({ code: 'EVAL_SOURCE_HAS_NO_EVENTS' });
      let successAssertions:
        readonly z.infer<typeof SuccessAssertionSchema>[] | undefined;
      try {
        successAssertions = parsed.data.successAssertions?.map((assertion) =>
          SuccessAssertionSchema.parse(assertion),
        );
      } catch {
        return reply.code(400).send({ code: 'INVALID_EVAL_ASSERTIONS' });
      }
      let manifest: EvalManifest;
      try {
        manifest = manifestFromSession({
          id: randomUUID(),
          name: parsed.data.name,
          sessionId: session.id,
          repository: { baseCommit: session.baseCommit },
          events,
          ...(session.runFingerprint
            ? { runFingerprint: session.runFingerprint }
            : {}),
          ...(successAssertions ? { successAssertions } : {}),
        });
      } catch {
        return reply.code(400).send({ code: 'INVALID_EVAL_MANIFEST' });
      }
      try {
        const blob = await storage.blobs.put(
          Readable.from([Buffer.from(JSON.stringify(manifest), 'utf8')]),
        );
        storage.recordBlob(blob);
        const id = storage.createEvalCase({
          id: manifest.id,
          name: manifest.name,
          manifestBlobHash: blob.address,
          manifestHash: hashEvalJson(manifest),
          schemaVersion: manifest.schemaVersion,
          ...(manifest.sourceSessionId
            ? { sourceSessionId: manifest.sourceSessionId }
            : {}),
        });
        return reply.code(201).send({
          case: storage.getEvalCase(id),
          manifest,
        });
      } catch {
        return reply.code(409).send({ code: 'EVAL_CASE_CONFLICT' });
      }
    });
    app.get('/api/v1/eval/cases/:id', async (request, reply) => {
      const id = evalCaseId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_EVAL_CASE_ID' });
      const value = storage.getEvalCase(id);
      return value
        ? { case: value }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/eval/cases/:id/manifest', async (request, reply) => {
      const id = evalCaseId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_EVAL_CASE_ID' });
      if (!storage.getEvalCase(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      try {
        return { manifest: await loadEvalManifest(id) };
      } catch {
        return reply
          .code(409)
          .send({ code: 'EVAL_MANIFEST_INTEGRITY_FAILURE' });
      }
    });
    app.get('/api/v1/eval/cases/:id/pre-task-patch', async (request, reply) => {
      const id = evalCaseId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_EVAL_CASE_ID' });
      if (!storage.getEvalCase(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      let manifest: EvalManifest;
      try {
        manifest = await loadEvalManifest(id);
      } catch {
        return reply
          .code(409)
          .send({ code: 'EVAL_MANIFEST_INTEGRITY_FAILURE' });
      }
      const patchHash = manifest.repository.preTaskPatchBlobHash;
      if (!patchHash)
        return reply.code(404).send({ code: 'PRE_TASK_PATCH_NOT_FOUND' });
      try {
        const patch = await readBoundedBlob(
          await storage.blobs.open(patchHash),
          16 * 1024 * 1024,
        );
        const expected = manifest.repository.preTaskPatchSha256;
        if (
          !expected ||
          createHash('sha256').update(patch).digest('hex') !== expected
        )
          return reply
            .code(409)
            .send({ code: 'PRE_TASK_PATCH_INTEGRITY_FAILURE' });
        return reply
          .header('cache-control', 'no-store')
          .header(
            'content-disposition',
            'attachment; filename="pre-task.patch"',
          )
          .header('x-content-type-options', 'nosniff')
          .type('application/octet-stream')
          .send(patch);
      } catch {
        return reply.code(404).send({ code: 'PRE_TASK_PATCH_NOT_FOUND' });
      }
    });
    app.post('/api/v1/eval/cases/:id/runs', async (request, reply) => {
      const id = evalCaseId(request);
      const parsed = evalRunCreateSchema.safeParse(request.body);
      if (!id || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_EVAL_RUN' });
      if (!storage.getEvalCase(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const configuration = parsed.data.configuration as JsonObject;
      const runId = storage.upsertEvalRun({
        id: parsed.data.id ?? randomUUID(),
        evalCaseId: id,
        configuration,
        configurationHash: hashEvalJson(configuration),
        worktreeFingerprintHash: parsed.data.worktreeFingerprintHash,
        status: parsed.data.status,
        ...(parsed.data.sourceSessionId
          ? { sourceSessionId: parsed.data.sourceSessionId }
          : {}),
      });
      return reply.code(201).send({ run: storage.getEvalRun(runId) });
    });
    app.get('/api/v1/eval/runs/:id', async (request, reply) => {
      const id = evalRunId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_EVAL_RUN_ID' });
      const run = storage.getEvalRun(id);
      return run ? { run } : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.patch('/api/v1/eval/runs/:id', async (request, reply) => {
      const id = evalRunId(request);
      const parsed = evalRunUpdateSchema.safeParse(request.body);
      if (!id || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_EVAL_RUN_UPDATE' });
      try {
        storage.updateEvalRun(id, parsed.data as EvalRunUpdate);
        return { run: storage.getEvalRun(id) };
      } catch {
        return reply.code(404).send({ code: 'NOT_FOUND' });
      }
    });
    app.post('/api/v1/eval/runs/:id/output', async (request, reply) => {
      const id = evalRunId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_EVAL_RUN_ID' });
      if (!storage.getEvalRun(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength > 16 * 1024 * 1024)
        return reply.code(400).send({ code: 'INVALID_EVAL_OUTPUT' });
      try {
        const blob = await storage.blobs.put(Readable.from([body]));
        storage.recordBlob(blob);
        storage.updateEvalRun(id, { outputBlobHash: blob.address });
        return { run: storage.getEvalRun(id) };
      } catch {
        return reply.code(400).send({ code: 'INVALID_EVAL_OUTPUT' });
      }
    });
    app.post('/api/v1/eval/runs/:id/events', async (request, reply) => {
      const id = evalRunId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_EVAL_RUN_ID' });
      const run = storage.getEvalRun(id);
      if (!run) return reply.code(404).send({ code: 'NOT_FOUND' });
      const parsed = evalEventCaptureSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.events.length === 0)
        return reply.code(400).send({ code: 'INVALID_EVAL_EVENTS' });
      const events = [...parsed.data.events].sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id),
      );
      const sessionId = events[0]!.sessionId;
      if (events.some((event) => event.sessionId !== sessionId))
        return reply.code(400).send({ code: 'EVAL_EVENTS_MIXED_SESSIONS' });
      if (run.sourceSessionId && run.sourceSessionId !== sessionId)
        return reply.code(409).send({ code: 'EVAL_SESSION_ID_CONFLICT' });
      const evalCase = storage.getEvalCase(run.evalCaseId);
      if (!evalCase) return reply.code(404).send({ code: 'NOT_FOUND' });
      const projectId = `eval-project:${run.evalCaseId}`;
      const sourceSessionId = `eval-run:${id}`;
      const first = events[0]!;
      const last = events.at(-1)!;
      const completed = last.type === 'session.completed';
      try {
        for (const event of events) {
          storage.importEvent({
            project: {
              id: projectId,
              displayName: `Evaluation · ${evalCase.name}`,
            },
            session: {
              id: sessionId,
              projectId,
              source: 'vibetrace-eval',
              sourceSessionId,
              startedAt: first.timestamp,
              ...(completed ? { endedAt: last.timestamp } : {}),
              status: completed ? 'completed' : 'active',
              captureMode: event.provenance.captureMode,
              ...(event.model ? { model: event.model } : {}),
              ...(event.provenance.sourceVersion
                ? { sourceVersion: event.provenance.sourceVersion }
                : {}),
            },
            raw: {
              adapter: event.provenance.adapter,
              adapterVersion: event.provenance.adapterVersion,
              ...(event.provenance.sourceVersion
                ? { sourceVersion: event.provenance.sourceVersion }
                : {}),
              sourceSessionId,
              ...(event.turnId ? { sourceTurnId: event.turnId } : {}),
              sourceEventId: event.sourceEventId ?? event.id,
              receivedAt: event.timestamp,
              payload: event.rawPayload,
            },
            event,
            normalizerId: `eval/${event.provenance.adapter}/${event.provenance.adapterVersion}`,
          });
        }
        try {
          analyzeAndPersist(storage, sessionId);
        } catch {
          // Capture must remain durable even if a future rule rejects a stream.
        }
        const latestRun = storage.getEvalRun(id);
        storage.updateEvalRun(id, {
          sourceSessionId: sessionId,
          metrics: {
            ...(latestRun?.metrics ?? {}),
            ...evalEventMetrics(events),
            findingCount: storage.listFindings(sessionId).length,
          },
        });
        return {
          imported: events.length,
          sessionId,
          run: storage.getEvalRun(id),
        };
      } catch {
        return reply.code(409).send({ code: 'EVAL_EVENT_IMPORT_CONFLICT' });
      }
    });
    app.post('/api/v1/eval/comparisons', async (request, reply) => {
      const parsed = evalComparisonCreateSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_EVAL_COMPARISON' });
      if (!storage.getEvalCase(parsed.data.evalCaseId))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const configuration = parsed.data.configuration as JsonObject;
      if (!ComparisonMatrixConfigurationSchema.safeParse(configuration).success)
        return reply.code(400).send({ code: 'INVALID_EVAL_MATRIX' });
      try {
        const id = storage.createEvalComparison({
          id: parsed.data.id ?? randomUUID(),
          evalCaseId: parsed.data.evalCaseId,
          name: parsed.data.name,
          configuration,
        });
        return reply
          .code(201)
          .send({ comparison: storage.getEvalComparison(id) });
      } catch {
        return reply.code(409).send({ code: 'EVAL_COMPARISON_CONFLICT' });
      }
    });
    app.get('/api/v1/eval/comparisons/:id', async (request, reply) => {
      const id = evalComparisonId(request);
      if (!id)
        return reply.code(400).send({ code: 'INVALID_EVAL_COMPARISON_ID' });
      const comparison = storage.getEvalComparison(id);
      if (!comparison) return reply.code(404).send({ code: 'NOT_FOUND' });
      const results = storage.listEvalComparisonResults(id);
      const runs = results
        .map((result) => storage.getEvalRun(result.evalRunId))
        .filter((run): run is NonNullable<typeof run> => run !== undefined);
      const capturedStreams = runs
        .filter(
          (run): run is typeof run & { sourceSessionId: string } =>
            typeof run.sourceSessionId === 'string',
        )
        .map((run) => {
          const events: TraceEvent[] = [];
          let cursor: { afterSequence: number; afterId: string } | undefined;
          do {
            const page = storage.listEvents({
              sessionId: run.sourceSessionId,
              limit: 10_000,
              ...(cursor ?? {}),
            });
            events.push(...page.map((item) => item.event));
            const last = page.at(-1);
            cursor =
              page.length === 10_000 && last
                ? { afterSequence: last.sequence, afterId: last.id }
                : undefined;
          } while (cursor);
          return events;
        });
      const persisted = comparisonDivergence(results);
      const streamDivergence =
        persisted ??
        (capturedStreams.length >= 2
          ? firstDivergence(capturedStreams[0]!, capturedStreams[1]!)
          : undefined);
      return {
        comparison,
        results,
        runs,
        summary: summarizeRuns(runs, streamDivergence),
      };
    });
    app.post('/api/v1/eval/comparisons/:id/results', async (request, reply) => {
      const id = evalComparisonId(request);
      const parsed = evalComparisonResultSchema.safeParse(request.body);
      if (!id || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_EVAL_COMPARISON_RESULT' });
      if (!storage.getEvalComparison(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      try {
        storage.upsertEvalComparisonResult({
          comparisonId: id,
          evalRunId: parsed.data.evalRunId,
          ordinal: parsed.data.ordinal,
          result: parsed.data.result as JsonObject,
        });
        return {
          results: storage.listEvalComparisonResults(id),
        };
      } catch {
        return reply
          .code(409)
          .send({ code: 'EVAL_COMPARISON_RESULT_CONFLICT' });
      }
    });
    app.post(
      '/api/v1/eval/comparisons/:id/divergence',
      async (request, reply) => {
        const id = evalComparisonId(request);
        const parsed = evalComparisonDivergenceSchema.safeParse(request.body);
        if (!id || !parsed.success)
          return reply.code(400).send({ code: 'INVALID_EVAL_DIVERGENCE' });
        const comparison = storage.getEvalComparison(id);
        if (!comparison) return reply.code(404).send({ code: 'NOT_FOUND' });
        const results = storage.listEvalComparisonResults(id);
        const linked = new Map(
          results.map((result) => [result.evalRunId, result]),
        );
        const leftResult = linked.get(parsed.data.leftRunId);
        const rightResult = linked.get(parsed.data.rightRunId);
        if (!leftResult || !rightResult)
          return reply.code(409).send({ code: 'EVAL_RUN_NOT_IN_COMPARISON' });
        const leftEvents = parseComparisonEvents(parsed.data.leftEvents);
        const rightEvents = parseComparisonEvents(parsed.data.rightEvents);
        if (!leftEvents || !rightEvents)
          return reply.code(400).send({ code: 'INVALID_EVAL_EVENT_STREAM' });
        const divergence = firstDivergence(leftEvents, rightEvents);
        const persisted = divergence
          ? (JSON.parse(JSON.stringify(divergence)) as JsonObject)
          : null;
        storage.upsertEvalComparisonResult({
          comparisonId: id,
          evalRunId: parsed.data.leftRunId,
          ordinal: leftResult.ordinal,
          result: {
            ...leftResult.result,
            comparedWithRunId: parsed.data.rightRunId,
            firstDivergence: persisted,
          },
        });
        const updatedResults = storage.listEvalComparisonResults(id);
        const runs = updatedResults
          .map((result) => storage.getEvalRun(result.evalRunId))
          .filter((run): run is NonNullable<typeof run> => run !== undefined);
        return {
          firstDivergence: divergence ?? null,
          results: updatedResults,
          summary: summarizeRuns(runs, comparisonDivergence(updatedResults)),
        };
      },
    );
    app.get('/api/v1/sessions/:id/events', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const parsed = eventListQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_QUERY' });
      const events = storage.listEvents({
        sessionId: id,
        ...parsed.data,
      });
      const last = events.at(-1);
      return {
        events,
        ...(events.length === parsed.data.limit && last
          ? {
              nextCursor: {
                afterSequence: last.sequence,
                afterId: last.id,
              },
            }
          : {}),
      };
    });
    app.get('/api/v1/sessions/:id/events/stream', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const parsed = eventStreamQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_QUERY' });
      reply.hijack();
      reply.raw.writeHead(200, {
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      let cursor =
        parsed.data.afterSequence === undefined
          ? undefined
          : {
              afterSequence: parsed.data.afterSequence,
              afterId: parsed.data.afterId!,
            };
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      const poll = (): void => {
        if (closed) return;
        const events = storage.listEvents({
          sessionId: id,
          limit: parsed.data.limit,
          ...(cursor ?? {}),
        });
        const last = events.at(-1);
        for (const event of events) {
          reply.raw.write(
            `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        if (last) cursor = { afterSequence: last.sequence, afterId: last.id };
        reply.raw.write(`: heartbeat ${clock.now().toISOString()}\n\n`);
        if (parsed.data.once) finish();
      };
      const timer = setInterval(poll, 1_000);
      timer.unref();
      request.raw.once('close', finish);
      poll();
      setTimeout(finish, 60_000).unref();
    });
    app.get('/api/v1/sessions/:id/events/search', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const parsed = eventSearchQuerySchema.safeParse(request.query);
      return parsed.success
        ? {
            events: storage.searchEvents(id, parsed.data.q, parsed.data.limit),
          }
        : reply.code(400).send({ code: 'INVALID_QUERY' });
    });
    app.get('/api/v1/sessions/:id/artifacts', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.getSession(id)
        ? { artifacts: storage.listArtifacts(id) }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get(
      '/api/v1/sessions/:id/artifacts/:artifactId/content',
      async (request, reply) => {
        const parsed = z
          .object({
            id: sessionIdSchema,
            artifactId: z.string().min(1).max(256),
          })
          .strict()
          .safeParse(request.params);
        if (!parsed.success)
          return reply.code(400).send({ code: 'INVALID_ARTIFACT_ID' });
        const artifact = storage.getArtifact(
          parsed.data.id,
          parsed.data.artifactId,
        );
        if (!artifact?.blobHash)
          return reply.code(404).send({ code: 'NOT_FOUND' });
        const candidate = artifact.metadata.mediaType;
        const normalized =
          typeof candidate === 'string' ? candidate.toLowerCase() : '';
        const inline = SAFE_ARTIFACT_MEDIA_TYPES.has(normalized);
        const mediaType = inline ? normalized : 'application/octet-stream';
        const stream = await storage.blobs.open(artifact.blobHash);
        return reply
          .header('cache-control', 'no-store')
          .header(
            'content-disposition',
            inline ? 'inline' : 'attachment; filename="vibetrace-artifact"',
          )
          .header('x-content-type-options', 'nosniff')
          .type(mediaType)
          .send(stream);
      },
    );
    app.get('/api/v1/sessions/:id/coverage', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const events: StoredNormalizedEvent[] = [];
      let cursor: { afterSequence: number; afterId: string } | undefined;
      do {
        const page = storage.listEvents({
          sessionId: id,
          limit: 10_000,
          ...(cursor ?? {}),
        });
        events.push(...page);
        const last = page.at(-1);
        cursor =
          page.length === 10_000 && last
            ? { afterSequence: last.sequence, afterId: last.id }
            : undefined;
      } while (cursor);
      return { coverage: deriveCaptureCoverage(events) };
    });
    app.get('/api/v1/sessions/:id/findings', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.getSession(id)
        ? { findings: storage.listFindings(id) }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/sessions/:id/scorecard', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const events: StoredNormalizedEvent[] = [];
      let cursor: { afterSequence: number; afterId: string } | undefined;
      do {
        const page = storage.listEvents({
          sessionId: id,
          limit: 10_000,
          ...(cursor ?? {}),
        });
        events.push(...page);
        const last = page.at(-1);
        cursor =
          page.length === 10_000 && last
            ? { afterSequence: last.sequence, afterId: last.id }
            : undefined;
      } while (cursor);
      if (events.length === 0)
        return reply.code(409).send({ code: 'SESSION_HAS_NO_EVENTS' });
      return {
        scorecard: buildSessionScorecard(
          events.map((item) => item.event),
          storage.listFindings(id),
        ),
      };
    });
    app.post('/api/v1/sessions/:id/analyze', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const events = storage.listEvents({ sessionId: id, limit: 1 });
      if (events.length === 0)
        return reply.code(409).send({ code: 'SESSION_HAS_NO_EVENTS' });
      return { analysis: analyzeAndPersist(storage, id) };
    });
    app.post('/api/v1/sessions/:id/ai-findings', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const parsed = aiFindingSubmissionSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_AI_FINDINGS' });
      const events: StoredNormalizedEvent[] = [];
      let cursor: { afterSequence: number; afterId: string } | undefined;
      do {
        const page = storage.listEvents({
          sessionId: id,
          limit: 10_000,
          ...(cursor ?? {}),
        });
        events.push(...page);
        const last = page.at(-1);
        cursor =
          page.length === 10_000 && last
            ? { afterSequence: last.sequence, afterId: last.id }
            : undefined;
        if (events.length > 20_000)
          return reply.code(413).send({ code: 'AI_EVIDENCE_LIMIT' });
      } while (cursor);
      let verifiedHypotheses;
      try {
        verifiedHypotheses = verifyHypotheses(
          { sessionId: id, events: events.map((item) => item.event) },
          parsed.data.hypotheses,
        );
      } catch {
        return reply.code(400).send({ code: 'AI_EVIDENCE_INVALID' });
      }
      const findings = verifiedHypotheses.map((hypothesis) => ({
        id: createUuidV5([
          'vibetrace/ai-finding/0.1',
          id,
          parsed.data.promptDigest,
          hypothesis.id,
        ]),
        sessionId: id,
        ruleId: 'ai-analyzer',
        detectorVersion: parsed.data.analyzerVersion,
        category: hypothesis.category,
        severity: hypothesis.confidence >= 0.8 ? 'high' : 'medium',
        confidence: hypothesis.confidence,
        title: hypothesis.title,
        explanation: hypothesis.explanation,
        recommendation:
          hypothesis.recommendation ??
          hypothesis.recommendedExperiment ??
          'Review the linked evidence before acting on this hypothesis.',
        evidenceEventIds: hypothesis.evidenceEventIds,
        counterevidenceEventIds: hypothesis.counterEvidenceEventIds,
        state: 'open',
      }));
      try {
        storage.replaceFindings(id, ['ai-analyzer'], findings);
        return {
          analysis: {
            analyzerVersion: parsed.data.analyzerVersion,
            promptDigest: parsed.data.promptDigest,
            hypotheses: findings,
          },
        };
      } catch {
        return reply.code(400).send({ code: 'INVALID_AI_EVIDENCE' });
      }
    });
    app.patch('/api/v1/findings/:id/review', async (request, reply) => {
      const params = z
        .object({ id: z.string().min(1).max(128) })
        .strict()
        .safeParse(request.params);
      const body = findingReviewSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ code: 'INVALID_FINDING_REVIEW' });
      return storage.reviewFinding(params.data.id, body.data)
        ? { finding: params.data.id, review: body.data }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/annotations', async (request, reply) => {
      const parsed = annotationListQuerySchema.safeParse(request.query);
      return parsed.success
        ? {
            annotations: storage.listAnnotations(
              parsed.data.targetType,
              parsed.data.targetId,
            ),
          }
        : reply.code(400).send({ code: 'INVALID_QUERY' });
    });
    app.post('/api/v1/annotations', async (request, reply) => {
      const parsed = annotationSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_ANNOTATION' });
      const annotation = {
        id: randomUUID(),
        ...parsed.data,
        createdAt: clock.now().toISOString(),
      };
      storage.createAnnotation(annotation);
      return reply.code(201).send({ annotation });
    });
    app.patch('/api/v1/annotations/:id', async (request, reply) => {
      const parsed = annotationSchema
        .pick({ label: true, note: true })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_ANNOTATION' });
      return storage.updateAnnotation(
        (request.params as { id: string }).id,
        parsed.data,
      )
        ? { ok: true }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.delete('/api/v1/annotations/:id', async (request, reply) =>
      storage.deleteAnnotation((request.params as { id: string }).id)
        ? reply.code(204).send()
        : reply.code(404).send({ code: 'NOT_FOUND' }),
    );
    app.post('/api/v1/exports/preview', async (request, reply) => {
      const parsed = bundlePreviewSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_BUNDLE_REQUEST' });
      try {
        return {
          preview: await bundleOperations.preview(
            storage,
            parsed.data.sessionId,
            parsed.data.profile,
          ),
        };
      } catch (error) {
        const failure = bundleFailure(error);
        return reply.code(failure.status).send({ code: failure.code });
      }
    });
    app.post('/api/v1/exports', async (request, reply) => {
      const parsed = bundleExportSchema.safeParse(request.body);
      if (!parsed.success || !isAbsolute(parsed.data.destination))
        return reply.code(400).send({ code: 'INVALID_BUNDLE_REQUEST' });
      try {
        const preview = await bundleOperations.export(storage, parsed.data);
        return {
          bundle: {
            destination: parsed.data.destination,
            manifestHash: preview.manifestHash,
            manifest: preview.manifest,
          },
        };
      } catch (error) {
        const failure = bundleFailure(error);
        return reply.code(failure.status).send({ code: failure.code });
      }
    });
    app.post('/api/v1/imports', async (request, reply) => {
      const parsed = bundleImportSchema.safeParse(request.body);
      if (!parsed.success || !isAbsolute(parsed.data.source))
        return reply.code(400).send({ code: 'INVALID_BUNDLE_REQUEST' });
      try {
        return {
          import: await bundleOperations.import(storage, parsed.data),
        };
      } catch (error) {
        const failure = bundleFailure(error);
        return reply.code(failure.status).send({ code: failure.code });
      }
    });
    let shutdownOnce: Promise<void> | undefined;
    app.post('/api/v1/admin/shutdown', async (request, reply) => {
      const supplied = bearer(request.headers.authorization);
      if (!supplied || !constantTimeEquals(supplied, token))
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      shutdownOnce ??= new Promise((resolve) =>
        setImmediate(() => {
          void close().finally(resolve);
        }),
      );
      return reply.code(202).send({ ok: true });
    });
    const serveDashboard = async (
      request: { cookies: Record<string, string | undefined> },
      reply: {
        sendFile(name: string): unknown;
        type(mediaType: string): { send(body: string): unknown };
      },
    ) => {
      if (sessions.has(request.cookies.vibetrace_session ?? ''))
        if (dashboardAvailable) return reply.sendFile('index.html');
      if (sessions.has(request.cookies.vibetrace_session ?? ''))
        return reply
          .type('text/html')
          .send(
            '<!doctype html><meta charset="utf-8">Dashboard assets unavailable.',
          );
      return reply
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><script>const p=new URLSearchParams(location.search),h=p.get("handoff");if(h){fetch("/api/v1/auth/browser-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({handoffToken:h})}).then(r=>{if(r.ok)location.replace(location.pathname+location.hash)})}</script>',
        );
    };
    app.get('/', serveDashboard);
    app.get('/sessions/*', serveDashboard);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL(address);
    const descriptor = {
      pid: process.pid,
      port: Number(url.port),
      origin: `http://127.0.0.1:${url.port}`,
      instanceId,
      apiVersion: API_VERSION,
      startedAt: clock.now().toISOString(),
    };
    origin = descriptor.origin;
    await writeAtomic(
      join(stateDir, 'daemon.json'),
      `${JSON.stringify(descriptor)}\n`,
      0o600,
    );
    let closeOnce: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closeOnce ??= (async () => {
        if (importTimer) clearInterval(importTimer);
        await importing;
        await app?.close();
        const current = await readDescriptor(stateDir);
        if (current?.instanceId === instanceId) {
          await rm(join(stateDir, 'daemon.json'), { force: true });
          await rm(join(stateDir, 'daemon.lock'), {
            force: true,
            recursive: true,
          });
        }
        if (ownStorage) storage.close();
      })());
    return { app, descriptor, stateDir, token, close };
  } catch (error) {
    if (importTimer) clearInterval(importTimer);
    await app?.close();
    await rm(lockPath, { force: true, recursive: true });
    if (ownStorage) openedStorage?.close();
    throw error;
  }
}

/** Run the importer once. A caller can schedule this without changing its safety properties. */
export async function importSpool(
  storage: Storage,
  stateDir: string,
  faults?: SpoolImportOptions,
): Promise<{ readonly imported: number; readonly quarantined: number }> {
  return importSegments(storage, spoolPaths(resolveStateDir(stateDir)), faults);
}
