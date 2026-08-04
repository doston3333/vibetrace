import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionId } from '@vibetrace/schema';
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
    expect(program.helpInformation()).toContain('doctor');
    expect(program.helpInformation()).not.toContain('hook collect');
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

  it('exposes opt-in full-fidelity app-server capture without shell interpolation', async () => {
    const state = await mkdtemp(join(tmpdir(), 'vibetrace-cli-app-server-'));
    directories.push(state);
    const calls: Array<{ cwd: string; prompt: string; executable?: string }> =
      [];
    const outputs: string[] = [];
    const program = createProgram({
      stateDir: () => state,
      runAppServerSession: async (options) => {
        calls.push({
          cwd: options.cwd,
          prompt: options.prompt,
          executable: options.executable,
        });
        return { events: [], raw: [], gaps: [] };
      },
      output: (line) => outputs.push(line),
    });
    await program.parseAsync([
      'node',
      'vibetrace',
      'codex',
      'app-server',
      '--prompt',
      'Inspect the repository.',
      '--cwd',
      state,
    ]);
    expect(calls).toEqual([
      { cwd: state, prompt: 'Inspect the repository.', executable: undefined },
    ]);
    expect(outputs).toContain(
      JSON.stringify({
        adapter: 'codex-app-server',
        eventCount: 0,
        gapCount: 0,
      }),
    );
  });

  it('validates manifests and persists human review as pending_review status', async () => {
    const state = await mkdtemp(join(tmpdir(), 'vibetrace-cli-eval-'));
    directories.push(state);
    const manifestPath = join(state, 'manifest.json');
    const manifest = {
      schemaVersion: '1.0.0',
      id: createSessionId('eval', 'cli-case'),
      name: 'CLI evaluation case',
      sourceEvidence: {
        eventIds: [],
        artifactBlobHashes: [],
        captureGapIds: [],
      },
      repository: { baseCommit: 'a'.repeat(40) },
      task: {
        prompt: 'Review the fixture.',
        constraints: [],
        inferredFields: [],
      },
      configuration: { skills: [], instructionHashes: [], inferredFields: [] },
      success: {
        assertions: [
          { type: 'human_rating' as const, prompt: 'Review', minimum: 80 },
        ],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const outputs: string[] = [];
    const program = createProgram({
      stateDir: () => state,
      spawn: () => undefined,
      waitForReady: async () => ({
        origin: 'http://127.0.0.1:45680',
        instanceId: createSessionId('daemon', 'cli-eval'),
        token: 'f'.repeat(43),
      }),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith(`/eval/cases/${manifest.id}/runs`))
          return new Response(
            JSON.stringify({ run: { id: createSessionId('run', 'cli') } }),
            { status: 201 },
          );
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      runEvaluation: async () => ({
        manifestId: manifest.id,
        success: null,
        checks: [
          {
            index: 0,
            type: 'human_rating' as const,
            status: 'pending' as const,
            detail: 'Human review is required.',
          },
        ],
        commandResults: [],
        worktreeFingerprintHash: 'b'.repeat(64),
        jsonRecordCount: 0,
        malformedJsonRecordCount: 0,
      }),
      output: (line) => outputs.push(line),
    });
    await program.parseAsync([
      'node',
      'vibetrace',
      'eval',
      'validate',
      manifestPath,
    ]);
    await program.parseAsync([
      'node',
      'vibetrace',
      'eval',
      'run',
      manifestPath,
      '--cwd',
      state,
    ]);
    const runCreate = requests.find(
      (request) =>
        request.url.includes('/eval/cases/') && request.url.endsWith('/runs'),
    );
    expect(JSON.parse(String(runCreate?.init?.body))).toMatchObject({
      status: 'pending_review',
    });
    expect(outputs).toContain(
      `Valid evaluation manifest ${manifest.id} (CLI evaluation case).`,
    );
    expect(outputs).toContain('Evaluation needs review.');
  });

  it('passes a headless storage passphrase only over daemon standard input', async () => {
    const state = await mkdtemp(join(tmpdir(), 'vibetrace-cli-headless-'));
    directories.push(state);
    const spawned: Array<{
      command: string;
      args: readonly string[];
      standardInput?: string;
    }> = [];
    const outputs: string[] = [];
    const passphrase = 'headless test passphrase';
    const program = createProgram({
      stateDir: () => state,
      fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch,
      readStdin: async () => `${passphrase}\n`,
      spawn: (command, args, standardInput) =>
        spawned.push({
          command,
          args,
          ...(standardInput === undefined ? {} : { standardInput }),
        }),
      output: (line) => outputs.push(line),
    });
    await program.parseAsync([
      'node',
      'vibetrace',
      'start',
      '--storage-passphrase-stdin',
    ]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain('--storage-passphrase-stdin');
    expect(spawned[0]?.args.join(' ')).not.toContain(passphrase);
    expect(spawned[0]?.standardInput).toBe(passphrase);
    expect(outputs.join('\n')).not.toContain(passphrase);
  });

  it('routes install, uninstall, doctor, and the silent hidden collector', async () => {
    const outputs: string[] = [];
    const installCalls: Array<{ dryRun?: boolean }> = [];
    const uninstallCalls: Array<{ dryRun?: boolean }> = [];
    const collected: string[] = [];
    const exitCodes: number[] = [];
    const program = createProgram({
      output: (line) => outputs.push(line),
      readStdin: async () => '{"hook_event_name":"Stop"}',
      collectCodexHook: async (text) => {
        collected.push(text);
        return true;
      },
      installCodexHooks: async (options) => {
        installCalls.push(options);
        return { changed: true, preview: 'install preview', warnings: [] };
      },
      uninstallCodexHooks: async (options) => {
        uninstallCalls.push(options);
        return { changed: true, preview: 'uninstall preview', warnings: [] };
      },
      doctorCodex: async () => ({
        ok: false,
        checkedAt: '2026-08-03T12:00:00.000Z',
        checks: [
          {
            id: 'hook-config',
            status: 'fail',
            message: 'missing',
            remediation: 'run init',
          },
        ],
      }),
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync([
      'node',
      'vibetrace',
      'init',
      'codex',
      '--dry-run',
    ]);
    await program.parseAsync([
      'node',
      'vibetrace',
      'uninstall',
      'codex',
      '--dry-run',
    ]);
    await program.parseAsync(['node', 'vibetrace', 'doctor', '--json']);
    const outputCount = outputs.length;
    await program.parseAsync([
      'node',
      'vibetrace',
      'hook',
      'collect',
      '--installation',
      '00000000-0000-4000-8000-000000000000',
    ]);

    expect(installCalls).toEqual([{ dryRun: true }]);
    expect(uninstallCalls).toEqual([{ dryRun: true }]);
    expect(outputs).toContain('install preview');
    expect(outputs).toContain('uninstall preview');
    expect(
      JSON.parse(outputs.find((line) => line.startsWith('{')) as string),
    ).toMatchObject({ ok: false });
    expect(exitCodes).toEqual([1]);
    expect(collected).toEqual(['{"hook_event_name":"Stop"}']);
    expect(outputs).toHaveLength(outputCount);
  });

  it('previews before encrypted export and routes import and session management through the daemon', async () => {
    const state = await mkdtemp(join(tmpdir(), 'vibetrace-cli-bundle-'));
    directories.push(state);
    const origin = 'http://127.0.0.1:45679';
    const token = 'c'.repeat(43);
    const manifestHash = 'd'.repeat(64);
    const passphrase = 'portable test passphrase';
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const value = String(url);
      requests.push({ url: value, init });
      if (value.endsWith('/exports/preview'))
        return new Response(
          JSON.stringify({
            preview: {
              manifestHash,
              manifest: { format: 'vibetrace-portable', records: [] },
            },
          }),
          { status: 200 },
        );
      if (value.endsWith('/exports')) {
        const body = JSON.parse(String(init?.body)) as {
          destination: string;
        };
        return new Response(
          JSON.stringify({
            bundle: { destination: body.destination, manifestHash },
          }),
          { status: 200 },
        );
      }
      if (value.endsWith('/imports'))
        return new Response(
          JSON.stringify({
            import: {
              sessionId: 'session-1',
              imported: true,
              eventCount: 7,
              artifactCount: 2,
            },
          }),
          { status: 200 },
        );
      if (value.endsWith('/sessions'))
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'session-1',
                startedAt: '2026-01-01T00:00:00.000Z',
                status: 'completed',
                displayName: 'Project',
              },
            ],
          }),
          { status: 200 },
        );
      if (value.endsWith('/sessions/session-1') && init?.method === 'DELETE')
        return new Response(undefined, { status: 204 });
      if (value.endsWith('/sessions/session-1'))
        return new Response(
          JSON.stringify({ session: { id: 'session-1', status: 'completed' } }),
          { status: 200 },
        );
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const outputs: string[] = [];
    const secrets = [passphrase, passphrase, passphrase];
    const program = createProgram({
      stateDir: () => state,
      fetch: request,
      waitForReady: async () => ({
        origin,
        instanceId: '00000000-0000-4000-8000-000000000001',
        token,
      }),
      spawn: () => undefined,
      readSecret: async () => secrets.shift() ?? '',
      output: (line) => outputs.push(line),
    });
    const destination = join(state, 'exported.vibetrace.age');
    await program.parseAsync([
      'node',
      'vibetrace',
      'export',
      'session-1',
      '--profile',
      'share-safe',
      '--restore',
      '/payload/safeFalsePositive',
      '--output',
      destination,
    ]);
    await program.parseAsync([
      'node',
      'vibetrace',
      'import',
      join(state, 'incoming.vibetrace.age'),
    ]);
    await program.parseAsync(['node', 'vibetrace', 'sessions', 'list']);
    await program.parseAsync([
      'node',
      'vibetrace',
      'sessions',
      'show',
      'session-1',
    ]);
    await program.parseAsync([
      'node',
      'vibetrace',
      'sessions',
      'delete',
      'session-1',
    ]);

    const previewIndex = requests.findIndex((item) =>
      item.url.endsWith('/exports/preview'),
    );
    const exportIndex = requests.findIndex((item) =>
      item.url.endsWith('/exports'),
    );
    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(previewIndex);
    const exportBody = JSON.parse(
      String(requests[exportIndex]?.init?.body),
    ) as Record<string, unknown>;
    expect(exportBody).toMatchObject({
      destination,
      expectedManifestHash: manifestHash,
      passphrase,
      profile: {
        kind: 'share-safe',
        restorePointers: ['/payload/safeFalsePositive'],
      },
    });
    expect(
      requests.every((item) =>
        JSON.stringify(item.init?.headers).includes(token),
      ),
    ).toBe(true);
    expect(outputs.join('\n')).not.toContain(passphrase);
    expect(outputs).toContain(`Encrypted bundle written to ${destination}.`);
    expect(outputs).toContain(
      'Imported session session-1 (7 events, 2 artifacts).',
    );
    expect(outputs).toContain(
      'session-1\t2026-01-01T00:00:00.000Z\tcompleted\tProject',
    );
    expect(outputs).toContain('Deleted session session-1.');
  });

  it('does not submit an export when hidden passphrase confirmation differs', async () => {
    const calls: string[] = [];
    const responses = ['first secret value', 'different secret value'];
    const program = createProgram({
      stateDir: () => '/tmp/vibetrace-cli-mismatch',
      spawn: () => undefined,
      waitForReady: async () => ({
        origin: 'http://127.0.0.1:40000',
        instanceId: '00000000-0000-4000-8000-000000000002',
        token: 'e'.repeat(43),
      }),
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            preview: { manifestHash: 'f'.repeat(64), manifest: {} },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
      readSecret: async () => responses.shift() ?? '',
      output: () => undefined,
    });
    await expect(
      program.parseAsync([
        'node',
        'vibetrace',
        'export',
        'session-1',
        '--profile',
        'metadata-only',
      ]),
    ).rejects.toThrow('do not match');
    expect(calls.filter((url) => url.endsWith('/exports'))).toHaveLength(0);
  });
});
