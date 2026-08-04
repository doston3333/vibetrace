import { spawn as nodeSpawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import {
  AI_HYPOTHESIS_OUTPUT_JSON_SCHEMA,
  AiProviderOutputSchema,
  type AiPrompt,
} from './index.js';

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

export const AiProviderIdSchema = z.enum(['direct-api', 'codex']);
export type AiProviderId = z.infer<typeof AiProviderIdSchema>;

export type AiProviderErrorCode =
  | 'AI_PROVIDER_CONFIG_INVALID'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_REQUEST_FAILED'
  | 'AI_PROVIDER_RESPONSE_REJECTED'
  | 'AI_PROVIDER_RESPONSE_TOO_LARGE'
  | 'AI_PROVIDER_RESPONSE_INVALID'
  | 'AI_PROVIDER_EXECUTION_FAILED'
  | 'AI_PROVIDER_OUTPUT_TOO_LARGE';

/** An intentionally detail-free provider error safe to surface to callers. */
export class AiProviderError extends Error {
  constructor(readonly code: AiProviderErrorCode) {
    super(code);
    this.name = 'AiProviderError';
  }
}

/** Provider provenance is local metadata; hypotheses are still untrusted. */
export interface AiProviderInvocationResult {
  readonly provider: AiProviderId;
  readonly model: string | undefined;
  readonly hypotheses: unknown;
}

export type FetchImplementation = typeof fetch;
export type SpawnImplementation = typeof nodeSpawn;

const ModelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/);
const TimeoutSchema = z.number().int().min(1).max(MAX_TIMEOUT_MS);
const PromptSchema = z
  .object({
    system: z.string(),
    user: z.string(),
    tools: z.tuple([]),
    networkAllowed: z.literal(false),
  })
  .strict();

const DirectApiInputSchema = z
  .object({
    prompt: PromptSchema,
    endpoint: z.string().min(1).max(4096),
    apiKey: z.string().min(1).max(4096),
    model: ModelSchema,
    timeoutMs: TimeoutSchema.optional(),
    fetch: z
      .custom<FetchImplementation>((value) => typeof value === 'function')
      .optional(),
  })
  .strict();

export interface DirectApiProviderInput {
  readonly prompt: AiPrompt;
  readonly endpoint: string;
  /** Ephemeral caller-owned credential; it is never included in thrown errors. */
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchImplementation;
}

function validatedHttpsEndpoint(endpoint: string): URL {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    )
      throw new Error('invalid');
    return url;
  } catch {
    throw new AiProviderError('AI_PROVIDER_CONFIG_INVALID');
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_PROVIDER_RESPONSE_BYTES)
  )
    throw new AiProviderError('AI_PROVIDER_RESPONSE_TOO_LARGE');
  if (!response.body) throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AiProviderError('AI_PROVIDER_RESPONSE_TOO_LARGE');
      }
      body += decoder.decode(next.value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError('AI_PROVIDER_REQUEST_FAILED');
  } finally {
    reader.releaseLock();
  }
}

/** Invoke an HTTPS Chat Completions endpoint with an ephemeral API key. */
export async function invokeDirectApiProvider(
  input: DirectApiProviderInput,
): Promise<AiProviderInvocationResult> {
  const parsed = DirectApiInputSchema.safeParse(input);
  if (!parsed.success) throw new AiProviderError('AI_PROVIDER_CONFIG_INVALID');
  const endpoint = validatedHttpsEndpoint(parsed.data.endpoint);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    let response: Response;
    try {
      const request = (parsed.data.fetch ?? fetch)(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${parsed.data.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: parsed.data.model,
          messages: [
            { role: 'system', content: parsed.data.prompt.system },
            { role: 'user', content: parsed.data.prompt.user },
          ],
          response_format: { type: 'json_object' },
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new AiProviderError('AI_PROVIDER_TIMEOUT'));
        }, parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      });
      response = await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError('AI_PROVIDER_REQUEST_FAILED');
    }
    if (!response.ok)
      throw new AiProviderError('AI_PROVIDER_RESPONSE_REJECTED');
    const body = await readBoundedResponse(response);
    let content: unknown;
    try {
      const envelope = JSON.parse(body) as {
        choices?: readonly { message?: { content?: unknown } }[];
      };
      content = envelope.choices?.[0]?.message?.content;
    } catch {
      throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
    }
    if (typeof content !== 'string')
      throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
    try {
      const output: unknown = JSON.parse(content);
      const parsedOutput = AiProviderOutputSchema.safeParse(output);
      if (!parsedOutput.success)
        throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
      return {
        provider: 'direct-api',
        model: parsed.data.model,
        hypotheses: parsedOutput.data.hypotheses,
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const CodexInputSchema = z
  .object({
    prompt: PromptSchema,
    model: ModelSchema.optional(),
    executable: z.string().min(1).max(4096).optional(),
    timeoutMs: TimeoutSchema.optional(),
    spawn: z
      .custom<SpawnImplementation>((value) => typeof value === 'function')
      .optional(),
    environment: z.record(z.string(), z.string().optional()).optional(),
  })
  .strict();

export interface CodexProviderInput {
  readonly prompt: AiPrompt;
  readonly model?: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly spawn?: SpawnImplementation;
  /** Test seam only; production callers should leave this unset. */
  readonly environment?: NodeJS.ProcessEnv;
}

function allowedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'CODEX_HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = environment[key];
    if (
      typeof value === 'string' &&
      !/(api.?key|token|secret|password|credential|auth)/i.test(key)
    )
      result[key] = value;
  }
  return result;
}

function codexPromptText(prompt: AiPrompt): string {
  return `${prompt.system}\n\n${prompt.user}`;
}

/** Invoke Codex in an isolated, read-only, ephemeral subprocess. */
export async function invokeCodexProvider(
  input: CodexProviderInput,
): Promise<AiProviderInvocationResult> {
  const parsed = CodexInputSchema.safeParse(input);
  if (!parsed.success) throw new AiProviderError('AI_PROVIDER_CONFIG_INVALID');
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(tmpdir(), 'vibetrace-ai-codex-'));
    await chmod(temporary, 0o700);
    const schemaPath = join(temporary, 'hypothesis-output-schema.json');
    await writeFile(
      schemaPath,
      JSON.stringify(AI_HYPOTHESIS_OUTPUT_JSON_SCHEMA),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await chmod(schemaPath, 0o600);
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ignore-user-config',
      '--ignore-rules',
      '--output-schema',
      schemaPath,
      ...(parsed.data.model ? ['--model', parsed.data.model] : []),
      '-',
    ];
    const spawn = parsed.data.spawn ?? nodeSpawn;
    let child: ReturnType<SpawnImplementation>;
    try {
      child = spawn(parsed.data.executable ?? 'codex', args, {
        cwd: temporary,
        env: allowedEnvironment(parsed.data.environment ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new AiProviderError('AI_PROVIDER_EXECUTION_FAILED');
    }
    if (!child.stdin || !child.stdout || !child.stderr)
      throw new AiProviderError('AI_PROVIDER_EXECUTION_FAILED');
    const stdin = child.stdin;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    const append = (
      chunks: Buffer[],
      chunk: string | Buffer,
      isStdout: boolean,
    ) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (isStdout) stdoutBytes += value.length;
      else stderrBytes += value.length;
      if (
        stdoutBytes > MAX_PROVIDER_RESPONSE_BYTES ||
        stderrBytes > MAX_PROVIDER_RESPONSE_BYTES
      ) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      if (isStdout) chunks.push(value);
    };
    child.stdout.on('data', (chunk: string | Buffer) =>
      append(stdout, chunk, true),
    );
    child.stderr.on('data', (chunk: string | Buffer) =>
      append(stdout, chunk, false),
    );
    const result = await new Promise<Buffer[]>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new AiProviderError('AI_PROVIDER_TIMEOUT')));
      }, parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.once('error', () =>
        finish(() =>
          reject(new AiProviderError('AI_PROVIDER_EXECUTION_FAILED')),
        ),
      );
      child.once('close', (code) =>
        finish(() => {
          if (outputTooLarge)
            reject(new AiProviderError('AI_PROVIDER_OUTPUT_TOO_LARGE'));
          else if (code !== 0)
            reject(new AiProviderError('AI_PROVIDER_EXECUTION_FAILED'));
          else resolve(stdout);
        }),
      );
      stdin.once('error', () =>
        finish(() =>
          reject(new AiProviderError('AI_PROVIDER_EXECUTION_FAILED')),
        ),
      );
      stdin.end(codexPromptText(parsed.data.prompt), 'utf8');
    });
    try {
      const output: unknown = JSON.parse(
        Buffer.concat(result).toString('utf8'),
      );
      const parsedOutput = AiProviderOutputSchema.safeParse(output);
      if (!parsedOutput.success)
        throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
      return {
        provider: 'codex',
        model: parsed.data.model,
        hypotheses: parsedOutput.data.hypotheses,
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError('AI_PROVIDER_RESPONSE_INVALID');
    }
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError('AI_PROVIDER_EXECUTION_FAILED');
  } finally {
    if (temporary) await rm(temporary, { force: true, recursive: true });
  }
}
