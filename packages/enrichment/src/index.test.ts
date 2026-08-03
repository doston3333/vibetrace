import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFileHistory,
  captureRepositoryState,
  classifyVerificationHistory,
  classifyCommand,
  createRunFingerprint,
  hashFingerprintFiles,
  parseVerification,
  tokenizeCommand,
} from './index.js';

const exec = promisify(execFile);
const directories: string[] = [];
const BASE_COMMIT = 'a'.repeat(40);
const HEAD_COMMIT = 'b'.repeat(40);
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});
async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vibetrace-git-'));
  directories.push(path);
  const run = async (...args: string[]) =>
    exec('git', args, { cwd: path, shell: false });
  await run('init');
  await run('config', 'user.email', 'test@example.com');
  await run('config', 'user.name', 'Test');
  await writeFile(join(path, 'tracked.txt'), 'base');
  await run('add', 'tracked.txt');
  await run('commit', '-m', 'base');
  return path;
}

describe('deterministic command enrichment', () => {
  it('classifies Node, Python, Rust, Go, Git, and safe fallback forms', () => {
    const cases = [
      ['rg "two words" src', 'search'],
      ['cat README.md', 'read'],
      ['apply_patch patch.diff', 'edit'],
      ['pnpm test -- --runInBand', 'test'],
      ['pnpm exec vitest run', 'test'],
      ['npx vitest run', 'test'],
      ['python3 -m pytest -q', 'test'],
      ['uv run pytest -q', 'test'],
      ['cargo test --workspace', 'test'],
      ['go test ./...', 'test'],
      ['env NODE_ENV=test pnpm lint', 'lint'],
      ['npx eslint src', 'lint'],
      ['cargo clippy', 'lint'],
      ['go vet ./...', 'lint'],
      ['npm run build', 'build'],
      ['cargo build --release', 'build'],
      ['go build ./...', 'build'],
      ['pnpm typecheck', 'typecheck'],
      ['npx tsc --noEmit', 'typecheck'],
      ['cargo check', 'typecheck'],
      ['pnpm install --frozen-lockfile', 'package-install'],
      ['npm.cmd ci', 'package-install'],
      ['C:\\Tools\\git.exe status --porcelain', 'git'],
      ['curl https://example.invalid', 'network'],
      ['pnpm test&&curl example.invalid', 'unknown'],
      ['custom-tool --flag', 'unknown'],
    ] as const;
    for (const [command, expected] of cases)
      expect(classifyCommand(command), command).toBe(expected);
  });
  it('captures clean, staged, unstaged, renamed, and untracked Git state without a root path', async () => {
    const path = await repo();
    const baseline = await captureRepositoryState(path, { phase: 'baseline' });
    expect(baseline).toMatchObject({ kind: 'snapshot', changedFiles: [] });
    await writeFile(join(path, 'tracked.txt'), 'staged');
    await exec('git', ['add', 'tracked.txt'], { cwd: path, shell: false });
    await writeFile(join(path, 'other.txt'), 'unstaged');
    await writeFile(join(path, 'new.txt'), 'one');
    const event = await captureRepositoryState(path, {
      phase: 'event',
      baseCommit:
        baseline.kind === 'snapshot' ? baseline.baseCommit : undefined,
    });
    expect(event.kind).toBe('snapshot');
    if (event.kind === 'snapshot') {
      expect(event.changedFiles.map((file) => file.path)).toEqual(
        expect.arrayContaining(['tracked.txt', 'other.txt', 'new.txt']),
      );
      expect(event.cumulativeDiff).not.toContain(path);
      const first = event.dirtyPatchHash;
      await writeFile(join(path, 'new.txt'), 'two');
      const changed = await captureRepositoryState(path, {
        phase: 'final',
        baseCommit: event.baseCommit,
      });
      expect(changed.kind === 'snapshot' && changed.dirtyPatchHash).not.toBe(
        first,
      );
    }
  });
  it('returns safe gaps and sends only argument-array git calls', async () => {
    const path = await mkdtemp(join(tmpdir(), 'vibetrace-not-git-'));
    directories.push(path);
    expect(
      await captureRepositoryState(path, { phase: 'baseline' }),
    ).toMatchObject({ kind: 'gap', reason: 'not-git' });
    const calls: unknown[] = [];
    const result = await captureRepositoryState(path, {
      phase: 'event',
      runner: async (executable, args, options) => {
        calls.push([executable, args, options]);
        throw new Error('not a git repository');
      },
    });
    expect(result).toMatchObject({ kind: 'gap', reason: 'not-git' });
    expect(calls).toHaveLength(1);
    expect((calls[0] as [string, unknown, { shell: boolean }])[0]).toBe('git');
    expect((calls[0] as [string, unknown, { shell: boolean }])[2].shell).toBe(
      false,
    );
  });

  it('records git mv rename orientation as the new path and previous path', async () => {
    const path = await repo();
    await exec('git', ['mv', 'tracked.txt', 'renamed.txt'], {
      cwd: path,
      shell: false,
    });
    const snapshot = await captureRepositoryState(path, { phase: 'event' });
    expect(snapshot).toMatchObject({ kind: 'snapshot' });
    if (snapshot.kind === 'snapshot') {
      expect(snapshot.changedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: expect.stringContaining('R'),
            path: 'renamed.txt',
            previousPath: 'tracked.txt',
          }),
        ]),
      );
    }
  });

  it('disables configured external diff and text-conversion helpers', async () => {
    const path = await repo();
    await exec('git', ['config', 'diff.external', '__must_not_execute__'], {
      cwd: path,
      shell: false,
    });
    await exec(
      'git',
      ['config', 'diff.vibetrace.textconv', '__must_not_execute__'],
      { cwd: path, shell: false },
    );
    await writeFile(
      join(path, '.gitattributes'),
      'tracked.txt diff=vibetrace\n',
    );
    await writeFile(join(path, 'tracked.txt'), 'changed');
    expect(
      await captureRepositoryState(path, { phase: 'event' }),
    ).toMatchObject({ kind: 'snapshot' });
  });

  it('rejects a symlink cwd before invoking the runner', async () => {
    const path = await repo();
    const linked = `${path}-link`;
    try {
      await symlink(path, linked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    directories.push(linked);
    let called = false;
    const snapshot = await captureRepositoryState(linked, {
      phase: 'baseline',
      runner: async () => {
        called = true;
        return '';
      },
    });
    expect(snapshot).toMatchObject({ kind: 'gap', reason: 'unsafe-cwd' });
    expect(called).toBe(false);
  });

  it('rejects a baseline option before invoking Git', async () => {
    const path = await repo();
    let called = false;
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      baseCommit: '--output=private.txt',
      runner: async () => {
        called = true;
        return '';
      },
    });
    expect(snapshot).toMatchObject({ kind: 'gap', reason: 'invalid-output' });
    expect(called).toBe(false);
  });

  it('rejects a noncanonical object ID returned by Git', async () => {
    const path = await repo();
    let calls = 0;
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      runner: async (_executable, args) => {
        calls += 1;
        return args[1] === '--show-toplevel' ? path : '--stat';
      },
    });
    expect(snapshot).toMatchObject({ kind: 'gap', reason: 'invalid-output' });
    expect(calls).toBe(2);
  });

  it('rejects a Git root outside the inspected working tree', async () => {
    const path = await repo();
    const other = await mkdtemp(join(tmpdir(), 'vibetrace-hostile-root-'));
    directories.push(other);
    let calls = 0;
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      runner: async () => {
        calls += 1;
        return other;
      },
    });
    expect(snapshot).toMatchObject({ kind: 'gap', reason: 'invalid-output' });
    expect(calls).toBe(1);
  });

  it('bounds the complete repository capture deadline', async () => {
    const path = await repo();
    const started = Date.now();
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      runner: () => new Promise<string>(() => undefined),
    });
    const elapsed = Date.now() - started;
    expect(snapshot).toMatchObject({
      kind: 'gap',
      reason: 'git-unavailable-or-timeout',
    });
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('caps untracked inventories and marks the snapshot truncated', async () => {
    const path = await repo();
    const untracked = Array.from(
      { length: 1_001 },
      (_value, index) => `generated-${index}.txt`,
    );
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      runner: async (_executable, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
          return path;
        if (args[0] === 'rev-parse') return HEAD_COMMIT;
        if (args[0] === 'diff') return '';
        return `${untracked.join('\0')}\0`;
      },
    });
    expect(snapshot).toMatchObject({ kind: 'snapshot', truncated: true });
    if (snapshot.kind === 'snapshot')
      expect(snapshot.changedFiles).toHaveLength(1_000);
  });

  it('does not read an untracked path through an intermediate symlink', async () => {
    const path = await repo();
    const outside = await mkdtemp(join(tmpdir(), 'vibetrace-outside-'));
    directories.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'SENTINEL_OUTSIDE_SECRET');
    await symlink(outside, join(path, 'linked'));
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      runner: async (_executable, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
          return path;
        if (args[0] === 'rev-parse') return HEAD_COMMIT;
        if (args[0] === 'diff') return '';
        return 'linked/secret.txt\0';
      },
    });
    expect(snapshot).toMatchObject({ kind: 'snapshot' });
    if (snapshot.kind === 'snapshot') {
      expect(snapshot.cumulativeDiff).toContain('[unsafe]');
      expect(snapshot.cumulativeDiff).not.toContain('SENTINEL_OUTSIDE_SECRET');
    }
  });

  it('maps runner timeout and bounded-output errors without leaking details', async () => {
    const path = await repo();
    for (const [message, reason] of [
      ['timed out SECRET', 'git-unavailable-or-timeout'],
      ['stdout maxBuffer SECRET', 'oversized-output'],
    ] as const) {
      const snapshot = await captureRepositoryState(path, {
        phase: 'event',
        runner: async () => {
          throw new Error(message);
        },
      });
      expect(snapshot).toMatchObject({ kind: 'gap', reason });
      if (snapshot.kind === 'gap')
        expect(snapshot.message).not.toContain('SECRET');
    }
  });

  it('rejects invalid absolute and traversal Git paths and records bounded runner options', async () => {
    const path = await repo();
    const calls: Array<readonly unknown[]> = [];
    const runner = async (
      executable: 'git',
      args: readonly string[],
      options: {
        readonly shell: false;
        readonly timeout: number;
        readonly maxBuffer: number;
      },
    ): Promise<string> => {
      calls.push([executable, args, options]);
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return path;
      if (args[0] === 'rev-parse') return HEAD_COMMIT;
      if (args[0] === 'diff' && args[1] === '--name-status')
        return 'M\0/absolute\0';
      if (args[0] === 'diff') return '';
      return '../traverse\0';
    };
    expect(
      await captureRepositoryState(path, { phase: 'event', runner }),
    ).toMatchObject({ kind: 'gap', reason: 'invalid-output' });
    expect(calls).toHaveLength(4);
    const diffCall = calls.find(
      (call) => (call[1] as readonly string[])[1] === '--binary',
    );
    expect(diffCall?.[1]).toEqual([
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      HEAD_COMMIT,
      '--',
    ]);
    for (const [executable, args, options] of calls as Array<
      [string, unknown, { shell: boolean; timeout: number; maxBuffer: number }]
    >) {
      expect(executable).toBe('git');
      expect(Array.isArray(args)).toBe(true);
      expect(options.shell).toBe(false);
      expect(options.timeout).toBeLessThanOrEqual(2_000);
      expect(options.maxBuffer).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });

  it('rejects traversal paths from the untracked inventory', async () => {
    const path = await repo();
    const snapshot = await captureRepositoryState(path, {
      phase: 'event',
      runner: async (_executable, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
          return path;
        if (args[0] === 'rev-parse') return HEAD_COMMIT;
        if (args[0] === 'diff' || args[0] === 'status') return '';
        return '../traverse\0';
      },
    });
    expect(snapshot).toMatchObject({ kind: 'gap', reason: 'invalid-output' });
  });

  it('uses the supplied original base commit for a final snapshot after an intervening commit', async () => {
    const path = await repo();
    const base = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: path,
      shell: false,
    });
    await writeFile(join(path, 'tracked.txt'), 'intervening');
    await exec('git', ['add', 'tracked.txt'], { cwd: path, shell: false });
    await exec('git', ['commit', '-m', 'intervening'], {
      cwd: path,
      shell: false,
    });
    await writeFile(join(path, 'later.txt'), 'final');
    const final = await captureRepositoryState(path, {
      phase: 'final',
      baseCommit: base.stdout.trim(),
    });
    expect(final).toMatchObject({
      kind: 'snapshot',
      phase: 'final',
      baseCommit: base.stdout.trim(),
    });
    if (final.kind === 'snapshot') {
      expect(final.cumulativeDiff).toContain('intervening');
      expect(final.changedFiles.map((file) => file.path)).toContain(
        'later.txt',
      );
      expect(final.changedFiles.map((file) => file.path)).toContain(
        'tracked.txt',
      );
    }
  });
  it('hashes fingerprint files without retaining sentinel content or root paths', async () => {
    const path = await mkdtemp(join(tmpdir(), 'vibetrace-fingerprint-secret-'));
    directories.push(path);
    await writeFile(join(path, 'AGENTS.md'), 'SENTINEL_SECRET_VALUE');
    await writeFile(join(path, 'pnpm-lock.yaml'), 'lock');
    const files = await hashFingerprintFiles(path);
    const fingerprint = createRunFingerprint({
      clientSurface: 'cli',
      fileHashes: files,
    });
    expect(JSON.stringify(fingerprint)).not.toContain('SENTINEL_SECRET_VALUE');
    expect(JSON.stringify(fingerprint)).not.toContain(path);
    expect(fingerprint.captureOmissions).toContain(
      'plugin-manifests-unavailable',
    );
  });
  it('bounds and deterministically orders fingerprint manifest capture', async () => {
    const path = await mkdtemp(join(tmpdir(), 'vibetrace-fingerprint-bound-'));
    directories.push(path);
    const skills = join(path, '.agents', 'skills');
    for (let index = 0; index < 70; index += 1) {
      const skill = join(skills, `skill-${String(index).padStart(3, '0')}`);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), String(index));
    }
    await symlink(
      join(skills, 'skill-000', 'SKILL.md'),
      join(path, 'SKILL.md'),
    );
    await writeFile(join(path, 'pnpm-lock.yaml'), 'x'.repeat(1_048_577));
    const first = await hashFingerprintFiles(path);
    const second = await hashFingerprintFiles(path);
    expect(first).toEqual(second);
    expect(first.instructions).toHaveLength(64);
    expect(first.omissions).toEqual(
      expect.arrayContaining([
        'bounded-directory-entries',
        'bounded-file-omitted',
        'unsafe-file',
      ]),
    );
  });
  it('keeps optional fingerprint fields defined when they are observed', () => {
    const fingerprint = createRunFingerprint({
      clientSurface: 'cli',
      fileHashes: { instructions: [], lockfiles: [], omissions: [] },
      codexVersion: '0.145.0',
      model: 'gpt-5',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      approvalPolicy: 'never',
      sandboxPolicy: 'workspace-write',
      networkPolicy: 'enabled',
      policyNames: ['default'],
      configDigest: 'c'.repeat(64),
      mcpServerHashes: ['d'.repeat(64)],
    });
    expect(fingerprint).toMatchObject({
      codexVersion: '0.145.0',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      approvalPolicy: 'never',
      sandboxPolicy: 'workspace-write',
      networkPolicy: 'enabled',
      policyNames: ['default'],
      configDigest: 'c'.repeat(64),
      mcpServerHashes: ['d'.repeat(64)],
      captureOmissions: ['plugin-manifests-unavailable'],
    });
    expect(JSON.stringify(fingerprint)).not.toContain('undefined');
  });
  it('builds stable file and verification histories from evidence only', () => {
    const snapshot = {
      kind: 'snapshot' as const,
      phase: 'event' as const,
      rootHash: 'a'.repeat(64),
      baseCommit: BASE_COMMIT,
      headCommit: HEAD_COMMIT,
      dirtyPatchHash: 'b'.repeat(64),
      changedFiles: [{ status: ' M', path: 'src/a.ts' }],
      cumulativeDiff: '',
      truncated: false,
    };
    expect(
      buildFileHistory([
        { eventId: 'e2', sequence: 2, phase: 'event', snapshot },
        { eventId: 'e1', sequence: 1, phase: 'baseline', snapshot },
      ])[0],
    ).toMatchObject({ firstSequence: 1, lastSequence: 2 });
    expect(
      classifyVerificationHistory(
        [
          {
            eventId: 'before',
            sequence: 1,
            command: 'pnpm test',
            kind: 'test',
            success: false,
          },
          {
            eventId: 'after',
            sequence: 3,
            command: 'pnpm test',
            kind: 'test',
            success: false,
          },
        ],
        2,
      )[0]?.status,
    ).toBe('pre-existing');
    expect(
      classifyVerificationHistory(
        [
          {
            eventId: 'before',
            sequence: 1,
            command: 'pnpm test',
            kind: 'test',
            success: true,
          },
          {
            eventId: 'after',
            sequence: 3,
            command: 'pnpm test',
            kind: 'test',
            success: false,
          },
        ],
        2,
      )[0]?.status,
    ).toBe('introduced');
  });
  it('tokenizes quotes and produces bounded verification summaries', () => {
    expect(tokenizeCommand('rg "two words" src')).toEqual([
      'rg',
      'two words',
      'src',
    ]);
    expect(
      parseVerification('pnpm lint', 1, 'x'.repeat(2_000), 12),
    ).toMatchObject({ kind: 'lint', success: false, durationMs: 12 });
  });
  it('keeps colon commands intact and conservatively classifies comparable evidence', () => {
    const histories = classifyVerificationHistory(
      [
        {
          eventId: 'test-before',
          sequence: 1,
          command: 'pnpm test --filter pkg:a',
          kind: 'test',
          success: true,
        },
        {
          eventId: 'test-after',
          sequence: 3,
          command: 'pnpm test --filter pkg:a',
          kind: 'test',
          success: false,
        },
        {
          eventId: 'build-id',
          sequence: 1,
          command: 'pnpm build',
          kind: 'build',
          success: true,
        },
        {
          eventId: 'build-id',
          sequence: 3,
          command: 'pnpm build',
          kind: 'build',
          success: true,
        },
        {
          eventId: 'mixed-fail',
          sequence: 1,
          command: 'pnpm lint',
          kind: 'lint',
          success: false,
        },
        {
          eventId: 'mixed-pass',
          sequence: 2,
          command: 'pnpm lint',
          kind: 'lint',
          success: true,
        },
        {
          eventId: 'after-only',
          sequence: 3,
          command: 'pnpm typecheck',
          kind: 'typecheck',
          success: true,
        },
      ],
      3,
    );
    expect(histories).toEqual([
      expect.objectContaining({
        command: 'pnpm build',
        kind: 'build',
        status: 'unchanged',
        evidenceIds: ['build-id'],
      }),
      expect.objectContaining({
        command: 'pnpm lint',
        kind: 'lint',
        status: 'unknown',
      }),
      expect.objectContaining({
        command: 'pnpm test --filter pkg:a',
        kind: 'test',
        status: 'introduced',
        counterevidenceIds: ['test-before'],
      }),
      expect.objectContaining({
        command: 'pnpm typecheck',
        kind: 'typecheck',
        status: 'unknown',
      }),
    ]);
  });
});
