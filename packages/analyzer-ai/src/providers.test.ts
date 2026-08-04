import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { buildAiPrompt } from './index.js';
import {
  AiProviderError,
  invokeCodexProvider,
  invokeDirectApiProvider,
  type SpawnImplementation,
} from './providers.js';

const prompt = buildAiPrompt({ sessionId: 'session-id', events: [] });

function chatResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function codeOf(error: unknown): string | undefined {
  return error instanceof AiProviderError ? error.code : undefined;
}

describe('direct API provider', () => {
  it('posts a strict JSON-schema request and returns only local provenance plus hypotheses', async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return chatResponse({ hypotheses: [{ arbitrary: true }] });
      },
    );
    const result = await invokeDirectApiProvider({
      prompt,
      endpoint: 'https://api.example.test/v1/chat/completions',
      apiKey: 'ephemeral-key',
      model: 'gpt-test',
      fetch,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.test/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ephemeral-key',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'gpt-test',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'vibetrace_ai_findings',
          strict: true,
          schema: {
            required: ['hypotheses'],
            properties: { hypotheses: { maxItems: 5 } },
          },
        },
      },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });
    expect(result).toEqual({
      provider: 'direct-api',
      model: 'gpt-test',
      hypotheses: [{ arbitrary: true }],
    });
  });

  it.each([
    'http://api.example.test/v1/chat/completions',
    'https://user:pass@api.example.test/v1/chat/completions',
    'https://api.example.test/v1/chat/completions#fragment',
  ])('rejects unsafe endpoint %s', async (endpoint) => {
    await expect(
      invokeDirectApiProvider({
        prompt,
        endpoint,
        apiKey: 'ephemeral-key',
        model: 'gpt-test',
      }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_CONFIG_INVALID' });
  });

  it('rejects oversized and malformed responses without exposing their body', async () => {
    await expect(
      invokeDirectApiProvider({
        prompt,
        endpoint: 'https://api.example.test/v1/chat/completions',
        apiKey: 'ephemeral-key',
        model: 'gpt-test',
        fetch: async () =>
          new Response('provider-secret', {
            status: 200,
            headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
          }),
      }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_RESPONSE_TOO_LARGE' });
    await expect(
      invokeDirectApiProvider({
        prompt,
        endpoint: 'https://api.example.test/v1/chat/completions',
        apiKey: 'ephemeral-key',
        model: 'gpt-test',
        fetch: async () => chatResponse({ unexpected: [] }),
      }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_RESPONSE_INVALID' });
  });

  it('redacts direct-provider transport and HTTP failures', async () => {
    const key = 'super-secret-api-key';
    await expect(
      invokeDirectApiProvider({
        prompt,
        endpoint: 'https://api.example.test/v1/chat/completions',
        apiKey: key,
        model: 'gpt-test',
        fetch: async () => {
          throw new Error(`failed with ${key}`);
        },
      }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_REQUEST_FAILED' });
    try {
      await invokeDirectApiProvider({
        prompt,
        endpoint: 'https://api.example.test/v1/chat/completions',
        apiKey: key,
        model: 'gpt-test',
        fetch: async () => new Response(`failure ${key}`, { status: 500 }),
      });
    } catch (error) {
      expect(codeOf(error)).toBe('AI_PROVIDER_RESPONSE_REJECTED');
      expect(String(error)).not.toContain(key);
    }
  });
});

interface SpawnCapture {
  readonly spawn: SpawnImplementation;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options: unknown;
  }>;
  readonly stdin: () => string;
  readonly killed: ReturnType<typeof vi.fn>;
  readonly inspection: () =>
    | {
        cwd: string;
        entries: readonly string[];
        directoryMode: number;
        schemaMode: number;
        schema: unknown;
      }
    | undefined;
}

function successfulSpawn(
  output: unknown = { hypotheses: [{ arbitrary: true }] },
): SpawnCapture {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: unknown;
  }> = [];
  let stdin = '';
  let inspection: ReturnType<SpawnCapture['inspection']>;
  const killed = vi.fn(() => true);
  const spawn = ((
    command: string,
    args: readonly string[],
    options: unknown,
  ) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: killed,
    });
    child.stdin.on('data', (chunk: Buffer) => {
      stdin += chunk.toString('utf8');
    });
    calls.push({ command, args, options });
    const cwd = (options as { cwd: string }).cwd;
    const schemaPath = args[args.indexOf('--output-schema') + 1]!;
    inspection = {
      cwd,
      entries: readdirSync(cwd),
      directoryMode: statSync(cwd).mode & 0o777,
      schemaMode: statSync(schemaPath).mode & 0o777,
      schema: JSON.parse(readFileSync(schemaPath, 'utf8')),
    };
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify(output));
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as SpawnImplementation;
  return {
    spawn,
    calls,
    stdin: () => stdin,
    killed,
    inspection: () => inspection,
  };
}

describe('Codex provider', () => {
  it('isolates Codex, sends only the prompt through stdin, and parses JSON output', async () => {
    const capture = successfulSpawn();
    const result = await invokeCodexProvider({
      prompt,
      model: 'gpt-test',
      spawn: capture.spawn,
      environment: {
        PATH: '/usr/bin',
        HOME: '/safe/home',
        CODEX_HOME: '/safe/codex-home',
        USERPROFILE: 'C:\\Users\\safe',
        APPDATA: 'C:\\Users\\safe\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\safe\\AppData\\Local',
        TEMP: '/tmp',
        CODEX_API_KEY: 'must-not-pass',
        OPENAI_API_KEY: 'must-not-pass',
        TRACE_CONTENT: 'must-not-pass',
      },
    });
    expect(result).toEqual({
      provider: 'codex',
      model: 'gpt-test',
      hypotheses: [{ arbitrary: true }],
    });
    const call = capture.calls[0]!;
    expect(call.command).toBe('codex');
    expect(call.args).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ignore-user-config',
      '--ignore-rules',
      '--output-schema',
      expect.any(String),
      '--model',
      'gpt-test',
      '-',
    ]);
    expect(call.args.join(' ')).not.toContain(prompt.user);
    expect(capture.stdin()).toContain(prompt.system);
    expect(capture.stdin()).toContain(prompt.user);
    expect(call.options).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const { cwd, env } = call.options as {
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    const inspection = capture.inspection();
    expect(inspection?.entries).toEqual(['hypothesis-output-schema.json']);
    expect(inspection?.directoryMode).toBe(0o700);
    expect(inspection?.schemaMode).toBe(0o600);
    expect(inspection?.schema).toMatchObject({
      required: ['hypotheses'],
      additionalProperties: false,
      properties: {
        hypotheses: {
          items: {
            required: [
              'id',
              'kind',
              'category',
              'severity',
              'title',
              'explanation',
              'impact',
              'recommendation',
              'confidence',
              'evidenceEventIds',
              'counterEvidenceEventIds',
            ],
            properties: {
              kind: { enum: ['problem', 'capture_limitation'] },
              severity: { enum: ['high', 'medium', 'low'] },
              recommendation: { type: 'string' },
              counterEvidenceEventIds: { type: 'array' },
            },
          },
        },
      },
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/safe/home',
      CODEX_HOME: '/safe/codex-home',
      USERPROFILE: 'C:\\Users\\safe',
      APPDATA: 'C:\\Users\\safe\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\safe\\AppData\\Local',
      TEMP: '/tmp',
    });
    expect(existsSync(cwd)).toBe(false);
  });

  it('returns generic codes on malformed output and timeout', async () => {
    const malformed = successfulSpawn({ hypotheses: [], extra: true });
    await expect(
      invokeCodexProvider({ prompt, spawn: malformed.spawn }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_RESPONSE_INVALID' });
    let child:
      | (EventEmitter & {
          stdin: PassThrough;
          stdout: PassThrough;
          stderr: PassThrough;
          kill: () => boolean;
        })
      | undefined;
    const hangingSpawn = (() => {
      child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      return child;
    }) as unknown as SpawnImplementation;
    await expect(
      invokeCodexProvider({ prompt, spawn: hangingSpawn, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });
    expect(child?.kill).toHaveBeenCalled();
  });
});
