import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
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
