import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const repositoryDirectory = resolve(import.meta.dirname, '..', '..');
const cliEntry = join(
  repositoryDirectory,
  'packages',
  'cli',
  'dist',
  'index.js',
);
const storagePassphrase = 'browser smoke storage passphrase';

let temporary = '';
let environment: NodeJS.ProcessEnv;
let origin = '';
let handoffUrl = '';
let eventId = '';
let rawEventId = '';

function runCli(args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repositoryDirectory,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) resolveRun(output);
      else
        reject(
          new Error(
            `vibetrace ${args.join(' ')} failed (${String(code)}): ${Buffer.concat(stderr).toString('utf8')}${output}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

async function waitFor<T>(operation: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  do {
    const value = await operation().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  throw new Error('Browser smoke setup timed out.');
}

test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'vibetrace-browser-smoke-'));
  environment = {
    ...process.env,
    VIBETRACE_HOME: join(temporary, 'vibetrace-home'),
    CODEX_HOME: join(temporary, 'codex-home'),
  };
  await runCli(
    ['hook', 'collect'],
    `${JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'browser-smoke-session',
      transcript_path: null,
      cwd: repositoryDirectory,
      model: 'browser-smoke-model',
      permission_mode: 'default',
      source: 'startup',
    })}\n`,
  );
  await runCli(
    ['start', '--storage-passphrase-stdin'],
    `${storagePassphrase}\n`,
  );

  const descriptor = await waitFor(async () => {
    const value = JSON.parse(
      await readFile(join(environment.VIBETRACE_HOME!, 'daemon.json'), 'utf8'),
    ) as { origin?: string };
    return typeof value.origin === 'string' ? value : undefined;
  });
  origin = descriptor.origin!;
  const token = (
    await readFile(join(environment.VIBETRACE_HOME!, 'auth-token'), 'utf8')
  ).trim();
  const authorization = { authorization: `Bearer ${token}` };
  const session = await waitFor(async () => {
    const response = await fetch(`${origin}/api/v1/sessions`, {
      headers: authorization,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      sessions?: readonly { id: string }[];
    };
    return body.sessions?.[0];
  });
  const eventsResponse = await fetch(
    `${origin}/api/v1/sessions/${encodeURIComponent(session.id)}/events?limit=100`,
    { headers: authorization },
  );
  const eventsBody = (await eventsResponse.json()) as {
    events: readonly { id: string; rawEventId: string }[];
  };
  eventId = eventsBody.events[0]!.id;
  rawEventId = eventsBody.events[0]!.rawEventId;

  const ticketResponse = await fetch(`${origin}/api/v1/auth/tickets`, {
    method: 'POST',
    headers: authorization,
  });
  if (!ticketResponse.ok)
    throw new Error(`Ticket creation failed (${ticketResponse.status}).`);
  const ticket = (await ticketResponse.json()) as { ticket: string };
  const handoffResponse = await fetch(`${origin}/api/v1/auth/browser-handoff`, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: ticket.ticket }),
  });
  if (!handoffResponse.ok)
    throw new Error(`Browser handoff failed (${handoffResponse.status}).`);
  const handoff = (await handoffResponse.json()) as { handoffToken: string };
  if (typeof handoff.handoffToken !== 'string')
    throw new Error('Browser handoff did not return a token.');
  handoffUrl = `${origin}/?handoff=${encodeURIComponent(handoff.handoffToken)}`;
});

test.afterAll(async () => {
  if (environment) await runCli(['stop']).catch(() => undefined);
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('authenticates a real browser and navigates evidence without console failures', async ({
  page,
  request,
}) => {
  const browserFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserFailures.push(message.text());
  });
  page.on('pageerror', (error) => browserFailures.push(error.message));

  const handoffDocument = await request.get(handoffUrl);
  expect(handoffDocument.headers()['content-security-policy']).toContain(
    "script-src 'self'",
  );
  expect(handoffDocument.headers()['x-frame-options']).toBe('DENY');

  await page.goto(handoffUrl);
  await page.waitForURL((url) => !url.searchParams.has('handoff'));
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.locator('.session-row')).toHaveCount(1);

  await page.locator('.session-row').click();
  await expect(
    page.getByRole('heading', { name: 'Evidence timeline' }),
  ).toBeVisible();
  await expect(page.getByText(eventId, { exact: true })).toBeVisible();
  await expect(page.getByText(rawEventId, { exact: true })).toBeVisible();

  await page
    .getByRole('searchbox', { name: 'Search observable evidence' })
    .fill('no-such-observable-evidence');
  await expect(
    page.getByText('No evidence matches these filters.'),
  ).toBeVisible();
  expect(browserFailures).toEqual([]);
});
