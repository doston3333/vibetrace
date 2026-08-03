import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  createEventId,
  createSessionId,
  type TraceEvent,
} from '@vibetrace/schema';
import { MemoryKeyProvider, Storage } from '@vibetrace/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { encryptRecordStream, type PreparedRecord } from './codec.js';
import { createBundlePreview, exportBundle, importBundle } from './index.js';

const roots: string[] = [];
const PASSPHRASE = 'correct horse battery staple';
const KNOWN_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryRoot(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `vibetrace-${label}-`));
  roots.push(path);
  return path;
}

function sourceEvent(
  sessionId: string,
): Extract<TraceEvent, { type: 'tool.completed' }> {
  return {
    schemaVersion: '0.1.0',
    id: createEventId({
      adapter: 'codex-hooks',
      sourceSessionId: 'portable-source',
      sourceSequence: 1,
      type: 'tool.completed',
    }),
    sessionId,
    sequence: 1,
    timestamp: '2026-01-01T00:00:01.000Z',
    source: 'tool',
    type: 'tool.completed',
    toolName: 'terminal',
    model: KNOWN_KEY,
    payload: {
      toolName: 'terminal',
      password: 'database-password',
      output: `authorization: Bearer abcDEF1234567890abcDEF1234567890 ${KNOWN_KEY}`,
    },
    rawPayload: { connection: 'postgres://user:secret@localhost/private' },
    provenance: {
      adapter: 'codex-hooks',
      adapterVersion: '0.1.0',
      captureMode: 'full',
    },
  };
}

async function sourceStorage(): Promise<{
  storage: Storage;
  sessionId: string;
  eventId: string;
  artifactText: string;
}> {
  const stateDir = await temporaryRoot('bundle-source');
  const storage = await Storage.initialize({
    stateDir,
    keyProvider: new MemoryKeyProvider(),
  });
  const sessionId = createSessionId('codex-hooks', 'portable-source');
  const event = sourceEvent(sessionId);
  storage.importEvent({
    project: {
      id: 'portable-project',
      displayName: `Portable ${KNOWN_KEY}`,
    },
    session: {
      id: sessionId,
      projectId: 'portable-project',
      source: 'codex-hooks',
      sourceSessionId: 'portable-source',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      status: 'completed',
      captureMode: 'full',
      title: `Portable ${KNOWN_KEY}`,
      sourceVersion: '0.144.3',
    },
    raw: {
      adapter: 'codex-hooks',
      adapterVersion: '0.1.0',
      sourceSessionId: 'portable-source',
      sourceEventId: 'source-event-1',
      receivedAt: event.timestamp,
      payload: event.rawPayload,
    },
    event,
    normalizerId: 'codex-hooks:0.1.0',
  });
  const artifactText = [
    'test output',
    KNOWN_KEY,
    '-----BEGIN PRIVATE KEY-----',
    'private key bytes',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const blob = await storage.blobs.put(
    Readable.from([Buffer.from(artifactText)]),
  );
  storage.recordBlob(blob);
  storage.createArtifact({
    id: 'terminal-output',
    sessionId,
    eventId: event.id,
    kind: 'command-output',
    contentHash: createHash('sha256').update(artifactText).digest('hex'),
    blobHash: blob.address,
    metadata: { mediaType: 'text/plain', password: 'metadata-secret' },
  });
  storage.createFinding({
    id: 'finding-1',
    sessionId,
    ruleId: 'test-rule',
    detectorVersion: '1.0.0',
    category: 'verification',
    severity: 'medium',
    confidence: 0.9,
    title: 'Secret-bearing finding',
    explanation: `Observed ${KNOWN_KEY}`,
    recommendation: 'Inspect the evidence.',
    evidenceEventIds: [event.id],
  });
  storage.reviewFinding('finding-1', {
    decision: 'confirmed',
    note: 'Keep this review',
  });
  storage.createAnnotation({
    id: 'annotation-1',
    targetType: 'finding',
    targetId: 'finding-1',
    createdAt: '2026-01-01T00:02:00.000Z',
    label: 'investigate',
    note: `Do not expose ${KNOWN_KEY}`,
  });
  return { storage, sessionId, eventId: event.id, artifactText };
}

async function emptyStorage(label: string): Promise<Storage> {
  return Storage.initialize({
    stateDir: await temporaryRoot(label),
    keyProvider: new MemoryKeyProvider(),
  });
}

async function collect(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('encrypted portable bundles', () => {
  it('previews the exact scrubbed view, emits standard age, and round-trips reviews and annotations', async () => {
    const { storage, sessionId, eventId, artifactText } = await sourceStorage();
    const exportRoot = await temporaryRoot('bundle-output');
    const destination = join(exportRoot, 'portable.vibetrace.age');
    const preview = await createBundlePreview(storage, sessionId, {
      kind: 'share-safe',
      restorePointers: [],
    });
    expect(preview.manifest.events).toHaveLength(1);
    expect(preview.manifest.metadataRedactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/project/displayName' }),
        expect.objectContaining({ path: '/session/title' }),
      ]),
    );
    expect(preview.manifest.artifacts).toMatchObject([
      {
        id: 'terminal-output',
        included: true,
        eventId,
      },
    ]);
    expect(
      preview.manifest.artifacts[0]?.redactions.map((item) => item.detector),
    ).toEqual(
      expect.arrayContaining(['suspicious-field', 'known-key', 'private-key']),
    );

    const exported = await exportBundle(storage, {
      sessionId,
      profile: { kind: 'share-safe', restorePointers: [] },
      destination,
      passphrase: PASSPHRASE,
      expectedManifestHash: preview.manifestHash,
    });
    expect(exported.manifestHash).toBe(preview.manifestHash);
    expect(
      (await readFile(destination)).subarray(0, 21).toString('ascii'),
    ).toBe('age-encryption.org/v1');
    expect((await readFile(destination)).includes(KNOWN_KEY)).toBe(false);

    const target = await emptyStorage('bundle-target');
    const imported = await importBundle(target, {
      source: destination,
      passphrase: PASSPHRASE,
    });
    expect(imported).toMatchObject({
      imported: true,
      sessionId,
      eventCount: 1,
      artifactCount: 1,
    });
    expect(target.getSession(sessionId)?.endedAt).toBe(
      '2026-01-01T00:01:00.000Z',
    );
    expect(target.getSession(sessionId)?.displayName).not.toContain(KNOWN_KEY);
    expect(target.getSession(sessionId)?.title).not.toContain(KNOWN_KEY);
    const storedEvent = target.listEvents({ sessionId })[0]?.event;
    const eventJson = JSON.stringify(storedEvent);
    expect(eventJson).not.toContain('database-password');
    expect(eventJson).not.toContain('abcDEF1234567890abcDEF1234567890');
    expect(eventJson).not.toContain('postgres://user:secret');
    expect(eventJson).not.toContain(KNOWN_KEY);
    const artifact = target.getArtifact(sessionId, 'terminal-output');
    expect(artifact?.blobHash).toBeTruthy();
    const importedArtifact = await collect(
      await target.blobs.open(artifact!.blobHash!),
    );
    expect(importedArtifact).not.toContain(KNOWN_KEY);
    expect(importedArtifact).not.toContain('private key bytes');
    expect(importedArtifact).not.toBe(artifactText);
    expect(target.listFindings(sessionId)[0]?.review).toMatchObject({
      decision: 'confirmed',
      note: 'Keep this review',
    });
    expect(target.listAnnotations()).toMatchObject([
      { id: 'annotation-1', targetId: 'finding-1' },
    ]);

    await expect(
      importBundle(target, { source: destination, passphrase: PASSPHRASE }),
    ).resolves.toMatchObject({ imported: false, sessionId });
    const concurrentTarget = await emptyStorage('bundle-concurrent-target');
    const concurrent = await Promise.all([
      importBundle(concurrentTarget, {
        source: destination,
        passphrase: PASSPHRASE,
      }),
      importBundle(concurrentTarget, {
        source: destination,
        passphrase: PASSPHRASE,
      }),
    ]);
    expect(concurrent.map((result) => result.imported).sort()).toEqual([
      false,
      true,
    ]);
    concurrentTarget.close();
    target.close();
    storage.close();
  }, 20_000);

  it('makes metadata-only omissions explicit and rejects a stale approved preview', async () => {
    const { storage, sessionId } = await sourceStorage();
    const metadata = await createBundlePreview(storage, sessionId, {
      kind: 'metadata-only',
    });
    expect(metadata.manifest.events).toMatchObject([
      { type: 'capture.gap', omittedFields: ['/payload', '/rawPayload'] },
    ]);
    expect(metadata.manifest.artifacts[0]).toMatchObject({
      included: false,
      reason: 'excluded-by-profile',
    });
    expect(metadata.manifest.omissions).toEqual(
      expect.arrayContaining([
        'event-payloads',
        'findings',
        'annotations',
        'artifacts',
      ]),
    );
    storage.createRedactionProfile({
      id: 'reviewed-share',
      name: 'Reviewed share',
      rules: {
        base: 'share-safe',
        restorePointers: ['/payload/password'],
        artifactDenyIds: ['terminal-output'],
      },
    });
    const custom = await createBundlePreview(storage, sessionId, {
      kind: 'custom',
      id: 'reviewed-share',
      restorePointers: [],
    });
    expect(custom.manifest.artifacts[0]).toMatchObject({
      included: false,
      reason: 'excluded-by-profile',
    });
    expect(custom.manifest.events[0]?.redactions).not.toContainEqual(
      expect.objectContaining({ path: '/payload/password' }),
    );
    expect(
      JSON.stringify(storage.listEvents({ sessionId })[0]?.event),
    ).toContain('database-password');

    const approved = await createBundlePreview(storage, sessionId, {
      kind: 'share-safe',
      restorePointers: [],
    });
    storage.createAnnotation({
      id: 'annotation-after-preview',
      targetType: 'session',
      targetId: sessionId,
      createdAt: '2026-01-01T00:03:00.000Z',
      note: 'changed',
    });
    const destination = join(
      await temporaryRoot('stale-output'),
      'stale.vibetrace.age',
    );
    await expect(
      exportBundle(storage, {
        sessionId,
        profile: { kind: 'share-safe', restorePointers: [] },
        destination,
        passphrase: PASSPHRASE,
        expectedManifestHash: approved.manifestHash,
      }),
    ).rejects.toThrow('stale');
    await expect(readFile(destination)).rejects.toThrow();
    storage.close();
  });

  it('excludes an oversized text line instead of splitting a boundary-spanning secret', async () => {
    const { storage, sessionId, eventId } = await sourceStorage();
    const content = `${'x'.repeat(1024 * 1024 - 8)}${KNOWN_KEY}`;
    const blob = await storage.blobs.put(
      Readable.from([Buffer.from(content, 'utf8')]),
    );
    storage.recordBlob(blob);
    storage.createArtifact({
      id: 'oversized-single-line',
      sessionId,
      eventId,
      kind: 'command-output',
      contentHash: createHash('sha256').update(content).digest('hex'),
      blobHash: blob.address,
      metadata: { mediaType: 'text/plain' },
    });
    const preview = await createBundlePreview(storage, sessionId, {
      kind: 'share-safe',
      restorePointers: [],
    });
    expect(
      preview.manifest.artifacts.find(
        (artifact) => artifact.id === 'oversized-single-line',
      ),
    ).toMatchObject({
      included: false,
      reason: 'artifact-line-exceeds-safe-redaction-limit',
    });
    expect(await collect(await storage.blobs.open(blob.address))).toBe(content);
    storage.close();
  });

  it('rejects malformed manifests before mutation and rolls back ID collisions with different content', async () => {
    const malformedRoot = await temporaryRoot('malformed-bundle');
    const malformedContent = join(malformedRoot, 'manifest-content');
    const malformedBytes = Buffer.from('{not-json', 'utf8');
    await writeFile(malformedContent, malformedBytes, { mode: 0o600 });
    const malformedRecord: PreparedRecord = {
      header: {
        version: 1,
        entryType: 'file',
        kind: 'manifest',
        path: 'manifest.json',
        byteLength: malformedBytes.byteLength,
        sha256: createHash('sha256').update(malformedBytes).digest('hex'),
      },
      contentPath: malformedContent,
    };
    const malformedBundle = join(malformedRoot, 'malformed.vibetrace.age');
    await encryptRecordStream([malformedRecord], malformedBundle, PASSPHRASE, {
      scryptWorkFactor: 10,
    });
    const empty = await emptyStorage('malformed-target');
    await expect(
      importBundle(empty, {
        source: malformedBundle,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toThrow('JSON record is malformed');
    expect(empty.listSessions()).toEqual([]);
    empty.close();

    const { storage: source, sessionId } = await sourceStorage();
    const outputRoot = await temporaryRoot('collision-output');
    const bundle = join(outputRoot, 'collision.vibetrace.age');
    const preview = await exportBundle(source, {
      sessionId,
      profile: { kind: 'share-safe', restorePointers: [] },
      destination: bundle,
      passphrase: PASSPHRASE,
    });
    const target = await emptyStorage('collision-target');
    const conflicting = {
      ...sourceEvent(sessionId),
      payload: { toolName: 'terminal', output: 'different local content' },
      rawPayload: { local: true },
    } satisfies TraceEvent;
    target.importEvent({
      project: { id: 'portable-project', displayName: 'Portable project' },
      session: {
        id: sessionId,
        projectId: 'portable-project',
        source: 'codex-hooks',
        sourceSessionId: 'portable-source',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'completed',
        captureMode: 'full',
      },
      raw: {
        adapter: 'local-test',
        adapterVersion: '1.0.0',
        sourceSessionId: 'portable-source',
        sourceEventId: 'local-conflict',
        receivedAt: conflicting.timestamp,
        payload: conflicting.rawPayload,
      },
      event: conflicting,
      normalizerId: 'local-test:1',
    });
    await expect(
      importBundle(target, { source: bundle, passphrase: PASSPHRASE }),
    ).rejects.toThrow('ID collision');
    expect(target.listEvents({ sessionId })).toHaveLength(1);
    expect(target.listArtifacts(sessionId)).toEqual([]);
    expect(target.listAnnotations()).toEqual([]);
    expect(target.hasBundleImport(preview.manifestHash)).toBe(false);
    target.close();
    source.close();
  }, 15_000);
});
