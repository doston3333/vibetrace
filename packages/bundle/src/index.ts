import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  RunFingerprintSchema,
  TraceEventSchema,
  createUuidV5,
  type JsonObject,
  type JsonValue,
  type TraceEvent,
} from '@vibetrace/schema';
import {
  Storage,
  StorageImportConflictError,
  type AnnotationInput,
  type ArtifactInput,
  type BlobInfo,
  type FindingInput,
  type SessionInput,
} from '@vibetrace/storage';
import { z } from 'zod';

import {
  BundleRecordHeaderSchema,
  DEFAULT_BUNDLE_LIMITS,
  decryptRecordStream,
  encryptRecordStream,
  readBoundedJson,
  type BundleLimits,
  type BundleRecordHeader,
  type ExtractedRecord,
  type PreparedRecord,
} from './codec.js';
import {
  CustomProfileRulesSchema,
  ExportProfileSchema,
  redactArtifactText,
  redactEvent,
  redactJson,
  type ExportProfile,
  type RedactionRecord,
  type ResolvedExportProfile,
} from './redaction.js';

export {
  BundleRecordHeaderSchema,
  CustomProfileRulesSchema,
  DEFAULT_BUNDLE_LIMITS,
  ExportProfileSchema,
  redactArtifactText,
  redactEvent,
  redactJson,
  type BundleLimits,
  type ExportProfile,
  type RedactionRecord,
  type ResolvedExportProfile,
};

export const BUNDLE_FORMAT = 'vibetrace-portable' as const;
export const BUNDLE_VERSION = 1 as const;
const BUNDLE_ADAPTER_VERSION = '0.1.0';
const MAX_JSON_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_LINE_CHARS = 1024 * 1024;

class UnsafeTextArtifactError extends Error {}

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
const redactionSchema = z
  .object({
    path: z.string().min(1),
    detector: z.string().min(1),
    replacement: z.string(),
  })
  .strict();
const manifestRecordSchema = BundleRecordHeaderSchema.omit({ entryType: true });
const manifestEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().min(1),
    includedFields: z.array(z.string().min(1)),
    omittedFields: z.array(z.string().min(1)),
    redactions: z.array(redactionSchema),
  })
  .strict();
const manifestArtifactSchema = z
  .object({
    id: z.string().min(1).max(512),
    kind: z.string().min(1).max(256),
    eventId: z.string().uuid().optional(),
    metadata: jsonObjectSchema,
    included: z.boolean(),
    reason: z.string().min(1).optional(),
    recordPath: z.string().min(1).optional(),
    byteLength: z.number().int().nonnegative().optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    redactions: z.array(redactionSchema),
  })
  .strict();
const bundleSessionSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1),
    source: z.string().min(1),
    sourceSessionId: z.string().min(1),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().optional(),
    status: z.string().min(1),
    captureMode: z.string().min(1),
    title: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    sourceVersion: z.string().min(1).optional(),
    baseCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    finalCommit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    runFingerprint: RunFingerprintSchema.optional(),
  })
  .strict();

export const BundleManifestSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    version: z.literal(BUNDLE_VERSION),
    schemaVersion: z.literal('0.1.0'),
    bundleId: z.string().uuid(),
    profile: z
      .object({
        kind: z.enum(['metadata-only', 'share-safe', 'custom']),
        id: z.string().min(1).optional(),
        name: z.string().min(1),
        base: z.enum(['metadata-only', 'share-safe']),
      })
      .strict(),
    project: z
      .object({ id: z.string().min(1), displayName: z.string().min(1) })
      .strict(),
    session: bundleSessionSchema,
    records: z.array(manifestRecordSchema).max(100_000),
    events: z.array(manifestEventSchema).max(100_000),
    artifacts: z.array(manifestArtifactSchema).max(100_000),
    metadataRedactions: z.array(redactionSchema).max(10_000),
    findingCount: z.number().int().nonnegative(),
    annotationCount: z.number().int().nonnegative(),
    omissions: z.array(z.string().min(1)),
  })
  .strict();
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

const findingSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().uuid(),
    ruleId: z.string().min(1),
    detectorVersion: z.string().min(1),
    category: z.string().min(1),
    severity: z.string().min(1),
    confidence: z.number().finite().optional(),
    title: z.string().min(1),
    explanation: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceEventIds: z.array(z.string().uuid()).min(1),
    counterevidenceEventIds: z.array(z.string().uuid()).optional(),
    state: z.string().min(1).optional(),
    review: z
      .object({
        decision: z.enum(['open', 'confirmed', 'rejected']).optional(),
        categoryOverride: z.string().min(1).optional(),
        note: z.string().optional(),
        updatedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
const annotationSchema = z
  .object({
    id: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    createdAt: z.iso.datetime(),
    label: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

export interface BundlePreview {
  readonly manifestHash: string;
  readonly manifest: BundleManifest;
}

export interface ExportBundleOptions {
  readonly sessionId: string;
  readonly profile: ExportProfile;
  readonly destination: string;
  readonly passphrase: string;
  readonly expectedManifestHash?: string;
  readonly temporaryRoot?: string;
}

export interface ImportBundleOptions {
  readonly source: string;
  readonly passphrase: string;
  readonly limits?: BundleLimits;
  readonly temporaryRoot?: string;
}

export interface BundleImportResult {
  readonly manifestHash: string;
  readonly sessionId: string;
  readonly imported: boolean;
  readonly eventCount: number;
  readonly artifactCount: number;
}

interface PreparedBundle {
  readonly directory: string;
  readonly records: readonly PreparedRecord[];
  readonly preview: BundlePreview;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function fileRecord(
  kind: BundleRecordHeader['kind'],
  path: string,
  contentPath: string,
): Promise<PreparedRecord> {
  const digest = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(contentPath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    digest.update(buffer);
  }
  return {
    header: {
      version: 1,
      entryType: 'file',
      kind,
      path,
      byteLength,
      sha256: digest.digest('hex'),
    },
    contentPath,
  };
}

async function writeStableJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(stableJson(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveProfile(
  storage: Storage,
  input: ExportProfile,
): ResolvedExportProfile {
  const profile = ExportProfileSchema.parse(input);
  if (profile.kind === 'metadata-only')
    return {
      kind: profile.kind,
      name: 'Metadata only',
      base: 'metadata-only',
      restorePointers: new Set(),
      redactPointers: new Set(),
      includeArtifacts: false,
      includeBinaryArtifacts: false,
      artifactDenyIds: new Set(),
    };
  if (profile.kind === 'share-safe')
    return {
      kind: profile.kind,
      name: 'Share safe',
      base: 'share-safe',
      restorePointers: new Set(profile.restorePointers),
      redactPointers: new Set(),
      includeArtifacts: true,
      includeBinaryArtifacts: false,
      artifactDenyIds: new Set(),
    };
  const stored = storage.getRedactionProfile(profile.id);
  if (!stored) throw new Error('Custom redaction profile was not found.');
  const rules = CustomProfileRulesSchema.parse(stored.rules);
  return {
    kind: profile.kind,
    id: stored.id,
    name: stored.name,
    base: rules.base,
    restorePointers: new Set([
      ...rules.restorePointers,
      ...profile.restorePointers,
    ]),
    redactPointers: new Set(rules.redactPointers),
    includeArtifacts: rules.base === 'share-safe' && rules.includeArtifacts,
    includeBinaryArtifacts: rules.includeBinaryArtifacts,
    ...(rules.artifactAllowIds
      ? { artifactAllowIds: new Set(rules.artifactAllowIds) }
      : {}),
    artifactDenyIds: new Set(rules.artifactDenyIds),
  };
}

function isTextArtifact(artifact: ArtifactInput): boolean {
  const candidate = artifact.metadata.mediaType;
  const mediaType =
    typeof candidate === 'string' ? candidate.toLowerCase() : '';
  if (
    mediaType.startsWith('text/') ||
    ['application/json', 'application/x-ndjson'].includes(mediaType)
  )
    return true;
  return /(?:output|diff|patch|log|json|text|test|lint|build|typecheck)/i.test(
    artifact.kind,
  );
}

async function writeBinaryArtifact(
  source: Readable,
  destination: string,
): Promise<void> {
  const handle = await open(destination, 'wx', 0o600);
  try {
    for await (const chunk of source)
      await handle.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTextArtifact(
  source: Readable,
  destination: string,
  profile: ResolvedExportProfile,
  artifactId: string,
): Promise<readonly RedactionRecord[]> {
  const handle = await open(destination, 'wx', 0o600);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records = new Map<string, RedactionRecord>();
  let pending = '';
  let inPrivateKey = false;
  const write = async (value: string): Promise<void> => {
    if (value.length > 0) await handle.write(Buffer.from(value, 'utf8'));
  };
  const merge = (items: readonly RedactionRecord[]): void => {
    for (const item of items)
      records.set(`${item.path}\0${item.detector}`, item);
  };
  const process = async (value: string): Promise<void> => {
    const begin = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/.exec(value);
    if (inPrivateKey) {
      if (/-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(value))
        inPrivateKey = false;
      return;
    }
    if (begin) {
      const before = value.slice(0, begin.index);
      const redactedBefore = redactArtifactText(before, profile, artifactId);
      merge(redactedBefore.redactions);
      await write(redactedBefore.value);
      const record = {
        path: `/artifacts/${artifactId}/content`,
        detector: 'private-key',
        replacement: '[REDACTED:private-key]',
      };
      merge([record]);
      await write(`${record.replacement}${value.endsWith('\n') ? '\n' : ''}`);
      if (
        !/-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(
          value.slice(begin.index),
        )
      )
        inPrivateKey = true;
      return;
    }
    const result = redactArtifactText(value, profile, artifactId);
    merge(result.redactions);
    await write(result.value);
  };
  try {
    for await (const chunk of source) {
      pending += decoder.decode(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        { stream: true },
      );
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        await process(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_ARTIFACT_LINE_CHARS)
        throw new UnsafeTextArtifactError(
          'Artifact contains an oversized line that cannot be safely redacted.',
        );
    }
    pending += decoder.decode();
    await process(pending);
    await handle.sync();
    return [...records.values()].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.detector.localeCompare(right.detector),
    );
  } finally {
    await handle.close();
  }
}

function artifactAllowed(
  artifact: ArtifactInput,
  profile: ResolvedExportProfile,
): boolean {
  return (
    profile.includeArtifacts &&
    !profile.artifactDenyIds.has(artifact.id) &&
    (!profile.artifactAllowIds || profile.artifactAllowIds.has(artifact.id))
  );
}

async function prepareBundle(
  storage: Storage,
  sessionId: string,
  profileInput: ExportProfile,
  temporaryRoot?: string,
): Promise<PreparedBundle> {
  const session = storage.getSession(sessionId);
  if (!session) throw new Error('Session was not found.');
  const profile = resolveProfile(storage, profileInput);
  const directory = await mkdtemp(
    join(temporaryRoot ?? tmpdir(), 'vibetrace-export-'),
  );
  await chmod(directory, 0o700);
  try {
    const eventsPath = join(directory, 'events.jsonl');
    const eventsHandle = await open(eventsPath, 'wx', 0o600);
    const eventManifest: BundleManifest['events'][number][] = [];
    const eventIds = new Set<string>();
    const turnIds = new Set<string>();
    try {
      let cursor:
        { readonly sequence: number; readonly id: string } | undefined;
      do {
        const page = storage.listEvents({
          sessionId,
          limit: 10_000,
          ...(cursor
            ? { afterSequence: cursor.sequence, afterId: cursor.id }
            : {}),
        });
        for (const stored of page) {
          const result = redactEvent(stored.event, profile);
          eventIds.add(result.value.id);
          if (result.value.turnId) turnIds.add(result.value.turnId);
          await eventsHandle.write(
            Buffer.from(`${stableJson(result.value)}\n`, 'utf8'),
          );
          eventManifest.push({
            id: result.value.id,
            type: result.value.type,
            includedFields:
              profile.base === 'metadata-only'
                ? [
                    'id',
                    'sessionId',
                    'turnId',
                    'parentEventId',
                    'sequence',
                    'timestamp',
                    'type',
                    'provenance',
                  ]
                : Object.keys(result.value).sort(),
            omittedFields:
              profile.base === 'metadata-only'
                ? ['/payload', '/rawPayload']
                : ['provenance.rawEventId', 'sourceEventId', 'rawPayloadRef'],
            redactions: [...result.redactions],
          });
        }
        const last = page.at(-1);
        cursor =
          page.length === 10_000 && last
            ? { sequence: last.sequence, id: last.id }
            : undefined;
      } while (cursor);
      await eventsHandle.sync();
    } finally {
      await eventsHandle.close();
    }

    const artifacts = storage.listArtifacts(sessionId);
    const artifactManifest: BundleManifest['artifacts'][number][] = [];
    const artifactRecords: PreparedRecord[] = [];
    const includedArtifactIds = new Set<string>();
    for (const [index, artifact] of artifacts.entries()) {
      const metadataResult = redactJson(
        artifact.metadata,
        profile,
        `/artifacts/${artifact.id}/metadata`,
      );
      if (!artifactAllowed(artifact, profile)) {
        artifactManifest.push({
          id: artifact.id,
          kind: artifact.kind,
          ...(artifact.eventId ? { eventId: artifact.eventId } : {}),
          metadata: metadataResult.value,
          included: false,
          reason: 'excluded-by-profile',
          redactions: [...metadataResult.redactions],
        });
        continue;
      }
      if (!artifact.blobHash) {
        artifactManifest.push({
          id: artifact.id,
          kind: artifact.kind,
          ...(artifact.eventId ? { eventId: artifact.eventId } : {}),
          metadata: metadataResult.value,
          included: false,
          reason: 'content-unavailable',
          redactions: [...metadataResult.redactions],
        });
        continue;
      }
      const textual = isTextArtifact(artifact);
      if (!textual && !profile.includeBinaryArtifacts) {
        artifactManifest.push({
          id: artifact.id,
          kind: artifact.kind,
          ...(artifact.eventId ? { eventId: artifact.eventId } : {}),
          metadata: metadataResult.value,
          included: false,
          reason: 'binary-content-requires-explicit-custom-profile',
          redactions: [...metadataResult.redactions],
        });
        continue;
      }
      const contentPath = join(directory, `artifact-${index}`);
      let contentRedactions: readonly RedactionRecord[] = [];
      try {
        const source = await storage.blobs.open(artifact.blobHash);
        if (textual)
          contentRedactions = await writeTextArtifact(
            source,
            contentPath,
            profile,
            artifact.id,
          );
        else await writeBinaryArtifact(source, contentPath);
      } catch (error) {
        await rm(contentPath, { force: true });
        if (error instanceof TypeError) {
          artifactManifest.push({
            id: artifact.id,
            kind: artifact.kind,
            ...(artifact.eventId ? { eventId: artifact.eventId } : {}),
            metadata: metadataResult.value,
            included: false,
            reason: 'artifact-is-not-valid-utf8',
            redactions: [...metadataResult.redactions],
          });
          continue;
        }
        if (error instanceof UnsafeTextArtifactError) {
          artifactManifest.push({
            id: artifact.id,
            kind: artifact.kind,
            ...(artifact.eventId ? { eventId: artifact.eventId } : {}),
            metadata: metadataResult.value,
            included: false,
            reason: 'artifact-line-exceeds-safe-redaction-limit',
            redactions: [...metadataResult.redactions],
          });
          continue;
        }
        throw error;
      }
      const recordPath = `artifacts/${sha256(artifact.id).slice(0, 32)}.bin`;
      const record = await fileRecord('artifact', recordPath, contentPath);
      artifactRecords.push(record);
      includedArtifactIds.add(artifact.id);
      artifactManifest.push({
        id: artifact.id,
        kind: artifact.kind,
        ...(artifact.eventId ? { eventId: artifact.eventId } : {}),
        metadata: metadataResult.value,
        included: true,
        recordPath,
        byteLength: record.header.byteLength,
        contentHash: record.header.sha256,
        redactions: [...metadataResult.redactions, ...contentRedactions],
      });
    }

    const findings =
      profile.base === 'metadata-only'
        ? []
        : storage
            .listFindings(sessionId)
            .map(
              (finding) =>
                redactJson(
                  asJsonValue(finding),
                  profile,
                  `/findings/${finding.id}`,
                ).value,
            );
    const findingIds = new Set(
      findings.map((finding) => String((finding as JsonObject).id)),
    );
    const annotations =
      profile.base === 'metadata-only'
        ? []
        : storage
            .listAnnotations()
            .filter(
              (annotation) =>
                (annotation.targetType === 'session' &&
                  annotation.targetId === sessionId) ||
                eventIds.has(annotation.targetId) ||
                turnIds.has(annotation.targetId) ||
                findingIds.has(annotation.targetId) ||
                includedArtifactIds.has(annotation.targetId),
            )
            .map(
              (annotation) =>
                redactJson(
                  asJsonValue(annotation),
                  profile,
                  `/annotations/${annotation.id}`,
                ).value,
            );
    const findingsPath = join(directory, 'findings.json');
    const annotationsPath = join(directory, 'annotations.json');
    await writeStableJson(findingsPath, findings);
    await writeStableJson(annotationsPath, annotations);
    const contentRecords = [
      await fileRecord('events', 'events.jsonl', eventsPath),
      await fileRecord('findings', 'findings.json', findingsPath),
      await fileRecord('annotations', 'annotations.json', annotationsPath),
      ...artifactRecords,
    ];
    const sessionMetadata = redactJson(
      asJsonValue({
        id: session.id,
        projectId: createUuidV5([
          'vibetrace/export-project/1',
          session.projectId,
        ]),
        source: session.source,
        sourceSessionId: session.sourceSessionId,
        startedAt: session.startedAt,
        ...(session.endedAt ? { endedAt: session.endedAt } : {}),
        status: session.status,
        captureMode:
          profile.base === 'metadata-only' ? 'partial' : session.captureMode,
        ...(session.title ? { title: session.title } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.sourceVersion
          ? { sourceVersion: session.sourceVersion }
          : {}),
        ...(session.baseCommit ? { baseCommit: session.baseCommit } : {}),
        ...(session.finalCommit ? { finalCommit: session.finalCommit } : {}),
        ...(session.runFingerprint
          ? { runFingerprint: session.runFingerprint }
          : {}),
      }) as JsonObject,
      profile,
      '/session',
    );
    const sessionManifest = bundleSessionSchema.parse({
      ...sessionMetadata.value,
      ...(sessionMetadata.redactions.some(
        (item) => item.path === '/session/sourceSessionId',
      )
        ? {
            sourceSessionId: `redacted-${sha256(session.sourceSessionId)}`,
          }
        : {}),
    });
    const projectMetadata = redactJson(
      asJsonValue({ displayName: session.displayName }) as JsonObject,
      profile,
      '/project',
    );
    const profileMetadata = redactJson(
      asJsonValue({ name: profile.name }) as JsonObject,
      profile,
      '/profile',
    );
    const metadataRedactions = [
      ...sessionMetadata.redactions,
      ...projectMetadata.redactions,
      ...profileMetadata.redactions,
    ].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.detector.localeCompare(right.detector),
    );
    const manifestBase = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      schemaVersion: '0.1.0',
      profile: {
        kind: profile.kind,
        ...(profile.id
          ? { id: `custom-${sha256(profile.id).slice(0, 32)}` }
          : {}),
        name: String(profileMetadata.value.name),
        base: profile.base,
      },
      project: {
        id: sessionManifest.projectId,
        displayName: String(projectMetadata.value.displayName),
      },
      session: sessionManifest,
      records: contentRecords.map(({ header }) => ({
        version: header.version,
        kind: header.kind,
        path: header.path,
        byteLength: header.byteLength,
        sha256: header.sha256,
      })),
      events: eventManifest,
      artifacts: artifactManifest,
      metadataRedactions,
      findingCount: findings.length,
      annotationCount: annotations.length,
      omissions: [
        ...(profile.base === 'metadata-only'
          ? ['event-payloads', 'findings', 'annotations', 'artifacts']
          : []),
        ...artifactManifest
          .filter((artifact) => !artifact.included)
          .map((artifact) => `artifact:${artifact.id}:${artifact.reason}`),
      ].sort(),
    } as const;
    const bundleId = createUuidV5([
      'vibetrace/bundle/1',
      sessionId,
      profile.kind,
      profile.id ?? '',
      sha256(stableJson(manifestBase)),
    ]);
    const manifest = BundleManifestSchema.parse({ ...manifestBase, bundleId });
    const manifestPath = join(directory, 'manifest.json');
    await writeStableJson(manifestPath, manifest);
    const manifestRecord = await fileRecord(
      'manifest',
      'manifest.json',
      manifestPath,
    );
    return {
      directory,
      records: [manifestRecord, ...contentRecords],
      preview: { manifestHash: manifestRecord.header.sha256, manifest },
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

/** Build the exact deterministic manifest without writing a bundle. */
export async function createBundlePreview(
  storage: Storage,
  sessionId: string,
  profile: ExportProfile,
  options: { readonly temporaryRoot?: string } = {},
): Promise<BundlePreview> {
  const prepared = await prepareBundle(
    storage,
    sessionId,
    profile,
    options.temporaryRoot,
  );
  try {
    return prepared.preview;
  } finally {
    await rm(prepared.directory, { force: true, recursive: true });
  }
}

/** Export only after the caller-approved preview still matches the current view. */
export async function exportBundle(
  storage: Storage,
  options: ExportBundleOptions,
): Promise<BundlePreview> {
  const prepared = await prepareBundle(
    storage,
    options.sessionId,
    options.profile,
    options.temporaryRoot,
  );
  try {
    if (
      options.expectedManifestHash &&
      options.expectedManifestHash !== prepared.preview.manifestHash
    )
      throw new Error(
        'Bundle preview is stale; review the current manifest first.',
      );
    await encryptRecordStream(
      prepared.records,
      options.destination,
      options.passphrase,
    );
    return prepared.preview;
  } finally {
    await rm(prepared.directory, { force: true, recursive: true });
  }
}

async function* boundedLines(
  path: string,
  maxLineBytes: number,
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > maxLineBytes)
        throw new Error('Bundle event line is oversized.');
      yield pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > maxLineBytes)
      throw new Error('Bundle event line is oversized.');
  }
  if (pending.length > 0)
    throw new Error('Bundle events file is not newline terminated.');
}

function requireRecord(
  records: ReadonlyMap<string, ExtractedRecord>,
  path: string,
  kind: BundleRecordHeader['kind'],
): ExtractedRecord {
  const record = records.get(path);
  if (!record || record.header.kind !== kind)
    throw new Error(`Bundle record ${path} is missing or has the wrong kind.`);
  return record;
}

function sameRecord(
  header: BundleRecordHeader,
  expected: BundleManifest['records'][number],
): boolean {
  return (
    header.version === expected.version &&
    header.kind === expected.kind &&
    header.path === expected.path &&
    header.byteLength === expected.byteLength &&
    header.sha256 === expected.sha256
  );
}

const importQueues = new WeakMap<Storage, Promise<void>>();

/** Validate the entire decrypted view before committing one portable session atomically. */
async function importBundleUnlocked(
  storage: Storage,
  options: ImportBundleOptions,
): Promise<BundleImportResult> {
  const staged = await decryptRecordStream(options.source, options.passphrase, {
    limits: options.limits,
    temporaryRoot: options.temporaryRoot,
  });
  try {
    const [manifestRecord, ...contentRecords] = staged.records;
    const manifest = BundleManifestSchema.parse(
      await readBoundedJson(manifestRecord!, MAX_JSON_RECORD_BYTES),
    );
    if (manifest.session.projectId !== manifest.project.id)
      throw new Error('Bundle project identity is inconsistent.');
    const manifestHash = manifestRecord!.header.sha256;
    const records = new Map(
      contentRecords.map((record) => [record.header.path, record]),
    );
    if (
      records.size !== manifest.records.length ||
      manifest.records.some((expected) => {
        const record = records.get(expected.path);
        return !record || !sameRecord(record.header, expected);
      })
    )
      throw new Error('Bundle records do not match the manifest.');
    const allowedPaths = new Set(manifest.records.map((record) => record.path));
    if (contentRecords.some((record) => !allowedPaths.has(record.header.path)))
      throw new Error('Bundle contains an unmanifested record.');

    const eventRecord = requireRecord(records, 'events.jsonl', 'events');
    const events: TraceEvent[] = [];
    const eventIds = new Set<string>();
    const turnIds = new Set<string>();
    for await (const line of boundedLines(
      eventRecord.contentPath,
      MAX_EVENT_LINE_BYTES,
    )) {
      let event: TraceEvent;
      try {
        event = TraceEventSchema.parse(JSON.parse(line));
      } catch {
        throw new Error('Bundle contains a malformed canonical event.');
      }
      if (event.sessionId !== manifest.session.id || eventIds.has(event.id))
        throw new Error('Bundle event identity is inconsistent.');
      eventIds.add(event.id);
      if (event.turnId) turnIds.add(event.turnId);
      events.push(event);
    }
    if (
      events.length !== manifest.events.length ||
      manifest.events.some(
        (item, index) =>
          events[index]?.id !== item.id || events[index]?.type !== item.type,
      )
    )
      throw new Error('Bundle event inventory does not match the manifest.');
    for (const event of events)
      if (event.parentEventId && !eventIds.has(event.parentEventId))
        throw new Error('Bundle event references a missing parent event.');

    const findings = z
      .array(findingSchema)
      .max(100_000)
      .parse(
        await readBoundedJson(
          requireRecord(records, 'findings.json', 'findings'),
          MAX_JSON_RECORD_BYTES,
        ),
      );
    const annotations = z
      .array(annotationSchema)
      .max(100_000)
      .parse(
        await readBoundedJson(
          requireRecord(records, 'annotations.json', 'annotations'),
          MAX_JSON_RECORD_BYTES,
        ),
      );
    if (
      findings.length !== manifest.findingCount ||
      annotations.length !== manifest.annotationCount
    )
      throw new Error('Bundle human-data counts do not match the manifest.');
    const findingIds = new Set<string>();
    for (const finding of findings) {
      if (
        finding.sessionId !== manifest.session.id ||
        findingIds.has(finding.id) ||
        !finding.evidenceEventIds.every((id) => eventIds.has(id)) ||
        !(finding.counterevidenceEventIds ?? []).every((id) => eventIds.has(id))
      )
        throw new Error('Bundle finding evidence is inconsistent.');
      findingIds.add(finding.id);
    }

    const includedArtifacts = manifest.artifacts.filter(
      (artifact) => artifact.included,
    );
    const artifactIds = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (artifactIds.has(artifact.id))
        throw new Error('Bundle artifact ID is duplicated.');
      artifactIds.add(artifact.id);
      if (artifact.eventId && !eventIds.has(artifact.eventId))
        throw new Error('Bundle artifact references a missing event.');
      if (artifact.included) {
        if (
          !artifact.eventId ||
          !artifact.recordPath ||
          artifact.byteLength === undefined ||
          !artifact.contentHash
        )
          throw new Error('Included bundle artifact lacks content metadata.');
        const record = requireRecord(records, artifact.recordPath, 'artifact');
        if (
          record.header.byteLength !== artifact.byteLength ||
          record.header.sha256 !== artifact.contentHash
        )
          throw new Error(
            'Bundle artifact content does not match the manifest.',
          );
      } else if (artifact.recordPath)
        throw new Error('Excluded bundle artifact unexpectedly names content.');
    }
    const expectedArtifactPaths = new Set(
      includedArtifacts.map((artifact) => artifact.recordPath),
    );
    if (
      contentRecords.some(
        (record) =>
          record.header.kind === 'artifact' &&
          !expectedArtifactPaths.has(record.header.path),
      )
    )
      throw new Error('Bundle contains an excluded or unknown artifact blob.');

    const annotationTargets = new Set([
      manifest.session.id,
      ...eventIds,
      ...turnIds,
      ...findingIds,
      ...includedArtifacts.map((artifact) => artifact.id),
    ]);
    if (
      annotations.some(
        (annotation) => !annotationTargets.has(annotation.targetId),
      )
    )
      throw new Error('Bundle annotation target is outside the session.');

    if (storage.hasBundleImport(manifestHash))
      return {
        manifestHash,
        sessionId: manifest.session.id,
        imported: false,
        eventCount: events.length,
        artifactCount: includedArtifacts.length,
      };

    const blobImports = new Map<string, BlobInfo>();
    for (const artifact of includedArtifacts) {
      const record = requireRecord(records, artifact.recordPath!, 'artifact');
      blobImports.set(
        artifact.id,
        await storage.blobs.put(createReadStream(record.contentPath)),
      );
    }
    try {
      storage.transaction(() => {
        for (const info of blobImports.values()) storage.recordBlob(info);
        const sessionInput: SessionInput = {
          id: manifest.session.id,
          projectId: manifest.session.projectId,
          source: manifest.session.source,
          sourceSessionId: manifest.session.sourceSessionId,
          startedAt: manifest.session.startedAt,
          ...(manifest.session.endedAt
            ? { endedAt: manifest.session.endedAt }
            : {}),
          status: manifest.session.status,
          captureMode: manifest.session.captureMode,
          ...(manifest.session.title ? { title: manifest.session.title } : {}),
          ...(manifest.session.model ? { model: manifest.session.model } : {}),
          ...(manifest.session.sourceVersion
            ? { sourceVersion: manifest.session.sourceVersion }
            : {}),
          ...(manifest.session.baseCommit
            ? { baseCommit: manifest.session.baseCommit }
            : {}),
          ...(manifest.session.finalCommit
            ? { finalCommit: manifest.session.finalCommit }
            : {}),
          ...(manifest.session.runFingerprint
            ? { runFingerprint: manifest.session.runFingerprint }
            : {}),
        };
        for (const event of events)
          storage.importEvent({
            project: {
              id: manifest.project.id,
              displayName: manifest.project.displayName,
            },
            session: sessionInput,
            raw: {
              adapter: 'vibetrace-bundle',
              adapterVersion: BUNDLE_ADAPTER_VERSION,
              sourceVersion: String(manifest.version),
              sourceSessionId: manifest.bundleId,
              ...(event.turnId ? { sourceTurnId: event.turnId } : {}),
              sourceEventId: event.id,
              receivedAt: event.timestamp,
              payload: event.rawPayload,
            },
            event: {
              ...event,
              provenance: { ...event.provenance, rawEventId: undefined },
            },
            normalizerId: `vibetrace-bundle-${BUNDLE_VERSION}:${manifestHash}`,
          });
        for (const artifact of includedArtifacts) {
          const blob = blobImports.get(artifact.id)!;
          storage.importArtifact({
            id: artifact.id,
            sessionId: manifest.session.id,
            eventId: artifact.eventId,
            kind: artifact.kind,
            metadata: artifact.metadata,
            contentHash: artifact.contentHash,
            blobHash: blob.address,
          });
        }
        for (const finding of findings) {
          const { review, ...input } = finding;
          storage.createFinding({
            ...(input as FindingInput),
            state: 'open',
          });
          if (review)
            storage.reviewFinding(finding.id, {
              ...(review.decision ? { decision: review.decision } : {}),
              ...(review.categoryOverride
                ? { categoryOverride: review.categoryOverride }
                : {}),
              ...(review.note !== undefined ? { note: review.note } : {}),
            });
        }
        for (const annotation of annotations)
          storage.createAnnotation(annotation as AnnotationInput);
        storage.recordBundleImport(manifestHash, manifest.session.id);
      });
    } catch (error) {
      if (
        error instanceof StorageImportConflictError ||
        (error instanceof Error &&
          /collision|UNIQUE constraint failed|already exists/.test(
            error.message,
          ))
      )
        throw new Error('Bundle ID collision has different local content.', {
          cause: error,
        });
      throw error;
    }
    return {
      manifestHash,
      sessionId: manifest.session.id,
      imported: true,
      eventCount: events.length,
      artifactCount: includedArtifacts.length,
    };
  } finally {
    await rm(staged.directory, { force: true, recursive: true });
  }
}

/** Serialize imports per local store so identical concurrent requests stay idempotent. */
export async function importBundle(
  storage: Storage,
  options: ImportBundleOptions,
): Promise<BundleImportResult> {
  const previous = importQueues.get(storage) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  importQueues.set(storage, queued);
  await previous;
  try {
    return await importBundleUnlocked(storage, options);
  } finally {
    release();
    if (importQueues.get(storage) === queued) importQueues.delete(storage);
  }
}
