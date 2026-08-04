import { PassThrough, Readable, Writable } from 'node:stream';

import { TraceEventSchema, createSessionId } from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  APP_SERVER_ADAPTER_ID,
  APP_SERVER_SCHEMA_ARTIFACTS,
  CODEX_APP_SERVER_SCHEMA_REGISTRY,
  CODEX_APP_SERVER_VALIDATED_VERSIONS,
  AppServerRpcEnvelopeSchema,
  assertSupportedAppServerVersion,
  captureAppServerJsonl,
  captureAppServerToSpool,
  parseAppServerJsonl,
  resolveAppServerSchema,
  runAppServerSession,
} from './index.js';

const context = {
  project: { projectId: 'project', displayName: 'Fixture project' },
  sourceSessionId: 'thread-fixture',
  stateDir: '/tmp/vibetrace-app-server-test',
  startedAt: '2026-01-01T00:00:00.000Z',
  sourceVersion: '0.144.3',
  cwd: '/repo',
};

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('Codex app-server adapter', () => {
  it('loads generated artifacts for every registered version', () => {
    expect(Object.keys(APP_SERVER_SCHEMA_ARTIFACTS)).toEqual([
      ...CODEX_APP_SERVER_VALIDATED_VERSIONS,
    ]);
    expect(CODEX_APP_SERVER_SCHEMA_REGISTRY).toHaveLength(
      CODEX_APP_SERVER_VALIDATED_VERSIONS.length,
    );
    for (const descriptor of CODEX_APP_SERVER_SCHEMA_REGISTRY) {
      expect(descriptor.artifact.$id).toBe(
        `https://vibetrace.dev/schemas/codex-app-server/${descriptor.schemaVersion}.json`,
      );
      expect(descriptor.artifact.properties).toHaveProperty('params');
      expect(
        AppServerRpcEnvelopeSchema.safeParse({
          id: 1,
          method: 'thread/started',
          params: { unknownField: true },
        }).success,
      ).toBe(true);
    }
  });

  it('resolves the versioned contract and turns older versions into explicit gaps', async () => {
    expect(resolveAppServerSchema('0.144.3')).toMatchObject({
      schemaVersion: '0.144.3',
      validated: true,
      artifactPath: 'schemas/0.144.3.json',
    });
    expect(resolveAppServerSchema('0.145.0')).toMatchObject({
      schemaVersion: '0.145.0',
      validated: true,
    });
    expect(resolveAppServerSchema('0.145.0-beta.1')).toBeUndefined();
    expect(resolveAppServerSchema('0.145.0+build.1')).toBeUndefined();
    expect(resolveAppServerSchema('0.147.0')).toBeUndefined();
    expect(() => assertSupportedAppServerVersion('0.144.2')).toThrow(
      'no validated contract',
    );
    expect(() => assertSupportedAppServerVersion('0.147.0')).toThrow(
      'no validated contract',
    );
    const result = await captureAppServerJsonl(
      Readable.from([line({ method: 'thread/started', params: {} })]),
      { ...context, sourceVersion: '0.143.9' },
    );
    expect(result.events[0]?.type).toBe('capture.gap');
  });

  it('parses split JSONL chunks with a bounded message iterator', async () => {
    const parsed = [];
    for await (const item of parseAppServerJsonl(
      Readable.from(['{"method":"thread/started"', ',"params":{}}\n']),
    ))
      parsed.push(item);
    expect(parsed).toHaveLength(1);
    expect('message' in (parsed[0] ?? {})).toBe(true);
  });

  it('maps ordered rich notifications and preserves raw fields', async () => {
    const result = await captureAppServerJsonl(
      Readable.from([
        line({
          method: 'thread/started',
          params: { thread: { id: 'thread-fixture' }, extra: 'keep' },
        }),
        line({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }),
        line({
          method: 'item/started',
          params: { item: { type: 'userMessage', text: 'Fix it' } },
        }),
        line({
          method: 'item/started',
          params: { item: { type: 'commandExecution', command: 'pnpm test' } },
        }),
        line({
          method: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              command: 'pnpm test',
              exitCode: 0,
            },
          },
        }),
        line({
          method: 'item/started',
          params: { item: { type: 'reasoningSummary', text: 'checking' } },
        }),
        line({
          method: 'item/started',
          params: { item: { type: 'agentMessage', text: 'Done' } },
        }),
        line({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-fixture',
            tokenUsage: { inputTokens: 12 },
          },
        }),
        line({
          method: 'turn/completed',
          params: {
            turn: {
              id: 'turn-1',
              status: 'completed',
              usage: { outputTokens: 4 },
            },
          },
        }),
      ]),
      context,
    );
    expect(result.events.map((event) => event.type)).toEqual([
      'session.started',
      'turn.started',
      'message.user',
      'command.started',
      'command.completed',
      'reasoning.summary',
      'message.agent',
      'usage.updated',
      'turn.completed',
    ]);
    expect(
      result.events.every((event) => TraceEventSchema.safeParse(event).success),
    ).toBe(true);
    expect(result.raw[0]?.payload).toMatchObject({ params: { extra: 'keep' } });
    expect(result.events.at(-1)?.usage?.outputTokens).toBe(4);
    expect(result.events[0]?.sessionId).toBe(
      createSessionId(APP_SERVER_ADAPTER_ID, 'thread-fixture'),
    );
  });

  it('records approval requests and explicit resolutions as scoped facts', async () => {
    const result = await captureAppServerJsonl(
      Readable.from([
        line({
          id: 41,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'pnpm test', reason: 'needs execution' },
        }),
        line({
          id: 41,
          method: 'permission/resolved',
          params: {
            requestId: '41',
            decision: 'decline',
            reason: 'user-denied',
          },
        }),
      ]),
      context,
    );
    expect(result.events.map((event) => event.type)).toEqual([
      'permission.requested',
      'permission.resolved',
    ]);
    expect(result.events[0]?.status).toBe('pending');
    expect(result.events[1]?.status).toBe('declined');
    expect(result.events[1]?.payload).toMatchObject({
      requestId: '41',
      decision: 'decline',
    });
    expect(result.events[0]?.payload).toMatchObject({ command: 'pnpm test' });
  });

  it('turns unknown, malformed, and oversized frames into bounded capture gaps', async () => {
    const malformed = '{not-json}\n';
    const oversized = `${'x'.repeat(20)}\n`;
    const result = await captureAppServerJsonl(
      Readable.from([
        line({
          method: 'unknown/event',
          params: { secret: 'retained encrypted' },
        }),
        malformed,
        oversized,
      ]),
      context,
      16,
    );
    expect(result.gaps).toHaveLength(3);
    expect(result.events.every((event) => event.type === 'capture.gap')).toBe(
      true,
    );
    expect(result.events.every((event) => event.rawPayload)).toBe(true);
  });

  it('does not concatenate a giant chunk before rejecting an oversized frame', async () => {
    const hugeChunk = `${'x'.repeat(2 * 1024 * 1024)}\n${line({ method: 'thread/started', params: {} })}`;
    const result = await captureAppServerJsonl(
      Readable.from([hugeChunk]),
      context,
      1024,
    );
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.type).toBe('capture.gap');
    expect(result.events[1]?.type).toBe('session.started');
  });

  it('writes each mapped event exactly once through the normal spool contract', async () => {
    const writes: unknown[] = [];
    const result = await captureAppServerToSpool(
      Readable.from([
        line({
          method: 'thread/started',
          params: { thread: { id: 'thread-fixture' } },
        }),
      ]),
      context,
      async (_paths, segment) => {
        writes.push(segment);
        return `segment-${writes.length}`;
      },
    );
    expect(writes).toHaveLength(result.events.length);
    expect(writes[0]).toMatchObject({
      event: { type: 'session.started' },
      version: 1,
    });
  });

  it('keeps the default process launch shell-free', async () => {
    const stdout = new PassThrough();
    const writes: unknown[] = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk)) as {
          id?: number | string;
          method?: string;
        };
        if (request.id === 1)
          stdout.write(
            line({
              id: 1,
              result: { serverInfo: { version: '0.144.3' } },
            }),
          );
        if (request.id === 2) {
          stdout.write(
            line({
              method: 'thread/started',
              params: { threadId: 'thread-live' },
            }),
          );
          stdout.write(
            line({ id: 2, result: { thread: { id: 'thread-live' } } }),
          );
        }
        if (request.id === 3) {
          stdout.write(
            line({
              method: 'turn/started',
              params: { turn: { id: 'turn-live' } },
            }),
          );
          stdout.write(line({ id: 3, result: { turn: { id: 'turn-live' } } }));
          stdout.write(
            line({
              id: 99,
              method: 'item/commandExecution/requestApproval',
              params: { command: 'pnpm test' },
            }),
          );
        }
        if (request.id === 99) {
          stdout.write(
            line({
              method: 'turn/completed',
              params: { turn: { id: 'turn-live', status: 'completed' } },
            }),
          );
        }
        callback();
      },
    });
    const result = await runAppServerSession({
      cwd: '/repo',
      prompt: 'Run the fixture.',
      context: { ...context, sourceSessionId: 'temporary-session' },
      spawn(executable, args, cwd) {
        expect(executable).toBe('codex');
        expect(args).toEqual(['app-server', '--stdio']);
        expect(cwd).toBe('/repo');
        return { stdin, stdout };
      },
      write: async (_paths, segment) => {
        writes.push(segment);
        return `segment-${writes.length}`;
      },
    });
    stdout.end();
    expect(result.events.map((event) => event.type)).toEqual([
      'session.started',
      'turn.started',
      'permission.requested',
      'permission.resolved',
      'turn.completed',
    ]);
    expect(result.events[3]?.status).toBe('declined');
    expect(writes).toHaveLength(5);
    expect(
      result.events.every(
        (event) => event.provenance.adapter === APP_SERVER_ADAPTER_ID,
      ),
    ).toBe(true);
    expect(stdin.writableEnded).toBe(true);
  });

  it.each([
    {
      mode: 'resume' as const,
      threadId: 'thread-existing',
      expectedMethod: 'thread/resume',
      expectedParams: { threadId: 'thread-existing', cwd: '/repo' },
      notification: 'thread/resumed',
      returnedThread: 'thread-existing',
    },
    {
      mode: 'fork' as const,
      threadId: 'thread-existing',
      lastTurnId: 'turn-1',
      ephemeral: true,
      expectedMethod: 'thread/fork',
      expectedParams: {
        threadId: 'thread-existing',
        lastTurnId: 'turn-1',
        ephemeral: true,
        cwd: '/repo',
      },
      notification: 'thread/started',
      returnedThread: 'thread-forked',
    },
  ])('supports $mode app-server thread mode', async (mode) => {
    const stdout = new PassThrough();
    const requests: Record<string, unknown>[] = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk)) as Record<string, unknown>;
        requests.push(request);
        const id = request.id;
        if (id === 1)
          stdout.write(
            line({ id: 1, result: { serverInfo: { version: '0.144.3' } } }),
          );
        if (id === 2) {
          stdout.write(
            line({
              method: mode.notification,
              params: {
                thread: {
                  id: mode.returnedThread,
                  ...(mode.mode === 'fork'
                    ? { forkedFromId: mode.threadId }
                    : {}),
                },
              },
            }),
          );
          stdout.write(
            line({
              id: 2,
              result: { thread: { id: mode.returnedThread } },
            }),
          );
        }
        if (id === 3) {
          stdout.write(
            line({
              method: 'turn/started',
              params: { turn: { id: 'turn-live' } },
            }),
          );
          stdout.write(line({ id: 3, result: { turn: { id: 'turn-live' } } }));
          stdout.write(
            line({
              method: 'turn/completed',
              params: { turn: { id: 'turn-live', status: 'completed' } },
            }),
          );
        }
        callback();
      },
    });
    const result = await runAppServerSession({
      cwd: '/repo',
      prompt: 'Continue the fixture.',
      context: { ...context, sourceSessionId: 'temporary-session' },
      thread: mode,
      spawn() {
        return { stdin, stdout };
      },
      write: async () => 'segment-thread-mode',
    });
    stdout.end();
    expect(requests[2]).toMatchObject({
      method: mode.expectedMethod,
      params: mode.expectedParams,
    });
    expect(result.events[0]?.payload).toMatchObject({
      mode: mode.mode,
      threadId: mode.returnedThread,
    });
    expect(result.events[0]?.sessionId).toBe(
      createSessionId(APP_SERVER_ADAPTER_ID, mode.returnedThread),
    );
  });

  it('rejects invalid resume and fork options before spawning Codex', async () => {
    const spawn = () => {
      throw new Error('spawn must not be reached');
    };
    await expect(
      runAppServerSession({
        cwd: '/repo',
        prompt: 'invalid',
        context,
        thread: { mode: 'resume' },
        spawn,
      }),
    ).rejects.toThrow('resume requires threadId');
    await expect(
      runAppServerSession({
        cwd: '/repo',
        prompt: 'invalid',
        context,
        thread: { mode: 'start', lastTurnId: 'turn-1' },
        spawn,
      }),
    ).rejects.toThrow('start cannot target');
  });

  it('bounds a nonresponsive child and records the timed-out phase', async () => {
    const stdout = new PassThrough();
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let onExit: (() => void) | undefined;
    let killed = false;
    const startedAt = Date.now();
    const result = await runAppServerSession({
      cwd: '/repo',
      prompt: 'This child never responds.',
      context: { ...context, sourceSessionId: 'stuck-session' },
      initializeTimeoutMs: 20,
      spawn() {
        return {
          stdin,
          stdout,
          kill() {
            killed = true;
            onExit?.();
            return true;
          },
          once(_event, listener) {
            onExit = listener as () => void;
            return this;
          },
        };
      },
      write: async () => 'segment-timeout',
    });
    stdout.destroy();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(killed).toBe(true);
    expect(result.events.at(-1)?.type).toBe('capture.gap');
    expect(result.gaps.at(-1)?.reason).toContain('initialize timed out');
  });
});
