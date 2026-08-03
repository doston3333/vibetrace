import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEventId,
  createSessionId,
  type TraceEvent,
} from '@vibetrace/schema';
import { MemoryKeyProvider, Storage } from '@vibetrace/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  importSpool,
  readDescriptor,
  recoverStaleState,
  resolveStateDir,
  startDaemon,
} from './index.js';
import {
  ensureSpool,
  spoolLimits,
  spoolPaths,
  SpoolSegmentSchema,
  writeSegment,
  type SpoolSegment,
} from './spool.js';

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function state(): Promise<{ path: string; storage: Storage }> {
  const path = await mkdtemp(join(tmpdir(), 'vibetrace-daemon-'));
  paths.push(path);
  return {
    path,
    storage: await Storage.initialize({
      stateDir: path,
      keyProvider: new MemoryKeyProvider(),
    }),
  };
}

function segment(sequence = 1): SpoolSegment {
  const sessionId = createSessionId('test', 'source-session');
  const raw = {
    adapter: 'test',
    adapterVersion: '1.0.0',
    sourceSessionId: 'source-session',
    sourceEventId: `source-${sequence}`,
    receivedAt: '2026-01-01T00:00:00.000Z',
    payload: { content: 'safe' },
  };
  const event: TraceEvent = {
    schemaVersion: '0.1.0',
    id: createEventId({
      adapter: 'test',
      sourceSessionId: 'source-session',
      sourceSequence: sequence,
      type: 'message.agent',
    }),
    sessionId,
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'agent',
    type: 'message.agent',
    payload: { content: 'safe' },
    rawPayload: { content: 'safe' },
    provenance: {
      adapter: 'test',
      adapterVersion: '1.0.0',
      captureMode: 'standard',
    },
  };
  return {
    version: 1,
    project: {
      projectId: 'project',
      displayName: 'Project',
      pathHash: 'a'.repeat(64),
    },
    session: {
      source: 'test',
      sourceSessionId: 'source-session',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      captureMode: 'standard',
    },
    raw,
    event,
    normalizerId: 'adapter-v1',
  };
}

function failedCommandSegment(sequence: number): SpoolSegment {
  const input = segment(sequence);
  input.event = {
    ...input.event,
    id: createEventId({
      adapter: 'test',
      sourceSessionId: 'source-session',
      sourceSequence: sequence,
      type: 'command.completed',
    }),
    source: 'tool',
    type: 'command.completed',
    payload: { command: 'pnpm test', category: 'test', exitCode: 1 },
    rawPayload: { command: 'pnpm test', exitCode: 1 },
  };
  return input;
}

describe('sealed spool', () => {
  it('keeps the final name invisible until the pre-rename pause is released', async () => {
    const { path, storage } = await state();
    const spool = spoolPaths(path);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atRename = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writing = writeSegment(spool, segment(), {
      beforeRename: async () => {
        entered?.();
        await paused;
      },
    });
    await atRename;
    expect(
      (await readdir(spool.incoming)).some((name) => name.endsWith('.jsonl')),
    ).toBe(false);
    release?.();
    await writing;
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 1,
    });
    storage.close();
  });

  it('quarantines deterministic conflicts while importing later valid segments', async () => {
    const { path, storage } = await state();
    const spool = spoolPaths(path);
    await writeSegment(spool, segment(1));
    await importSpool(storage, path);
    const conflict = segment(1);
    conflict.raw = { ...conflict.raw, payload: { content: 'different' } };
    await writeSegment(spool, conflict);
    await writeSegment(spool, segment(2));
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 1,
      quarantined: 1,
    });
    const reason = (await readdir(spool.quarantine)).find((name) =>
      name.endsWith('.reason'),
    );
    expect(reason).toBeDefined();
    expect(
      await readFile(join(spool.quarantine, reason as string), 'utf8'),
    ).toBe('IMPORT_CONFLICT\n');
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(2);
    storage.close();
  });

  it('rejects relationally inconsistent envelope fields', () => {
    expect(
      SpoolSegmentSchema.safeParse({
        ...segment(),
        session: { ...segment().session, source: 'other' },
      }).success,
    ).toBe(false);
  });
  it('rejects pending artifact hash and event mismatches before persistence', () => {
    const input = segment();
    const content = 'secret';
    const contentHash = createHash('sha256').update(content).digest('hex');
    expect(
      SpoolSegmentSchema.safeParse({
        ...input,
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'command-output',
            eventId: 'other-event',
            content,
            contentHash,
            metadata: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SpoolSegmentSchema.safeParse({
        ...input,
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'command-output',
            eventId: input.event.id,
            content,
            contentHash: '0'.repeat(64),
            metadata: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SpoolSegmentSchema.safeParse({
        ...input,
        artifacts: Array.from({ length: 33 }, (_, index) => ({
          id: `artifact-${index}`,
          kind: 'command-output',
          eventId: input.event.id,
          content,
          contentHash,
          metadata: {},
        })),
      }).success,
    ).toBe(false);
  });
  it('persists a pending artifact once across interruption retries', async () => {
    const { path, storage } = await state();
    const input = segment();
    const content = 'SENTINEL_PENDING_ARTIFACT';
    await writeSegment(spoolPaths(path), {
      ...input,
      artifacts: [
        {
          id: 'artifact-output-1',
          kind: 'command-output',
          eventId: input.event.id,
          content,
          contentHash: createHash('sha256').update(content).digest('hex'),
          metadata: { summary: 'captured separately' },
        },
      ],
    });
    await expect(
      importSpool(storage, path, {
        afterEventBeforeArtifact: () => {
          throw new Error('interrupt');
        },
      }),
    ).rejects.toThrow('interrupt');
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 1,
    });
    const artifacts = storage.listArtifacts(input.event.sessionId);
    expect(artifacts).toHaveLength(1);
    const stream = await storage.blobs.open(artifacts[0]?.blobHash as string);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(content);
    expect(input.event.payload).not.toMatchObject({ content });
    await writeSegment(spoolPaths(path), {
      ...input,
      artifacts: [
        {
          id: 'artifact-output-1',
          kind: 'command-output',
          eventId: input.event.id,
          content,
          contentHash: createHash('sha256').update(content).digest('hex'),
          metadata: { summary: 'captured separately' },
        },
      ],
    });
    await expect(
      importSpool(storage, path, {
        afterArtifactBeforeArchive: () => {
          throw new Error('interrupt after artifact');
        },
      }),
    ).rejects.toThrow('interrupt after artifact');
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 1,
    });
    expect(storage.listArtifacts(input.event.sessionId)).toHaveLength(1);
    storage.close();
  });
  it('quarantines artifact ID collisions without changing the original blob', async () => {
    const { path, storage } = await state();
    const input = segment();
    const original = 'ORIGINAL_ARTIFACT_BYTES';
    const artifact = (content: string) => ({
      id: 'collision-artifact',
      kind: 'command-output',
      eventId: input.event.id,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      metadata: { summary: 'output' },
    });
    const spool = spoolPaths(path);
    await writeSegment(spool, { ...input, artifacts: [artifact(original)] });
    await importSpool(storage, path);
    const originalArtifact = storage.listArtifacts(input.event.sessionId)[0];
    await writeSegment(spool, {
      ...input,
      artifacts: [artifact('DIFFERENT_ARTIFACT_BYTES')],
    });
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      quarantined: 1,
    });
    expect(storage.listArtifacts(input.event.sessionId)).toEqual([
      originalArtifact,
    ]);
    const stream = await storage.blobs.open(
      originalArtifact?.blobHash as string,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(original);
    const reason = (await readdir(spool.quarantine)).find((name) =>
      name.endsWith('.reason'),
    );
    expect(
      await readFile(join(spool.quarantine, reason as string), 'utf8'),
    ).toBe('IMPORT_CONFLICT\n');
    storage.close();
  });
  it('only exposes renamed segments and imports a retry exactly once', async () => {
    const { path, storage } = await state();
    const spool = spoolPaths(path);
    const sealed = await writeSegment(spool, segment());
    expect(sealed.endsWith('.jsonl')).toBe(true);
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 1,
    });
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(1);
    expect(importSpool(storage, path)).resolves.toMatchObject({ imported: 0 });
    storage.close();
  });

  it('archives separately named duplicate segments while storing one canonical event', async () => {
    const { path, storage } = await state();
    const spool = spoolPaths(path);
    await writeSegment(spool, segment());
    await writeSegment(spool, segment());
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 2,
    });
    expect(
      (await readdir(spool.archive)).filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(2);
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(1);
    storage.close();
  });

  it('cleans temporary files when the writer fails before rename', async () => {
    const { path, storage } = await state();
    const spool = spoolPaths(path);
    await expect(
      writeSegment(spool, segment(), {
        beforeRename: () => {
          throw new Error('fault');
        },
      }),
    ).rejects.toThrow('fault');
    expect(
      (await readdir(spool.incoming)).some(
        (name) => name.endsWith('.tmp') || name.endsWith('.jsonl'),
      ),
    ).toBe(false);
    storage.close();
  });

  it('keeps a committed segment for retry when archiving is interrupted', async () => {
    const { path, storage } = await state();
    await writeSegment(spoolPaths(path), segment());
    await expect(
      importSpool(storage, path, {
        afterCommitBeforeArchive: () => {
          throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(1);
    await expect(importSpool(storage, path)).resolves.toMatchObject({
      imported: 1,
    });
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(1);
    storage.close();
  });

  it('quarantines malformed, multiline, oversized, and symlink segments without blocking valid input', async () => {
    const { path, storage } = await state();
    const spool = spoolPaths(path);
    await writeSegment(spool, segment());
    await writeFile(join(spool.incoming, 'bad.jsonl'), '{\n', { mode: 0o600 });
    await writeFile(join(spool.incoming, 'multi.jsonl'), '{}\n{}\n', {
      mode: 0o600,
    });
    await writeFile(join(spool.incoming, 'large.jsonl'), '', { mode: 0o600 });
    await truncate(
      join(spool.incoming, 'large.jsonl'),
      spoolLimits.maxSegmentBytes + 1,
    );
    await symlink(
      join(spool.incoming, 'bad.jsonl'),
      join(spool.incoming, 'link.jsonl'),
    );
    await writeFile(join(spool.incoming, 'old.tmp'), '{}', { mode: 0o600 });
    await expect(
      importSpool(storage, path, {
        now: () => Date.now() + spoolLimits.temporaryGraceMs + 1,
      }),
    ).resolves.toMatchObject({ imported: 1, quarantined: 5 });
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(1);
    storage.close();
  });
});

describe('daemon API', () => {
  it('requires bearer auth, uses single-use origin-bound tickets, and does not persist secrets', async () => {
    const { path, storage } = await state();
    let time = Date.parse('2026-01-01T00:00:00.000Z');
    const daemon = await startDaemon({
      stateDir: path,
      storage,
      clock: { now: () => new Date(time) },
    });
    const health = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    expect(health.statusCode).toBe(401);
    const bearer = { authorization: `Bearer ${daemon.token}` };
    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: '/api/v1/health',
          headers: bearer,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: '/api/v1/health',
          headers: { authorization: 'Bearer x'.padEnd(50, 'x') },
        })
      ).statusCode,
    ).toBe(401);
    const browserTicket = (
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/auth/tickets',
        headers: bearer,
      })
    ).json() as { ticket: string };
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/auth/browser-handoff',
          headers: bearer,
          payload: { ticket: browserTicket.ticket },
        })
      ).statusCode,
    ).toBe(200);
    const browserSession = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser-session',
      headers: { origin: daemon.descriptor.origin },
    });
    expect(browserSession.statusCode).toBe(200);
    expect(browserSession.headers['set-cookie']).toContain('HttpOnly');
    const ticket = (
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/auth/tickets',
        headers: bearer,
      })
    ).json() as { ticket: string };
    const redeemed = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      headers: { origin: daemon.descriptor.origin },
      payload: { ticket: ticket.ticket },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.headers['set-cookie']).toContain('HttpOnly');
    expect(redeemed.headers['set-cookie']).toContain('SameSite=Strict');
    const deepLink = await daemon.app.inject({
      method: 'GET',
      url: '/sessions/example-session',
      headers: { cookie: redeemed.headers['set-cookie'] as string },
    });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers['content-type']).toContain('text/html');
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/annotations',
          headers: {
            cookie: redeemed.headers['set-cookie'] as string,
            origin: daemon.descriptor.origin,
          },
          payload: { targetType: 'session', targetId: 'x' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/annotations',
          headers: bearer,
          payload: { targetType: 'session', targetId: 'x' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/auth/session',
          headers: { origin: daemon.descriptor.origin },
          payload: { ticket: ticket.ticket },
        })
      ).statusCode,
    ).toBe(401);
    const foreign = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tickets',
      headers: { ...bearer, origin: 'http://evil.test' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/annotations',
          headers: { ...bearer, origin: 'http://evil.test' },
          payload: { targetType: 'session', targetId: 'x' },
        })
      ).statusCode,
    ).toBe(403);
    const expiry = (
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/auth/tickets',
        headers: bearer,
      })
    ).json() as { ticket: string };
    time += 60_001;
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/auth/session',
          headers: { origin: daemon.descriptor.origin },
          payload: { ticket: expiry.ticket },
        })
      ).statusCode,
    ).toBe(401);
    const descriptor = await readFile(join(path, 'daemon.json'), 'utf8');
    expect(descriptor).not.toContain(daemon.token);
    expect(descriptor).not.toContain(ticket.ticket);
    expect(
      (await daemon.app.inject({ method: 'GET', url: '/api/v1/imports' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: '/api/v1/imports',
          headers: bearer,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: '/api/v1/exports',
          headers: bearer,
        })
      ).statusCode,
    ).toBe(404);
    await daemon.close();
    storage.close();
  });

  it('validates authenticated bundle preview, export, and import requests without echoing passphrases', async () => {
    const { path, storage } = await state();
    const calls: string[] = [];
    const manifestHash = 'a'.repeat(64);
    const daemon = await startDaemon({
      stateDir: path,
      storage,
      bundleOperations: {
        preview: async (_storage, sessionId, profile) => {
          calls.push(`preview:${sessionId}:${profile.kind}`);
          return { manifestHash, manifest: {} as never };
        },
        export: async (_storage, options) => {
          calls.push(
            `export:${options.sessionId}:${options.passphrase.length > 10}`,
          );
          return { manifestHash, manifest: {} as never };
        },
        import: async (_storage, options) => {
          calls.push(
            `import:${options.source}:${options.passphrase.length > 10}`,
          );
          if (options.source.endsWith('collision.vibetrace.age'))
            throw new Error('Bundle ID collision has different local content.');
          return {
            manifestHash,
            sessionId: 'portable-session',
            imported: true,
            eventCount: 3,
            artifactCount: 1,
          };
        },
      },
    });
    const headers = { authorization: `Bearer ${daemon.token}` };
    const passphrase = 'route-secret-passphrase';
    const preview = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/exports/preview',
      headers,
      payload: {
        sessionId: 'portable-session',
        profile: { kind: 'share-safe', restorePointers: [] },
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ preview: { manifestHash } });

    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/exports',
          headers,
          payload: {
            sessionId: 'portable-session',
            profile: { kind: 'share-safe', restorePointers: [] },
            destination: 'relative.vibetrace.age',
            passphrase,
            expectedManifestHash: manifestHash,
          },
        })
      ).statusCode,
    ).toBe(400);
    const destination = join(path, 'portable.vibetrace.age');
    const exported = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers,
      payload: {
        sessionId: 'portable-session',
        profile: { kind: 'share-safe', restorePointers: [] },
        destination,
        passphrase,
        expectedManifestHash: manifestHash,
      },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(passphrase);
    expect(exported.json()).toMatchObject({
      bundle: { destination, manifestHash },
    });

    const source = join(path, 'portable-source.vibetrace.age');
    const imported = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers,
      payload: { source, passphrase },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.body).not.toContain(passphrase);
    expect(imported.json()).toMatchObject({
      import: { imported: true, eventCount: 3 },
    });
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/imports',
          headers,
          payload: {
            source: join(path, 'collision.vibetrace.age'),
            passphrase,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/imports',
          headers: { ...headers, origin: 'http://evil.test' },
          payload: { source, passphrase },
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toEqual([
      'preview:portable-session:share-safe',
      'export:portable-session:true',
      `import:${source}:true`,
      `import:${join(path, 'collision.vibetrace.age')}:true`,
    ]);
    await daemon.close();
    storage.close();
  });

  it('imports sealed events during daemon startup', async () => {
    const { path, storage } = await state();
    await writeSegment(spoolPaths(path), segment());
    const daemon = await startDaemon({ stateDir: path, storage });
    expect(
      storage.listEvents({ sessionId: segment().event.sessionId }),
    ).toHaveLength(1);
    const health = (
      await daemon.app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: `Bearer ${daemon.token}` },
      })
    ).json() as { importer: { status: string } };
    expect(health.importer.status).toBe('idle');
    await daemon.close();
    storage.close();
  });

  it('analyzes imported sessions and preserves finding reviews across reruns', async () => {
    const { path, storage } = await state();
    await writeSegment(spoolPaths(path), failedCommandSegment(1));
    await writeSegment(spoolPaths(path), failedCommandSegment(2));
    const daemon = await startDaemon({ stateDir: path, storage });
    const headers = { authorization: `Bearer ${daemon.token}` };
    const sessionId = segment().event.sessionId;
    const initial = storage.listFindings(sessionId);
    const repeated = initial.find(
      (finding) => finding.ruleId === 'repeated-identical-failed-command',
    );
    expect(repeated).toBeDefined();
    expect(
      (
        await daemon.app.inject({
          method: 'PATCH',
          url: `/api/v1/findings/${repeated!.id}/review`,
          headers,
          payload: {
            decision: 'confirmed',
            categoryOverride: 'confirmed-loop',
            note: 'The retry used the same command.',
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await daemon.app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/analyze`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      storage
        .listFindings(sessionId)
        .find((finding) => finding.id === repeated!.id),
    ).toMatchObject({
      state: 'confirmed',
      category: 'confirmed-loop',
      review: { note: 'The retry used the same command.' },
    });
    expect(
      (
        await daemon.app.inject({
          method: 'PATCH',
          url: `/api/v1/findings/${repeated!.id}/review`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    await daemon.close();
    storage.close();
  });

  it('paginates, searches, reports coverage, streams artifacts, and filters annotations', async () => {
    const { path, storage } = await state();
    await writeSegment(spoolPaths(path), segment(1));
    await writeSegment(spoolPaths(path), segment(2));
    const gap = segment(3);
    gap.event = {
      ...gap.event,
      id: createEventId({
        adapter: 'test',
        sourceSessionId: 'source-session',
        sourceSequence: 3,
        type: 'capture.gap',
      }),
      source: 'harness',
      type: 'capture.gap',
      payload: {
        dataClass: 'plans',
        state: 'partial',
        reason: 'Transcript enrichment was incomplete.',
        observedSources: ['hook lifecycle'],
      },
      rawPayload: { dataClass: 'plans' },
    };
    await writeSegment(spoolPaths(path), gap);
    const daemon = await startDaemon({ stateDir: path, storage });
    const headers = { authorization: `Bearer ${daemon.token}` };
    const sessionId = segment().event.sessionId;

    const first = (
      await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/events?limit=1`,
        headers,
      })
    ).json() as {
      events: { id: string; sequence: number }[];
      nextCursor: { afterId: string; afterSequence: number };
    };
    expect(first.events).toHaveLength(1);
    const second = (
      await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/events?limit=1&afterSequence=${first.nextCursor.afterSequence}&afterId=${first.nextCursor.afterId}`,
        headers,
      })
    ).json() as { events: { id: string }[] };
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.id).not.toBe(first.events[0]!.id);

    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/events/search?q=safe&limit=1`,
          headers,
        })
      ).json(),
    ).toMatchObject({ events: [{ sessionId }] });
    const listed = (
      await daemon.app.inject({
        method: 'GET',
        url: '/api/v1/sessions?project=Project&captureMode=standard',
        headers,
      })
    ).json() as { sessions: { eventCount: number }[] };
    expect(listed.sessions).toMatchObject([{ eventCount: 3 }]);

    const coverage = (
      await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/coverage`,
        headers,
      })
    ).json() as { coverage: { dataClass: string; state: string }[] };
    expect(coverage.coverage).toHaveLength(5);
    expect(coverage.coverage).toContainEqual(
      expect.objectContaining({ dataClass: 'conversation', state: 'captured' }),
    );
    expect(coverage.coverage).toContainEqual(
      expect.objectContaining({
        dataClass: 'context',
        state: 'partial',
        sources: ['hook lifecycle'],
        gaps: [
          expect.objectContaining({
            reason: 'Transcript enrichment was incomplete.',
          }),
        ],
      }),
    );

    const blob = await storage.blobs.put(
      Readable.from([Buffer.from('artifact evidence')]),
    );
    storage.createArtifact({
      id: 'artifact-api',
      sessionId,
      eventId: first.events[0]!.id,
      kind: 'command-output',
      blobHash: blob.address,
      metadata: { mediaType: 'text/plain' },
    });
    storage.createArtifact({
      id: 'artifact-hostile-html',
      sessionId,
      eventId: first.events[0]!.id,
      kind: 'command-output',
      blobHash: blob.address,
      metadata: { mediaType: 'text/html' },
    });
    const artifact = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/artifacts/artifact-api/content`,
      headers,
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toBe('artifact evidence');
    expect(artifact.headers['cache-control']).toBe('no-store');
    expect(artifact.headers['x-content-type-options']).toBe('nosniff');
    expect(artifact.headers['content-type']).toContain('text/plain');
    const hostileArtifact = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/artifacts/artifact-hostile-html/content`,
      headers,
    });
    expect(hostileArtifact.statusCode).toBe(200);
    expect(hostileArtifact.headers['content-type']).toContain(
      'application/octet-stream',
    );
    expect(hostileArtifact.headers['content-disposition']).toBe(
      'attachment; filename="vibetrace-artifact"',
    );

    for (const [targetId, label] of [
      [sessionId, 'outcome:partial'],
      [first.events[0]!.id, 'evidence:reviewed'],
    ])
      expect(
        (
          await daemon.app.inject({
            method: 'POST',
            url: '/api/v1/annotations',
            headers,
            payload: { targetType: 'session', targetId, label },
          })
        ).statusCode,
      ).toBe(201);
    const annotations = (
      await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/annotations?targetType=session&targetId=${sessionId}`,
        headers,
      })
    ).json() as { annotations: { targetId: string }[] };
    expect(annotations.annotations).toMatchObject([{ targetId: sessionId }]);

    await daemon.close();
    storage.close();
  });

  it('tombstones sessions through the API while preserving stored evidence', async () => {
    const { path, storage } = await state();
    const captured = segment();
    await writeSegment(spoolPaths(path), captured);
    const daemon = await startDaemon({ stateDir: path, storage });
    const headers = { authorization: `Bearer ${daemon.token}` };

    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: '/api/v1/sessions',
          headers,
        })
      ).json(),
    ).toMatchObject({ sessions: [{ id: captured.event.sessionId }] });
    expect(
      (
        await daemon.app.inject({
          method: 'DELETE',
          url: `/api/v1/sessions/${captured.event.sessionId}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await daemon.app.inject({
          method: 'GET',
          url: '/api/v1/sessions',
          headers,
        })
      ).json(),
    ).toEqual({ sessions: [] });
    for (const suffix of ['', '/events']) {
      expect(
        (
          await daemon.app.inject({
            method: 'GET',
            url: `/api/v1/sessions/${captured.event.sessionId}${suffix}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(storage.getSession(captured.event.sessionId, true)).toBeDefined();

    await daemon.close();
    storage.close();
  });

  it('recovers a stale descriptor without signalling its unrelated recorded PID', async () => {
    const { path, storage } = await state();
    await writeFile(
      join(path, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        port: 9,
        origin: 'http://127.0.0.1:9',
        instanceId: '00000000-0000-4000-8000-000000000000',
        apiVersion: 'v1',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await writeFile(join(path, 'auth-token'), 'x'.repeat(43));
    await expect(recoverStaleState(path)).resolves.toBe(true);
    const daemon = await startDaemon({ stateDir: path, storage });
    expect(daemon.descriptor.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await daemon.close();
    storage.close();
  });

  it('closes idempotently and preserves a descriptor owned by another instance', async () => {
    const { path, storage } = await state();
    const daemon = await startDaemon({ stateDir: path, storage });
    const replacement = {
      ...daemon.descriptor,
      instanceId: '00000000-0000-4000-8000-000000000000',
    };
    await writeFile(join(path, 'daemon.json'), JSON.stringify(replacement));
    await Promise.all([daemon.close(), daemon.close()]);
    expect(await readDescriptor(path)).toMatchObject({
      instanceId: replacement.instanceId,
    });
    await rm(join(path, 'daemon.json'), { force: true });
    await rm(join(path, 'daemon.lock'), { force: true, recursive: true });
    storage.close();
  });

  it('rejects relative and forged descriptor origins before any bearer request', async () => {
    expect(() => resolveStateDir('relative')).toThrow('absolute');
    const { path, storage } = await state();
    await writeFile(
      join(path, 'daemon.json'),
      JSON.stringify({
        pid: 1,
        port: 9,
        origin: 'http://evil.test:9',
        instanceId: '00000000-0000-4000-8000-000000000000',
        apiVersion: 'v1',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(await readDescriptor(path)).toBeUndefined();
    let calls = 0;
    await expect(
      recoverStaleState(path, (async () => {
        calls += 1;
        return new Response('{}');
      }) as typeof fetch),
    ).resolves.toBe(true);
    expect(calls).toBe(0);
    storage.close();
  });

  it('rejects symlinked state and spool directories', async () => {
    const { path, storage } = await state();
    const stateTarget = join(path, 'state-target');
    const stateLink = join(path, 'state-link');
    const spool = spoolPaths(path);
    const incomingTarget = join(path, 'incoming-target');
    await mkdir(stateTarget, { mode: 0o700 });
    await mkdir(spool.root, { mode: 0o700 });
    await mkdir(incomingTarget, { mode: 0o700 });
    try {
      const kind = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(stateTarget, stateLink, kind);
      await symlink(incomingTarget, spool.incoming, kind);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        storage.close();
        return;
      }
      throw error;
    }

    await expect(startDaemon({ stateDir: stateLink, storage })).rejects.toThrow(
      'unsafe',
    );
    await expect(ensureSpool(spool)).rejects.toThrow('unsafe');
    storage.close();
  });
});
