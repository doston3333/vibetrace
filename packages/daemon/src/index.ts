import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyInstance } from 'fastify';
import { Storage } from '@vibetrace/storage';
import { z } from 'zod';

import {
  ensureSpool,
  importSegments,
  spoolPaths,
  type SpoolImportOptions,
} from './spool.js';

const API_VERSION = 'v1';
const TOKEN_BYTES = 32;
const ticketSchema = z
  .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const annotationSchema = z
  .object({
    targetType: z.string().min(1).max(64),
    targetId: z.string().min(1).max(512),
    label: z.string().max(256).optional(),
    note: z.string().max(16_384).optional(),
  })
  .strict();
const sessionIdSchema = z.string().min(1).max(128);
const sessionListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(10_000).optional() })
  .strict();

/** The on-disk, secret-free description of one daemon instance. */
export interface DaemonDescriptor {
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly instanceId: string;
  readonly apiVersion: string;
  readonly startedAt: string;
}

/** Clock injection makes ticket expiry and lifecycle tests deterministic. */
export interface DaemonClock {
  now(): Date;
}

/** Optional collaborators for in-process tests and non-browser CLI integration. */
export interface DaemonOptions {
  readonly stateDir?: string;
  readonly storage?: Storage;
  readonly clock?: DaemonClock;
  readonly dashboardDir?: string;
  readonly spoolFaults?: SpoolImportOptions;
}

/** Injectable fetch boundary used to verify descriptor checks never leak tokens. */
export type DaemonFetch = typeof fetch;

export interface RunningDaemon {
  readonly app: FastifyInstance;
  readonly descriptor: DaemonDescriptor;
  readonly stateDir: string;
  readonly token: string;
  close(): Promise<void>;
}

interface Ticket {
  readonly expiresAt: number;
  used: boolean;
}

/** Resolve the only supported state directory shape; relative overrides are unsafe. */
export function resolveStateDir(value = process.env.VIBETRACE_HOME): string {
  if (value !== undefined) {
    if (!isAbsolute(value))
      throw new Error('VIBETRACE_HOME must be an absolute path.');
    return value;
  }
  return join(homedir(), '.vibetrace');
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function bearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return match?.[1];
}

async function restrictedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('VibeTrace state directory is unsafe.');
  await chmod(path, 0o700);
}

async function writeAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadOrCreateToken(stateDir: string): Promise<string> {
  const path = join(stateDir, 'auth-token');
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('VibeTrace token path is unsafe.');
    const token = (await readFile(path, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('VibeTrace token file is invalid.');
    await chmod(path, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return loadOrCreateToken(stateDir);
  }
}

/** Read an optional descriptor without interpreting its contents as trusted. */
export async function readDescriptor(
  stateDir: string,
): Promise<DaemonDescriptor | undefined> {
  try {
    const path = join(stateDir, 'daemon.json');
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const descriptor = z
      .object({
        pid: z.number().int().positive(),
        port: z.number().int().min(1).max(65535),
        origin: z.string().url(),
        instanceId: z.string().uuid(),
        apiVersion: z.literal(API_VERSION),
        startedAt: z.string().datetime(),
      })
      .strict()
      .parse(JSON.parse(await readFile(path, 'utf8')));
    const origin = new URL(descriptor.origin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.port !== String(descriptor.port) ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== ''
    )
      return undefined;
    return descriptor;
  } catch {
    return undefined;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function descriptorIsHealthy(
  stateDir: string,
  descriptor: DaemonDescriptor,
  request: DaemonFetch = fetch,
): Promise<boolean> {
  try {
    const token = (await readFile(join(stateDir, 'auth-token'), 'utf8')).trim();
    const response = await request(`${descriptor.origin}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    const body = (await response.json()) as { instanceId?: unknown };
    return response.ok && body.instanceId === descriptor.instanceId;
  } catch {
    return false;
  }
}

/** Clear only unusable local state; it never signals or kills the recorded PID. */
export async function recoverStaleState(
  stateDir: string,
  request: DaemonFetch = fetch,
): Promise<boolean> {
  const descriptor = await readDescriptor(stateDir);
  if (descriptor && (await descriptorIsHealthy(stateDir, descriptor, request)))
    return false;
  // The PID probe deliberately has no side effect. A mismatched/unhealthy instance
  // may be an unrelated process with a recycled PID and must never be terminated.
  if (descriptor) void pidExists(descriptor.pid);
  await rm(join(stateDir, 'daemon.json'), { force: true });
  await rm(join(stateDir, 'daemon.lock'), { force: true, recursive: true });
  return true;
}

/** Start an authenticated loopback-only daemon. It never logs credentials or trace data. */
export async function startDaemon(
  options: DaemonOptions = {},
): Promise<RunningDaemon> {
  const stateDir = resolveStateDir(options.stateDir);
  await restrictedDirectory(stateDir);
  const lockPath = join(stateDir, 'daemon.lock');
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch {
    if (!(await recoverStaleState(stateDir)))
      throw new Error('A VibeTrace daemon lock already exists.');
    await mkdir(lockPath, { mode: 0o700 });
  }
  const clock = options.clock ?? { now: () => new Date() };
  const instanceId = randomUUID();
  const ownStorage = options.storage === undefined;
  let openedStorage: Storage | undefined;
  let app: FastifyInstance | undefined;
  let importTimer: NodeJS.Timeout | undefined;
  try {
    const storage = options.storage ?? (await Storage.open({ stateDir }));
    openedStorage = storage;
    const token = await loadOrCreateToken(stateDir);
    await ensureSpool(spoolPaths(stateDir));
    app = fastify({ logger: false, bodyLimit: 1_048_576 });
    await app.register(cookie);
    let dashboardAvailable = false;
    {
      const dashboardDir =
        options.dashboardDir ??
        join(
          fileURLToPath(new URL('../../..', import.meta.url)),
          'apps',
          'dashboard',
          'dist',
        );
      const dashboard = await lstat(dashboardDir).catch(() => undefined);
      if (dashboard?.isDirectory() && !dashboard.isSymbolicLink()) {
        await app.register(fastifyStatic, {
          root: dashboardDir,
          prefix: '/',
          index: false,
          wildcard: false,
        });
        dashboardAvailable = true;
      }
    }
    const tickets = new Map<string, Ticket>();
    const sessions = new Set<string>();
    let pendingBrowserTicket: string | undefined;
    const importer = {
      status: 'idle' as 'idle' | 'error',
      lastImportedAt: undefined as string | undefined,
      lastErrorCode: undefined as string | undefined,
    };
    let importing: Promise<void> | undefined;
    const importOnce = async (): Promise<void> => {
      if (importing) return importing;
      importing = (async () => {
        try {
          const result = await importSegments(
            storage,
            spoolPaths(stateDir),
            options.spoolFaults,
          );
          importer.status = 'idle';
          importer.lastErrorCode = undefined;
          if (result.imported > 0 || result.quarantined > 0)
            importer.lastImportedAt = clock.now().toISOString();
        } catch {
          importer.status = 'error';
          importer.lastErrorCode = 'IMPORT_FAILED';
        } finally {
          importing = undefined;
        }
      })();
      return importing;
    };
    await importOnce();
    importTimer = setInterval(() => {
      void importOnce();
    }, 1_000);
    importTimer.unref();
    let origin = '';
    const exactOrigin = (): string => origin;
    const authenticated = (request: {
      headers: Record<string, unknown>;
      cookies: Record<string, string | undefined>;
    }): 'bearer' | 'cookie' | undefined => {
      const supplied = bearer(request.headers.authorization);
      if (supplied && constantTimeEquals(supplied, token)) return 'bearer';
      const session = request.cookies.vibetrace_session;
      return typeof session === 'string' && sessions.has(session)
        ? 'cookie'
        : undefined;
    };
    const prune = (): void => {
      const now = clock.now().getTime();
      for (const [id, ticket] of tickets)
        if (ticket.used || ticket.expiresAt <= now) tickets.delete(id);
      while (tickets.size > 128)
        tickets.delete(tickets.keys().next().value as string);
      while (sessions.size > 128)
        sessions.delete(sessions.values().next().value as string);
    };
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/v1')) return;
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin !== exactOrigin())
        return reply.code(403).send({ code: 'FOREIGN_ORIGIN' });
      if (
        request.url === '/api/v1/auth/session' ||
        request.url === '/api/v1/auth/browser-session'
      )
        return;
      const method = request.method;
      const mode = authenticated(request);
      if (!mode) return reply.code(401).send({ code: 'UNAUTHORIZED' });
      if (
        mode === 'cookie' &&
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
        origin !== exactOrigin()
      )
        return reply.code(403).send({ code: 'ORIGIN_REQUIRED' });
    });
    app.get('/api/v1/health', async () => ({
      ok: true,
      instanceId,
      apiVersion: API_VERSION,
      importer,
    }));
    app.post('/api/v1/auth/tickets', async (request, reply) => {
      const supplied = bearer(request.headers.authorization);
      if (!supplied || !constantTimeEquals(supplied, token))
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      prune();
      const ticket = randomBytes(TOKEN_BYTES).toString('base64url');
      tickets.set(hashTicket(ticket), {
        expiresAt: clock.now().getTime() + 60_000,
        used: false,
      });
      return {
        ticket,
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      };
    });
    app.post('/api/v1/auth/browser-handoff', async (request, reply) => {
      const supplied = bearer(request.headers.authorization);
      if (!supplied || !constantTimeEquals(supplied, token))
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      const parsed = ticketSchema.safeParse(request.body);
      if (!parsed.success || !tickets.has(hashTicket(parsed.data.ticket)))
        return reply.code(400).send({ code: 'INVALID_TICKET' });
      pendingBrowserTicket = hashTicket(parsed.data.ticket);
      return { ok: true };
    });
    app.post('/api/v1/auth/session', async (request, reply) => {
      if (request.headers.origin !== exactOrigin())
        return reply.code(403).send({ code: 'FOREIGN_ORIGIN' });
      const parsed = ticketSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_TICKET' });
      const record = tickets.get(hashTicket(parsed.data.ticket));
      if (!record || record.used || record.expiresAt <= clock.now().getTime())
        return reply.code(401).send({ code: 'INVALID_TICKET' });
      record.used = true;
      const session = randomBytes(TOKEN_BYTES).toString('base64url');
      sessions.add(session);
      prune();
      reply.setCookie('vibetrace_session', session, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
      return { ok: true };
    });
    app.post('/api/v1/auth/browser-session', async (request, reply) => {
      if (request.headers.origin !== exactOrigin())
        return reply.code(403).send({ code: 'FOREIGN_ORIGIN' });
      const ticketId = pendingBrowserTicket;
      pendingBrowserTicket = undefined;
      const record = ticketId ? tickets.get(ticketId) : undefined;
      if (!record || record.used || record.expiresAt <= clock.now().getTime())
        return reply.code(401).send({ code: 'INVALID_TICKET' });
      record.used = true;
      const session = randomBytes(TOKEN_BYTES).toString('base64url');
      sessions.add(session);
      prune();
      reply.setCookie('vibetrace_session', session, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
      return { ok: true };
    });
    const sessionId = (request: { params: unknown }): string | undefined => {
      const parsed = z
        .object({ id: sessionIdSchema })
        .safeParse(request.params);
      return parsed.success ? parsed.data.id : undefined;
    };
    app.get('/api/v1/sessions', async (request, reply) => {
      const parsed = sessionListQuerySchema.safeParse(request.query);
      return parsed.success
        ? { sessions: storage.listSessions(false, parsed.data.limit) }
        : reply.code(400).send({ code: 'INVALID_QUERY' });
    });
    app.get('/api/v1/sessions/:id', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      const session = storage.getSession(id);
      return session
        ? { session }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.delete('/api/v1/sessions/:id', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.deleteSession(id)
        ? reply.code(204).send()
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/sessions/:id/events', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      if (!storage.getSession(id))
        return reply.code(404).send({ code: 'NOT_FOUND' });
      return { events: storage.listEvents({ sessionId: id }) };
    });
    app.get('/api/v1/sessions/:id/artifacts', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.getSession(id)
        ? { artifacts: storage.listArtifacts(id) }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/sessions/:id/coverage', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.getSession(id)
        ? { coverage: { status: 'not_available' } }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/sessions/:id/findings', async (request, reply) => {
      const id = sessionId(request);
      if (!id) return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
      return storage.getSession(id)
        ? { findings: storage.listFindings(id) }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.get('/api/v1/annotations', async () => ({
      annotations: storage.listAnnotations(),
    }));
    app.post('/api/v1/annotations', async (request, reply) => {
      const parsed = annotationSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_ANNOTATION' });
      const annotation = {
        id: randomUUID(),
        ...parsed.data,
        createdAt: clock.now().toISOString(),
      };
      storage.createAnnotation(annotation);
      return reply.code(201).send({ annotation });
    });
    app.patch('/api/v1/annotations/:id', async (request, reply) => {
      const parsed = annotationSchema
        .pick({ label: true, note: true })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID_ANNOTATION' });
      return storage.updateAnnotation(
        (request.params as { id: string }).id,
        parsed.data,
      )
        ? { ok: true }
        : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    app.delete('/api/v1/annotations/:id', async (request, reply) =>
      storage.deleteAnnotation((request.params as { id: string }).id)
        ? reply.code(204).send()
        : reply.code(404).send({ code: 'NOT_FOUND' }),
    );
    app.route({
      method: ['GET', 'POST'],
      url: '/api/v1/imports',
      handler: async (_request, reply) =>
        reply.code(501).send({ code: 'NOT_AVAILABLE_UNTIL_BUNDLE_SLICE' }),
    });
    app.route({
      method: ['GET', 'POST'],
      url: '/api/v1/exports',
      handler: async (_request, reply) =>
        reply.code(501).send({ code: 'NOT_AVAILABLE_UNTIL_BUNDLE_SLICE' }),
    });
    let shutdownOnce: Promise<void> | undefined;
    app.post('/api/v1/admin/shutdown', async (request, reply) => {
      const supplied = bearer(request.headers.authorization);
      if (!supplied || !constantTimeEquals(supplied, token))
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      shutdownOnce ??= new Promise((resolve) =>
        setImmediate(() => {
          void close().finally(resolve);
        }),
      );
      return reply.code(202).send({ ok: true });
    });
    app.get('/', async (request, reply) => {
      if (sessions.has(request.cookies.vibetrace_session ?? ''))
        if (dashboardAvailable) return reply.sendFile('index.html');
      if (sessions.has(request.cookies.vibetrace_session ?? ''))
        return reply
          .type('text/html')
          .send(
            '<!doctype html><meta charset="utf-8">Dashboard assets unavailable.',
          );
      return reply
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><script>fetch("/api/v1/auth/browser-session",{method:"POST"}).then(r=>{if(r.ok)location.replace("/")})</script>',
        );
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL(address);
    const descriptor = {
      pid: process.pid,
      port: Number(url.port),
      origin: `http://127.0.0.1:${url.port}`,
      instanceId,
      apiVersion: API_VERSION,
      startedAt: clock.now().toISOString(),
    };
    origin = descriptor.origin;
    await writeAtomic(
      join(stateDir, 'daemon.json'),
      `${JSON.stringify(descriptor)}\n`,
      0o600,
    );
    let closeOnce: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closeOnce ??= (async () => {
        if (importTimer) clearInterval(importTimer);
        await importing;
        await app?.close();
        const current = await readDescriptor(stateDir);
        if (current?.instanceId === instanceId) {
          await rm(join(stateDir, 'daemon.json'), { force: true });
          await rm(join(stateDir, 'daemon.lock'), {
            force: true,
            recursive: true,
          });
        }
        if (ownStorage) storage.close();
      })());
    return { app, descriptor, stateDir, token, close };
  } catch (error) {
    if (importTimer) clearInterval(importTimer);
    await app?.close();
    await rm(lockPath, { force: true, recursive: true });
    if (ownStorage) openedStorage?.close();
    throw error;
  }
}

/** Run the importer once. A caller can schedule this without changing its safety properties. */
export async function importSpool(
  storage: Storage,
  stateDir: string,
  faults?: SpoolImportOptions,
): Promise<{ readonly imported: number; readonly quarantined: number }> {
  return importSegments(storage, spoolPaths(resolveStateDir(stateDir)), faults);
}
