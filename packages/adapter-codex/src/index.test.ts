import { execFile as execFileCallback } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { importSpool, spoolPaths, startDaemon } from '@vibetrace/daemon';
import { MemoryKeyProvider, Storage } from '@vibetrace/storage';
import { captureProfilePolicy } from '@vibetrace/schema';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  FingerprintFileHashes,
  RepositorySnapshot,
} from '@vibetrace/enrichment';

import {
  CODEX_ADAPTER_VERSION,
  CODEX_HOOK_EVENTS,
  collectCodexHook,
  deriveCodexApprovalCoverageSegment,
  deriveCodexCommandSegments,
  deriveCodexRepositorySegments,
  detectCodexVersion,
  doctorCodex,
  enrichCodexTranscript,
  installCodexHooks,
  normalizeCodexHook,
  parseCodexHook,
  readCodexInstallManifest,
  readCaptureProfilePolicy,
  readCodexBaselinePointer,
  removeCodexBaselinePointer,
  uninstallCodexHooks,
  writeCodexBaselinePointer,
  writeCaptureProfilePolicy,
} from './index.js';
import {
  CODEX_0_144_3_SESSION_FIXTURES,
  CODEX_CURRENT_SESSION_END_FIXTURE,
  CODEX_ROLLOUT_V1_FIXTURE,
} from './fixtures.js';

const directories: string[] = [];
const execFile = promisify(execFileCallback);
const BASE_COMMIT = 'a'.repeat(40);
const NEXT_COMMIT = 'b'.repeat(40);
const FINAL_COMMIT = 'c'.repeat(40);

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

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function gitRepository(): Promise<string> {
  const path = await directory('vibetrace-codex-git-');
  const git = (...arguments_: string[]) =>
    execFile('git', arguments_, { cwd: path, shell: false });
  await git('init');
  await git('config', 'user.email', 'vibetrace@example.invalid');
  await git('config', 'user.name', 'VibeTrace Test');
  await writeFile(join(path, 'tracked.txt'), 'baseline\n');
  await git('add', 'tracked.txt');
  await git('commit', '-m', 'baseline');
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

describe('pure command derivation', () => {
  const clock = () => new Date('2026-08-03T12:00:00.000Z');
  const hook = (
    name: 'PreToolUse' | 'PostToolUse',
    command: string,
    response?: unknown,
  ) =>
    parseCodexHook({
      ...fixture(name),
      tool_input: { cmd: command },
      ...(name === 'PostToolUse' ? { tool_response: response } : {}),
    });
  it('derives ordered pre and verification children with sealed IDs and artifacts', () => {
    const pre = hook('PreToolUse', 'pnpm test');
    const post = hook('PostToolUse', 'pnpm test', {
      stdout: 'passed',
      stderr: 'warning',
      exit_code: 0,
      duration_ms: 12,
    });
    const parent = normalizeCodexHook(post, { clock });
    const preChild = deriveCodexCommandSegments(
      pre,
      normalizeCodexHook(pre, { clock }),
    );
    const children = deriveCodexCommandSegments(post, parent);
    expect(preChild[0]?.event).toMatchObject({
      type: 'command.started',
      status: 'running',
    });
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.event.sequence)).toEqual([
      parent.event.sequence + 1,
      parent.event.sequence + 2,
    ]);
    const verification = children[1];
    if (!verification) throw new Error('Missing verification segment.');
    expect(verification?.event).toMatchObject({
      parentEventId: parent.event.id,
      sourceEventId: verification.raw.sourceEventId,
      type: 'test.completed',
    });
    expect(verification?.event.provenance).toEqual(parent.event.provenance);
    expect(verification?.event.payload).toMatchObject({
      summary: 'passed warning',
      rawOutputArtifactId: verification?.artifacts?.[0]?.id,
    });
    expect(JSON.stringify(verification?.event.payload)).not.toContain(
      'passed\\nwarning',
    );
    expect(verification?.artifacts?.[0]).toMatchObject({
      eventId: verification.event.id,
      kind: 'verification-output',
    });
    expect(deriveCodexCommandSegments(post, parent)).toEqual(children);
  });
  it('classifies Node, pytest, cargo, Go, nonverification, and ambiguous responses', () => {
    for (const [command, framework] of [
      ['pnpm test', 'node'],
      ['python3 -m pytest', 'pytest'],
      ['cargo test', 'cargo'],
      ['go test ./...', 'go'],
    ] as const) {
      const input = hook('PostToolUse', command, {
        output: 'ok',
        exitCode: 0,
        durationMs: 7,
      });
      const parent = normalizeCodexHook(input, { clock });
      const derived = deriveCodexCommandSegments(input, parent);
      expect(derived[1]?.event).toMatchObject({
        type: 'test.completed',
        status: 'completed',
        payload: { kind: 'test', category: 'test', framework, success: true },
      });
      expect(derived[1]?.artifacts).toHaveLength(1);
    }
    const nonVerification = hook('PostToolUse', 'git status', {
      exitCode: 0,
      output: 'clean',
    });
    const nonVerificationDerived = deriveCodexCommandSegments(
      nonVerification,
      normalizeCodexHook(nonVerification, { clock }),
    );
    expect(nonVerificationDerived).toHaveLength(1);
    expect(nonVerificationDerived[0]?.artifacts).toBeUndefined();
    expect(
      deriveCodexCommandSegments(
        hook('PostToolUse', 'pnpm test', { output: 'unknown' }),
        normalizeCodexHook(
          hook('PostToolUse', 'pnpm test', { output: 'unknown' }),
          { clock },
        ),
      )[0]?.event.type,
    ).toBe('capture.gap');
    expect(() =>
      hook('PostToolUse', 'pnpm test', {
        exitCode: Infinity,
        durationMs: Infinity,
      }),
    ).toThrow();
  });
});

describe('pure repository derivation', () => {
  const clock = () => new Date('2026-08-03T12:00:00.000Z');
  const parent = () => normalizeCodexHook(fixture('PostToolUse'), { clock });
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
  const snapshot = (
    phase: 'baseline' | 'event' | 'final',
    cumulativeDiff = '',
  ) => ({
    kind: 'snapshot' as const,
    phase,
    rootHash: 'a'.repeat(64),
    baseCommit: BASE_COMMIT,
    headCommit: NEXT_COMMIT,
    dirtyPatchHash: 'b'.repeat(64),
    changedFiles: [
      { status: ' M', path: 'z.ts' },
      { status: 'A ', path: 'a.ts' },
    ],
    cumulativeDiff,
    truncated: false,
  });
  it('derives phase-safe repository evidence without placing diffs in normalized events', () => {
    const baseline = deriveCodexRepositorySegments(
      parent(),
      snapshot('baseline'),
      fingerprint,
    );
    expect(baseline[0]?.session).toMatchObject({
      baseCommit: BASE_COMMIT,
      runFingerprint: fingerprint,
    });
    expect(baseline[0]?.session.finalCommit).toBeUndefined();
    expect(baseline[0]?.artifacts).toBeUndefined();
    const diff = 'SENTINEL_DIFF /absolute/cwd';
    const event = deriveCodexRepositorySegments(
      parent(),
      snapshot('event', diff),
    );
    expect(event[0]?.event).toMatchObject({
      type: 'git.snapshot',
      source: 'vcs',
      parentEventId: parent().event.id,
    });
    expect(event[0]?.artifacts?.[0]).toMatchObject({
      kind: 'git-diff',
      eventId: event[0]?.event.id,
      content: diff,
    });
    expect(JSON.stringify(event[0]?.event)).not.toContain(diff);
    expect(JSON.stringify(event[0]?.event)).not.toContain('/absolute/cwd');
    expect(
      event
        .slice(1)
        .map((item) => (item.event.payload as { path?: string }).path),
    ).toEqual(['a.ts', 'z.ts']);
    expect(
      event
        .slice(1)
        .every((item) => item.event.parentEventId === event[0]?.event.id),
    ).toBe(true);
    const final = deriveCodexRepositorySegments(parent(), snapshot('final'));
    expect(final[0]?.session).toMatchObject({ finalCommit: NEXT_COMMIT });
    expect(final[0]?.session.baseCommit).toBeUndefined();
  });
  it('creates safe deterministic gap and collision-free repository children', () => {
    const input = parent();
    const gap = deriveCodexRepositorySegments(input, {
      kind: 'gap',
      phase: 'event',
      reason: 'not-git',
      message: '/secret/path',
    });
    expect(gap[0]?.event).toMatchObject({
      type: 'capture.gap',
      parentEventId: input.event.id,
    });
    expect(JSON.stringify(gap[0]?.event)).not.toContain('/secret/path');
    const repository = deriveCodexRepositorySegments(
      input,
      snapshot('event', 'd'),
    );
    const commandHook = parseCodexHook({
      ...fixture('PostToolUse'),
      tool_input: { cmd: 'pnpm test' },
      tool_response: { exitCode: 0, output: 'ok' },
    });
    const command = deriveCodexCommandSegments(commandHook, input);
    const all = [...repository, ...command];
    expect(new Set(all.map((item) => item.event.id)).size).toBe(all.length);
    expect(new Set(all.map((item) => item.raw.sourceEventId)).size).toBe(
      all.length,
    );
    expect(new Set(all.map((item) => item.event.sequence)).size).toBe(
      all.length,
    );
    expect(
      deriveCodexRepositorySegments(input, snapshot('event', 'd')),
    ).toEqual(repository);
    const truncated = deriveCodexRepositorySegments(input, {
      ...snapshot('event', 'd'),
      truncated: true,
    });
    expect(truncated.at(-1)?.event).toMatchObject({
      type: 'capture.gap',
      parentEventId: truncated[0]?.event.id,
      payload: {
        dataClass: 'fileDiffs',
        state: 'partial',
        reason: 'repository-capture-bounded',
      },
    });
  });
});

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
  it('stores opaque, bounded baseline pointers and removes only the exact file', async () => {
    const stateDir = await directory();
    const session = 'raw-session-secret';
    const pointer = {
      version: 1 as const,
      baseCommit: BASE_COMMIT,
      rootHash: 'a'.repeat(64),
    };
    expect(
      await writeCodexBaselinePointer(stateDir, session, {
        ...pointer,
        baseCommit: '--output=private.txt',
      }),
    ).toBe(false);
    expect(await writeCodexBaselinePointer(stateDir, session, pointer)).toBe(
      true,
    );
    expect(await readCodexBaselinePointer(stateDir, session)).toEqual(pointer);
    const pointerDirectory = join(stateDir, 'capture', 'codex');
    const names = await readdir(pointerDirectory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(names.join()).not.toContain(session);
    expect(
      (await readFile(join(pointerDirectory, names[0]!))).toString(),
    ).not.toContain(session);
    expect(
      await writeCodexBaselinePointer(stateDir, session, {
        ...pointer,
        baseCommit: NEXT_COMMIT,
      }),
    ).toBe(true);
    expect(
      (await readCodexBaselinePointer(stateDir, session))?.baseCommit,
    ).toBe(NEXT_COMMIT);
    await writeFile(join(pointerDirectory, 'sibling'), 'keep');
    expect(await removeCodexBaselinePointer(stateDir, session)).toBe(true);
    expect(await readFile(join(pointerDirectory, 'sibling'), 'utf8')).toBe(
      'keep',
    );
    expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
  });
  it('degrades safely for missing, malformed, oversized, and symlink baseline pointers', async () => {
    const stateDir = await directory();
    const session = 'baseline-safety';
    expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
    expect(await removeCodexBaselinePointer(stateDir, session)).toBe(false);
    const pointer = {
      version: 1 as const,
      baseCommit: BASE_COMMIT,
      rootHash: 'b'.repeat(64),
    };
    await writeCodexBaselinePointer(stateDir, session, pointer);
    const pointerDirectory = join(stateDir, 'capture', 'codex');
    const name = (await readdir(pointerDirectory))[0]!;
    const path = join(pointerDirectory, name);
    await writeFile(path, JSON.stringify({ ...pointer, baseCommit: '--stat' }));
    expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
    await writeFile(path, '{');
    expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
    await writeFile(path, 'x'.repeat(4097));
    expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
    const target = join(stateDir, 'target');
    await writeFile(target, 'keep');
    await rm(path);
    try {
      await symlink(target, path);
      expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
      expect(await removeCodexBaselinePointer(stateDir, session)).toBe(false);
      expect(await readFile(target, 'utf8')).toBe('keep');
    } catch (error) {
      if (
        !['EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  });
  it('rejects symlink baseline directories and uses restrictive POSIX modes', async () => {
    const stateDir = await directory();
    const target = await directory('vibetrace-target-');
    const session = 'directory-safety';
    const pointer = {
      version: 1 as const,
      baseCommit: BASE_COMMIT,
      rootHash: 'c'.repeat(64),
    };
    try {
      await symlink(target, join(stateDir, 'capture'));
      expect(await writeCodexBaselinePointer(stateDir, session, pointer)).toBe(
        false,
      );
      expect(await readCodexBaselinePointer(stateDir, session)).toBeUndefined();
      expect(await removeCodexBaselinePointer(stateDir, session)).toBe(false);
      expect(await readdir(target)).toEqual([]);
    } catch (error) {
      if (
        !['EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
    const clean = await directory();
    await writeCodexBaselinePointer(clean, session, pointer);
    if (process.platform !== 'win32') {
      const codex = join(clean, 'capture', 'codex');
      const file = join(codex, (await readdir(codex))[0]!);
      expect((await stat(join(clean, 'capture'))).mode & 0o077).toBe(0);
      expect((await stat(codex)).mode & 0o077).toBe(0);
      expect((await stat(file)).mode & 0o077).toBe(0);
    }
  });
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

  it('applies privacy profiles before data reaches the spool', () => {
    const minimalInput = fixture('UserPromptSubmit');
    minimalInput.prompt =
      'ship this change token=sk-test-secret-value-1234567890';
    const minimal = normalizeCodexHook(minimalInput, {
      captureProfile: captureProfilePolicy('minimal'),
      sourceVersion: '0.144.3',
    });
    expect(JSON.stringify(minimal)).not.toContain('sk-test-secret-value');
    expect(minimal.event.payload).toMatchObject({
      content: '[OMITTED:profile-minimal]',
    });

    const standardInput = fixture('PostToolUse');
    standardInput.tool_response = {
      output:
        'Authorization: Bearer secret-bearer-value-123456789\nPATH=/private/user/workspace',
      environment: { DATABASE_PASSWORD: 'do-not-persist' },
    };
    const standard = normalizeCodexHook(standardInput, {
      captureProfile: captureProfilePolicy('standard'),
      sourceVersion: '0.144.3',
    });
    expect(JSON.stringify(standard)).not.toContain('secret-bearer-value');
    expect(JSON.stringify(standard)).not.toContain('do-not-persist');
    expect(JSON.stringify(standard)).not.toContain('/private/user/workspace');
    expect(standard.event.redactions?.length).toBeGreaterThan(0);
  });

  it('normalizes structured PostToolUse failure and decline outcomes', () => {
    const post = fixture('PostToolUse');
    expect(
      normalizeCodexHook({ ...post, tool_response: { isError: true } }).event
        .status,
    ).toBe('failed');
    expect(
      normalizeCodexHook({ ...post, tool_response: { exitCode: 1 } }).event
        .status,
    ).toBe('failed');
    expect(
      normalizeCodexHook({ ...post, tool_response: { status: 'declined' } })
        .event.status,
    ).toBe('declined');
    expect(
      normalizeCodexHook({ ...post, tool_response: { output: 'ok' } }).event
        .status,
    ).toBe('completed');
  });

  it('makes the missing PermissionRequest resolution visible as a capture gap', async () => {
    const stateDir = await directory();
    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    const input = parseCodexHook(fixture('PermissionRequest'));
    const parent = normalizeCodexHook(input, { sourceVersion: '0.144.3' });
    expect(
      deriveCodexApprovalCoverageSegment(input, parent)?.event,
    ).toMatchObject({
      type: 'capture.gap',
      payload: {
        dataClass: 'approvals',
        affectedEventTypes: ['permission.resolved'],
      },
      provenance: { captureMode: 'partial' },
    });
    await collectCodexHook(JSON.stringify(input), {
      stateDir,
      sourceVersion: '0.144.3',
      enrichTranscript: false,
      enrichRepository: false,
    });
    await expect(importSpool(storage, stateDir)).resolves.toEqual({
      imported: 2,
      quarantined: 0,
    });
    expect(
      storage
        .listEvents({ sessionId: parent.event.sessionId })
        .map((item) => item.event.type),
    ).toEqual(['permission.requested', 'capture.gap']);
    storage.close();
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
      enrichRepository: false,
    });
    await collectCodexHook(JSON.stringify(fixture('PostToolUse')), {
      stateDir,
      clock,
      sourceVersion: '0.144.3',
      enrichTranscript: false,
      enrichRepository: false,
    });
    await expect(importSpool(storage, stateDir)).resolves.toEqual({
      imported: 4,
      quarantined: 0,
    });
    expect(storage.listEvents({ sessionId: pre.event.sessionId })).toHaveLength(
      4,
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
      enrichRepository: false,
    });
    await collectCodexHook(JSON.stringify(CODEX_CURRENT_SESSION_END_FIXTURE), {
      stateDir,
      sourceVersion: '0.145.0',
      clock: () => new Date('2026-08-03T12:10:00.000Z'),
      enrichTranscript: false,
      enrichRepository: false,
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

describe('collector repository and verification enrichment', () => {
  it('imports verification output through the encrypted blob boundary', async () => {
    const stateDir = await directory();
    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    const common = {
      session_id: 'session-command-artifact',
      cwd: stateDir,
      tool_name: 'Bash',
      tool_use_id: 'tool-verification',
      tool_input: { command: 'pnpm test' },
    };
    const pre = { ...fixture('PreToolUse'), ...common };
    const post = {
      ...fixture('PostToolUse'),
      ...common,
      tool_response: {
        exitCode: 1,
        durationMs: 37,
        stdout: 'one test failed',
        stderr: 'assertion details',
      },
    };
    const options = {
      stateDir,
      sourceVersion: '0.144.3',
      enrichRepository: false,
      enrichTranscript: false,
      clock: () => new Date('2026-08-03T12:00:00.000Z'),
    } as const;
    expect(await collectCodexHook(JSON.stringify(pre), options)).toBe(true);
    expect(await collectCodexHook(JSON.stringify(post), options)).toBe(true);
    await expect(importSpool(storage, stateDir)).resolves.toMatchObject({
      quarantined: 0,
    });

    const sessionId = normalizeCodexHook(pre, options).event.sessionId;
    const events = storage.listEvents({ sessionId });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'command.started',
        'command.completed',
        'test.completed',
      ]),
    );
    const verification = events.find(
      (event) => event.type === 'test.completed',
    );
    expect(verification?.event.payload).toMatchObject({
      success: false,
      exitCode: 1,
      durationMs: 37,
    });
    expect(JSON.stringify(verification?.event.payload)).not.toContain(
      'one test failed\\nassertion details',
    );
    const artifacts = storage.listArtifacts(sessionId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.eventId).toBe(verification?.id);
    expect(
      await streamText(await storage.blobs.open(artifacts[0]!.blobHash!)),
    ).toBe('one test failed\nassertion details');
    storage.close();
  });

  it('captures baseline, cumulative changes, final state, and a private fingerprint', async () => {
    const stateDir = await directory();
    const cwd = await gitRepository();
    const sentinelEnvironment = 'VIBETRACE_ENV_VALUE_MUST_NOT_PERSIST';
    const sentinelInstruction = 'PRIVATE_AGENTS_CONTENT_MUST_BE_HASHED';
    const sentinelLockfile = 'PRIVATE_LOCKFILE_CONTENT_MUST_BE_HASHED';
    const sentinelApproval = 'APPROVAL_POLICY_SECRET_MUST_NOT_PERSIST';
    const sentinelSandbox = 'SANDBOX_POLICY_SECRET_MUST_NOT_PERSIST';
    const sentinelNetwork = 'NETWORK_POLICY_SECRET_MUST_NOT_PERSIST';
    const previous = process.env.VIBETRACE_TEST_SENTINEL;
    process.env.VIBETRACE_TEST_SENTINEL = sentinelEnvironment;
    await writeFile(join(cwd, 'AGENTS.md'), sentinelInstruction);
    await writeFile(join(cwd, 'pnpm-lock.yaml'), sentinelLockfile);
    const sessionId = 'session-real-repository';
    const start = {
      ...fixture('SessionStart'),
      session_id: sessionId,
      cwd,
      approval_policy: sentinelApproval,
      sandbox_policy: sentinelSandbox,
      network_policy: sentinelNetwork,
    };
    const post = {
      ...fixture('PostToolUse'),
      session_id: sessionId,
      cwd,
      turn_id: 'turn-real-repository',
      tool_name: 'Bash',
      tool_use_id: 'tool-real-repository',
      tool_input: { command: 'pnpm test' },
      tool_response: { exitCode: 0, output: 'tests passed', durationMs: 9 },
    };
    const end = {
      ...CODEX_CURRENT_SESSION_END_FIXTURE,
      session_id: sessionId,
      cwd,
    };
    try {
      expect(
        await collectCodexHook(JSON.stringify(start), {
          stateDir,
          sourceVersion: '0.145.0',
          enrichTranscript: false,
        }),
      ).toBe(true);
      await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
      await writeFile(join(cwd, 'untracked.txt'), 'new evidence\n');
      expect(
        await collectCodexHook(JSON.stringify(post), {
          stateDir,
          sourceVersion: '0.145.0',
          enrichTranscript: false,
        }),
      ).toBe(true);
      expect(
        await collectCodexHook(JSON.stringify(end), {
          stateDir,
          sourceVersion: '0.145.0',
          enrichTranscript: false,
        }),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.VIBETRACE_TEST_SENTINEL;
      else process.env.VIBETRACE_TEST_SENTINEL = previous;
    }

    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    await expect(importSpool(storage, stateDir)).resolves.toMatchObject({
      quarantined: 0,
    });
    const canonicalSessionId = normalizeCodexHook(start).event.sessionId;
    const session = storage.getSession(canonicalSessionId);
    expect(session).toMatchObject({
      status: 'completed',
      baseCommit: expect.any(String),
      finalCommit: expect.any(String),
    });
    expect(session?.baseCommit).toBe(session?.finalCommit);
    const fingerprintText = JSON.stringify(session?.runFingerprint);
    for (const excluded of [
      sentinelEnvironment,
      sentinelInstruction,
      sentinelLockfile,
      sentinelApproval,
      sentinelSandbox,
      sentinelNetwork,
      cwd,
      sessionId,
    ])
      expect(fingerprintText).not.toContain(excluded);
    expect(session?.runFingerprint?.instructionHashes).toHaveLength(1);
    expect(session?.runFingerprint?.lockfileHashes).toHaveLength(1);
    expect(session?.runFingerprint).toMatchObject({
      approvalPolicy: 'default',
    });
    expect(session?.runFingerprint?.captureOmissions).toContain(
      'unrecognized-policy',
    );

    const events = storage.listEvents({ sessionId: canonicalSessionId });
    expect(
      events.filter((event) => event.type === 'git.snapshot'),
    ).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['file.changed', 'test.completed']),
    );
    for (const event of events)
      expect(event.event.provenance).toMatchObject({
        adapter: 'codex-hooks',
        sourceVersion: '0.145.0',
      });
    const diffArtifacts = storage
      .listArtifacts(canonicalSessionId)
      .filter((artifact) => artifact.kind === 'git-diff');
    expect(diffArtifacts.length).toBeGreaterThan(0);
    const diff = (
      await Promise.all(
        diffArtifacts.map(async (artifact) =>
          streamText(await storage.blobs.open(artifact.blobHash!)),
        ),
      )
    ).join('\n');
    expect(diff).toContain('tracked.txt');
    expect(diff).toContain('untracked untracked.txt sha256:');
    expect(await readCodexBaselinePointer(stateDir, sessionId)).toBeUndefined();
    storage.close();
  });

  it('keeps Stop as a checkpoint and reserves final metadata for SessionEnd', async () => {
    const stateDir = await directory();
    const sourceSessionId = 'session-stop-checkpoint';
    const rootHash = 'a'.repeat(64);
    const emptyHashes: FingerprintFileHashes = {
      instructions: [],
      lockfiles: [],
      omissions: [],
    };
    const capture = async (
      _cwd: string,
      options: { phase: 'baseline' | 'event' | 'final'; baseCommit?: string },
    ): Promise<RepositorySnapshot> => ({
      kind: 'snapshot',
      phase: options.phase,
      rootHash,
      baseCommit: options.baseCommit ?? BASE_COMMIT,
      headCommit: options.phase === 'final' ? FINAL_COMMIT : BASE_COMMIT,
      dirtyPatchHash: 'b'.repeat(64),
      changedFiles: [],
      cumulativeDiff: '',
      truncated: false,
    });
    const commonOptions = {
      stateDir,
      sourceVersion: '0.145.0',
      enrichTranscript: false,
      captureRepository: capture,
      hashFingerprint: async () => emptyHashes,
    } as const;
    const start = {
      ...fixture('SessionStart'),
      session_id: sourceSessionId,
    };
    const stop = {
      ...fixture('Stop'),
      session_id: sourceSessionId,
      last_assistant_message: null,
    };
    const end = {
      ...CODEX_CURRENT_SESSION_END_FIXTURE,
      session_id: sourceSessionId,
    };
    expect(await collectCodexHook(JSON.stringify(start), commonOptions)).toBe(
      true,
    );
    expect(await collectCodexHook(JSON.stringify(stop), commonOptions)).toBe(
      true,
    );
    expect(
      await readCodexBaselinePointer(stateDir, sourceSessionId),
    ).toMatchObject({ baseCommit: BASE_COMMIT });
    const storage = await Storage.initialize({
      stateDir,
      keyProvider: new MemoryKeyProvider(),
    });
    await importSpool(storage, stateDir);
    const canonicalSessionId = normalizeCodexHook(start).event.sessionId;
    expect(storage.getSession(canonicalSessionId)?.finalCommit).toBeUndefined();

    expect(await collectCodexHook(JSON.stringify(end), commonOptions)).toBe(
      true,
    );
    await importSpool(storage, stateDir);
    expect(storage.getSession(canonicalSessionId)?.finalCommit).toBe(
      FINAL_COMMIT,
    );
    expect(
      await readCodexBaselinePointer(stateDir, sourceSessionId),
    ).toBeUndefined();
    storage.close();
  });

  it('preserves original capture when injected repository enrichment fails', async () => {
    const stateDir = await directory();
    const start = {
      ...fixture('SessionStart'),
      session_id: 'session-enrichment-failure',
    };
    expect(
      await collectCodexHook(JSON.stringify(start), {
        stateDir,
        enrichTranscript: false,
        captureRepository: async () => {
          throw new Error('unsafe injected detail');
        },
        hashFingerprint: async () => {
          throw new Error('private injected detail');
        },
      }),
    ).toBe(true);
    const files = (await readdir(spoolPaths(stateDir).incoming)).filter(
      (name) => name.endsWith('.jsonl'),
    );
    expect(files).toHaveLength(2);
    const contents = await Promise.all(
      files.map((name) =>
        readFile(join(spoolPaths(stateDir).incoming, name), 'utf8'),
      ),
    );
    expect(contents.join('')).not.toContain('unsafe injected detail');
    expect(contents.join('')).not.toContain('private injected detail');
    expect(contents.some((value) => value.includes('repositoryState'))).toBe(
      true,
    );
  });

  it('rejects a baseline pointer from a different repository root', async () => {
    const stateDir = await directory();
    const sourceSessionId = 'session-root-mismatch';
    await writeCodexBaselinePointer(stateDir, sourceSessionId, {
      version: 1,
      baseCommit: BASE_COMMIT,
      rootHash: 'a'.repeat(64),
    });
    const stop = {
      ...fixture('Stop'),
      session_id: sourceSessionId,
      last_assistant_message: null,
    };
    expect(
      await collectCodexHook(JSON.stringify(stop), {
        stateDir,
        enrichTranscript: false,
        hashFingerprint: async () => ({
          instructions: [],
          lockfiles: [],
          omissions: [],
        }),
        captureRepository: async (_cwd, options) => ({
          kind: 'snapshot',
          phase: options.phase,
          rootHash: 'b'.repeat(64),
          baseCommit: options.baseCommit ?? NEXT_COMMIT,
          headCommit: NEXT_COMMIT,
          dirtyPatchHash: 'c'.repeat(64),
          changedFiles: [],
          cumulativeDiff: '',
          truncated: false,
        }),
      }),
    ).toBe(true);
    const contents = await Promise.all(
      (await readdir(spoolPaths(stateDir).incoming))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) =>
          readFile(join(spoolPaths(stateDir).incoming, name), 'utf8'),
        ),
    );
    expect(contents.some((value) => value.includes('invalid-output'))).toBe(
      true,
    );
    expect(
      await readCodexBaselinePointer(stateDir, sourceSessionId),
    ).toMatchObject({ baseCommit: BASE_COMMIT });
  });
});

describe('silent spool collector', () => {
  it('reads the active profile from an owner-only policy file', async () => {
    const stateDir = await directory();
    await writeCaptureProfilePolicy(stateDir, captureProfilePolicy('minimal'));
    expect(await readCaptureProfilePolicy(stateDir)).toMatchObject({
      mode: 'minimal',
      capturePrompts: false,
    });
    await expect(
      collectCodexHook(
        JSON.stringify({
          ...fixture('UserPromptSubmit'),
          prompt: 'private prompt',
        }),
        { stateDir, enrichTranscript: false },
      ),
    ).resolves.toBe(true);
    const files = await readdir(spoolPaths(stateDir).incoming);
    const content = await readFile(
      join(spoolPaths(stateDir).incoming, files[0] as string),
      'utf8',
    );
    expect(content).not.toContain('private prompt');
  });

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
        enrichRepository: false,
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
