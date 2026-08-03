import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  readonly waitForReady?: (
    stateDir: string,
  ) => Promise<
    { origin: string; instanceId: string; token: string } | undefined
  >;
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
  return program;
}
