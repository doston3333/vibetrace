import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

import {
  GitObjectIdSchema,
  RunFingerprintSchema,
  type CommandCategory,
  type VerificationKind,
} from '@vibetrace/schema';

const exec = promisify(execFile);
const REPOSITORY_CAPTURE_TIMEOUT_MS = 2_000;
const MAX_UNTRACKED_FILES = 1_000;
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;

/** Tokenize an observed shell-like command for classification only; never execute it. */
export function tokenizeCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  const input = command.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    if (character === '\\') {
      const next = input[index + 1];
      if (next !== undefined && /[\s"'\\]/.test(next)) {
        current += next;
        index += 1;
      } else current += character;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Classify a command from its observable tokens. */
export function classifyCommand(command: string): CommandCategory {
  const tokens = tokenizeCommand(command);
  if (tokens.some((token) => /&&|\|\||[;|]/.test(token))) return 'unknown';
  let index = 0;
  const executable = (value: string | undefined): string =>
    (value ?? '')
      .split(/[\\/]/)
      .at(-1)!
      .replace(/\.(?:bat|cmd|exe)$/i, '')
      .toLowerCase();
  while (/^(env|command|time|sudo)$/.test(executable(tokens[index]))) {
    index += 1;
    while (
      (tokens[index] ?? '').startsWith('-') ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')
    )
      index += 1;
  }
  const first = executable(tokens[index]);
  const arguments_ = tokens.slice(index + 1);
  const subcommand = executable(arguments_[0]);
  if (/^(rg|grep|find|fd|select-string)$/.test(first)) return 'search';
  if (/^(cat|sed|head|tail|less|type|get-content)$/.test(first)) return 'read';
  if (first === 'git') return 'git';
  if (/^(curl|wget|ssh|scp|gh)$/.test(first)) return 'network';

  if (/^(npm|pnpm|yarn|bun)$/.test(first)) {
    if (/^(install|add|remove|uninstall|update|upgrade|ci)$/.test(subcommand))
      return 'package-install';
    const scriptIndex = /^(run|run-script|exec|x|dlx)$/.test(subcommand)
      ? 1
      : 0;
    const script = executable(arguments_[scriptIndex]);
    if (/^(test|vitest|jest)(?::|$)/.test(script)) return 'test';
    if (/^(lint|eslint|clippy|vet)(?::|$)/.test(script)) return 'lint';
    if (/^(build)(?::|$)/.test(script)) return 'build';
    if (/^(typecheck|tsc|check)(?::|$)/.test(script)) return 'typecheck';
  }
  if (/^(npx|bunx)$/.test(first)) {
    if (/^(vitest|jest|pytest)$/.test(subcommand)) return 'test';
    if (/^(eslint)$/.test(subcommand)) return 'lint';
    if (/^(tsc)$/.test(subcommand)) return 'typecheck';
  }
  if (
    /^(pytest|vitest|jest)$/.test(first) ||
    (/^(python|python3)$/.test(first) &&
      arguments_.some((value) => executable(value) === 'pytest')) ||
    (/^(uv|poetry)$/.test(first) &&
      arguments_.some((value) => executable(value) === 'pytest')) ||
    (first === 'go' && subcommand === 'test') ||
    (first === 'cargo' && subcommand === 'test')
  )
    return 'test';
  if (first === 'tsc') return 'typecheck';
  if (first === 'eslint') return 'lint';
  if (first === 'cargo' && subcommand === 'build') return 'build';
  if (first === 'cargo' && subcommand === 'check') return 'typecheck';
  if (first === 'cargo' && subcommand === 'clippy') return 'lint';
  if (first === 'go' && subcommand === 'build') return 'build';
  if (first === 'go' && subcommand === 'vet') return 'lint';
  if (/^(cp|mv|rm|mkdir|touch|apply_patch|tee|gofmt)$/.test(first))
    return 'edit';
  return 'unknown';
}

export interface VerificationResult {
  readonly kind: VerificationKind;
  readonly success: boolean;
  readonly framework?: string;
  readonly summary: string;
  readonly durationMs?: number;
}
/** Parse only bounded, observable verification facts; raw output remains separate. */
export function parseVerification(
  command: string,
  exitCode: number,
  output: string,
  durationMs?: number,
): VerificationResult | undefined {
  const category = classifyCommand(command);
  const kind =
    category === 'test' ||
    category === 'lint' ||
    category === 'build' ||
    category === 'typecheck'
      ? category
      : undefined;
  if (!kind) return undefined;
  const normalized = command.toLowerCase();
  const framework = /pytest/.test(normalized)
    ? 'pytest'
    : /cargo/.test(normalized)
      ? 'cargo'
      : /\bgo\s+test\b/.test(normalized)
        ? 'go'
        : /vitest/.test(normalized)
          ? 'vitest'
          : /jest/.test(normalized)
            ? 'jest'
            : /eslint/.test(normalized)
              ? 'eslint'
              : /\btsc\b/.test(normalized)
                ? 'typescript'
                : /pnpm|npm|yarn|bun/.test(normalized)
                  ? 'node'
                  : undefined;
  return {
    kind,
    success: exitCode === 0,
    ...(framework ? { framework } : {}),
    summary: output.slice(0, 1024).replaceAll(/\s+/g, ' ').trim(),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export type RepositoryPhase = 'baseline' | 'event' | 'final';
export interface RepositoryFileChange {
  readonly status: string;
  readonly path: string;
  readonly previousPath?: string;
}
export interface RepositorySnapshotSuccess {
  readonly kind: 'snapshot';
  readonly phase: RepositoryPhase;
  readonly rootHash: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly dirtyPatchHash: string;
  readonly changedFiles: readonly RepositoryFileChange[];
  readonly cumulativeDiff: string;
  readonly truncated: boolean;
}
export interface RepositorySnapshotGap {
  readonly kind: 'gap';
  readonly phase: RepositoryPhase;
  readonly reason:
    | 'unsafe-cwd'
    | 'not-git'
    | 'git-unavailable-or-timeout'
    | 'oversized-output'
    | 'invalid-output';
  readonly message: string;
}
export type RepositorySnapshot =
  RepositorySnapshotSuccess | RepositorySnapshotGap;
export interface GitRunnerOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
}
export type GitRunner = (
  executable: 'git',
  arguments_: readonly string[],
  options: GitRunnerOptions,
) => Promise<string>;
export interface CaptureRepositoryOptions {
  readonly phase: RepositoryPhase;
  readonly baseCommit?: string;
  readonly runner?: GitRunner;
}
const GIT_LIMIT = 8 * 1024 * 1024;
const gitOptions = (cwd: string, timeout: number): GitRunnerOptions => ({
  cwd,
  timeout,
  maxBuffer: GIT_LIMIT,
  shell: false,
});
const defaultRunner: GitRunner = async (_executable, arguments_, options) =>
  (await exec('git', [...arguments_], options)).stdout;
function safePath(value: string): string | undefined {
  const path = value.replaceAll('\\', '/');
  if (
    !path ||
    isAbsolute(path) ||
    path.split('/').some((part) => part === '..' || part === '')
  )
    return undefined;
  return path;
}
function parseNameStatus(value: string): RepositoryFileChange[] | undefined {
  const fields = value.split('\0');
  const out: RepositoryFileChange[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++] ?? '';
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) return undefined;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = safePath(fields[index++] ?? '');
      const path = safePath(fields[index++] ?? '');
      if (!path || !previousPath) return undefined;
      out.push({ status, path, previousPath });
      continue;
    }
    const path = safePath(fields[index++] ?? '');
    if (!path) return undefined;
    out.push({ status, path });
  }
  return out;
}
async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('repository capture deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('repository capture deadline')),
        remaining,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
async function inventory(
  root: string,
  paths: readonly string[],
  deadline: number,
): Promise<{ text: string; truncated: boolean }> {
  let text = '';
  let truncated = false;
  let totalBytes = 0;
  for (const path of paths) {
    if (Date.now() >= deadline) return { text, truncated: true };
    const full = join(root, ...path.split('/'));
    try {
      const stat = await beforeDeadline(lstat(full), deadline);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        text += `untracked ${path} [unsafe]\n`;
        continue;
      }
      const canonical = await beforeDeadline(realpath(full), deadline);
      const relativePath = relative(root, canonical);
      if (
        isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes('..')
      ) {
        text += `untracked ${path} [unsafe]\n`;
        continue;
      }
      if (stat.size > 1_048_576) {
        text += `untracked ${path} [oversize]\n`;
        truncated = true;
        continue;
      }
      if (totalBytes + stat.size > MAX_UNTRACKED_BYTES)
        return { text, truncated: true };
      const content = await beforeDeadline(readFile(canonical), deadline);
      totalBytes += content.byteLength;
      text += `untracked ${path} sha256:${createHash('sha256').update(content).digest('hex')}\n`;
    } catch {
      if (Date.now() >= deadline) return { text, truncated: true };
      text += `untracked ${path} [unreadable]\n`;
    }
  }
  return { text, truncated };
}
/** Capture a bounded observable Git snapshot without ever running captured commands through a shell. */
export async function captureRepositoryState(
  cwd: string,
  options: CaptureRepositoryOptions,
): Promise<RepositorySnapshot> {
  const deadline = Date.now() + REPOSITORY_CAPTURE_TIMEOUT_MS;
  const gap = (
    reason: RepositorySnapshotGap['reason'],
    message: string,
  ): RepositorySnapshotGap => ({
    kind: 'gap',
    phase: options.phase,
    reason,
    message,
  });
  if (
    options.baseCommit !== undefined &&
    !GitObjectIdSchema.safeParse(options.baseCommit).success
  )
    return gap('invalid-output', 'Repository baseline object ID is invalid.');
  let cwdReal: string;
  try {
    const state = await beforeDeadline(lstat(cwd), deadline);
    if (!state.isDirectory() || state.isSymbolicLink())
      return gap(
        'unsafe-cwd',
        'Repository directory is not a safe real directory.',
      );
    cwdReal = await beforeDeadline(realpath(cwd), deadline);
  } catch {
    if (Date.now() >= deadline)
      return gap(
        'git-unavailable-or-timeout',
        'Repository capture was unavailable or timed out.',
      );
    return gap('unsafe-cwd', 'Repository directory is unavailable.');
  }
  const run = options.runner ?? defaultRunner;
  try {
    const call = async (...args: string[]): Promise<string> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('repository capture deadline');
      return beforeDeadline(
        run('git', args, gitOptions(cwd, remaining)),
        deadline,
      );
    };
    const root = (await call('rev-parse', '--show-toplevel')).trim();
    if (!isAbsolute(root))
      return gap('invalid-output', 'Git returned an invalid worktree root.');
    const rootState = await beforeDeadline(lstat(root), deadline);
    const rootReal = await beforeDeadline(realpath(root), deadline);
    const relativeCwd = relative(rootReal, cwdReal);
    if (
      !rootState.isDirectory() ||
      rootState.isSymbolicLink() ||
      isAbsolute(relativeCwd) ||
      relativeCwd.split(/[\\/]/).includes('..')
    )
      return gap('invalid-output', 'Git returned an unsafe worktree root.');
    const headCommit = (await call('rev-parse', 'HEAD')).trim();
    if (!GitObjectIdSchema.safeParse(headCommit).success)
      return gap('invalid-output', 'Git returned an invalid object ID.');
    const baseCommit = options.baseCommit ?? headCommit;
    const diff = await call(
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      baseCommit,
      '--',
    );
    const changed = await call(
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      baseCommit,
      '--',
    );
    const changedFiles = parseNameStatus(changed);
    if (!changedFiles)
      return gap('invalid-output', 'Git changed-file output was invalid.');
    const rawUntracked = await call(
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    );
    const rawUntrackedPaths = rawUntracked.split('\0').filter(Boolean);
    const untrackedOverflow = rawUntrackedPaths.length > MAX_UNTRACKED_FILES;
    const untracked = rawUntrackedPaths
      .slice(0, MAX_UNTRACKED_FILES)
      .map(safePath);
    if (untracked.some((path) => !path))
      return gap('invalid-output', 'Git untracked inventory was invalid.');
    for (const path of untracked as string[])
      if (!changedFiles.some((file) => file.path === path))
        changedFiles.push({ status: '??', path });
    const trackedOverflow = changedFiles.length > MAX_UNTRACKED_FILES;
    if (trackedOverflow) changedFiles.splice(MAX_UNTRACKED_FILES);
    const untrackedInventory = await inventory(
      rootReal,
      untracked as string[],
      deadline,
    );
    const cumulative = `${diff}${untrackedInventory.text}`;
    const truncated =
      cumulative.length > GIT_LIMIT ||
      untrackedInventory.truncated ||
      untrackedOverflow ||
      trackedOverflow;
    const bounded = cumulative.slice(0, GIT_LIMIT);
    return {
      kind: 'snapshot',
      phase: options.phase,
      rootHash: createHash('sha256').update(rootReal).digest('hex'),
      baseCommit,
      headCommit,
      dirtyPatchHash: createHash('sha256').update(cumulative).digest('hex'),
      changedFiles,
      cumulativeDiff: bounded,
      truncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/not a git repository/i.test(message))
      return gap('not-git', 'Directory is not a Git worktree.');
    if (/maxBuffer|stdout maxBuffer/i.test(message))
      return gap(
        'oversized-output',
        'Git output exceeded the bounded capture limit.',
      );
    return gap(
      'git-unavailable-or-timeout',
      'Git capture was unavailable or timed out.',
    );
  }
}

/** Hash stable, non-secret run-fingerprint inputs without retaining environment values or root paths. */
export interface FingerprintFileHashes {
  readonly instructions: readonly {
    kind: 'agents' | 'skill' | 'plugin';
    sha256: string;
  }[];
  readonly lockfiles: readonly { name: string; sha256: string }[];
  readonly omissions: readonly string[];
}
const FINGERPRINT_FILE_LIMIT = 64;
const FINGERPRINT_BYTE_LIMIT = 8 * 1024 * 1024;
const FINGERPRINT_SINGLE_FILE_LIMIT = 1_048_576;
const fingerprintLockfiles = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
] as const;

/** Hash only known bounded files, returning hashes rather than paths or contents. */
export async function hashFingerprintFiles(
  root: string,
): Promise<FingerprintFileHashes> {
  const instructions: {
    kind: 'agents' | 'skill' | 'plugin';
    sha256: string;
  }[] = [];
  const lockfiles: { name: string; sha256: string }[] = [];
  const omissions: string[] = [];
  let count = 0;
  let totalBytes = 0;
  const hash = async (
    path: string,
    kind: 'agents' | 'skill' | 'plugin' | 'lockfile',
    name?: string,
  ): Promise<void> => {
    try {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink()) {
        omissions.push('unsafe-file');
        return;
      }
      if (
        status.size > FINGERPRINT_SINGLE_FILE_LIMIT ||
        count >= FINGERPRINT_FILE_LIMIT ||
        totalBytes + status.size > FINGERPRINT_BYTE_LIMIT
      ) {
        omissions.push('bounded-file-omitted');
        return;
      }
      const sha256 = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      count += 1;
      totalBytes += status.size;
      if (kind === 'lockfile' && name) lockfiles.push({ name, sha256 });
      else if (kind !== 'lockfile') instructions.push({ kind, sha256 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        omissions.push('unreadable-file');
    }
  };
  try {
    const rootStatus = await lstat(root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
      return { instructions, lockfiles, omissions: ['unsafe-root'] };
  } catch {
    return { instructions, lockfiles, omissions: ['unreadable-root'] };
  }
  await hash(join(root, 'AGENTS.md'), 'agents');
  await hash(join(root, 'SKILL.md'), 'skill');
  for (const directory of ['.agents/skills', '.codex/skills'] as const) {
    try {
      const status = await lstat(join(root, directory));
      if (!status.isDirectory() || status.isSymbolicLink()) {
        omissions.push('unsafe-skill-directory');
        continue;
      }
      const entries = (
        await readdir(join(root, directory), {
          withFileTypes: true,
        })
      ).sort((left, right) => left.name.localeCompare(right.name));
      const selected = entries.slice(
        0,
        Math.max(0, FINGERPRINT_FILE_LIMIT - count),
      );
      if (selected.length < entries.length)
        omissions.push('bounded-directory-entries');
      for (const entry of selected) {
        if (entry.isSymbolicLink()) {
          omissions.push('unsafe-file');
          continue;
        }
        if (entry.isDirectory())
          await hash(join(root, directory, entry.name, 'SKILL.md'), 'skill');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        omissions.push('unreadable-skill-directory');
    }
  }
  for (const name of fingerprintLockfiles)
    await hash(join(root, name), 'lockfile', name);
  return {
    instructions: instructions.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.sha256.localeCompare(right.sha256),
    ),
    lockfiles: lockfiles.sort((a, b) => a.name.localeCompare(b.name)),
    omissions: [...new Set(omissions)].sort(),
  };
}
/** Build a strict JSON-safe fingerprint from safe exposed values only. */
export function createRunFingerprint(input: {
  readonly clientSurface: 'cli' | 'ide' | 'app' | 'app-server' | 'exec' | 'sdk';
  readonly fileHashes: FingerprintFileHashes;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly reasoningEffort?: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
  readonly networkPolicy?: string;
  readonly policyNames?: readonly string[];
  readonly configDigest?: string;
  readonly mcpServerHashes?: readonly string[];
  readonly codexVersion?: string;
  readonly git?: RepositorySnapshotSuccess;
}): import('@vibetrace/schema').RunFingerprint {
  return RunFingerprintSchema.parse({
    source: 'codex',
    clientSurface: input.clientSurface,
    ...(input.model ? { model: input.model } : {}),
    ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input.sandboxPolicy ? { sandboxPolicy: input.sandboxPolicy } : {}),
    ...(input.networkPolicy ? { networkPolicy: input.networkPolicy } : {}),
    ...(input.codexVersion ? { codexVersion: input.codexVersion } : {}),
    policyNames: [...(input.policyNames ?? [])],
    instructionHashes: input.fileHashes.instructions,
    lockfileHashes: input.fileHashes.lockfiles,
    captureOmissions: [
      ...new Set([
        ...input.fileHashes.omissions,
        'plugin-manifests-unavailable',
      ]),
    ].sort(),
    ...(input.configDigest ? { configDigest: input.configDigest } : {}),
    ...(input.mcpServerHashes
      ? { mcpServerHashes: [...input.mcpServerHashes] }
      : {}),
    os: process.platform,
    architecture: process.arch,
    runtimeVersions: Object.fromEntries(
      Object.entries(process.versions).filter(
        ([, value]) => typeof value === 'string' && value.length > 0,
      ),
    ),
    ...(input.git
      ? {
          gitState: {
            baseCommit: input.git.baseCommit,
            headCommit: input.git.headCommit,
            rootHash: input.git.rootHash,
            dirtyPatchHash: input.git.dirtyPatchHash,
          },
        }
      : {}),
  });
}
export interface FileHistoryEvidence {
  readonly eventId: string;
  readonly sequence: number;
  readonly phase: RepositoryPhase;
  readonly snapshot: RepositorySnapshotSuccess;
}
export function buildFileHistory(
  input: readonly FileHistoryEvidence[],
): readonly {
  path: string;
  eventIds: readonly string[];
  firstSequence: number;
  lastSequence: number;
  statuses: readonly string[];
  phases: readonly RepositoryPhase[];
}[] {
  const files = new Map<
    string,
    {
      eventIds: string[];
      firstSequence: number;
      lastSequence: number;
      statuses: string[];
      phases: RepositoryPhase[];
    }
  >();
  for (const item of [...input].sort(
    (a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId),
  ))
    for (const file of item.snapshot.changedFiles)
      if (item.eventId && item.sequence > 0 && safePath(file.path)) {
        const value = files.get(file.path) ?? {
          eventIds: [],
          firstSequence: item.sequence,
          lastSequence: item.sequence,
          statuses: [],
          phases: [],
        };
        value.eventIds.push(item.eventId);
        value.lastSequence = item.sequence;
        if (!value.statuses.includes(file.status))
          value.statuses.push(file.status);
        if (!value.phases.includes(item.phase)) value.phases.push(item.phase);
        files.set(file.path, value);
      }
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, value]) => ({ path, ...value }));
}
export interface VerificationEvidence {
  readonly eventId: string;
  readonly sequence: number;
  readonly command: string;
  readonly kind: VerificationKind;
  readonly success: boolean;
}
export function classifyVerificationHistory(
  input: readonly VerificationEvidence[],
  firstObservedChangeSequence: number | undefined,
): readonly {
  command: string;
  kind: VerificationKind;
  status: 'pre-existing' | 'introduced' | 'resolved' | 'unchanged' | 'unknown';
  evidenceIds: readonly string[];
  counterevidenceIds: readonly string[];
}[] {
  const records = [...input]
    .filter((value) => value.eventId && value.sequence > 0)
    .sort(
      (a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId),
    );
  const groups = new Map<
    VerificationKind,
    Map<string, VerificationEvidence[]>
  >();
  for (const value of records) {
    const command = tokenizeCommand(value.command).join(' ');
    const commands =
      groups.get(value.kind) ?? new Map<string, VerificationEvidence[]>();
    commands.set(command, [...(commands.get(command) ?? []), value]);
    groups.set(value.kind, commands);
  }
  const uniqueIds = (
    values: readonly VerificationEvidence[],
  ): readonly string[] => [...new Set(values.map((value) => value.eventId))];
  const output: {
    command: string;
    kind: VerificationKind;
    status:
      'pre-existing' | 'introduced' | 'resolved' | 'unchanged' | 'unknown';
    evidenceIds: readonly string[];
    counterevidenceIds: readonly string[];
  }[] = [];
  for (const [kind, commands] of groups)
    for (const [command, values] of commands) {
      const before =
        firstObservedChangeSequence === undefined
          ? []
          : values.filter(
              (value) => value.sequence < firstObservedChangeSequence,
            );
      const after =
        firstObservedChangeSequence === undefined
          ? []
          : values.filter(
              (value) => value.sequence >= firstObservedChangeSequence,
            );
      const beforeStates = new Set(before.map((value) => value.success));
      const afterStates = new Set(after.map((value) => value.success));
      const beforeSuccess = beforeStates.values().next().value as
        boolean | undefined;
      const afterSuccess = afterStates.values().next().value as
        boolean | undefined;
      const status =
        firstObservedChangeSequence === undefined ||
        beforeStates.size !== 1 ||
        afterStates.size !== 1
          ? 'unknown'
          : !beforeSuccess && !afterSuccess
            ? 'pre-existing'
            : beforeSuccess && !afterSuccess
              ? 'introduced'
              : !beforeSuccess && afterSuccess
                ? 'resolved'
                : 'unchanged';
      output.push({
        command,
        kind,
        status,
        evidenceIds: uniqueIds(values),
        counterevidenceIds:
          status === 'introduced'
            ? uniqueIds(before.filter((value) => value.success))
            : status === 'resolved'
              ? uniqueIds(before.filter((value) => !value.success))
              : [],
      });
    }
  return output.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.command.localeCompare(right.command),
  );
}
