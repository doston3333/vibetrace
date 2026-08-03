import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { RawSourceEventSchema, TraceEventSchema } from '@vibetrace/schema';
import { createSessionId } from '@vibetrace/schema';
import {
  StorageImportConflictError,
  type ImportedEventInput,
  type Storage,
} from '@vibetrace/storage';
import { z } from 'zod';

/** Large tool output remains bounded without excluding the 100 MiB capture scenario. */
const MAX_SEGMENT_BYTES = 128 * 1024 * 1024;
const TEMP_GRACE_MS = 60_000;

const projectSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(512),
    pathHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

const sessionSchema = z
  .object({
    source: z.string().min(1).max(128),
    sourceSessionId: z.string().min(1).max(512),
    startedAt: z.iso.datetime().refine((value) => value.endsWith('Z')),
    status: z.string().min(1).max(64),
    captureMode: z.enum(['full', 'standard', 'partial', 'unknown']),
    title: z.string().min(1).max(2048).optional(),
    model: z.string().min(1).max(512).optional(),
    sourceVersion: z.string().min(1).max(128).optional(),
  })
  .strict();

/** The sealed, bounded v1 segment written by source adapters. */
export const SpoolSegmentSchema = z
  .object({
    version: z.literal(1),
    project: projectSchema,
    session: sessionSchema,
    raw: RawSourceEventSchema,
    event: TraceEventSchema,
    normalizerId: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.event.provenance.adapter !== value.raw.adapter)
      ctx.addIssue({
        code: 'custom',
        message: 'Event adapter must match raw adapter.',
        path: ['event', 'provenance', 'adapter'],
      });
    if (value.event.provenance.adapterVersion !== value.raw.adapterVersion)
      ctx.addIssue({
        code: 'custom',
        message: 'Event adapter version must match raw adapter.',
        path: ['event', 'provenance', 'adapterVersion'],
      });
    if (value.session.source !== value.raw.adapter)
      ctx.addIssue({
        code: 'custom',
        message: 'Session source must match raw adapter.',
        path: ['session', 'source'],
      });
    if (value.session.sourceSessionId !== value.raw.sourceSessionId)
      ctx.addIssue({
        code: 'custom',
        message: 'Session source ID must match raw source ID.',
        path: ['session', 'sourceSessionId'],
      });
    if (
      value.event.sessionId !==
      createSessionId(value.raw.adapter, value.raw.sourceSessionId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Event session ID is not stable.',
        path: ['event', 'sessionId'],
      });
    if (value.event.provenance.captureMode !== value.session.captureMode)
      ctx.addIssue({
        code: 'custom',
        message: 'Capture mode must match session context.',
        path: ['event', 'provenance', 'captureMode'],
      });
    if (value.event.provenance.rawEventId !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Adapters must not supply a raw event ID.',
        path: ['event', 'provenance', 'rawEventId'],
      });
    if (value.event.sequence < 1)
      ctx.addIssue({
        code: 'custom',
        message: 'Canonical ordering is required.',
        path: ['event'],
      });
  });

export type SpoolSegment = z.infer<typeof SpoolSegmentSchema>;

/** Injectable points used to fault-test persistence boundaries without sleeps. */
export interface SpoolFaults {
  readonly afterCommitBeforeArchive?: (path: string) => void | Promise<void>;
  readonly beforeRename?: (temporary: string) => void | Promise<void>;
}

/** Read-only time control for stale temporary segment recovery. */
export interface SpoolImportOptions extends SpoolFaults {
  readonly now?: () => number;
  readonly temporaryGraceMs?: number;
}

export interface SpoolPaths {
  readonly root: string;
  readonly incoming: string;
  readonly archive: string;
  readonly quarantine: string;
}

/** Build state-scoped spool locations. */
export function spoolPaths(stateDir: string): SpoolPaths {
  const root = join(stateDir, 'spool');
  return {
    root,
    incoming: join(root, 'incoming'),
    archive: join(root, 'archive'),
    quarantine: join(root, 'quarantine'),
  };
}

/** Create the restricted spool layout. */
export async function ensureSpool(paths: SpoolPaths): Promise<void> {
  for (const path of [
    paths.root,
    paths.incoming,
    paths.archive,
    paths.quarantine,
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('Spool directory is unsafe.');
    await chmod(path, 0o700);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* Directory sync is unavailable on some supported platforms. */
  }
}

/** Atomically seal one event segment; readers only observe the final JSONL file. */
export async function writeSegment(
  paths: SpoolPaths,
  input: SpoolSegment,
  faults: Pick<SpoolFaults, 'beforeRename'> = {},
): Promise<string> {
  const segment = SpoolSegmentSchema.parse(input);
  const contents = `${JSON.stringify(segment)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_SEGMENT_BYTES)
    throw new Error('Spool segment exceeds the 128 MiB size limit.');
  await ensureSpool(paths);
  const name = `${randomUUID()}.jsonl`;
  const target = join(paths.incoming, name);
  const temporary = join(paths.incoming, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await faults.beforeRename?.(temporary);
    await rename(temporary, target);
    await syncDirectory(paths.incoming);
    return target;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function imported(segment: SpoolSegment): ImportedEventInput {
  return {
    project: {
      id: segment.project.projectId,
      displayName: segment.project.displayName,
      pathHash: segment.project.pathHash,
    },
    session: {
      id: segment.event.sessionId,
      projectId: segment.project.projectId,
      source: segment.session.source,
      sourceSessionId: segment.session.sourceSessionId,
      startedAt: segment.session.startedAt,
      status: segment.session.status,
      captureMode: segment.session.captureMode,
      title: segment.session.title,
      model: segment.session.model,
      sourceVersion: segment.session.sourceVersion,
    },
    raw: segment.raw,
    event: segment.event,
    normalizerId: segment.normalizerId,
  };
}

async function quarantine(
  paths: SpoolPaths,
  file: string,
  reason: string,
): Promise<void> {
  const target = join(paths.quarantine, `${file}.${randomUUID()}.quarantine`);
  try {
    await rename(join(paths.incoming, file), target);
  } catch {
    return;
  }
  await writeFile(`${target}.reason`, `${reason}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await syncDirectory(paths.quarantine);
}

/** Import every sealed segment present at call time, quarantining unsafe input individually. */
export async function importSegments(
  storage: Storage,
  paths: SpoolPaths,
  options: SpoolImportOptions = {},
): Promise<{ readonly imported: number; readonly quarantined: number }> {
  await ensureSpool(paths);
  let importedCount = 0;
  let quarantined = 0;
  for (const entry of await readdir(paths.incoming)) {
    if (entry.endsWith('.tmp')) {
      const metadata = await lstat(join(paths.incoming, entry)).catch(
        () => undefined,
      );
      const grace = options.temporaryGraceMs ?? TEMP_GRACE_MS;
      if (metadata && (options.now ?? Date.now)() - metadata.mtimeMs > grace) {
        await quarantine(paths, entry, 'STALE_TEMPORARY');
        quarantined += 1;
      }
      continue;
    }
    if (!entry.endsWith('.jsonl')) continue;
    const path = join(paths.incoming, entry);
    let input: SpoolSegment;
    let reason = 'INVALID_SEGMENT';
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        reason = 'SYMLINK';
        throw new Error();
      }
      if (!metadata.isFile()) {
        reason = 'NOT_REGULAR';
        throw new Error();
      }
      if (metadata.size > MAX_SEGMENT_BYTES) {
        reason = 'OVERSIZE';
        throw new Error();
      }
      const text = await readFile(path, 'utf8');
      if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
        reason = 'MULTILINE';
        throw new Error();
      }
      try {
        input = SpoolSegmentSchema.parse(JSON.parse(text));
      } catch {
        reason = 'INVALID_ENVELOPE';
        throw new Error();
      }
    } catch {
      await quarantine(paths, entry, reason);
      quarantined += 1;
      continue;
    }
    try {
      storage.importEvent(imported(input));
      await options.afterCommitBeforeArchive?.(path);
      const archived = join(paths.archive, entry);
      await rename(path, archived);
      await syncDirectory(paths.archive);
      importedCount += 1;
    } catch (error) {
      if (error instanceof StorageImportConflictError) {
        await quarantine(paths, entry, 'IMPORT_CONFLICT');
        quarantined += 1;
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return { imported: importedCount, quarantined };
}

/** Test-only size limit accessor; production import always uses the bounded constant. */
export const spoolLimits = {
  maxSegmentBytes: MAX_SEGMENT_BYTES,
  temporaryGraceMs: TEMP_GRACE_MS,
} as const;
