import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createHash, hkdfSync } from 'node:crypto';

import Database from 'better-sqlite3-multiple-ciphers';
import {
  createEventId,
  createSessionId,
  type RawSourceEvent,
  type TraceEvent,
} from '@vibetrace/schema';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BlobStore,
  MemoryKeyProvider,
  Storage,
  StorageImportConflictError,
  type KeyProvider,
} from './index.js';
import { readPassphraseEnvelope, writePassphraseEnvelope } from './keys.js';

const directories: string[] = [];
const BASE_COMMIT = 'a'.repeat(40);
const FINAL_COMMIT = 'b'.repeat(40);
const OTHER_COMMIT = 'c'.repeat(40);
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vibetrace-storage-'));
  directories.push(path);
  return path;
}
function raw(sequence: number): RawSourceEvent {
  return {
    adapter: 'test-adapter',
    adapterVersion: '1.0.0',
    sourceSessionId: 'source-session',
    sourceEventId: `source-${sequence}`,
    receivedAt: '2026-01-01T00:00:00.000Z',
    payload: { content: `needle ${sequence}` },
  };
}
function event(
  sessionId: string,
  rawEventId: string,
  sequence: number,
): Extract<TraceEvent, { type: 'tool.completed' }> {
  return {
    schemaVersion: '0.1.0',
    id: createEventId({
      adapter: 'test-adapter',
      sourceSessionId: 'source-session',
      sourceSequence: sequence,
      type: 'tool.completed',
    }),
    sessionId,
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'tool',
    type: 'tool.completed',
    toolName: 'terminal',
    payload: { toolName: 'terminal', content: `needle ${sequence}` },
    rawPayload: { retained: `needle ${sequence}` },
    provenance: {
      adapter: 'test-adapter',
      adapterVersion: '1.0.0',
      captureMode: 'full',
      rawEventId,
    },
  };
}
async function setup(): Promise<{
  storage: Storage;
  provider: MemoryKeyProvider;
  path: string;
  sessionId: string;
}> {
  const path = await stateDirectory();
  const provider = new MemoryKeyProvider();
  const storage = await Storage.initialize({
    stateDir: path,
    keyProvider: provider,
  });
  const sessionId = createSessionId('test-adapter', 'source-session');
  storage.createProject({ id: 'project', displayName: 'Project' });
  storage.createSession({
    id: sessionId,
    projectId: 'project',
    source: 'test-adapter',
    sourceSessionId: 'source-session',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    captureMode: 'full',
  });
  return { storage, provider, path, sessionId };
}
async function collected(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
class UnavailableProvider implements KeyProvider {
  async getRootSecret(): Promise<Uint8Array | undefined> {
    throw new Error('unavailable');
  }
  async setRootSecret(): Promise<void> {
    throw new Error('unavailable');
  }
}
class FailingIfUsedProvider implements KeyProvider {
  async getRootSecret(): Promise<Uint8Array | undefined> {
    throw new Error('keychain must not be consulted');
  }
  async setRootSecret(): Promise<void> {
    throw new Error('keychain must not be consulted');
  }
}
async function directDatabase(
  path: string,
  provider: MemoryKeyProvider,
): Promise<import('better-sqlite3').Database> {
  const root = await provider.getRootSecret();
  if (!root) throw new Error('Missing test root secret.');
  const db = new Database(join(path, 'state.db'));
  const key = Buffer.from(
    hkdfSync('sha256', root, Buffer.alloc(0), 'vibetrace/db', 32),
  );
  db.pragma("cipher = 'sqlcipher'");
  db.pragma('legacy = 4');
  db.pragma(`key = "x'${key.toString('hex')}'"`);
  return db;
}

describe('encrypted Storage', () => {
  it('migrates, persists over restart, filters and full-text searches', async () => {
    const { storage, provider, path, sessionId } = await setup();
    const rawId = storage.appendRaw(sessionId, raw(1));
    const normalizedId = storage.appendNormalized(
      event(sessionId, rawId, 1),
      'normalizer-v1',
    );
    expect(
      storage.listEvents({
        sessionId,
        toolName: 'terminal',
        type: 'tool.completed',
      }),
    ).toHaveLength(1);
    expect(storage.searchEvents(sessionId, 'needle')).toMatchObject([
      { id: normalizedId },
    ]);
    storage.close();
    const reopened = await Storage.unlock({
      stateDir: path,
      keyProvider: provider,
    });
    expect(
      reopened.listEvents({
        sessionId,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).toHaveLength(1);
    reopened.close();
  });

  it('keeps raw source imports idempotent and immutable', async () => {
    const { storage, sessionId, provider, path } = await setup();
    const once = storage.appendRaw(sessionId, raw(1));
    expect(storage.appendRaw(sessionId, raw(1))).toBe(once);
    storage.appendNormalized(event(sessionId, once, 1), 'normalizer-v1');
    expect(
      storage.appendNormalized(event(sessionId, once, 1), 'normalizer-v1'),
    ).toBe(
      createEventId({
        adapter: 'test-adapter',
        sourceSessionId: 'source-session',
        sourceSequence: 1,
        type: 'tool.completed',
      }),
    );
    storage.close();
    const db = await directDatabase(path, provider);
    expect(() =>
      db
        .prepare('UPDATE raw_events SET payload_json = ? WHERE id = ?')
        .run('{}', once),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('DELETE FROM raw_events WHERE id = ?').run(once),
    ).toThrow('immutable');
    db.close();
  });

  it('tombstones sessions without deleting immutable raw evidence', async () => {
    const { storage, sessionId, provider, path } = await setup();
    const rawId = storage.appendRaw(sessionId, raw(1));
    storage.appendNormalized(event(sessionId, rawId, 1), 'normalizer-v1');
    expect(storage.deleteSession(sessionId)).toBe(true);
    expect(storage.getSession(sessionId)).toBeUndefined();
    expect(storage.listEvents({ sessionId })).toEqual([]);
    expect(storage.searchEvents(sessionId, 'needle')).toEqual([]);
    storage.close();
    const db = await directDatabase(path, provider);
    expect(
      db.prepare('SELECT id FROM raw_events WHERE id = ?').get(rawId),
    ).toMatchObject({ id: rawId });
    db.close();
  });

  it('canonicalizes raw hashes and rejects source/normalized identity collisions', async () => {
    const { storage, sessionId } = await setup();
    const first = {
      ...raw(1),
      payload: { alpha: 1, nested: { beta: 2, gamma: 3 } },
    };
    const reversed = {
      ...first,
      payload: { nested: { gamma: 3, beta: 2 }, alpha: 1 },
    };
    const rawId = storage.appendRaw(sessionId, first);
    expect(storage.appendRaw(sessionId, reversed)).toBe(rawId);
    expect(() =>
      storage.appendRaw(sessionId, { ...first, payload: { alpha: 9 } }),
    ).toThrow('collision');
    const normalized = event(sessionId, rawId, 1);
    storage.appendNormalized(normalized, 'normalizer-v1');
    expect(storage.appendNormalized(normalized, 'normalizer-v1')).toBe(
      normalized.id,
    );
    expect(() =>
      storage.appendNormalized({ ...normalized, sequence: 2 }, 'normalizer-v1'),
    ).toThrow('collision');
    expect(() => storage.searchEvents(sessionId, '   ')).toThrow('blank');
    storage.close();
  });

  it('stores turns, artifacts, annotations, and profiles with aligned SQL bindings', async () => {
    const { storage, sessionId, provider, path } = await setup();
    const rawId = storage.appendRaw(sessionId, raw(1));
    const eventId = storage.appendNormalized(
      event(sessionId, rawId, 1),
      'normalizer-v1',
    );
    const blob = await storage.blobs.put(
      Readable.from([Buffer.from('artifact')]),
    );
    storage.createTurn({
      id: 'turn',
      sessionId,
      sequence: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
    });
    storage.createArtifact({
      id: 'artifact',
      sessionId,
      eventId,
      kind: 'log',
      blobHash: blob.address,
      metadata: { ok: true },
    });
    storage.createAnnotation({
      id: 'annotation',
      targetType: 'event',
      targetId: eventId,
      createdAt: '2026-01-01T00:00:00.000Z',
      note: 'note',
    });
    storage.createRedactionProfile({
      id: 'profile',
      name: 'default',
      rules: { mode: 'strict' },
    });
    storage.close();
    const db = await directDatabase(path, provider);
    expect(
      db
        .prepare(
          'SELECT count(*) AS count FROM turns, artifacts, annotations, redaction_profiles',
        )
        .get(),
    ).toMatchObject({ count: 1 });
    db.close();
  });

  it('persists capture profiles and applies reversible retention tombstones', async () => {
    const { storage, sessionId } = await setup();
    storage.createCaptureProfile({
      id: 'profile-standard',
      name: 'Standard local',
      mode: 'standard',
      settings: { captureDiffs: true, secretDetection: true },
    });
    expect(storage.getCaptureProfile('Standard local')).toMatchObject({
      mode: 'standard',
    });
    storage.createRetentionPolicy({
      id: 'retention',
      name: 'Ninety days',
      retentionDays: 90,
      maxSessions: 10,
    });
    expect(storage.listRetentionPolicies()).toHaveLength(1);
    storage.createSession({
      id: 'old-session',
      projectId: 'project',
      source: 'test-adapter',
      sourceSessionId: 'old-source-session',
      startedAt: '2025-01-01T00:00:00.000Z',
      status: 'completed',
      captureMode: 'minimal',
    });
    expect(storage.applyRetention('2026-01-01T00:00:00.000Z')).toBe(1);
    expect(storage.getSession('old-session')).toBeUndefined();
    expect(storage.getSession('old-session', true)).toBeDefined();
    expect(storage.getSession(sessionId)).toBeDefined();
    storage.close();
  });

  it('persists eval manifests, deterministic runs, and comparison evidence', async () => {
    const { storage, sessionId } = await setup();
    const manifest = await storage.blobs.put(
      Readable.from([Buffer.from('{"schemaVersion":"1.0.0"}')]),
    );
    storage.recordBlob(manifest);
    const manifestHash = 'c'.repeat(64);
    const caseId = storage.createEvalCase({
      id: 'eval-case-1',
      name: 'Authorization regression',
      manifestBlobHash: manifest.address,
      manifestHash,
      schemaVersion: '1.0.0',
      sourceSessionId: sessionId,
    });
    expect(caseId).toBe('eval-case-1');
    expect(
      storage.createEvalCase({
        id: 'ignored-duplicate',
        name: 'Duplicate import',
        manifestBlobHash: manifest.address,
        manifestHash,
        schemaVersion: '1.0.0',
      }),
    ).toBe(caseId);
    expect(storage.getEvalCase(caseId)).toMatchObject({
      id: caseId,
      manifestBlobHash: manifest.address,
    });
    const reviewedManifest = await storage.blobs.put(
      Readable.from([Buffer.from('{"schemaVersion":"1.0.0","reviewed":true}')]),
    );
    storage.recordBlob(reviewedManifest);
    storage.updateEvalCase(caseId, {
      name: 'Reviewed authorization regression',
      manifestBlobHash: reviewedManifest.address,
      manifestHash: 'e'.repeat(64),
      schemaVersion: '1.0.0',
    });
    expect(storage.getEvalCase(caseId)).toMatchObject({
      name: 'Reviewed authorization regression',
      manifestBlobHash: reviewedManifest.address,
      manifestHash: 'e'.repeat(64),
    });

    const configuration = { model: 'gpt-test' };
    const configurationHash = createHash('sha256')
      .update('{"model":"gpt-test"}')
      .digest('hex');
    const worktreeFingerprintHash = 'd'.repeat(64);
    const runId = storage.upsertEvalRun({
      id: 'eval-run-1',
      evalCaseId: caseId,
      configuration,
      configurationHash,
      worktreeFingerprintHash,
      status: 'queued',
    });
    expect(
      storage.upsertEvalRun({
        id: 'ignored-duplicate-run',
        evalCaseId: caseId,
        configuration,
        configurationHash,
        worktreeFingerprintHash,
        status: 'running',
      }),
    ).toBe(runId);
    storage.updateEvalRun(runId, {
      status: 'completed',
      outcome: { success: true },
      metrics: { durationMs: 42 },
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(storage.getEvalRun(runId)).toMatchObject({
      id: runId,
      status: 'completed',
      outcome: { success: true },
      metrics: { durationMs: 42 },
    });

    const comparisonId = storage.createEvalComparison({
      id: 'comparison-1',
      evalCaseId: caseId,
      name: 'Model comparison',
      configuration: { dimensions: ['model'] },
    });
    storage.upsertEvalComparisonResult({
      comparisonId,
      evalRunId: runId,
      ordinal: 0,
      result: { success: true, firstDivergenceEventId: null },
    });
    expect(storage.listEvalComparisonResults(comparisonId)).toEqual([
      expect.objectContaining({ comparisonId, evalRunId: runId, ordinal: 0 }),
    ]);
    storage.close();
  });

  it('resolves export profiles and rolls back nested portable-import work atomically', async () => {
    const { storage, sessionId } = await setup();
    storage.createRedactionProfile({
      id: 'share-team',
      name: 'Share with team',
      rules: { base: 'share-safe', artifactDenyIds: ['private-log'] },
    });
    expect(storage.getRedactionProfile('share-team')).toMatchObject({
      id: 'share-team',
      name: 'Share with team',
    });
    expect(storage.getRedactionProfile('Share with team')?.rules).toEqual({
      base: 'share-safe',
      artifactDenyIds: ['private-log'],
    });

    const manifestHash = 'd'.repeat(64);
    expect(() =>
      storage.transaction(() => {
        storage.importEvent({
          project: { id: 'project', displayName: 'Project' },
          session: {
            id: sessionId,
            projectId: 'project',
            source: 'test-adapter',
            sourceSessionId: 'source-session',
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T00:01:00.000Z',
            status: 'active',
            captureMode: 'full',
          },
          raw: raw(2),
          event: event(sessionId, 'replaced-during-import', 2),
          normalizerId: 'normalizer-v1',
        });
        storage.recordBundleImport(manifestHash, sessionId);
        throw new Error('rollback sentinel');
      }),
    ).toThrow('rollback sentinel');
    expect(storage.listEvents({ sessionId })).toEqual([]);
    expect(storage.getSession(sessionId)?.endedAt).toBeUndefined();
    expect(storage.hasBundleImport(manifestHash)).toBe(false);

    storage.importEvent({
      project: { id: 'project', displayName: 'Project' },
      session: {
        id: sessionId,
        projectId: 'project',
        source: 'test-adapter',
        sourceSessionId: 'source-session',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
        status: 'active',
        captureMode: 'full',
      },
      raw: raw(2),
      event: event(sessionId, 'replaced-during-import', 2),
      normalizerId: 'normalizer-v1',
    });
    expect(storage.getSession(sessionId)?.endedAt).toBe(
      '2026-01-01T00:01:00.000Z',
    );
    storage.recordBundleImport(manifestHash, sessionId);
    expect(storage.hasBundleImport(manifestHash)).toBe(true);
    storage.close();
  });

  it('idempotently imports artifacts and rejects every immutable collision', async () => {
    const { storage, sessionId } = await setup();
    const rawId = storage.appendRaw(sessionId, raw(1));
    const eventId = storage.appendNormalized(
      event(sessionId, rawId, 1),
      'normalizer-v1',
    );
    const input = {
      id: 'imported-artifact',
      sessionId,
      eventId,
      kind: 'command-output',
      contentHash: 'a'.repeat(64),
      blobHash: 'b'.repeat(64),
      metadata: { alpha: 1, beta: true },
    };
    storage.importArtifact(input);
    storage.importArtifact({ ...input, metadata: { beta: true, alpha: 1 } });
    for (const changed of [
      { contentHash: 'c'.repeat(64) },
      { blobHash: 'c'.repeat(64) },
      { metadata: { alpha: 2 } },
      { sessionId: 'other' },
      { eventId: 'other' },
      { kind: 'other' },
    ])
      expect(() => storage.importArtifact({ ...input, ...changed })).toThrow(
        StorageImportConflictError,
      );
    expect(storage.listArtifacts(sessionId)).toHaveLength(1);
    storage.close();
  });

  it('round-trips session metadata, fills it once, and rejects conflicts', async () => {
    const { storage, sessionId, path, provider } = await setup();
    const fingerprint = {
      source: 'codex' as const,
      clientSurface: 'cli' as const,
      instructionHashes: [],
      lockfileHashes: [],
      captureOmissions: ['plugin-manifests-unavailable' as const],
      os: 'test',
      architecture: 'test',
      runtimeVersions: { node: '24' },
    };
    const input = {
      project: { id: 'project', displayName: 'Project' },
      session: {
        id: sessionId,
        projectId: 'project',
        source: 'test-adapter',
        sourceSessionId: 'source-session',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'active',
        captureMode: 'full',
        baseCommit: BASE_COMMIT,
        finalCommit: FINAL_COMMIT,
        runFingerprint: fingerprint,
      },
      raw: raw(9),
      event: event(sessionId, 'ignored', 9),
      normalizerId: 'normalizer-v1',
    };
    storage.importEvent(input);
    storage.importEvent(input);
    expect(() =>
      storage.importEvent({
        ...input,
        session: { ...input.session, baseCommit: '--stat' },
      }),
    ).toThrow('canonical Git object ID');
    expect(storage.getSession(sessionId)).toMatchObject({
      baseCommit: BASE_COMMIT,
      finalCommit: FINAL_COMMIT,
      runFingerprint: fingerprint,
    });
    for (const session of [
      { ...input.session, baseCommit: OTHER_COMMIT },
      { ...input.session, finalCommit: OTHER_COMMIT },
      { ...input.session, runFingerprint: { ...fingerprint, os: 'other' } },
    ])
      expect(() => storage.importEvent({ ...input, session })).toThrow(
        StorageImportConflictError,
      );
    storage.close();
    const reopened = await Storage.unlock({
      stateDir: path,
      keyProvider: provider,
    });
    expect(reopened.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId, baseCommit: BASE_COMMIT }),
      ]),
    );
    reopened.close();
  });

  it('orders tied event sequences deterministically by event ID', async () => {
    const { storage, sessionId } = await setup();
    const firstRawId = storage.appendRaw(sessionId, raw(101));
    const secondRawId = storage.appendRaw(sessionId, raw(102));
    const tied = [
      {
        ...event(sessionId, firstRawId, 42),
        id: createEventId({
          adapter: 'test-adapter',
          sourceSessionId: 'source-session',
          sourceEventId: 'tie-z',
          sourceSequence: 42,
          type: 'tool.completed',
        }),
        provenance: {
          ...event(sessionId, firstRawId, 42).provenance,
          rawEventId: firstRawId,
        },
      },
      {
        ...event(sessionId, secondRawId, 42),
        id: createEventId({
          adapter: 'test-adapter',
          sourceSessionId: 'source-session',
          sourceEventId: 'tie-a',
          sourceSequence: 42,
          type: 'tool.completed',
        }),
        provenance: {
          ...event(sessionId, secondRawId, 42).provenance,
          rawEventId: secondRawId,
        },
      },
    ];
    for (const item of tied) storage.appendNormalized(item, 'normalizer-v1');
    const expected = tied.map((item) => item.id).sort();
    expect(storage.listEvents({ sessionId }).map((item) => item.id)).toEqual(
      expected,
    );
    expect(
      storage.searchEvents(sessionId, 'needle').map((item) => item.id),
    ).toEqual(expected);
    const firstPage = storage.listEvents({ sessionId, limit: 1 });
    expect(firstPage.map((item) => item.id)).toEqual(expected.slice(0, 1));
    const cursor = firstPage[0]!;
    expect(
      storage
        .listEvents({
          sessionId,
          limit: 1,
          afterSequence: cursor.sequence,
          afterId: cursor.id,
        })
        .map((item) => item.id),
    ).toEqual(expected.slice(1));
    expect(() =>
      storage.listEvents({
        sessionId,
        limit: 1,
        afterSequence: cursor.sequence,
      }),
    ).toThrow('afterSequence and afterId');
    storage.close();
  });

  it('rejects findings with missing evidence and accepts existing evidence', async () => {
    const { storage, sessionId } = await setup();
    const rawId = storage.appendRaw(sessionId, raw(1));
    const id = storage.appendNormalized(
      event(sessionId, rawId, 1),
      'normalizer-v1',
    );
    const finding = {
      id: 'finding',
      sessionId,
      ruleId: 'rule',
      detectorVersion: '1',
      category: 'test',
      severity: 'low',
      title: 'Title',
      explanation: 'Explanation',
      recommendation: 'Recommendation',
    };
    expect(() =>
      storage.createFinding({ ...finding, evidenceEventIds: ['missing'] }),
    ).toThrow('nonexistent');
    expect(() =>
      storage.createFinding({ ...finding, evidenceEventIds: [id] }),
    ).not.toThrow();
    storage.close();
  });

  it('replaces analyzer findings while preserving durable human reviews', async () => {
    const { storage, sessionId } = await setup();
    const rawId = storage.appendRaw(sessionId, raw(1));
    const eventId = storage.appendNormalized(
      event(sessionId, rawId, 1),
      'normalizer-v1',
    );
    const finding = {
      id: 'stable-finding',
      sessionId,
      ruleId: 'deterministic-rule',
      detectorVersion: '0.1.0',
      category: 'verification',
      severity: 'medium',
      title: 'Initial title',
      explanation: 'Initial explanation',
      recommendation: 'Inspect the evidence.',
      evidenceEventIds: [eventId],
      counterevidenceEventIds: [],
      state: 'open',
    };
    storage.replaceFindings(sessionId, ['deterministic-rule'], [finding]);
    expect(
      storage.reviewFinding(finding.id, {
        decision: 'confirmed',
        categoryOverride: 'user-category',
        note: 'Confirmed from the linked output.',
      }),
    ).toBe(true);
    storage.replaceFindings(
      sessionId,
      ['deterministic-rule'],
      [
        {
          ...finding,
          detectorVersion: '0.2.0',
          title: 'Updated title',
          category: 'new-detector-category',
        },
      ],
    );
    expect(storage.listFindings(sessionId)).toMatchObject([
      {
        id: finding.id,
        detectorVersion: '0.2.0',
        title: 'Updated title',
        category: 'user-category',
        state: 'confirmed',
        review: {
          decision: 'confirmed',
          categoryOverride: 'user-category',
          note: 'Confirmed from the linked output.',
        },
      },
    ]);
    storage.replaceFindings(sessionId, ['deterministic-rule'], []);
    expect(storage.listFindings(sessionId)).toEqual([]);
    storage.replaceFindings(sessionId, ['deterministic-rule'], [finding]);
    expect(storage.listFindings(sessionId)[0]).toMatchObject({
      state: 'confirmed',
      category: 'user-category',
    });
    expect(storage.getSession(sessionId)?.primaryFinding).toBe('Initial title');
    storage.reviewFinding(finding.id, { decision: 'rejected' });
    expect(storage.getSession(sessionId)?.primaryFinding).toBeUndefined();
    storage.reviewFinding(finding.id, { decision: 'open' });
    expect(() =>
      storage.replaceFindings(sessionId, ['other-rule'], [finding]),
    ).toThrow('not owned');
    expect(() =>
      storage.replaceFindings(
        sessionId,
        ['deterministic-rule'],
        [{ ...finding, evidenceEventIds: ['missing'] }],
      ),
    ).toThrow('nonexistent');
    expect(storage.listFindings(sessionId)).toHaveLength(1);
    expect(storage.reviewFinding('missing', { decision: 'rejected' })).toBe(
      false,
    );
    storage.close();
  });

  it('imports and queries 10,000 synthetic events', async () => {
    const { storage, sessionId } = await setup();
    for (let sequence = 1; sequence <= 10_000; sequence += 1) {
      const rawId = storage.appendRaw(sessionId, raw(sequence));
      storage.appendNormalized(
        event(sessionId, rawId, sequence),
        'normalizer-v1',
      );
    }
    expect(storage.listEvents({ sessionId, limit: 10_000 })).toHaveLength(
      10_000,
    );
    expect(storage.searchEvents(sessionId, 'needle 9999')).toHaveLength(1);
    storage.close();
  }, 45_000);

  it('indexes and lists 10,000 sessions', async () => {
    const path = await stateDirectory();
    const storage = await Storage.initialize({
      stateDir: path,
      keyProvider: new MemoryKeyProvider(),
    });
    storage.createProject({ id: 'project', displayName: 'Project' });
    const startedAt = performance.now();
    storage.transaction(() => {
      for (let index = 1; index <= 10_000; index += 1) {
        storage.createSession({
          id: createSessionId('performance-fixture', `session-${index}`),
          projectId: 'project',
          source: 'performance-fixture',
          sourceSessionId: `session-${index}`,
          startedAt: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + index,
          ).toISOString(),
          status: 'completed',
          captureMode: 'standard',
        });
      }
    });

    const sessions = storage.listSessions(false, 10_000);
    const elapsed = performance.now() - startedAt;
    expect(sessions).toHaveLength(10_000);
    expect(sessions[0]?.sourceSessionId).toBe('session-10000');
    expect(sessions.at(-1)?.sourceSessionId).toBe('session-1');
    expect(elapsed).toBeLessThan(10_000);
    storage.close();
  }, 20_000);

  it('initializes and unlocks an explicit passphrase envelope', async () => {
    const path = await stateDirectory();
    const unavailable = new UnavailableProvider();
    const storage = await Storage.initialize({
      stateDir: path,
      keyProvider: unavailable,
      passphrase: 'correct horse battery staple',
    });
    storage.close();
    expect(await stat(join(path, 'key-envelope.v1.json'))).toMatchObject({
      mode: expect.any(Number),
    });
    if (process.platform !== 'win32')
      expect(
        (await stat(join(path, 'key-envelope.v1.json'))).mode & 0o077,
      ).toBe(0);
    const unlocked = await Storage.unlock({
      stateDir: path,
      keyProvider: unavailable,
      passphrase: 'correct horse battery staple',
    });
    unlocked.close();
    await expect(
      Storage.unlock({
        stateDir: path,
        keyProvider: unavailable,
        passphrase: 'wrong passphrase',
      }),
    ).rejects.toThrow('could not be unlocked');
  });

  it('requires an explicit passphrase when the OS provider is unavailable', async () => {
    const path = await stateDirectory();
    await expect(
      Storage.initialize({
        stateDir: path,
        keyProvider: new UnavailableProvider(),
      }),
    ).rejects.toThrow('passphrase is required');
  });

  it('bypasses the OS provider when an explicit passphrase is supplied', async () => {
    const path = await stateDirectory();
    const provider = new FailingIfUsedProvider();
    const storage = await Storage.initialize({
      stateDir: path,
      keyProvider: provider,
      passphrase: 'explicit headless passphrase',
    });
    storage.close();
    const unlocked = await Storage.unlock({
      stateDir: path,
      keyProvider: provider,
      passphrase: 'explicit headless passphrase',
    });
    unlocked.close();
  });

  it('does not create an envelope while opening an existing locked database', async () => {
    const { storage, path } = await setup();
    storage.close();
    await expect(
      Storage.open({
        stateDir: path,
        keyProvider: new UnavailableProvider(),
        passphrase: 'must-not-create-an-envelope',
      }),
    ).rejects.toThrow('envelope');
    await expect(access(join(path, 'key-envelope.v1.json'))).rejects.toThrow();
  });

  it('atomically replaces passphrase envelopes without leaving temporary files', async () => {
    const path = await stateDirectory();
    await writePassphraseEnvelope(
      path,
      'first passphrase',
      Buffer.alloc(32, 1),
    );
    await writePassphraseEnvelope(
      path,
      'second passphrase',
      Buffer.alloc(32, 2),
    );
    await expect(
      readPassphraseEnvelope(path, 'first passphrase'),
    ).rejects.toThrow('could not be unlocked');
    expect(await readPassphraseEnvelope(path, 'second passphrase')).toEqual(
      Buffer.alloc(32, 2),
    );
    const envelope = join(path, 'key-envelope.v1.json');
    await rename(envelope, `${envelope}.swap-backup`);
    expect(await readPassphraseEnvelope(path, 'second passphrase')).toEqual(
      Buffer.alloc(32, 2),
    );
    await expect(access(`${envelope}.swap-backup`)).rejects.toThrow();
    expect(
      (await readdir(path)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('deduplicates, authenticates, rotates, and restricts encrypted blobs', async () => {
    const { storage, provider, path } = await setup();
    const secret = Buffer.from('blob secret should never be plaintext');
    const first = await storage.blobs.put(Readable.from([secret]));
    storage.recordBlob(first);
    const duplicate = await storage.blobs.put(Readable.from([secret]));
    expect(duplicate.address).toBe(first.address);
    const concurrent = await Promise.all([
      storage.blobs.put(Readable.from([secret])),
      storage.blobs.put(Readable.from([secret])),
    ]);
    expect(concurrent.map((info) => info.address)).toEqual([
      first.address,
      first.address,
    ]);
    expect(
      (await readdir(join(path, 'blobs'))).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
    expect(await collected(await storage.blobs.open(first.address))).toEqual(
      secret,
    );
    const before = await readFile(storage.blobs.pathFor(first.address));
    expect(before.includes(secret)).toBe(false);
    const newKey = storage.rotateBlobKey('blob-v2');
    await storage.blobs.reencrypt(first.address);
    const after = await readFile(storage.blobs.pathFor(first.address));
    expect(after.toString('utf8', 6, 13)).toBe(newKey);
    const backup = `${storage.blobs.pathFor(first.address)}.swap-backup`;
    await rename(storage.blobs.pathFor(first.address), backup);
    storage.close();
    const recovered = await Storage.unlock({
      stateDir: path,
      keyProvider: provider,
    });
    expect(await collected(await recovered.blobs.open(first.address))).toEqual(
      secret,
    );
    await expect(access(backup)).rejects.toThrow();
    const root = await provider.getRootSecret();
    if (!root) throw new Error('Missing test root secret.');
    const mismatchedAddressStore = new BlobStore({
      stateDir: path,
      addressKey: Buffer.alloc(32, 9),
      keyForId: (keyId) =>
        Buffer.from(
          hkdfSync(
            'sha256',
            root,
            Buffer.alloc(0),
            `vibetrace/blob-encryption/${keyId}`,
            32,
          ),
        ),
      activeKeyId: () => 'blob-v3',
    });
    const original = await readFile(recovered.blobs.pathFor(first.address));
    await expect(
      mismatchedAddressStore.reencrypt(first.address),
    ).rejects.toThrow('address changed');
    expect(await readFile(recovered.blobs.pathFor(first.address))).toEqual(
      original,
    );
    await chmod(recovered.blobs.pathFor(first.address), 0o600);
    if (process.platform !== 'win32')
      expect(
        (await stat(recovered.blobs.pathFor(first.address))).mode & 0o077,
      ).toBe(0);
    const corruptCiphertext = Buffer.from(after);
    corruptCiphertext[25] = corruptCiphertext[25] === 0 ? 1 : 0;
    await writeFile(recovered.blobs.pathFor(first.address), corruptCiphertext);
    await expect(recovered.blobs.reencrypt(first.address)).rejects.toThrow(
      'integrity',
    );
    expect(await readFile(recovered.blobs.pathFor(first.address))).toEqual(
      corruptCiphertext,
    );
    const corruptTag = Buffer.from(after);
    corruptTag[corruptTag.length - 1] =
      corruptTag[corruptTag.length - 1] === 0 ? 1 : 0;
    await writeFile(recovered.blobs.pathFor(first.address), corruptTag);
    await expect(recovered.blobs.reencrypt(first.address)).rejects.toThrow(
      'integrity',
    );
    const corrupt = Buffer.from(after);
    corrupt[0] = 0;
    await writeFile(recovered.blobs.pathFor(first.address), corrupt);
    await expect(recovered.blobs.open(first.address)).rejects.toThrow('header');
    expect(path).toContain('vibetrace-storage');
    recovered.close();
  });

  it('does not delete an active slow put temporary file during a concurrent put', async () => {
    const { storage } = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let concurrentStarted!: () => void;
    const concurrentStartedPromise = new Promise<void>((resolve) => {
      concurrentStarted = resolve;
    });
    async function* slow(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(1024 * 1024, 1);
      started();
      await blocked;
      yield Buffer.alloc(1024 * 1024, 2);
    }
    const first = storage.blobs.put(Readable.from(slow()));
    await startedPromise;
    async function* concurrent(): AsyncGenerator<Buffer> {
      concurrentStarted();
      yield Buffer.alloc(1024 * 1024, 3);
    }
    const second = storage.blobs.put(Readable.from(concurrent()));
    await concurrentStartedPromise;
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(await collected(await storage.blobs.open(one.address))).toHaveLength(
      2 * 1024 * 1024,
    );
    expect(await collected(await storage.blobs.open(two.address))).toHaveLength(
      1024 * 1024,
    );
    storage.close();
  });

  it('streams a 100 MB blob without constructing a 100 MB input buffer', async () => {
    const { storage } = await setup();
    const megabyte = Buffer.alloc(1024 * 1024, 0x61);
    async function* chunks(): AsyncGenerator<Buffer> {
      for (let index = 0; index < 100; index += 1) yield megabyte;
    }
    const info = await storage.blobs.put(Readable.from(chunks()));
    let bytes = 0;
    await pipeline(
      await storage.blobs.open(info.address),
      new Writable({
        write(chunk, _, callback) {
          bytes += chunk.length;
          callback();
        },
      }),
    );
    expect(bytes).toBe(100 * 1024 * 1024);
    storage.close();
  }, 20_000);

  it('does not leave a known secret in encrypted database, WAL, or blobs', async () => {
    const { storage, path, sessionId } = await setup();
    const secret = 'VIBETRACE_KNOWN_SECRET_4ba1e7';
    const source = { ...raw(1), payload: { secret } };
    const rawId = storage.appendRaw(sessionId, source);
    storage.appendNormalized(
      {
        ...event(sessionId, rawId, 1),
        payload: { toolName: 'terminal', secret },
        rawPayload: { secret },
      },
      'normalizer-v1',
    );
    const blob = await storage.blobs.put(Readable.from([Buffer.from(secret)]));
    storage.close();
    const files = [
      join(path, 'state.db'),
      join(path, 'state.db-wal'),
      storage.blobs.pathFor(blob.address),
    ];
    for (const file of files) {
      try {
        expect((await readFile(file)).includes(secret)).toBe(false);
      } catch {
        /* WAL may be checkpointed on close. */
      }
    }
  });

  it('rejects a database opened with a different root secret', async () => {
    const { storage, path } = await setup();
    storage.close();
    const wrong = new MemoryKeyProvider();
    await wrong.setRootSecret(Buffer.alloc(32, 7));
    await expect(
      Storage.unlock({ stateDir: path, keyProvider: wrong }),
    ).rejects.toThrow();
  });

  it('restricts an existing state directory before SQLite creates WAL files', async () => {
    const path = await stateDirectory();
    await chmod(path, 0o755);
    const storage = await Storage.initialize({
      stateDir: path,
      keyProvider: new MemoryKeyProvider(),
    });
    if (process.platform !== 'win32')
      expect((await stat(path)).mode & 0o077).toBe(0);
    storage.close();
  });
});
