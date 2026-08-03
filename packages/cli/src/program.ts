import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
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
  readDescriptor,
  recoverStaleState,
  resolveStateDir,
} from '@vibetrace/daemon';

export const cliVersion = '0.0.0';

export interface CliDependencies {
  readonly stateDir?: () => string;
  readonly spawn?: (command: string, args: readonly string[]) => void;
  readonly openBrowser?: (url: string) => void;
  readonly output?: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly readStdin?: (maxBytes: number) => Promise<string | undefined>;
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

function defaultSpawn(command: string, args: readonly string[]): void {
  spawn(command, [...args], { detached: true, stdio: 'ignore' }).unref();
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
  spawnDaemon: (command: string, args: readonly string[]) => void,
  request: typeof fetch,
): Promise<void> {
  if (await descriptorWithToken(stateDir, request)) return;
  await recoverStaleState(stateDir);
  const runPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../daemon/dist/run.js',
  );
  spawnDaemon(process.execPath, [runPath]);
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
  const program = new Command()
    .name('vibetrace')
    .description('VibeTrace local forensic debugger.')
    .version(cliVersion);
  program
    .command('start')
    .description('Start the local VibeTrace daemon.')
    .action(async () => {
      await start(stateDir(), spawnDaemon, request);
      output('VibeTrace daemon start requested.');
    });
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
