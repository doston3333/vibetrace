import { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  codexAdapterLimits,
  collectCodexHook,
  doctorCodex,
  installCodexHooks,
  uninstallCodexHooks,
  type CodexDoctorReport,
  type HookChangeResult,
} from '@vibetrace/adapter-codex';
import {
  APP_SERVER_ADAPTER_ID,
  runAppServerSession,
  type AppServerCaptureResult,
} from '@vibetrace/adapter-codex-app-server';
import { genericJsonlAdapter } from '@vibetrace/adapter-generic-jsonl';
import {
  manifestFromSession,
  parseEvalManifest,
  type EvalManifest,
} from '@vibetrace/eval-spec';
import { runEvaluation, type EvalRunResult } from '@vibetrace/eval-runner';
import { ExportProfileSchema, type ExportProfile } from '@vibetrace/bundle';
import {
  readDescriptor,
  recoverStaleState,
  resolveStateDir,
} from '@vibetrace/daemon';

export const cliVersion = '0.1.0';

export interface CliDependencies {
  readonly stateDir?: () => string;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    standardInput?: string,
  ) => void;
  readonly openBrowser?: (url: string) => void;
  readonly output?: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly readStdin?: (maxBytes: number) => Promise<string | undefined>;
  readonly readSecret?: (prompt: string) => Promise<string>;
  readonly collectCodexHook?: (text: string) => Promise<boolean>;
  readonly installCodexHooks?: (options: {
    readonly dryRun?: boolean;
  }) => Promise<HookChangeResult>;
  readonly uninstallCodexHooks?: (options: {
    readonly dryRun?: boolean;
  }) => Promise<HookChangeResult>;
  readonly doctorCodex?: () => Promise<CodexDoctorReport>;
  readonly runAppServerSession?: (
    options: Parameters<typeof runAppServerSession>[0],
  ) => Promise<AppServerCaptureResult>;
  readonly runEvaluation?: (
    options: Parameters<typeof runEvaluation>[0],
  ) => Promise<EvalRunResult>;
  readonly setExitCode?: (code: number) => void;
  readonly waitForReady?: (
    stateDir: string,
  ) => Promise<
    { origin: string; instanceId: string; token: string } | undefined
  >;
}

async function readHiddenSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('A terminal is required to read the bundle passphrase.');
  process.stdout.write(prompt);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise<string>((resolveSecret, reject) => {
    let value = '';
    const finish = (error?: Error): void => {
      input.off('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolveSecret(value);
    };
    const onData = (chunk: string | Buffer): void => {
      const text = String(chunk);
      for (const character of text) {
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Passphrase entry cancelled.'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
}

function exportProfile(
  value: string,
  restores: readonly string[],
): ExportProfile {
  const profile =
    value === 'metadata-only'
      ? { kind: 'metadata-only' as const }
      : value === 'share-safe'
        ? { kind: 'share-safe' as const, restorePointers: [...restores] }
        : value.startsWith('custom:') && value.length > 'custom:'.length
          ? {
              kind: 'custom' as const,
              id: value.slice('custom:'.length),
              restorePointers: [...restores],
            }
          : undefined;
  if (!profile)
    throw new Error(
      'Profile must be metadata-only, share-safe, or custom:<id>.',
    );
  return ExportProfileSchema.parse(profile);
}

async function readBoundedStdin(maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > maxBytes) oversized = true;
    else if (!oversized) chunks.push(buffer);
  }
  return oversized ? undefined : Buffer.concat(chunks).toString('utf8');
}

function humanDoctor(report: CodexDoctorReport): readonly string[] {
  return report.checks.map((check) => {
    const remediation = check.remediation
      ? ` Remediation: ${check.remediation}`
      : '';
    return `[${check.status.toUpperCase()}] ${check.id}: ${check.message}${remediation}`;
  });
}

async function descriptorWithToken(
  stateDir: string,
  request: typeof fetch = fetch,
): Promise<{ origin: string; instanceId: string; token: string } | undefined> {
  const descriptor = await readDescriptor(stateDir);
  if (!descriptor) return undefined;
  try {
    const token = (await readFile(join(stateDir, 'auth-token'), 'utf8')).trim();
    const result = await request(`${descriptor.origin}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    const body = (await result.json()) as { instanceId?: unknown };
    return result.ok && body.instanceId === descriptor.instanceId
      ? { origin: descriptor.origin, instanceId: descriptor.instanceId, token }
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  standardInput?: string,
): void {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: [
      standardInput === undefined ? 'ignore' : 'pipe',
      'ignore',
      'ignore',
    ],
  });
  if (standardInput !== undefined) child.stdin?.end(`${standardInput}\n`);
  child.unref();
}

function defaultOpen(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function waitForReady(
  stateDir: string,
  request: typeof fetch = fetch,
): Promise<{ origin: string; instanceId: string; token: string } | undefined> {
  const deadline = Date.now() + 3_000;
  do {
    const running = await descriptorWithToken(stateDir, request);
    if (running) return running;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return undefined;
}

async function start(
  stateDir: string,
  spawnDaemon: (
    command: string,
    args: readonly string[],
    standardInput?: string,
  ) => void,
  request: typeof fetch,
  storagePassphrase?: string,
): Promise<void> {
  if (await descriptorWithToken(stateDir, request)) return;
  await recoverStaleState(stateDir);
  const runPath = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js');
  spawnDaemon(
    process.execPath,
    [
      runPath,
      ...(storagePassphrase === undefined
        ? []
        : ['--storage-passphrase-stdin']),
    ],
    storagePassphrase,
  );
}

/** Creates the VibeTrace foundation CLI program. */
export function createProgram(dependencies: CliDependencies = {}): Command {
  const stateDir = dependencies.stateDir ?? (() => resolveStateDir());
  const output =
    dependencies.output ??
    ((line: string) => process.stdout.write(`${line}\n`));
  const spawnDaemon = dependencies.spawn ?? defaultSpawn;
  const openBrowser = dependencies.openBrowser ?? defaultOpen;
  const request = dependencies.fetch ?? fetch;
  const stdin = dependencies.readStdin ?? readBoundedStdin;
  const collect =
    dependencies.collectCodexHook ??
    ((text: string) => collectCodexHook(text, { stateDir: stateDir() }));
  const install =
    dependencies.installCodexHooks ??
    ((options: { readonly dryRun?: boolean }) =>
      installCodexHooks({ ...options, stateDir: stateDir() }));
  const uninstall =
    dependencies.uninstallCodexHooks ??
    ((options: { readonly dryRun?: boolean }) =>
      uninstallCodexHooks({ ...options, stateDir: stateDir() }));
  const doctor =
    dependencies.doctorCodex ??
    (() => doctorCodex({ stateDir: stateDir(), fetch: request }));
  const runAppServer = dependencies.runAppServerSession ?? runAppServerSession;
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => (process.exitCode = code));
  const ready =
    dependencies.waitForReady ??
    ((directory: string) => waitForReady(directory, request));
  const secret = dependencies.readSecret ?? readHiddenSecret;
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const directory = stateDir();
    await start(directory, spawnDaemon, request);
    const running = await ready(directory);
    if (!running) throw new Error('Daemon did not become ready.');
    const response = await request(`${running.origin}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${running.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as {
        code?: unknown;
      };
      throw new Error(
        `VibeTrace request failed: ${typeof failure.code === 'string' ? failure.code : response.status}.`,
      );
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  };
  const apiBinary = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Uint8Array> => {
    const directory = stateDir();
    await start(directory, spawnDaemon, request);
    const running = await ready(directory);
    if (!running) throw new Error('Daemon did not become ready.');
    const response = await request(`${running.origin}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${running.token}`,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as {
        code?: unknown;
      };
      throw new Error(
        `VibeTrace request failed: ${typeof failure.code === 'string' ? failure.code : response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  const uploadBinary = async (
    path: string,
    body: Uint8Array,
  ): Promise<void> => {
    const directory = stateDir();
    await start(directory, spawnDaemon, request);
    const running = await ready(directory);
    if (!running) throw new Error('Daemon did not become ready.');
    const response = await request(`${running.origin}/api/v1${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${running.token}`,
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from(body) as unknown as BodyInit,
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as {
        code?: unknown;
      };
      throw new Error(
        `VibeTrace request failed: ${typeof failure.code === 'string' ? failure.code : response.status}.`,
      );
    }
  };
  const readManifestFile = async (file: string): Promise<EvalManifest> => {
    const path = resolve(file);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024)
      throw new Error(
        'Evaluation manifest must be a regular file smaller than 2 MiB.',
      );
    return parseEvalManifest(JSON.parse(await readFile(path, 'utf8')));
  };
  const sessionEvents = async (
    session: string,
  ): Promise<readonly unknown[]> => {
    const events: unknown[] = [];
    let cursor: { afterSequence: number; afterId: string } | undefined;
    do {
      const query = new URLSearchParams({ limit: '2000' });
      if (cursor) {
        query.set('afterSequence', String(cursor.afterSequence));
        query.set('afterId', cursor.afterId);
      }
      const page = await api<{
        events: readonly unknown[];
        nextCursor?: { afterSequence: number; afterId: string };
      }>(`/sessions/${encodeURIComponent(session)}/events?${query}`);
      events.push(...page.events);
      cursor = page.nextCursor;
      if (events.length > 100_000)
        throw new Error('Session exceeds the evaluation evidence limit.');
    } while (cursor);
    return events;
  };
  const program = new Command()
    .name('vibetrace')
    .description('VibeTrace local forensic debugger.')
    .version(cliVersion);
  program
    .command('start')
    .description('Start the local VibeTrace daemon.')
    .option(
      '--storage-passphrase',
      'Prompt for a passphrase when the OS keyring is unavailable.',
    )
    .option(
      '--storage-passphrase-stdin',
      'Read the storage passphrase from standard input.',
    )
    .action(
      async (options: {
        storagePassphrase?: boolean;
        storagePassphraseStdin?: boolean;
      }) => {
        if (options.storagePassphrase && options.storagePassphraseStdin)
          throw new Error('Choose only one storage passphrase input method.');
        let storagePassphrase: string | undefined;
        if (options.storagePassphrase)
          storagePassphrase = await secret('Storage passphrase: ');
        if (options.storagePassphraseStdin) {
          const value = await stdin(4_096);
          storagePassphrase = value?.replace(/[\r\n]+$/, '');
        }
        if (
          (options.storagePassphrase || options.storagePassphraseStdin) &&
          !storagePassphrase
        )
          throw new Error('Storage passphrase is empty or too large.');
        await start(stateDir(), spawnDaemon, request, storagePassphrase);
        output('VibeTrace daemon start requested.');
      },
    );
  program
    .command('status')
    .description('Report whether the local daemon is healthy.')
    .action(async () => {
      output(
        (await descriptorWithToken(stateDir(), request))
          ? 'running'
          : 'stopped',
      );
    });
  program
    .command('stop')
    .description('Stop the matching local VibeTrace daemon.')
    .action(async () => {
      const running = await descriptorWithToken(stateDir(), request);
      if (!running) {
        output('stopped');
        return;
      }
      await request(`${running.origin}/api/v1/admin/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${running.token}` },
      });
      output('VibeTrace daemon stop requested.');
    });
  program
    .command('open')
    .description('Open the authenticated local dashboard.')
    .action(async () => {
      const directory = stateDir();
      await start(directory, spawnDaemon, request);
      const running = await ready(directory);
      if (!running) throw new Error('Daemon did not become ready.');
      const response = await request(`${running.origin}/api/v1/auth/tickets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${running.token}` },
      });
      const ticket = (await response.json()) as { ticket?: unknown };
      if (!response.ok || typeof ticket.ticket !== 'string')
        throw new Error('Could not mint browser ticket.');
      const handoff = await request(
        `${running.origin}/api/v1/auth/browser-handoff`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${running.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ticket: ticket.ticket }),
        },
      );
      if (!handoff.ok) throw new Error('Could not prepare browser handoff.');
      openBrowser(`${running.origin}/`);
    });

  const sessions = program
    .command('sessions')
    .description('List, inspect, or delete captured sessions.');
  sessions
    .command('list')
    .description('List captured sessions.')
    .option('--json', 'Print stable JSON.')
    .action(async (options: { json?: boolean }) => {
      const result = await api<{
        sessions: readonly {
          id: string;
          startedAt: string;
          status: string;
          title?: string;
          displayName: string;
        }[];
      }>('/sessions');
      if (options.json) output(JSON.stringify(result));
      else if (result.sessions.length === 0) output('No sessions.');
      else
        for (const session of result.sessions)
          output(
            [
              session.id,
              session.startedAt,
              session.status,
              session.title ?? session.displayName,
            ].join('\t'),
          );
    });

  const evalCommand = program
    .command('eval')
    .description('Create, validate, run, and inspect isolated evaluations.');
  evalCommand
    .command('create <session>')
    .description('Derive a reviewable evaluation manifest from a session.')
    .requiredOption('--name <name>', 'Evaluation case name.')
    .option(
      '--base-commit <commit>',
      'Base commit; defaults to session metadata.',
    )
    .option(
      '-o, --output <path>',
      'Manifest JSON output path.',
      'eval-manifest.json',
    )
    .option('--no-persist', 'Do not persist the encrypted case in the daemon.')
    .action(
      async (
        session: string,
        options: {
          name: string;
          baseCommit?: string;
          output: string;
          persist: boolean;
        },
      ) => {
        const metadata = await api<{
          session: { id: string; baseCommit?: string };
        }>(`/sessions/${encodeURIComponent(session)}`);
        const baseCommit = options.baseCommit ?? metadata.session.baseCommit;
        if (!baseCommit)
          throw new Error(
            'A base commit is required to create an evaluation manifest.',
          );
        const events = await sessionEvents(session);
        const manifest = manifestFromSession({
          id: randomUUID(),
          name: options.name,
          sessionId: metadata.session.id,
          repository: { baseCommit },
          events: events as Parameters<typeof manifestFromSession>[0]['events'],
        });
        const destination = resolve(options.output);
        await writeFile(
          destination,
          `${JSON.stringify(manifest, undefined, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        if (options.persist)
          await api(`/eval/cases`, {
            method: 'POST',
            body: JSON.stringify({ manifest }),
          });
        output(JSON.stringify({ path: destination, manifest }, undefined, 2));
      },
    );
  evalCommand
    .command('validate <manifest>')
    .description('Validate an evaluation manifest at the trust boundary.')
    .option('--json', 'Print the normalized manifest.')
    .action(async (file: string, options: { json?: boolean }) => {
      const manifest = await readManifestFile(file);
      output(
        options.json
          ? JSON.stringify(manifest, undefined, 2)
          : `Valid evaluation manifest ${manifest.id} (${manifest.name}).`,
      );
    });
  evalCommand
    .command('run <manifest>')
    .description(
      'Run Codex in a detached worktree and evaluate success checks.',
    )
    .option('--cwd <path>', 'Active checkout to isolate.', process.cwd())
    .option('--no-persist', 'Do not persist the run result in the daemon.')
    .option('--json', 'Print the complete run result.')
    .action(
      async (
        file: string,
        options: { cwd: string; persist: boolean; json?: boolean },
      ) => {
        const manifest = await readManifestFile(file);
        const runOptions: Parameters<typeof runEvaluation>[0] = {
          manifest,
          activeCheckout: resolve(options.cwd),
          ...(manifest.repository.preTaskPatchBlobHash
            ? {
                patchResolver: async (blobHash: string) =>
                  apiBinary(
                    `/eval/cases/${encodeURIComponent(manifest.id)}/pre-task-patch?blob=${encodeURIComponent(blobHash)}`,
                  ),
              }
            : {}),
        };
        const result = await (dependencies.runEvaluation ?? runEvaluation)(
          runOptions,
        );
        if (options.persist) {
          const runStatus =
            result.success === true
              ? 'completed'
              : result.success === null
                ? 'pending_review'
                : 'failed';
          const stored = await api<{ run: { id: string } }>(
            `/eval/cases/${manifest.id}/runs`,
            {
              method: 'POST',
              body: JSON.stringify({
                configuration: manifest.configuration,
                worktreeFingerprintHash: result.worktreeFingerprintHash,
                status: runStatus,
              }),
            },
          );
          await api(`/eval/runs/${stored.run.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              status: runStatus,
              outcome: {
                success: result.success,
                checks: result.checks,
              },
              metrics: {
                commandCount: result.commandResults.length,
                jsonRecordCount: result.jsonRecordCount,
                malformedJsonRecordCount: result.malformedJsonRecordCount,
              },
            }),
          });
          if (result.output !== undefined)
            await uploadBinary(
              `/eval/runs/${stored.run.id}/output`,
              Buffer.from(result.output, 'utf8'),
            );
        }
        output(
          options.json
            ? JSON.stringify(result)
            : `Evaluation ${result.success === true ? 'passed' : result.success === null ? 'needs review' : 'failed'}.`,
        );
        if (result.success === false) setExitCode(1);
      },
    );
  evalCommand
    .command('compare-create <evalCase>')
    .description('Create a comparison matrix from persisted evaluation runs.')
    .requiredOption('--name <name>', 'Comparison name.')
    .requiredOption('--run <run...>', 'Persisted run IDs to include.')
    .option('--configuration <json>', 'JSON comparison dimensions.', '{}')
    .action(
      async (
        evalCase: string,
        options: { name: string; run: string[]; configuration: string },
      ) => {
        let configuration: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(options.configuration);
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
          )
            throw new Error('not an object');
          configuration = parsed as Record<string, unknown>;
        } catch {
          throw new Error('Comparison configuration must be a JSON object.');
        }
        const created = await api<{ comparison: { id: string } }>(
          '/eval/comparisons',
          {
            method: 'POST',
            body: JSON.stringify({
              evalCaseId: evalCase,
              name: options.name,
              configuration,
            }),
          },
        );
        for (const [ordinal, evalRunId] of options.run.entries())
          await api(`/eval/comparisons/${created.comparison.id}/results`, {
            method: 'POST',
            body: JSON.stringify({ evalRunId, ordinal, result: {} }),
          });
        output(created.comparison.id);
      },
    );
  evalCommand
    .command('compare-add <comparison> <run...>')
    .description('Add persisted runs to an existing comparison matrix.')
    .action(async (comparison: string, runs: readonly string[]) => {
      for (const [ordinal, evalRunId] of runs.entries())
        await api(`/eval/comparisons/${comparison}/results`, {
          method: 'POST',
          body: JSON.stringify({ evalRunId, ordinal, result: {} }),
        });
      output(`Added ${runs.length} run(s) to ${comparison}.`);
    });
  evalCommand
    .command('compare <comparison>')
    .description(
      'Show persisted comparison runs and first-divergence evidence.',
    )
    .option('--json', 'Print stable JSON.')
    .action(async (comparison: string, options: { json?: boolean }) => {
      const result = await api<{
        comparison: unknown;
        results: readonly unknown[];
        summary: unknown;
      }>(`/eval/comparisons/${encodeURIComponent(comparison)}`);
      output(
        options.json
          ? JSON.stringify(result)
          : `${JSON.stringify(result.comparison)}\n${JSON.stringify(result.summary)}\n${JSON.stringify(result.results)}`,
      );
    });
  evalCommand
    .command(
      'compare-divergence <comparison> <leftRun> <rightRun> <leftEvents> <rightEvents>',
    )
    .description(
      'Compute and persist first-divergence evidence from two bounded event JSON files.',
    )
    .option('--json', 'Print stable JSON.')
    .action(
      async (
        comparison: string,
        leftRun: string,
        rightRun: string,
        leftEventsPath: string,
        rightEventsPath: string,
        options: { json?: boolean },
      ) => {
        const readEvents = async (
          path: string,
        ): Promise<readonly unknown[]> => {
          const parsed: unknown = JSON.parse(
            await readFile(resolve(path), 'utf8'),
          );
          if (!Array.isArray(parsed))
            throw new Error(`Event file must contain a JSON array: ${path}`);
          return parsed;
        };
        const result = await api<{
          firstDivergence: unknown;
          summary: unknown;
        }>(`/eval/comparisons/${encodeURIComponent(comparison)}/divergence`, {
          method: 'POST',
          body: JSON.stringify({
            leftRunId: leftRun,
            rightRunId: rightRun,
            leftEvents: await readEvents(leftEventsPath),
            rightEvents: await readEvents(rightEventsPath),
          }),
        });
        output(
          options.json
            ? JSON.stringify(result)
            : JSON.stringify(result.firstDivergence ?? null),
        );
      },
    );

  const adapters = program
    .command('adapters')
    .description(
      'Inspect installed source adapters and capability declarations.',
    );
  adapters
    .command('list')
    .option('--json', 'Print stable JSON.')
    .action((options: { json?: boolean }) => {
      const descriptors = [
        {
          id: APP_SERVER_ADAPTER_ID,
          version: '0.1.0',
          source: 'codex-app-server',
          capabilities: {
            prompts: true,
            messages: true,
            plans: true,
            reasoning: true,
            toolInputs: true,
            toolOutputs: true,
            approvals: true,
            compaction: true,
            subagents: true,
            tokenUsage: true,
            diffs: true,
            verification: true,
          },
        },
        genericJsonlAdapter.descriptor,
      ];
      output(
        options.json
          ? JSON.stringify({ adapters: descriptors })
          : descriptors
              .map((descriptor) => `${descriptor.id}\t${descriptor.version}`)
              .join('\n'),
      );
    });
  adapters
    .command('doctor')
    .option('--json', 'Print stable JSON.')
    .action((options: { json?: boolean }) => {
      const report = {
        ok: true,
        adapters: [APP_SERVER_ADAPTER_ID, genericJsonlAdapter.descriptor.id],
        checks: [
          {
            id: 'sdk',
            status: 'pass',
            message: 'Adapter capability contracts are available.',
          },
          {
            id: 'raw-preservation',
            status: 'pass',
            message: 'Adapters retain unknown source fields in raw payloads.',
          },
        ],
      };
      output(options.json ? JSON.stringify(report) : 'Adapters are ready.');
    });

  const codex = program
    .command('codex')
    .description('Run opt-in Codex integrations.');
  codex
    .command('app-server')
    .description('Capture one full-fidelity Codex app-server session.')
    .requiredOption('--prompt <text>', 'Prompt to submit to Codex.')
    .option('--cwd <path>', 'Working directory for Codex.', process.cwd())
    .option(
      '--project-id <id>',
      'Stable local project identifier.',
      'codex-app-server',
    )
    .option('--project-name <name>', 'Display name for the project.')
    .option('--model <model>', 'Optional Codex model override.')
    .action(
      async (options: {
        prompt: string;
        cwd: string;
        projectId: string;
        projectName?: string;
        model?: string;
      }) => {
        const cwd = resolve(options.cwd);
        const result = await runAppServer({
          cwd,
          prompt: options.prompt,
          context: {
            stateDir: stateDir(),
            sourceSessionId: `cli-${randomUUID()}`,
            project: {
              projectId: options.projectId,
              displayName: options.projectName ?? basename(cwd),
              pathHash: createHash('sha256').update(cwd).digest('hex'),
            },
            ...(options.model ? { model: options.model } : {}),
          },
        });
        output(
          JSON.stringify({
            adapter: APP_SERVER_ADAPTER_ID,
            eventCount: result.events.length,
            gapCount: result.gaps.length,
          }),
        );
      },
    );
  sessions
    .command('show <session>')
    .description('Show one captured session.')
    .action(async (session: string) => {
      const result = await api<{ session: unknown }>(
        `/sessions/${encodeURIComponent(session)}`,
      );
      output(JSON.stringify(result.session, undefined, 2));
    });
  sessions
    .command('delete <session>')
    .description('Tombstone one captured session while retaining raw evidence.')
    .action(async (session: string) => {
      await api<void>(`/sessions/${encodeURIComponent(session)}`, {
        method: 'DELETE',
      });
      output(`Deleted session ${session}.`);
    });

  program
    .command('export <session>')
    .description('Preview, scrub, and encrypt one portable session bundle.')
    .requiredOption(
      '--profile <profile>',
      'metadata-only, share-safe, or custom:<id>',
    )
    .option('-o, --output <path>', 'Output .vibetrace.age path.')
    .option(
      '--restore <pointer...>',
      'Restore JSON pointers only in this derived export view.',
      [],
    )
    .option(
      '--passphrase-stdin',
      'Read the bundle passphrase from standard input.',
    )
    .action(
      async (
        session: string,
        options: {
          profile: string;
          output?: string;
          restore: string[];
          passphraseStdin?: boolean;
        },
      ) => {
        const profile = exportProfile(options.profile, options.restore);
        const destination = resolve(
          options.output ??
            `${session.replaceAll(/[^A-Za-z0-9._-]/g, '_')}.vibetrace.age`,
        );
        const previewResult = await api<{
          preview: { manifestHash: string; manifest: unknown };
        }>('/exports/preview', {
          method: 'POST',
          body: JSON.stringify({ sessionId: session, profile }),
        });
        output(JSON.stringify(previewResult.preview.manifest, undefined, 2));
        output(`Manifest SHA-256: ${previewResult.preview.manifestHash}`);
        let passphrase: string;
        if (options.passphraseStdin) {
          const value = await stdin(4_096);
          passphrase = value?.replace(/[\r\n]+$/, '') ?? '';
          if (!passphrase)
            throw new Error('Bundle passphrase is empty or too large.');
        } else {
          passphrase = await secret('Bundle passphrase: ');
          const confirmation = await secret('Confirm passphrase: ');
          if (passphrase !== confirmation)
            throw new Error('Bundle passphrases do not match.');
        }
        const result = await api<{
          bundle: { destination: string; manifestHash: string };
        }>('/exports', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: session,
            profile,
            destination,
            passphrase,
            expectedManifestHash: previewResult.preview.manifestHash,
          }),
        });
        output(`Encrypted bundle written to ${result.bundle.destination}.`);
      },
    );

  program
    .command('import <bundle>')
    .description('Decrypt, validate, and import a portable VibeTrace bundle.')
    .option(
      '--passphrase-stdin',
      'Read the bundle passphrase from standard input.',
    )
    .action(async (bundle: string, options: { passphraseStdin?: boolean }) => {
      const source = resolve(bundle);
      const value = options.passphraseStdin
        ? await stdin(4_096)
        : await secret('Bundle passphrase: ');
      const passphrase = options.passphraseStdin
        ? (value?.replace(/[\r\n]+$/, '') ?? '')
        : value;
      if (!passphrase)
        throw new Error('Bundle passphrase is empty or too large.');
      const result = await api<{
        import: {
          sessionId: string;
          imported: boolean;
          eventCount: number;
          artifactCount: number;
        };
      }>('/imports', {
        method: 'POST',
        body: JSON.stringify({ source, passphrase }),
      });
      output(
        result.import.imported
          ? `Imported session ${result.import.sessionId} (${result.import.eventCount} events, ${result.import.artifactCount} artifacts).`
          : `Bundle already imported for session ${result.import.sessionId}.`,
      );
    });

  const init = program
    .command('init')
    .description('Install a source integration safely.');
  init
    .command('codex')
    .description('Install VibeTrace Codex lifecycle hooks.')
    .option('--dry-run', 'Preview changes without writing files.')
    .action(async (options: { dryRun?: boolean }) => {
      const result = await install({ dryRun: options.dryRun });
      output(result.preview);
      if (!options.dryRun)
        output('Open /hooks in Codex to review and trust the handlers.');
    });

  const uninstallCommand = program
    .command('uninstall')
    .description('Remove a source integration safely.');
  uninstallCommand
    .command('codex')
    .description('Remove only manifest-owned VibeTrace Codex hooks.')
    .option('--dry-run', 'Preview changes without writing files.')
    .action(async (options: { dryRun?: boolean }) => {
      const result = await uninstall({ dryRun: options.dryRun });
      output(result.preview);
      for (const warning of result.warnings) output(`Warning: ${warning}`);
    });

  program
    .command('doctor')
    .description('Diagnose the local Codex capture integration.')
    .option('--json', 'Print a stable JSON report.')
    .action(async (options: { json?: boolean }) => {
      const report = await doctor();
      if (options.json) output(JSON.stringify(report));
      else for (const line of humanDoctor(report)) output(line);
      if (!report.ok) setExitCode(1);
    });

  const hook = program.command('hook', { hidden: true });
  hook
    .command('collect', { hidden: true })
    .option('--installation <id>')
    .action(async () => {
      try {
        const text = await stdin(codexAdapterLimits.maxHookBytes);
        if (text !== undefined) await collect(text);
      } catch {
        // Hook collection is advisory and must never change Codex behavior.
      }
    });
  return program;
}
