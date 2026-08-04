import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionId } from '@vibetrace/schema';
import { afterAll, describe, expect, it } from 'vitest';

import { evaluateAssertions, parseCommand, runEvaluation } from './index.js';

const execFile = promisify(nodeExecFile);
const directories: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', ['-C', cwd, ...args], { cwd, shell: false });
}

async function repository(): Promise<{ path: string; commit: string }> {
  const path = await mkdtemp(join(tmpdir(), 'vibetrace-eval-runner-'));
  directories.push(path);
  await git(path, ['init', '-q']);
  await git(path, ['config', 'user.email', 'test@example.invalid']);
  await git(path, ['config', 'user.name', 'VibeTrace Test']);
  await writeFile(join(path, 'README.md'), 'baseline\n');
  await git(path, ['add', 'README.md']);
  await git(path, ['commit', '-qm', 'baseline']);
  const { stdout } = await execFile('git', ['-C', path, 'rev-parse', 'HEAD'], {
    cwd: path,
    shell: false,
  });
  return { path, commit: stdout.trim() };
}

describe('isolated evaluation runner', () => {
  it('tokenizes only shell-free commands', () => {
    expect(parseCommand("pnpm test --filter 'unit tests'")).toEqual([
      'pnpm',
      'test',
      '--filter',
      'unit tests',
    ]);
    expect(() => parseCommand('pnpm test && cat .env')).toThrow(
      'unsupported shell syntax',
    );
  });

  it('evaluates command, file, regex, diff, and human assertions', async () => {
    const { path } = await repository();
    const work = await mkdtemp(join(tmpdir(), 'vibetrace-eval-checks-'));
    directories.push(work);
    await writeFile(join(work, 'result.txt'), 'authorized\n');
    const result = await evaluateAssertions({
      cwd: work,
      assertions: [
        {
          type: 'command_exit_code',
          command: 'node -e "process.exit(0)"',
          expected: 0,
        },
        { type: 'file_exists', path: 'result.txt' },
        { type: 'regex_match', path: 'result.txt', pattern: 'authorized' },
        { type: 'human_rating', prompt: 'Review', minimum: 80 },
      ],
      humanRatings: { 3: 90 },
    });
    expect(result.success).toBe(true);
    expect(result.checks.every((check) => check.status === 'passed')).toBe(
      true,
    );
    expect(path).toBeTruthy();
  });

  it('runs in a detached worktree and leaves the active checkout untouched', async () => {
    const { path, commit } = await repository();
    const sentinel = join(path, 'sentinel.txt');
    await writeFile(sentinel, 'do not change\n');
    const manifest = {
      schemaVersion: '1.0.0',
      id: createSessionId('eval', 'case-runner'),
      name: 'runner fixture',
      sourceEvidence: {
        eventIds: [],
        artifactBlobHashes: [],
        captureGapIds: [],
      },
      repository: { baseCommit: commit },
      task: {
        prompt: 'Make the fixture change.',
        constraints: [],
        inferredFields: [],
      },
      configuration: { skills: [], instructionHashes: [], inferredFields: [] },
      success: {
        assertions: [
          { type: 'file_exists' as const, path: 'created.txt' },
          {
            type: 'regex_match' as const,
            path: 'created.txt',
            pattern: 'done',
          },
        ],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const result = await runEvaluation({
      manifest,
      activeCheckout: path,
      execute: async ({ cwd }) => {
        await writeFile(join(cwd, 'created.txt'), 'done\n');
        return { output: '{"type":"turn.completed"}\n' };
      },
    });
    expect(result.success).toBe(true);
    expect(result.jsonRecordCount).toBe(1);
    expect(await readFile(sentinel, 'utf8')).toBe('do not change\n');
    await expect(
      readFile(join(path, 'created.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies and applies a pre-task patch only inside the isolated worktree', async () => {
    const { path, commit } = await repository();
    const patch =
      'diff --git a/README.md b/README.md\nindex 8f1f3a7..c4f4f2a 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-baseline\n+pre-task\n';
    const patchHash = createHash('sha256').update(patch).digest('hex');
    const manifest = {
      schemaVersion: '1.0.0',
      id: createSessionId('eval', 'patch-runner'),
      name: 'patch fixture',
      sourceEvidence: {
        eventIds: [],
        artifactBlobHashes: [],
        captureGapIds: [],
      },
      repository: {
        baseCommit: commit,
        preTaskPatchBlobHash: 'e'.repeat(64),
        preTaskPatchSha256: patchHash,
      },
      task: {
        prompt: 'Continue from the captured state.',
        constraints: [],
        inferredFields: [],
      },
      configuration: { skills: [], instructionHashes: [], inferredFields: [] },
      success: {
        assertions: [
          { type: 'human_rating' as const, prompt: 'Review', minimum: 0 },
        ],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const result = await runEvaluation({
      manifest,
      activeCheckout: path,
      patchResolver: async () => patch,
      execute: async ({ cwd }) => {
        expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe(
          'pre-task\n',
        );
        return undefined;
      },
      humanRatings: { 0: 100 },
    });
    expect(result.success).toBe(true);
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('baseline\n');
  });
});

afterAll(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
