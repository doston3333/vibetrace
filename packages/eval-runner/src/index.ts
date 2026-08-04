import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  parseEvalManifest,
  type EvalManifest,
  type SuccessAssertion,
} from '@vibetrace/eval-spec';

const execFile = promisify(nodeExecFile);

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandResult {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ExecuteOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface EvalCheck {
  readonly index: number;
  readonly type: SuccessAssertion['type'];
  readonly status: 'passed' | 'failed' | 'pending';
  readonly detail: string;
  readonly observed?: unknown;
}

export interface EvalOutcome {
  readonly success: boolean | null;
  readonly checks: readonly EvalCheck[];
  readonly commandResults: readonly CommandResult[];
}

export interface WorktreeHandle {
  readonly activeCheckout: string;
  readonly worktree: string;
  readonly cleanup: () => Promise<void>;
}

export interface EvalExecutionContext {
  readonly manifest: EvalManifest;
  readonly cwd: string;
  readonly worktree: string;
  readonly activeCheckout: string;
}

export interface EvalExecutionRecord {
  readonly commandResults?: readonly CommandResult[];
  readonly output?: string;
}

export interface RunEvaluationOptions {
  readonly manifest: EvalManifest | unknown;
  readonly activeCheckout: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly humanRatings?: Readonly<Record<number, number>>;
  readonly execute?: (
    context: EvalExecutionContext,
  ) => Promise<EvalExecutionRecord | undefined>;
  readonly patchResolver?: (
    blobHash: string,
  ) => Promise<Uint8Array | string | undefined>;
  readonly codex?: CodexExecOptions;
}

export interface EvalRunResult extends EvalOutcome {
  readonly manifestId: string;
  readonly worktreeFingerprintHash: string;
  readonly output?: string;
  readonly jsonRecordCount: number;
  readonly malformedJsonRecordCount: number;
}

export interface CodexExecOptions {
  readonly executable?: string;
  readonly extraArgs?: readonly string[];
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function safeRelativePath(value: string): string {
  text(value, 'path');
  if (
    value.includes('\0') ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    throw new Error(`Unsafe relative path: ${value}`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..'))
    throw new Error(`Path traversal is not allowed: ${value}`);
  return normalized;
}

function inside(root: string, candidate: string): boolean {
  const rootRelative = relative(root, candidate);
  return (
    rootRelative === '' ||
    (!rootRelative.startsWith(`..${sep}`) &&
      rootRelative !== '..' &&
      !isAbsolute(rootRelative))
  );
}

/** Tokenize a display command without invoking a shell or interpreting operators. */
export function parseCommand(command: string): readonly string[] {
  text(command, 'command');
  if (command.length > 16_384 || /[;&|<>`\n\r]/u.test(command))
    throw new Error('Command contains unsupported shell syntax.');
  const argv: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  const push = (): void => {
    if (current.length > 0) {
      argv.push(current);
      current = '';
    }
  };
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/u.test(character)) push();
    else current += character;
  }
  if (escaped || quote) throw new Error('Command has an unterminated quote.');
  push();
  if (argv.length === 0 || argv.length > 256)
    throw new Error('Command must contain between 1 and 256 arguments.');
  return argv;
}

/** Execute one argv vector with a hard timeout and bounded output. */
export async function executeArgv(
  argv: readonly string[],
  options: ExecuteOptions,
): Promise<CommandResult> {
  if (argv.length === 0) throw new Error('Cannot execute an empty argv.');
  const cwd = resolve(text(options.cwd, 'cwd'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
    throw new Error('timeoutMs is outside the permitted range.');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new Error('maxOutputBytes must be positive.');
  const started = Date.now();
  try {
    const result = await execFile(argv[0]!, [...argv.slice(1)], {
      cwd,
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      encoding: 'utf8',
    });
    return {
      argv: [...argv],
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      killed?: boolean;
    };
    const numericCode =
      typeof failure.code === 'number' ? failure.code : Number(failure.code);
    return {
      argv: [...argv],
      exitCode: Number.isInteger(numericCode) ? numericCode : 1,
      stdout: String(failure.stdout ?? '').slice(0, maxOutputBytes),
      stderr: String(failure.stderr ?? '').slice(0, maxOutputBytes),
      durationMs: Date.now() - started,
      timedOut: failure.signal === 'SIGTERM' || failure.killed === true,
    };
  }
}

/** Create a detached worktree beside (never inside) the active checkout. */
export async function createIsolatedWorktree(options: {
  readonly activeCheckout: string;
  readonly baseCommit: string;
}): Promise<WorktreeHandle> {
  const activeInput = text(options.activeCheckout, 'activeCheckout');
  const inputStatus = await lstat(activeInput);
  if (!inputStatus.isDirectory() || inputStatus.isSymbolicLink())
    throw new Error('Active checkout must be a real directory.');
  const active = await realpath(activeInput);
  const status = await lstat(active);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error('Active checkout must be a real directory.');
  if (!/^[a-f0-9]{40,64}$/iu.test(options.baseCommit))
    throw new Error('Invalid base commit.');
  const parent = dirname(active);
  const temporaryParent = await mkdtemp(join(parent, '.vibetrace-eval-'));
  const worktree = join(temporaryParent, 'worktree');
  if (inside(active, worktree)) {
    await rm(temporaryParent, { force: true, recursive: true });
    throw new Error(
      'Evaluation worktree must not be inside the active checkout.',
    );
  }
  const result = await executeArgv(
    [
      'git',
      '-C',
      active,
      'worktree',
      'add',
      '--detach',
      worktree,
      options.baseCommit,
    ],
    { cwd: active, timeoutMs: 120_000, maxOutputBytes: 1_000_000 },
  );
  if (result.exitCode !== 0) {
    await rm(temporaryParent, { force: true, recursive: true });
    throw new Error(
      `Could not create isolated evaluation worktree: ${result.stderr || result.stdout}`,
    );
  }
  let cleaned = false;
  return {
    activeCheckout: active,
    worktree,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await executeArgv(
        ['git', '-C', active, 'worktree', 'remove', '--force', worktree],
        { cwd: active, timeoutMs: 120_000, maxOutputBytes: 1_000_000 },
      );
      await rm(temporaryParent, { force: true, recursive: true });
    },
  };
}

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error('Assertion path is not a regular file.');
  if (status.size > maxBytes)
    throw new Error('Assertion file exceeds the read limit.');
  return readFile(path, 'utf8');
}

function changedFiles(status: string): readonly string[] {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(' -> ').at(-1) ?? '')
    .filter(Boolean);
}

async function evaluateDiff(
  assertion: Extract<SuccessAssertion, { type: 'diff_constraints' }>,
  cwd: string,
): Promise<{ status: EvalCheck['status']; detail: string; observed: unknown }> {
  const result = await executeArgv(['git', '-C', cwd, 'diff', '--numstat'], {
    cwd,
    timeoutMs: 120_000,
    maxOutputBytes: 2_000_000,
  });
  const status = await executeArgv(
    ['git', '-C', cwd, 'status', '--porcelain=v1'],
    {
      cwd,
      timeoutMs: 120_000,
      maxOutputBytes: 2_000_000,
    },
  );
  if (result.exitCode !== 0 || status.exitCode !== 0)
    return {
      status: 'failed',
      detail: 'Could not inspect the isolated worktree.',
      observed: { stdout: result.stdout, stderr: result.stderr },
    };
  let added = 0;
  let deleted = 0;
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    if (a !== '-') added += Number(a) || 0;
    if (d !== '-') deleted += Number(d) || 0;
  }
  const files = changedFiles(status.stdout);
  const allowed = assertion.allowedPaths;
  const disallowed = allowed.length
    ? files.filter((path) => !allowed.includes(path))
    : [];
  const failed =
    disallowed.length > 0 ||
    (assertion.maxChangedFiles !== undefined &&
      files.length > assertion.maxChangedFiles) ||
    (assertion.maxAddedLines !== undefined &&
      added > assertion.maxAddedLines) ||
    (assertion.maxDeletedLines !== undefined &&
      deleted > assertion.maxDeletedLines);
  return {
    status: failed ? 'failed' : 'passed',
    detail: failed
      ? 'Diff constraints were violated.'
      : 'Diff constraints passed.',
    observed: { files, addedLines: added, deletedLines: deleted, disallowed },
  };
}

/** Evaluate all manifest assertions without executing any captured command text. */
export async function evaluateAssertions(options: {
  readonly assertions: readonly SuccessAssertion[];
  readonly cwd: string;
  readonly humanRatings?: Readonly<Record<number, number>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}): Promise<EvalOutcome> {
  const checks: EvalCheck[] = [];
  const commandResults: CommandResult[] = [];
  for (const [index, assertion] of options.assertions.entries()) {
    if (assertion.type === 'human_rating') {
      const rating = options.humanRatings?.[index];
      checks.push(
        rating === undefined
          ? {
              index,
              type: assertion.type,
              status: 'pending',
              detail: 'Human review is required.',
            }
          : {
              index,
              type: assertion.type,
              status: rating >= assertion.minimum ? 'passed' : 'failed',
              detail: `Human rating ${rating}/${assertion.minimum}.`,
              observed: rating,
            },
      );
      continue;
    }
    if (assertion.type === 'file_exists' || assertion.type === 'file_absent') {
      const path = join(options.cwd, safeRelativePath(assertion.path));
      let exists = false;
      try {
        const status = await lstat(path);
        exists = status.isFile() || status.isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const passed = assertion.type === 'file_exists' ? exists : !exists;
      checks.push({
        index,
        type: assertion.type,
        status: passed ? 'passed' : 'failed',
        detail: passed ? 'File assertion passed.' : 'File assertion failed.',
        observed: exists,
      });
      continue;
    }
    if (assertion.type === 'regex_match') {
      const path = join(options.cwd, safeRelativePath(assertion.path));
      try {
        const content = await readBounded(
          path,
          options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        );
        const expression = new RegExp(assertion.pattern, assertion.flags);
        const passed = expression.test(content);
        checks.push({
          index,
          type: assertion.type,
          status: passed ? 'passed' : 'failed',
          detail: passed
            ? 'Regex assertion passed.'
            : 'Regex assertion failed.',
        });
      } catch (error) {
        checks.push({
          index,
          type: assertion.type,
          status: 'failed',
          detail:
            error instanceof Error ? error.message : 'Regex assertion failed.',
        });
      }
      continue;
    }
    if (assertion.type === 'diff_constraints') {
      const result = await evaluateDiff(assertion, options.cwd);
      checks.push({ index, type: assertion.type, ...result });
      continue;
    }
    if (
      assertion.type !== 'command_exit_code' &&
      assertion.type !== 'test_command'
    )
      continue;
    const argv = parseCommand(assertion.command);
    const result = await executeArgv(argv, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    commandResults.push(result);
    const expected =
      assertion.type === 'command_exit_code'
        ? assertion.expected
        : assertion.expectedExitCode;
    const passed = result.exitCode === expected && !result.timedOut;
    checks.push({
      index,
      type: assertion.type,
      status: passed ? 'passed' : 'failed',
      detail: passed
        ? `Command exited ${result.exitCode}.`
        : `Command exited ${result.exitCode}; expected ${expected}.`,
      observed: { exitCode: result.exitCode, timedOut: result.timedOut },
    });
  }
  const success = checks.some((check) => check.status === 'failed')
    ? false
    : checks.some((check) => check.status === 'pending')
      ? null
      : true;
  return { success, checks, commandResults };
}

async function fingerprintWorktree(worktree: string): Promise<string> {
  const head = await executeArgv(['git', '-C', worktree, 'rev-parse', 'HEAD'], {
    cwd: worktree,
    timeoutMs: 120_000,
    maxOutputBytes: 100_000,
  });
  const status = await executeArgv(
    ['git', '-C', worktree, 'status', '--porcelain=v1'],
    { cwd: worktree, timeoutMs: 120_000, maxOutputBytes: 2_000_000 },
  );
  return createHash('sha256')
    .update(`${head.stdout.trim()}\0${status.stdout}`)
    .digest('hex');
}

function jsonRecords(output: string): { count: number; malformed: number } {
  let count = 0;
  let malformed = 0;
  for (const line of output.split('\n').filter(Boolean)) {
    try {
      JSON.parse(line);
      count += 1;
    } catch {
      malformed += 1;
    }
  }
  return { count, malformed };
}

/** Run Codex batch mode with a shell-free argv and bounded transcript output. */
export async function runCodexExec(
  manifest: EvalManifest,
  cwd: string,
  options: CodexExecOptions & ExecuteOptions,
): Promise<EvalExecutionRecord> {
  const executable = options.executable ?? 'codex';
  const args = [
    executable,
    'exec',
    '--json',
    ...(options.extraArgs ?? []),
    manifest.task.prompt,
  ];
  const result = await executeArgv(args, options);
  return { commandResults: [result], output: result.stdout };
}

/** Execute one reviewed manifest in a detached worktree and run its checks. */
export async function runEvaluation(
  options: RunEvaluationOptions,
): Promise<EvalRunResult> {
  const manifest = parseEvalManifest(options.manifest);
  const handle = await createIsolatedWorktree({
    activeCheckout: options.activeCheckout,
    baseCommit: manifest.repository.baseCommit,
  });
  try {
    if (manifest.repository.preTaskPatchBlobHash) {
      if (!options.patchResolver)
        throw new Error(
          'A pre-task patch resolver is required for this evaluation.',
        );
      const patch = await options.patchResolver(
        manifest.repository.preTaskPatchBlobHash,
      );
      if (patch === undefined)
        throw new Error('The pre-task patch blob is unavailable.');
      const bytes =
        typeof patch === 'string' ? Buffer.from(patch) : Buffer.from(patch);
      if (bytes.byteLength > 16 * 1024 * 1024)
        throw new Error('The pre-task patch exceeds the 16 MiB safety limit.');
      const expected = manifest.repository.preTaskPatchSha256;
      if (!expected)
        throw new Error('The pre-task patch is missing its content hash.');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected)
        throw new Error(
          'The pre-task patch content hash does not match the manifest.',
        );
      const patchPath = join(handle.worktree, '.vibetrace-pre-task.patch');
      await writeFile(patchPath, bytes, { mode: 0o600, flag: 'wx' });
      try {
        const check = await executeArgv(
          ['git', '-C', handle.worktree, 'apply', '--check', patchPath],
          {
            cwd: handle.worktree,
            timeoutMs: 120_000,
            maxOutputBytes: 1_000_000,
          },
        );
        if (check.exitCode !== 0)
          throw new Error(
            `The pre-task patch cannot be applied: ${check.stderr || check.stdout}`,
          );
        const applied = await executeArgv(
          ['git', '-C', handle.worktree, 'apply', patchPath],
          {
            cwd: handle.worktree,
            timeoutMs: 120_000,
            maxOutputBytes: 1_000_000,
          },
        );
        if (applied.exitCode !== 0)
          throw new Error(
            `The pre-task patch failed to apply: ${applied.stderr || applied.stdout}`,
          );
      } finally {
        await rm(patchPath, { force: true });
      }
    }
    const execution = options.execute
      ? await options.execute({
          manifest,
          cwd: handle.worktree,
          worktree: handle.worktree,
          activeCheckout: handle.activeCheckout,
        })
      : await runCodexExec(manifest, handle.worktree, {
          ...(options.codex ?? {}),
          cwd: handle.worktree,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        });
    const outcome = await evaluateAssertions({
      assertions: manifest.success.assertions,
      cwd: handle.worktree,
      humanRatings: options.humanRatings,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    const output = execution?.output;
    const records = output ? jsonRecords(output) : { count: 0, malformed: 0 };
    return {
      manifestId: manifest.id,
      worktreeFingerprintHash: await fingerprintWorktree(handle.worktree),
      ...outcome,
      ...(output ? { output } : {}),
      ...(execution?.commandResults
        ? {
            commandResults: [
              ...execution.commandResults,
              ...outcome.commandResults,
            ],
          }
        : {}),
      jsonRecordCount: records.count,
      malformedJsonRecordCount: records.malformed,
    };
  } finally {
    await handle.cleanup();
  }
}
