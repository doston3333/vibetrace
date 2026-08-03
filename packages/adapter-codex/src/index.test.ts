import { performance } from 'node:perf_hooks';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importSpool, spoolPaths, startDaemon } from '@vibetrace/daemon';
import { MemoryKeyProvider, Storage } from '@vibetrace/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_ADAPTER_VERSION,
  CODEX_HOOK_EVENTS,
  collectCodexHook,
  detectCodexVersion,
  doctorCodex,
  enrichCodexTranscript,
  installCodexHooks,
  normalizeCodexHook,
  parseCodexHook,
  readCodexInstallManifest,
  uninstallCodexHooks,
} from './index.js';
import {
  CODEX_0_144_3_SESSION_FIXTURES,
  CODEX_CURRENT_SESSION_END_FIXTURE,
  CODEX_ROLLOUT_V1_FIXTURE,
} from './fixtures.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function directory(label = 'vibetrace-codex-'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), label));
  directories.push(path);
  return path;
}

function allHookFixtures(): readonly Record<string, unknown>[] {
  return [
    ...CODEX_0_144_3_SESSION_FIXTURES.flat(),
    CODEX_CURRENT_SESSION_END_FIXTURE,
  ];
}

function fixture(event: string): Record<string, unknown> {
  const found = allHookFixtures().find(
    (candidate) => candidate.hook_event_name === event,
  );
  if (!found) throw new Error(`Missing ${event} fixture.`);
  return structuredClone(found);
}

async function writeRollout(
  path: string,
  rows: readonly unknown[] = CODEX_ROLLOUT_V1_FIXTURE,
): Promise<void> {
  await writeFile(
    path,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

describe('Codex hook contracts', () => {
  it('validates ten 0.144.3 sessions plus current SessionEnd with full provenance', () => {
    expect(CODEX_0_144_3_SESSION_FIXTURES).toHaveLength(10);
    const seen = new Set<string>();
    for (const input of allHookFixtures()) {
      const segment = normalizeCodexHook(input, {
        clock: () => new Date('2026-08-03T12:00:00.000Z'),
        sourceVersion: '0.144.3',
      });
      seen.add(String(input.hook_event_name));
      expect(segment.raw.sourceVersion).toBe('0.144.3');
      expect(segment.event.provenance).toMatchObject({
        adapter: 'codex-hooks',
        adapterVersion: CODEX_ADAPTER_VERSION,
        sourceVersion: '0.144.3',
      });
      expect(segment.event.sequence).toBeGreaterThan(0);
    }
    expect([...seen].sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
  });

  it('preserves future JSON fields and rejects non-JSON or incomplete input precisely', () => {
    const input = fixture('UserPromptSubmit');
    input.future = { nested: ['retained'] };
    const parsed = parseCodexHook(input);
    expect(parsed.future).toEqual({ nested: ['retained'] });
    expect(() => parseCodexHook({ ...input, future: BigInt(1) })).toThrow();
    expect(() =>
      parseCodexHook({ ...fixture('PreToolUse'), tool_input: undefined }),
    ).toThrow(/tool_input/);
    expect(() =>
      parseCodexHook({ ...fixture('PostToolUse'), tool_response: undefined }),
    ).toThrow(/tool_response/);
    expect(
      parseCodexHook({
        ...fixture('PostToolUse'),
        tool_response: { output: 'object output is valid' },
      }).hook_event_name,
    ).toBe('PostToolUse');
  });

  it('keeps PreToolUse and PostToolUse identities distinct and imports both once', async () => {
    const stateDir = await directory();
    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    const clock = () => new Date('2026-08-03T12:00:00.000Z');
    const pre = normalizeCodexHook(fixture('PreToolUse'), {
      clock,
      sourceVersion: '0.144.3',
    });
    const post = normalizeCodexHook(fixture('PostToolUse'), {
      clock,
      sourceVersion: '0.144.3',
    });
    expect(pre.raw.sourceEventId).not.toBe(post.raw.sourceEventId);
    expect(pre.event.id).not.toBe(post.event.id);
    await collectCodexHook(JSON.stringify(fixture('PreToolUse')), {
      stateDir,
      clock,
      sourceVersion: '0.144.3',
      enrichTranscript: false,
    });
    await collectCodexHook(JSON.stringify(fixture('PostToolUse')), {
      stateDir,
      clock,
      sourceVersion: '0.144.3',
      enrichTranscript: false,
    });
    await expect(importSpool(storage, stateDir)).resolves.toEqual({
      imported: 2,
      quarantined: 0,
    });
    expect(storage.listEvents({ sessionId: pre.event.sessionId })).toHaveLength(
      2,
    );
    storage.close();
  });

  it('updates the derived session state when SessionEnd imports', async () => {
    const stateDir = await directory();
    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    await collectCodexHook(JSON.stringify(fixture('SessionStart')), {
      stateDir,
      sourceVersion: '0.145.0',
      clock: () => new Date('2026-08-03T12:00:00.000Z'),
      enrichTranscript: false,
    });
    await collectCodexHook(JSON.stringify(CODEX_CURRENT_SESSION_END_FIXTURE), {
      stateDir,
      sourceVersion: '0.145.0',
      clock: () => new Date('2026-08-03T12:10:00.000Z'),
      enrichTranscript: false,
    });
    await expect(importSpool(storage, stateDir)).resolves.toEqual({
      imported: 2,
      quarantined: 0,
    });
    const sessionId = normalizeCodexHook(fixture('SessionStart')).event
      .sessionId;
    expect(storage.getSession(sessionId)?.status).toBe('completed');
    storage.close();
  });
});

describe('silent spool collector', () => {
  it('captures with the cached install version while the daemon is unavailable', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    await installCodexHooks({
      stateDir,
      codexHome,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000111',
    });
    await expect(
      collectCodexHook(JSON.stringify(fixture('UserPromptSubmit')), {
        stateDir,
        clock: () => new Date('2026-08-03T12:00:00.000Z'),
        enrichTranscript: false,
      }),
    ).resolves.toBe(true);
    await expect(collectCodexHook('{', { stateDir })).resolves.toBe(false);
    const files = await readdir(spoolPaths(stateDir).incoming);
    const segment = JSON.parse(
      await readFile(
        join(spoolPaths(stateDir).incoming, files[0] as string),
        'utf8',
      ),
    ) as { raw: { sourceVersion: string } };
    expect(segment.raw.sourceVersion).toBe('0.144.3');
  });

  it('keeps p95 atomic collection below 100ms on the local fixture path', async () => {
    const stateDir = await directory();
    const durations: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      const input = {
        ...fixture('UserPromptSubmit'),
        session_id: `performance-${index}`,
      };
      expect(
        await collectCodexHook(JSON.stringify(input), {
          stateDir,
          sourceVersion: '0.144.3',
          enrichTranscript: false,
        }),
      ).toBe(true);
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThan(100);
  });
});

describe('Codex installer ownership', () => {
  it('previews without writing, backs up, installs valid handlers, and is idempotent', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    const hooksPath = join(codexHome, 'hooks.json');
    const original = {
      description: 'user config',
      retained: { future: true },
      hooks: {
        Stop: [
          { matcher: 'x', hooks: [{ type: 'command', command: 'other' }] },
        ],
      },
    };
    await writeFile(hooksPath, `${JSON.stringify(original, null, 2)}\n`);
    const dryRun = await installCodexHooks({
      stateDir,
      codexHome,
      dryRun: true,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000222',
    });
    expect(dryRun.changed).toBe(true);
    expect(JSON.parse(await readFile(hooksPath, 'utf8'))).toEqual(original);
    expect(await readCodexInstallManifest(stateDir)).toBeUndefined();

    const installed = await installCodexHooks({
      stateDir,
      codexHome,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000222',
    });
    expect(installed.warnings.join(' ')).toContain('/hooks');
    const document = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      retained: unknown;
      hooks: Record<string, Array<{ hooks: Record<string, unknown>[] }>>;
    };
    expect(document.retained).toEqual({ future: true });
    for (const event of CODEX_HOOK_EVENTS) {
      const owned = document.hooks[event]
        ?.flatMap((group) => group.hooks)
        .find((handler) => String(handler.command).includes('000000000222'));
      expect(owned).toEqual({
        type: 'command',
        command:
          'vibetrace hook collect --installation 00000000-0000-4000-8000-000000000222',
        commandWindows:
          'vibetrace.cmd hook collect --installation 00000000-0000-4000-8000-000000000222',
        timeout: 3,
      });
    }
    const backups = (await readdir(codexHome)).filter((name) =>
      name.includes('vibetrace-backup'),
    );
    expect(backups).toHaveLength(1);
    expect(
      await installCodexHooks({ stateDir, codexHome, codexVersion: '0.144.3' }),
    ).toMatchObject({ changed: false });
    expect(
      (await readdir(codexHome)).filter((name) =>
        name.includes('vibetrace-backup'),
      ),
    ).toHaveLength(1);
  });

  it('uninstalls only exact manifest handlers and preserves same-group additions', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    const hooksPath = join(codexHome, 'hooks.json');
    await installCodexHooks({
      stateDir,
      codexHome,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000333',
    });
    const document = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Record<string, unknown>[] }>>;
    };
    document.hooks.Stop?.[0]?.hooks.push({
      type: 'command',
      command: 'user-added',
    });
    await writeFile(hooksPath, `${JSON.stringify(document, null, 2)}\n`);
    const preview = await uninstallCodexHooks({
      stateDir,
      codexHome,
      dryRun: true,
    });
    expect(preview.changed).toBe(true);
    const result = await uninstallCodexHooks({ stateDir, codexHome });
    expect(result.warnings).toEqual([]);
    const remaining = await readFile(hooksPath, 'utf8');
    expect(remaining).toContain('user-added');
    expect(remaining).not.toContain('000000000333');
    expect(await readCodexInstallManifest(stateDir)).toBeUndefined();
  });

  it('preserves a user-modified owned handler and its manifest', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    const hooksPath = join(codexHome, 'hooks.json');
    await installCodexHooks({
      stateDir,
      codexHome,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000444',
    });
    const document = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Record<string, unknown>[] }>>;
    };
    const handler = document.hooks.Stop?.[0]?.hooks[0];
    if (!handler) throw new Error('Expected Stop handler.');
    handler.timeout = 2;
    await writeFile(hooksPath, `${JSON.stringify(document, null, 2)}\n`);
    const result = await uninstallCodexHooks({ stateDir, codexHome });
    expect(result.warnings.join(' ')).toContain('user-modified');
    expect(await readFile(hooksPath, 'utf8')).toContain('000000000444');
    expect(await readCodexInstallManifest(stateDir)).toBeDefined();
  });

  it('rejects symlinked or malformed configuration without overwriting it', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    const target = join(await directory(), 'target.json');
    await writeFile(target, '{}');
    await symlink(target, join(codexHome, 'hooks.json'));
    await expect(
      installCodexHooks({ stateDir, codexHome, codexVersion: '0.144.3' }),
    ).rejects.toThrow(/unsafe/i);
    await rm(join(codexHome, 'hooks.json'));
    await writeFile(join(codexHome, 'hooks.json'), '{');
    await expect(
      installCodexHooks({ stateDir, codexHome, codexVersion: '0.144.3' }),
    ).rejects.toThrow();
    expect(await readFile(join(codexHome, 'hooks.json'), 'utf8')).toBe('{');
  });
});

describe('versioned transcript enrichment', () => {
  it('extracts only exposed assistant output and preserves the source row', async () => {
    const path = join(await directory(), 'rollout.jsonl');
    await writeRollout(path);
    const segments = await enrichCodexTranscript(path, {
      sourceSessionId: 'session-transcript',
      cwd: '/workspace/vibetrace-fixture',
      model: 'gpt-5.6-codex',
      clock: () => new Date('2026-08-03T12:00:00.000Z'),
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.event).toMatchObject({
      type: 'message.agent',
      subtype: 'transcript.rollout-v1',
      payload: { content: 'Visible final answer.' },
    });
    expect(segments[0]?.raw.payload.future_row).toEqual({ retained: true });
    expect(JSON.stringify(segments)).not.toContain('not-canonicalized');
  });

  it('turns missing, unsupported, malformed, and mismatched transcripts into gaps', async () => {
    const context = {
      sourceSessionId: 'session-transcript',
      cwd: '/workspace/vibetrace-fixture',
      sourceVersion: '0.144.3',
      clock: () => new Date('2026-08-03T12:00:00.000Z'),
    };
    expect(
      (await enrichCodexTranscript(undefined, context))[0]?.event.type,
    ).toBe('capture.gap');
    const unsupported = join(await directory(), 'unsupported.jsonl');
    await writeFile(
      unsupported,
      `${JSON.stringify({
        timestamp: '2026-08-03T10:00:00.000Z',
        type: 'other',
        payload: {},
      })}\n`,
    );
    expect(
      (await enrichCodexTranscript(unsupported, context))[0]?.event.subtype,
    ).toBe('transcript.unsupported');
    const malformed = join(await directory(), 'malformed.jsonl');
    await writeRollout(malformed);
    await writeFile(malformed, 'not-json\n', { flag: 'a' });
    expect(
      (await enrichCodexTranscript(malformed, context)).some(
        (segment) => segment.event.type === 'capture.gap',
      ),
    ).toBe(true);
    const mismatch = join(await directory(), 'mismatch.jsonl');
    await writeRollout(mismatch, [
      {
        ...CODEX_ROLLOUT_V1_FIXTURE[0],
        payload: { ...CODEX_ROLLOUT_V1_FIXTURE[0].payload, id: 'other' },
      },
    ]);
    expect(
      (await enrichCodexTranscript(mismatch, context))[0]?.event.subtype,
    ).toBe('transcript.metadata-mismatch');
  });

  it('emits transcript segments from Stop without requiring SessionEnd', async () => {
    const stateDir = await directory();
    const path = join(await directory(), 'rollout.jsonl');
    await writeRollout(path);
    const stop = {
      ...fixture('Stop'),
      session_id: 'session-transcript',
      transcript_path: path,
    };
    expect(
      await collectCodexHook(JSON.stringify(stop), {
        stateDir,
        sourceVersion: '0.144.3',
        clock: () => new Date('2026-08-03T12:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      (await readdir(spoolPaths(stateDir).incoming)).filter((name) =>
        name.endsWith('.jsonl'),
      ),
    ).toHaveLength(3);
  });
});

describe('doctor', () => {
  it('reports exact remediation and a clean JSON-safe installed state', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    const missing = await doctorCodex({
      stateDir,
      codexHome,
      detectVersion: async () => undefined,
      clock: () => new Date('2026-08-03T12:00:00.000Z'),
    });
    expect(missing.ok).toBe(false);
    expect(missing.checks.every((check) => check.message.length > 0)).toBe(
      true,
    );
    expect(
      missing.checks
        .filter((check) => check.status === 'fail')
        .every((check) => Boolean(check.remediation)),
    ).toBe(true);

    await installCodexHooks({
      stateDir,
      codexHome,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000555',
    });
    const installed = await doctorCodex({
      stateDir,
      codexHome,
      detectVersion: async () => '0.144.3',
      clock: () => new Date('2026-08-03T12:00:00.000Z'),
    });
    expect(installed.ok).toBe(true);
    expect(installed.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'hook-config', status: 'pass' }),
        expect.objectContaining({ id: 'spool-capture', status: 'pass' }),
        expect.objectContaining({ id: 'daemon', status: 'warn' }),
        expect.objectContaining({
          id: 'session-end-coverage',
          status: 'warn',
        }),
      ]),
    );
    expect(() => JSON.stringify(installed)).not.toThrow();
  });

  it('authenticates the live daemon and verifies its open encrypted database', async () => {
    const stateDir = await directory();
    const codexHome = await directory();
    await installCodexHooks({
      stateDir,
      codexHome,
      codexVersion: '0.144.3',
      installationId: '00000000-0000-4000-8000-000000000556',
    });
    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    const daemon = await startDaemon({ stateDir, storage });
    try {
      const report = await doctorCodex({
        stateDir,
        codexHome,
        detectVersion: async () => '0.144.3',
      });
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: 'daemon', status: 'pass' }),
      );
    } finally {
      await daemon.close();
      storage.close();
    }
  });

  it('parses an argument-only Codex version probe result when Codex is present', async () => {
    const version = await detectCodexVersion();
    if (version !== undefined) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
