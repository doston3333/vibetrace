import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cliVersion, createProgram } from './program.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('createProgram', () => {
  it('exposes the VibeTrace command name, version, and help surface', () => {
    const program = createProgram();

    expect(program.name()).toBe('vibetrace');
    expect(program.version()).toBe(cliVersion);
    expect(program.helpInformation()).toContain(
      'VibeTrace local forensic debugger.',
    );
    expect(program.helpInformation()).toContain('start');
    expect(program.helpInformation()).toContain('stop');
  });

  it('runs root lifecycle commands through injected process, browser, readiness, and HTTP boundaries', async () => {
    const state = await mkdtemp(join(tmpdir(), 'vibetrace-cli-'));
    directories.push(state);
    const origin = 'http://127.0.0.1:45678';
    const token = 'a'.repeat(43);
    await writeFile(join(state, 'auth-token'), `${token}\n`);
    await writeFile(
      join(state, 'daemon.json'),
      JSON.stringify({
        pid: 1,
        port: 45678,
        origin,
        instanceId: '00000000-0000-4000-8000-000000000000',
        apiVersion: 'v1',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/health'))
        return new Response(
          JSON.stringify({
            instanceId: '00000000-0000-4000-8000-000000000000',
          }),
          { status: 200 },
        );
      if (String(url).endsWith('/tickets'))
        return new Response(JSON.stringify({ ticket: 'b'.repeat(43) }), {
          status: 200,
        });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const opened: string[] = [];
    const outputs: string[] = [];
    const program = createProgram({
      stateDir: () => state,
      fetch: request,
      waitForReady: async () => ({
        origin,
        instanceId: '00000000-0000-4000-8000-000000000000',
        token,
      }),
      spawn: () => undefined,
      openBrowser: (url) => opened.push(url),
      output: (line) => outputs.push(line),
    });
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['start', 'status', 'stop', 'open']),
    );
    await program.parseAsync(['node', 'vibetrace', 'start']);
    await program.parseAsync(['node', 'vibetrace', 'status']);
    await program.parseAsync(['node', 'vibetrace', 'stop']);
    await program.parseAsync(['node', 'vibetrace', 'open']);
    expect(
      calls.some(
        (call) =>
          call.url.endsWith('/admin/shutdown') &&
          call.init?.headers &&
          JSON.stringify(call.init.headers).includes(token),
      ),
    ).toBe(true);
    const handoff = calls.find((call) =>
      call.url.endsWith('/auth/browser-handoff'),
    );
    expect(handoff?.init?.body).toContain('b'.repeat(43));
    expect(opened).toEqual([`${origin}/`]);
    expect(opened[0]).not.toContain(token);
    expect(opened[0]).not.toContain('b'.repeat(43));
    expect(outputs).toContain('running');
  });
});
