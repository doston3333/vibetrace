import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';
import {
  GitObjectIdSchema,
  RawSourceEventSchema,
  RunFingerprintSchema,
  TraceEventSchema,
  type JsonObject,
  type RawSourceEvent,
  type RunFingerprint,
  type TraceEvent,
} from '@vibetrace/schema';

import { BlobStore, type BlobInfo } from './blobs.js';
import {
  type KeyProvider,
  resolveRootSecret,
  writePassphraseEnvelope,
} from './keys.js';
import { runMigrations } from './migrations.js';
import { restrictDirectoryToCurrentUser } from './permissions.js';

export { BlobStore, type BlobInfo } from './blobs.js';
export {
  MemoryKeyProvider,
  OsKeyringProvider,
  type KeyProvider,
} from './keys.js';
export { migrations, type SqlMigration } from './migrations.js';
export {
  restrictDirectoriesToCurrentUser,
  restrictDirectoryToCurrentUser,
} from './permissions.js';
export * from './schema.js';

/** A clock injection point for deterministic storage tests. */
export interface Clock {
  now(): Date;
}

/** Options for opening or initializing an encrypted VibeTrace state directory. */
export interface StorageOpenOptions {
  readonly stateDir: string;
  readonly keyProvider?: KeyProvider;
  readonly passphrase?: string;
  readonly clock?: Clock;
}

/** A minimal project record stored inside the encrypted database. */
export interface ProjectInput {
  readonly id: string;
  readonly displayName: string;
  readonly rootPathEncrypted?: string;
  readonly pathHash?: string;
  readonly vcsRemoteHash?: string;
}

/** A session record. IDs are caller-provided stable schema IDs. */
export interface SessionInput {
  readonly id: string;
  readonly projectId: string;
  readonly source: string;
  readonly sourceSessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: string;
  readonly captureMode: string;
  readonly title?: string;
  readonly model?: string;
  readonly sourceVersion?: string;
  readonly baseCommit?: string;
  readonly finalCommit?: string;
  readonly runFingerprint?: RunFingerprint;
}

/** An append-only turn record. */
export interface TurnInput {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly status: string;
  readonly sourceTurnId?: string;
}

/** A queryable normalized event returned by storage. */
export interface StoredNormalizedEvent {
  readonly id: string;
  readonly rawEventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly toolName?: string;
  readonly event: TraceEvent;
}

/** Filters that can be combined without exposing SQL construction to callers. */
export interface EventFilter {
  readonly sessionId: string;
  readonly type?: string;
  readonly toolName?: string;
  readonly from?: string;
  readonly to?: string;
  readonly afterSequence?: number;
  readonly afterId?: string;
  readonly limit?: number;
}

/** Safe metadata filters for the forensic sessions index. */
export interface SessionFilter {
  readonly project?: string;
  readonly model?: string;
  readonly result?: string;
  readonly category?: string;
  readonly captureMode?: string;
}

/** A deterministic finding. Evidence IDs must refer to normalized events. */
export interface FindingInput {
  readonly id: string;
  readonly sessionId: string;
  readonly ruleId: string;
  readonly detectorVersion: string;
  readonly category: string;
  readonly severity: string;
  readonly title: string;
  readonly explanation: string;
  readonly recommendation: string;
  readonly evidenceEventIds: readonly string[];
  readonly counterevidenceEventIds?: readonly string[];
  readonly confidence?: number;
  readonly state?: string;
}

/** Human review data remains stable while analyzer-owned findings are replaced. */
export interface FindingReviewInput {
  readonly decision?: 'open' | 'confirmed' | 'rejected';
  readonly categoryOverride?: string;
  readonly note?: string;
}

export interface StoredFindingReview extends FindingReviewInput {
  readonly updatedAt: string;
}

/** Generic encrypted metadata-bearing artifact input. */
export interface ArtifactInput {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly metadata: JsonObject;
  readonly eventId?: string;
  readonly pathEncrypted?: string;
  readonly pathHash?: string;
  readonly contentHash?: string;
  readonly blobHash?: string;
}

/** A human annotation attached to a storage target. */
export interface AnnotationInput {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly label?: string;
  readonly note?: string;
}

/** A project and session envelope persisted atomically with one imported event. */
export interface ImportedEventInput {
  readonly project: ProjectInput;
  readonly session: SessionInput;
  readonly raw: RawSourceEvent;
  readonly event: TraceEvent;
  readonly normalizerId: string;
}

/** Safe session metadata for daemon consumers; encrypted paths are never exposed. */
export interface StoredSession {
  readonly id: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly source: string;
  readonly sourceSessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: string;
  readonly captureMode: string;
  readonly title?: string;
  readonly model?: string;
  readonly sourceVersion?: string;
  readonly baseCommit?: string;
  readonly finalCommit?: string;
  readonly runFingerprint?: RunFingerprint;
  readonly eventCount: number;
  readonly findingCount: number;
  readonly primaryFinding?: string;
}

/** A persisted metadata artifact. */
export type StoredArtifact = ArtifactInput;

/** A persisted annotation. */
export type StoredAnnotation = AnnotationInput;

/** A persisted deterministic finding with an optional durable human review. */
export interface StoredFinding extends FindingInput {
  readonly review?: StoredFindingReview;
}

/** A user-controlled export redaction profile. */
export interface RedactionProfileInput {
  readonly id: string;
  readonly name: string;
  readonly rules: JsonObject;
}

export interface StoredRedactionProfile extends RedactionProfileInput {
  readonly createdAt: string;
}

/** A deterministic imported identity conflict, safe for spool quarantine. */
export class StorageImportConflictError extends Error {
  constructor() {
    super('Imported event conflicts with immutable stored identity.');
    this.name = 'StorageImportConflictError';
  }
}

type SqliteDatabase = import('better-sqlite3').Database;
type Row = Record<string, unknown>;

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be a non-empty string.`);
}

function assertIso(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || !value.endsWith('Z'))
    throw new Error(`${field} must be an ISO 8601 UTC timestamp.`);
}

function assertGitObjectId(value: string | undefined, field: string): void {
  if (value !== undefined && !GitObjectIdSchema.safeParse(value).success)
    throw new Error(`${field} must be a canonical Git object ID.`);
}

function assertPositiveInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0)
    throw new Error(`${field} must be a positive integer.`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
function fromJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

const SESSION_SELECT = `s.id, s.project_id, p.display_name, s.source, s.source_session_id, s.started_at, s.ended_at, s.status, s.capture_mode, s.title, s.model, s.source_version, s.base_commit, s.final_commit, s.run_fingerprint_json,
  (SELECT COUNT(*) FROM normalized_events n WHERE n.session_id = s.id) AS event_count,
  (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS finding_count,
  (SELECT f.title FROM findings f LEFT JOIN finding_reviews r ON r.finding_id = f.id WHERE f.session_id = s.id AND COALESCE(r.decision, f.state) != 'rejected' ORDER BY f.severity DESC, f.id ASC LIMIT 1) AS primary_finding`;

function storedSession(row: Row): StoredSession {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    displayName: String(row.display_name),
    source: String(row.source),
    sourceSessionId: String(row.source_session_id),
    startedAt: String(row.started_at),
    ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
    status: String(row.status),
    captureMode: String(row.capture_mode),
    ...(row.title ? { title: String(row.title) } : {}),
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.source_version
      ? { sourceVersion: String(row.source_version) }
      : {}),
    ...(row.base_commit ? { baseCommit: String(row.base_commit) } : {}),
    ...(row.final_commit ? { finalCommit: String(row.final_commit) } : {}),
    ...(row.run_fingerprint_json
      ? {
          runFingerprint: RunFingerprintSchema.parse(
            fromJson(row.run_fingerprint_json),
          ),
        }
      : {}),
    eventCount: Number(row.event_count),
    findingCount: Number(row.finding_count),
    ...(row.primary_finding
      ? { primaryFinding: String(row.primary_finding) }
      : {}),
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function derive(root: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), label, 32));
}

function configureCipher(database: SqliteDatabase, key: Buffer): void {
  // SQLite3MultipleCiphers' legacy SQLCipher mode is set before the key is accepted.
  database.pragma("cipher = 'sqlcipher'");
  database.pragma('legacy = 4');
  database.pragma(`key = "x'${key.toString('hex')}'"`);
  if (database.pragma('cipher', { simple: true }) !== 'sqlcipher')
    throw new Error('Encrypted storage cipher verification failed.');
  // A schema read forces key verification before repositories can be used.
  database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
}

/** Encrypted local VibeTrace state. Its native database client is deliberately private. */
export class Storage {
  readonly #database: SqliteDatabase;
  readonly #root: Buffer;
  readonly #clock: Clock;
  readonly #stateDir: string;
  #activeBlobKeyId: string;
  readonly blobs: BlobStore;

  private constructor(
    database: SqliteDatabase,
    root: Buffer,
    stateDir: string,
    clock: Clock,
    activeBlobKeyId: string,
  ) {
    this.#database = database;
    this.#root = root;
    this.#clock = clock;
    this.#stateDir = stateDir;
    this.#activeBlobKeyId = activeBlobKeyId;
    this.blobs = new BlobStore({
      stateDir,
      addressKey: derive(root, 'vibetrace/blob-address'),
      keyForId: (id) => derive(root, `vibetrace/blob-encryption/${id}`),
      activeKeyId: () => this.#activeBlobKeyId,
    });
  }

  /** Initialize a new store when needed, then open it. */
  static async initialize(options: StorageOpenOptions): Promise<Storage> {
    return Storage.#open(options, true);
  }

  /** Open an existing store or initialize it using the configured secret provider. */
  static async open(options: StorageOpenOptions): Promise<Storage> {
    return Storage.#open(options, true);
  }

  /** Unlock an existing store only; it never creates new key material. */
  static async unlock(options: StorageOpenOptions): Promise<Storage> {
    return Storage.#open(options, false);
  }

  static async #open(
    options: StorageOpenOptions,
    create: boolean,
  ): Promise<Storage> {
    assertText(options.stateDir, 'stateDir');
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const stateStatus = await lstat(options.stateDir);
    if (!stateStatus.isDirectory() || stateStatus.isSymbolicLink())
      throw new Error('Encrypted storage directory is unsafe.');
    await restrictDirectoryToCurrentUser(options.stateDir);
    const dbPath = join(options.stateDir, 'state.db');
    let databaseExists = false;
    try {
      const status = await lstat(dbPath);
      if (!status.isFile() || status.isSymbolicLink())
        throw new Error('Encrypted storage path is unsafe.');
      databaseExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!create && !databaseExists)
      throw new Error('Encrypted storage has not been initialized.');
    const root = await resolveRootSecret({
      stateDir: options.stateDir,
      keyProvider: options.keyProvider,
      passphrase: options.passphrase,
      create: create && !databaseExists,
    });
    let database: SqliteDatabase | undefined;
    try {
      database = new Database(dbPath);
      configureCipher(database, derive(root, 'vibetrace/db'));
      const clock = options.clock ?? { now: () => new Date() };
      runMigrations(database, clock.now().toISOString());
      const existing = database
        .prepare(
          "SELECT id FROM encryption_keys WHERE purpose = 'blob' AND status = 'active' LIMIT 1",
        )
        .get() as { id: string } | undefined;
      const activeBlobKeyId = existing?.id ?? 'blob-v1';
      if (!existing)
        database
          .prepare(
            "INSERT INTO encryption_keys (id, purpose, status, created_at) VALUES (?, 'blob', 'active', ?)",
          )
          .run(activeBlobKeyId, clock.now().toISOString());
      const storage = new Storage(
        database,
        root,
        options.stateDir,
        clock,
        activeBlobKeyId,
      );
      await storage.blobs.initialize();
      return storage;
    } catch (error) {
      database?.close();
      throw error;
    }
  }

  /** Close the encrypted database. Existing blob streams remain independent. */
  close(): void {
    this.#database.close();
    this.#root.fill(0);
  }

  /** Run a bounded synchronous unit atomically, including nested repository calls. */
  transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation)();
  }

  /** Re-wrap the unchanged root secret under a new local passphrase. */
  async changePassphrase(passphrase: string): Promise<void> {
    await writePassphraseEnvelope(this.#stateDir, passphrase, this.#root);
  }

  /** Create a project. */
  createProject(input: ProjectInput): void {
    assertText(input.id, 'project.id');
    assertText(input.displayName, 'project.displayName');
    this.#database
      .prepare(
        'INSERT INTO projects (id, display_name, root_path_encrypted, path_hash, vcs_remote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.displayName,
        input.rootPathEncrypted ?? null,
        input.pathHash ?? null,
        input.vcsRemoteHash ?? null,
        this.#clock.now().toISOString(),
      );
  }

  /** Create a session belonging to an existing project. */
  createSession(input: SessionInput): void {
    assertText(input.id, 'session.id');
    assertText(input.projectId, 'session.projectId');
    assertText(input.source, 'session.source');
    assertText(input.sourceSessionId, 'session.sourceSessionId');
    assertText(input.status, 'session.status');
    assertText(input.captureMode, 'session.captureMode');
    assertIso(input.startedAt, 'session.startedAt');
    if (input.endedAt) assertIso(input.endedAt, 'session.endedAt');
    assertGitObjectId(input.baseCommit, 'session.baseCommit');
    assertGitObjectId(input.finalCommit, 'session.finalCommit');
    this.#database
      .prepare(
        'INSERT INTO sessions (id, project_id, source, source_session_id, title, started_at, ended_at, status, capture_mode, model, source_version, base_commit, final_commit, run_fingerprint_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.projectId,
        input.source,
        input.sourceSessionId,
        input.title ?? null,
        input.startedAt,
        input.endedAt ?? null,
        input.status,
        input.captureMode,
        input.model ?? null,
        input.sourceVersion ?? null,
        input.baseCommit ?? null,
        input.finalCommit ?? null,
        input.runFingerprint
          ? json(RunFingerprintSchema.parse(input.runFingerprint))
          : null,
      );
  }

  /** Import one raw/canonical pair with its project and session in one transaction. */
  importEvent(input: ImportedEventInput): string {
    if (input.session.endedAt)
      assertIso(input.session.endedAt, 'session.endedAt');
    assertGitObjectId(input.session.baseCommit, 'session.baseCommit');
    assertGitObjectId(input.session.finalCommit, 'session.finalCommit');
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          'INSERT INTO projects (id, display_name, root_path_encrypted, path_hash, vcs_remote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        )
        .run(
          input.project.id,
          input.project.displayName,
          input.project.rootPathEncrypted ?? null,
          input.project.pathHash ?? null,
          input.project.vcsRemoteHash ?? null,
          this.#clock.now().toISOString(),
        );
      const project = this.#database
        .prepare('SELECT display_name FROM projects WHERE id = ?')
        .get(input.project.id) as { display_name: string } | undefined;
      if (!project || project.display_name !== input.project.displayName)
        throw new Error('Project identity collision.');
      this.#database
        .prepare(
          'INSERT INTO sessions (id, project_id, source, source_session_id, title, started_at, ended_at, status, capture_mode, model, source_version, base_commit, final_commit, run_fingerprint_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, source_session_id) DO NOTHING',
        )
        .run(
          input.session.id,
          input.session.projectId,
          input.session.source,
          input.session.sourceSessionId,
          input.session.title ?? null,
          input.session.startedAt,
          input.session.endedAt ?? null,
          input.session.status,
          input.session.captureMode,
          input.session.model ?? null,
          input.session.sourceVersion ?? null,
          input.session.baseCommit ?? null,
          input.session.finalCommit ?? null,
          input.session.runFingerprint
            ? json(RunFingerprintSchema.parse(input.session.runFingerprint))
            : null,
        );
      const session = this.#database
        .prepare(
          'SELECT id, project_id, deleted_at, ended_at, base_commit, final_commit, run_fingerprint_json FROM sessions WHERE source = ? AND source_session_id = ?',
        )
        .get(input.session.source, input.session.sourceSessionId) as
        | {
            id: string;
            project_id: string;
            deleted_at: string | null;
            ended_at: string | null;
            base_commit: string | null;
            final_commit: string | null;
            run_fingerprint_json: string | null;
          }
        | undefined;
      if (
        !session ||
        session.id !== input.session.id ||
        session.project_id !== input.session.projectId
      )
        throw new Error('Session identity collision.');
      if (session.deleted_at !== null)
        throw new Error('Cannot append to a deleted session.');
      const stable = (
        stored: string | null,
        incoming: string | undefined,
      ): void => {
        if (incoming === undefined) return;
        if (stored !== null && stored !== incoming)
          throw new StorageImportConflictError();
      };
      const fingerprint = input.session.runFingerprint
        ? json(RunFingerprintSchema.parse(input.session.runFingerprint))
        : undefined;
      stable(session.base_commit, input.session.baseCommit);
      stable(session.ended_at, input.session.endedAt);
      stable(session.run_fingerprint_json, fingerprint);
      stable(session.final_commit, input.session.finalCommit);
      if (session.base_commit === null && input.session.baseCommit)
        this.#database
          .prepare('UPDATE sessions SET base_commit = ? WHERE id = ?')
          .run(input.session.baseCommit, session.id);
      if (session.ended_at === null && input.session.endedAt)
        this.#database
          .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
          .run(input.session.endedAt, session.id);
      if (session.run_fingerprint_json === null && fingerprint)
        this.#database
          .prepare('UPDATE sessions SET run_fingerprint_json = ? WHERE id = ?')
          .run(fingerprint, session.id);
      if (session.final_commit === null && input.session.finalCommit)
        this.#database
          .prepare('UPDATE sessions SET final_commit = ? WHERE id = ?')
          .run(input.session.finalCommit, session.id);
      if (input.event.type === 'session.completed')
        this.#database
          .prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?')
          .run('completed', input.event.timestamp, input.session.id);
      if (input.event.turnId) {
        if (!input.raw.sourceTurnId)
          throw new Error('Turn event is missing its source turn identity.');
        this.#database
          .prepare(
            'INSERT INTO turns (id, session_id, source_turn_id, sequence, started_at, status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
          )
          .run(
            input.event.turnId,
            input.session.id,
            input.raw.sourceTurnId,
            input.event.sequence,
            input.event.timestamp,
            input.event.type === 'turn.completed' ? 'completed' : 'active',
          );
        const turn = this.#database
          .prepare('SELECT session_id, source_turn_id FROM turns WHERE id = ?')
          .get(input.event.turnId) as
          { session_id: string; source_turn_id: string | null } | undefined;
        if (
          !turn ||
          turn.session_id !== input.session.id ||
          turn.source_turn_id !== input.raw.sourceTurnId
        )
          throw new Error('Turn identity collision.');
        if (input.event.type === 'turn.completed')
          this.#database
            .prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?')
            .run('completed', input.event.timestamp, input.event.turnId);
      }
      const rawId = this.appendRaw(input.session.id, input.raw);
      if (input.event.sessionId !== input.session.id)
        throw new Error(
          'Normalized event session does not match import session.',
        );
      this.appendNormalized(
        {
          ...input.event,
          provenance: { ...input.event.provenance, rawEventId: rawId },
        },
        input.normalizerId,
      );
      return rawId;
    });
    try {
      return transaction();
    } catch (error) {
      if (error instanceof StorageImportConflictError) throw error;
      if (
        error instanceof Error &&
        /collision|belongs to a different session|Cannot append to a deleted session|Session identity/.test(
          error.message,
        )
      )
        throw new StorageImportConflictError();
      throw error;
    }
  }

  /** List non-deleted sessions without exposing encrypted project paths. */
  listSessions(
    includeDeleted = false,
    limit = 500,
    filter: SessionFilter = {},
  ): readonly StoredSession[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('session limit must be between 1 and 10000.');
    const conditions = includeDeleted ? [] : ['s.deleted_at IS NULL'];
    const values: unknown[] = [];
    if (filter.project) {
      conditions.push('(s.project_id = ? OR p.display_name = ?)');
      values.push(filter.project, filter.project);
    }
    if (filter.model) {
      conditions.push('s.model = ?');
      values.push(filter.model);
    }
    if (filter.result) {
      conditions.push('s.status = ?');
      values.push(filter.result);
    }
    if (filter.captureMode) {
      conditions.push('s.capture_mode = ?');
      values.push(filter.captureMode);
    }
    if (filter.category) {
      conditions.push(
        'EXISTS (SELECT 1 FROM findings f WHERE f.session_id = s.id AND f.category = ?)',
      );
      values.push(filter.category);
    }
    values.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${SESSION_SELECT} FROM sessions s JOIN projects p ON p.id = s.project_id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY s.started_at DESC, s.id ASC LIMIT ?`,
      )
      .all(...values) as Row[];
    return rows.map(storedSession);
  }

  /** Find one non-deleted session. */
  getSession(id: string, includeDeleted = false): StoredSession | undefined {
    assertText(id, 'session.id');
    const row = this.#database
      .prepare(
        `SELECT ${SESSION_SELECT} FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ? ${includeDeleted ? '' : 'AND s.deleted_at IS NULL'}`,
      )
      .get(id) as Row | undefined;
    if (!row) return undefined;
    return storedSession(row);
  }

  /** Hide a session while preserving its immutable raw and normalized evidence. */
  deleteSession(id: string): boolean {
    assertText(id, 'session.id');
    return (
      this.#database
        .prepare(
          'UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
        )
        .run(this.#clock.now().toISOString(), id).changes > 0
    );
  }

  /** Append a turn. */
  createTurn(input: TurnInput): void {
    assertText(input.id, 'turn.id');
    assertText(input.sessionId, 'turn.sessionId');
    assertText(input.status, 'turn.status');
    assertPositiveInteger(input.sequence, 'turn.sequence');
    assertIso(input.startedAt, 'turn.startedAt');
    this.#database
      .prepare(
        'INSERT INTO turns (id, session_id, source_turn_id, sequence, started_at, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.sessionId,
        input.sourceTurnId ?? null,
        input.sequence,
        input.startedAt,
        input.status,
      );
  }

  /** Validate and append immutable adapter input; duplicate source identity returns the original ID. */
  appendRaw(sessionId: string, input: RawSourceEvent): string {
    assertText(sessionId, 'raw.sessionId');
    const raw = RawSourceEventSchema.parse(input);
    const payloadHash = hash(raw.payload);
    const identityHash = hash(
      raw.sourceEventId
        ? {
            adapter: raw.adapter,
            sourceSessionId: raw.sourceSessionId,
            sourceEventId: raw.sourceEventId,
          }
        : {
            adapter: raw.adapter,
            sourceSessionId: raw.sourceSessionId,
            sourceTurnId: raw.sourceTurnId ?? '',
            receivedAt: raw.receivedAt,
            payloadHash,
          },
    );
    const id = `raw_${identityHash}`;
    this.#database
      .prepare(
        'INSERT INTO raw_events (id, session_id, adapter, adapter_version, source_version, source_session_id, source_turn_id, source_event_id, received_at, payload_json, identity_hash, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity_hash) DO NOTHING',
      )
      .run(
        id,
        sessionId,
        raw.adapter,
        raw.adapterVersion,
        raw.sourceVersion ?? null,
        raw.sourceSessionId,
        raw.sourceTurnId ?? null,
        raw.sourceEventId ?? null,
        raw.receivedAt,
        json(raw.payload),
        identityHash,
        payloadHash,
      );
    const row = this.#database
      .prepare(
        'SELECT id, session_id, payload_hash FROM raw_events WHERE identity_hash = ?',
      )
      .get(identityHash) as
      { id: string; session_id: string; payload_hash: string } | undefined;
    if (!row || row.session_id !== sessionId)
      throw new Error('Raw event identity belongs to a different session.');
    if (row.payload_hash !== payloadHash)
      throw new Error('Raw event identity collision with different content.');
    return row.id;
  }

  /** Validate and append a canonical normalized event, derived from an existing raw event. */
  appendNormalized(eventInput: TraceEvent, normalizerId: string): string {
    const event = TraceEventSchema.parse(eventInput);
    assertText(normalizerId, 'normalizerId');
    const rawEventId = event.provenance.rawEventId;
    if (!rawEventId)
      throw new Error('Normalized events must reference a raw event ID.');
    const raw = this.#database
      .prepare('SELECT session_id FROM raw_events WHERE id = ?')
      .get(rawEventId) as { session_id: string } | undefined;
    if (!raw || raw.session_id !== event.sessionId)
      throw new Error(
        'Normalized event references a nonexistent raw event in its session.',
      );
    const insert = this.#database.prepare(
      'INSERT INTO normalized_events (id, raw_event_id, session_id, turn_id, parent_event_id, sequence, timestamp, source, type, subtype, status, tool_name, payload_json, raw_payload_json, provenance_json, normalizer_id, schema_version, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(raw_event_id, normalizer_id, schema_version) DO NOTHING',
    );
    const result = insert.run(
      event.id,
      rawEventId,
      event.sessionId,
      event.turnId ?? null,
      event.parentEventId ?? null,
      event.sequence,
      event.timestamp,
      event.source,
      event.type,
      event.subtype ?? null,
      event.status ?? null,
      event.toolName ?? null,
      json(event.payload),
      json(event.rawPayload),
      json(event.provenance),
      normalizerId,
      event.schemaVersion,
      json(event),
    );
    const stored = this.#database
      .prepare(
        'SELECT id, event_json FROM normalized_events WHERE raw_event_id = ? AND normalizer_id = ? AND schema_version = ?',
      )
      .get(rawEventId, normalizerId, event.schemaVersion) as
      { id: string; event_json: string } | undefined;
    if (!stored) throw new Error('Normalized event was not stored.');
    if (
      stored.id !== event.id ||
      canonicalJson(fromJson(stored.event_json)) !== canonicalJson(event)
    )
      throw new Error('Normalized event idempotency collision.');
    if (result.changes > 0)
      this.#database
        .prepare(
          'INSERT INTO normalized_event_search (event_id, session_id, type, content) VALUES (?, ?, ?, ?)',
        )
        .run(
          stored.id,
          event.sessionId,
          event.type,
          `${event.type} ${event.toolName ?? ''} ${json(event.payload)}`,
        );
    return stored.id;
  }

  /** List canonical events by session and optional type, tool, and time bounds. */
  listEvents(filter: EventFilter): readonly StoredNormalizedEvent[] {
    assertText(filter.sessionId, 'filter.sessionId');
    if (!this.getSession(filter.sessionId)) return [];
    const conditions = ['session_id = ?'];
    const values: unknown[] = [filter.sessionId];
    if (filter.type) {
      conditions.push('type = ?');
      values.push(filter.type);
    }
    if (filter.toolName) {
      conditions.push('tool_name = ?');
      values.push(filter.toolName);
    }
    if (filter.from) {
      assertIso(filter.from, 'filter.from');
      conditions.push('timestamp >= ?');
      values.push(filter.from);
    }
    if (filter.to) {
      assertIso(filter.to, 'filter.to');
      conditions.push('timestamp <= ?');
      values.push(filter.to);
    }
    if ((filter.afterSequence === undefined) !== (filter.afterId === undefined))
      throw new Error('Event cursor requires afterSequence and afterId.');
    if (filter.afterSequence !== undefined && filter.afterId !== undefined) {
      assertPositiveInteger(filter.afterSequence, 'filter.afterSequence');
      assertText(filter.afterId, 'filter.afterId');
      conditions.push('(sequence > ? OR (sequence = ? AND id > ?))');
      values.push(filter.afterSequence, filter.afterSequence, filter.afterId);
    }
    const limit = filter.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('filter.limit must be between 1 and 10000.');
    values.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT id, raw_event_id, session_id, sequence, timestamp, type, tool_name, event_json FROM normalized_events WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC, id ASC LIMIT ?`,
      )
      .all(...values) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      rawEventId: String(row.raw_event_id),
      sessionId: String(row.session_id),
      sequence: Number(row.sequence),
      timestamp: String(row.timestamp),
      type: String(row.type),
      ...(row.tool_name ? { toolName: String(row.tool_name) } : {}),
      event: fromJson<TraceEvent>(row.event_json),
    }));
  }

  /** Full-text search event payloads within one session. */
  searchEvents(
    sessionId: string,
    query: string,
    limit = 100,
  ): readonly StoredNormalizedEvent[] {
    assertText(sessionId, 'sessionId');
    if (!this.getSession(sessionId)) return [];
    assertText(query, 'query');
    if (query.trim().length === 0) throw new Error('query must not be blank.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error('limit must be between 1 and 1000.');
    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' AND ');
    const rows = this.#database
      .prepare(
        'SELECT n.id, n.raw_event_id, n.session_id, n.sequence, n.timestamp, n.type, n.tool_name, n.event_json FROM normalized_event_search s JOIN normalized_events n ON n.id = s.event_id WHERE s.session_id = ? AND normalized_event_search MATCH ? ORDER BY n.sequence ASC, n.id ASC LIMIT ?',
      )
      .all(sessionId, terms, limit) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      rawEventId: String(row.raw_event_id),
      sessionId: String(row.session_id),
      sequence: Number(row.sequence),
      timestamp: String(row.timestamp),
      type: String(row.type),
      ...(row.tool_name ? { toolName: String(row.tool_name) } : {}),
      event: fromJson<TraceEvent>(row.event_json),
    }));
  }

  /** Look up one artifact only within its visible parent session. */
  getArtifact(sessionId: string, id: string): StoredArtifact | undefined {
    assertText(sessionId, 'sessionId');
    assertText(id, 'artifact.id');
    if (!this.getSession(sessionId)) return undefined;
    const row = this.#database
      .prepare(
        'SELECT id, session_id, event_id, kind, path_encrypted, path_hash, content_hash, blob_hash, metadata_json FROM artifacts WHERE session_id = ? AND id = ?',
      )
      .get(sessionId, id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      kind: String(row.kind),
      metadata: fromJson<JsonObject>(row.metadata_json),
      ...(row.event_id ? { eventId: String(row.event_id) } : {}),
      ...(row.path_encrypted
        ? { pathEncrypted: String(row.path_encrypted) }
        : {}),
      ...(row.path_hash ? { pathHash: String(row.path_hash) } : {}),
      ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
      ...(row.blob_hash ? { blobHash: String(row.blob_hash) } : {}),
    };
  }

  /** Store a metadata artifact. */
  createArtifact(input: ArtifactInput): void {
    assertText(input.id, 'artifact.id');
    assertText(input.sessionId, 'artifact.sessionId');
    assertText(input.kind, 'artifact.kind');
    this.#database
      .prepare(
        'INSERT INTO artifacts (id, session_id, event_id, kind, path_encrypted, path_hash, content_hash, blob_hash, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.sessionId,
        input.eventId ?? null,
        input.kind,
        input.pathEncrypted ?? null,
        input.pathHash ?? null,
        input.contentHash ?? null,
        input.blobHash ?? null,
        json(input.metadata),
      );
  }

  /** Idempotently import an artifact attached to an existing visible event. */
  importArtifact(input: ArtifactInput): void {
    assertText(input.id, 'artifact.id');
    assertText(input.sessionId, 'artifact.sessionId');
    assertText(input.kind, 'artifact.kind');
    if (!input.eventId) throw new StorageImportConflictError();
    if (input.contentHash && !/^[a-f0-9]{64}$/.test(input.contentHash))
      throw new StorageImportConflictError();
    const event = this.#database
      .prepare('SELECT session_id FROM normalized_events WHERE id = ?')
      .get(input.eventId) as { session_id: string } | undefined;
    if (
      !event ||
      event.session_id !== input.sessionId ||
      !this.getSession(input.sessionId)
    )
      throw new StorageImportConflictError();
    const existing = this.#database
      .prepare(
        'SELECT session_id, event_id, kind, path_encrypted, path_hash, content_hash, blob_hash, metadata_json FROM artifacts WHERE id = ?',
      )
      .get(input.id) as Row | undefined;
    if (existing) {
      const equal =
        String(existing.session_id) === input.sessionId &&
        String(existing.event_id) === input.eventId &&
        String(existing.kind) === input.kind &&
        (existing.path_encrypted ?? null) === (input.pathEncrypted ?? null) &&
        (existing.path_hash ?? null) === (input.pathHash ?? null) &&
        (existing.content_hash ?? null) === (input.contentHash ?? null) &&
        (existing.blob_hash ?? null) === (input.blobHash ?? null) &&
        canonicalJson(fromJson(existing.metadata_json)) ===
          canonicalJson(input.metadata);
      if (!equal) throw new StorageImportConflictError();
      return;
    }
    this.createArtifact(input);
  }

  /** List metadata artifacts attached to a visible session. */
  listArtifacts(sessionId: string): readonly StoredArtifact[] {
    if (!this.getSession(sessionId)) return [];
    return (
      this.#database
        .prepare(
          'SELECT id, session_id, event_id, kind, path_encrypted, path_hash, content_hash, blob_hash, metadata_json FROM artifacts WHERE session_id = ? ORDER BY id ASC',
        )
        .all(sessionId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      kind: String(row.kind),
      metadata: fromJson<JsonObject>(row.metadata_json),
      ...(row.event_id ? { eventId: String(row.event_id) } : {}),
      ...(row.path_encrypted
        ? { pathEncrypted: String(row.path_encrypted) }
        : {}),
      ...(row.path_hash ? { pathHash: String(row.path_hash) } : {}),
      ...(row.content_hash ? { contentHash: String(row.content_hash) } : {}),
      ...(row.blob_hash ? { blobHash: String(row.blob_hash) } : {}),
    }));
  }

  /** Store a finding after atomically validating every evidence event ID. */
  createFinding(input: FindingInput): void {
    for (const [name, value] of Object.entries({
      id: input.id,
      sessionId: input.sessionId,
      ruleId: input.ruleId,
      detectorVersion: input.detectorVersion,
      category: input.category,
      severity: input.severity,
      title: input.title,
      explanation: input.explanation,
      recommendation: input.recommendation,
    }))
      assertText(value, `finding.${name}`);
    if (input.evidenceEventIds.length === 0)
      throw new Error('Findings require at least one evidence event ID.');
    const ids = [
      ...input.evidenceEventIds,
      ...(input.counterevidenceEventIds ?? []),
    ];
    const transaction = this.#database.transaction(() => {
      for (const id of ids) {
        const row = this.#database
          .prepare(
            'SELECT id FROM normalized_events WHERE id = ? AND session_id = ?',
          )
          .get(id, input.sessionId);
        if (!row)
          throw new Error(
            `Finding references nonexistent normalized event ${id}.`,
          );
      }
      this.#database
        .prepare(
          'INSERT INTO findings (id, session_id, rule_id, detector_version, category, severity, confidence, title, explanation, evidence_event_ids_json, counterevidence_event_ids_json, recommendation, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.id,
          input.sessionId,
          input.ruleId,
          input.detectorVersion,
          input.category,
          input.severity,
          input.confidence ?? null,
          input.title,
          input.explanation,
          json(input.evidenceEventIds),
          json(input.counterevidenceEventIds ?? []),
          input.recommendation,
          input.state ?? 'open',
        );
    });
    transaction();
  }

  /** Atomically replace findings owned by a rule set while retaining human reviews. */
  replaceFindings(
    sessionId: string,
    ownedRuleIds: readonly string[],
    inputs: readonly FindingInput[],
  ): void {
    assertText(sessionId, 'sessionId');
    const rules = [...new Set(ownedRuleIds)];
    if (rules.length === 0)
      throw new Error('replaceFindings requires at least one owned rule ID.');
    for (const ruleId of rules) assertText(ruleId, 'ownedRuleId');
    const ruleSet = new Set(rules);
    const findingIds = new Set<string>();
    for (const input of inputs) {
      if (input.sessionId !== sessionId)
        throw new Error('Replacement finding belongs to another session.');
      if (!ruleSet.has(input.ruleId))
        throw new Error('Replacement finding is not owned by this rule set.');
      if (findingIds.has(input.id))
        throw new Error('Replacement findings contain a duplicate ID.');
      findingIds.add(input.id);
      for (const [name, value] of Object.entries({
        id: input.id,
        ruleId: input.ruleId,
        detectorVersion: input.detectorVersion,
        category: input.category,
        severity: input.severity,
        title: input.title,
        explanation: input.explanation,
        recommendation: input.recommendation,
      }))
        assertText(value, `finding.${name}`);
      if (input.evidenceEventIds.length === 0)
        throw new Error('Findings require at least one evidence event ID.');
    }
    const transaction = this.#database.transaction(() => {
      if (!this.getSession(sessionId))
        throw new Error('Cannot replace findings for a missing session.');
      for (const input of inputs) {
        for (const id of [
          ...input.evidenceEventIds,
          ...(input.counterevidenceEventIds ?? []),
        ]) {
          const row = this.#database
            .prepare(
              'SELECT id FROM normalized_events WHERE id = ? AND session_id = ?',
            )
            .get(id, sessionId);
          if (!row)
            throw new Error(
              `Finding references nonexistent normalized event ${id}.`,
            );
        }
        const existing = this.#database
          .prepare('SELECT session_id FROM findings WHERE id = ?')
          .get(input.id) as { session_id: string } | undefined;
        if (existing && existing.session_id !== sessionId)
          throw new Error('Finding ID belongs to another session.');
        this.#database
          .prepare(
            `INSERT INTO findings (id, session_id, rule_id, detector_version, category, severity, confidence, title, explanation, evidence_event_ids_json, counterevidence_event_ids_json, recommendation, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               rule_id = excluded.rule_id,
               detector_version = excluded.detector_version,
               category = excluded.category,
               severity = excluded.severity,
               confidence = excluded.confidence,
               title = excluded.title,
               explanation = excluded.explanation,
               evidence_event_ids_json = excluded.evidence_event_ids_json,
               counterevidence_event_ids_json = excluded.counterevidence_event_ids_json,
               recommendation = excluded.recommendation,
               state = excluded.state`,
          )
          .run(
            input.id,
            sessionId,
            input.ruleId,
            input.detectorVersion,
            input.category,
            input.severity,
            input.confidence ?? null,
            input.title,
            input.explanation,
            json(input.evidenceEventIds),
            json(input.counterevidenceEventIds ?? []),
            input.recommendation,
            input.state ?? 'open',
          );
      }
      const rulePlaceholders = rules.map(() => '?').join(', ');
      const ids = [...findingIds];
      const keepClause =
        ids.length > 0
          ? ` AND id NOT IN (${ids.map(() => '?').join(', ')})`
          : '';
      this.#database
        .prepare(
          `DELETE FROM findings WHERE session_id = ? AND rule_id IN (${rulePlaceholders})${keepClause}`,
        )
        .run(sessionId, ...rules, ...ids);
    });
    transaction();
  }

  /** Replace one human finding review without mutating analyzer-owned evidence. */
  reviewFinding(id: string, input: FindingReviewInput): boolean {
    assertText(id, 'finding.id');
    if (input.categoryOverride !== undefined)
      assertText(input.categoryOverride, 'finding.review.categoryOverride');
    if (input.note !== undefined && input.note.length > 16_384)
      throw new Error('finding.review.note is too long.');
    const exists = this.#database
      .prepare('SELECT id FROM findings WHERE id = ?')
      .get(id);
    if (!exists) return false;
    const current = this.#database
      .prepare(
        'SELECT decision, category_override, note FROM finding_reviews WHERE finding_id = ?',
      )
      .get(id) as Row | undefined;
    this.#database
      .prepare(
        `INSERT INTO finding_reviews (finding_id, decision, category_override, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(finding_id) DO UPDATE SET
           decision = excluded.decision,
           category_override = excluded.category_override,
           note = excluded.note,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.decision ?? current?.decision ?? null,
        input.categoryOverride ?? current?.category_override ?? null,
        input.note ?? current?.note ?? null,
        this.#clock.now().toISOString(),
      );
    return true;
  }

  /** List findings for a visible session. */
  listFindings(sessionId: string): readonly StoredFinding[] {
    if (!this.getSession(sessionId)) return [];
    return (
      this.#database
        .prepare(
          `SELECT f.id, f.session_id, f.rule_id, f.detector_version,
             COALESCE(r.category_override, f.category) AS category,
             f.severity, f.confidence, f.title, f.explanation, f.recommendation,
             f.evidence_event_ids_json, f.counterevidence_event_ids_json,
             COALESCE(r.decision, f.state) AS state,
             r.decision, r.category_override, r.note, r.updated_at
           FROM findings f LEFT JOIN finding_reviews r ON r.finding_id = f.id
           WHERE f.session_id = ? ORDER BY f.id ASC`,
        )
        .all(sessionId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      ruleId: String(row.rule_id),
      detectorVersion: String(row.detector_version),
      category: String(row.category),
      severity: String(row.severity),
      title: String(row.title),
      explanation: String(row.explanation),
      recommendation: String(row.recommendation),
      evidenceEventIds: fromJson<string[]>(row.evidence_event_ids_json),
      counterevidenceEventIds: fromJson<string[]>(
        row.counterevidence_event_ids_json,
      ),
      state: String(row.state),
      ...(row.updated_at
        ? {
            review: {
              updatedAt: String(row.updated_at),
              ...(row.decision
                ? {
                    decision: String(row.decision) as
                      'open' | 'confirmed' | 'rejected',
                  }
                : {}),
              ...(row.category_override
                ? { categoryOverride: String(row.category_override) }
                : {}),
              ...(row.note ? { note: String(row.note) } : {}),
            },
          }
        : {}),
      ...(row.confidence === null
        ? {}
        : { confidence: Number(row.confidence) }),
    }));
  }

  /** Store a human annotation. */
  createAnnotation(input: AnnotationInput): void {
    assertText(input.id, 'annotation.id');
    assertText(input.targetType, 'annotation.targetType');
    assertText(input.targetId, 'annotation.targetId');
    assertIso(input.createdAt, 'annotation.createdAt');
    this.#database
      .prepare(
        'INSERT INTO annotations (id, target_type, target_id, label, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.targetType,
        input.targetId,
        input.label ?? null,
        input.note ?? null,
        input.createdAt,
      );
  }

  /** List annotations, optionally narrowed to one target. */
  listAnnotations(
    targetType?: string,
    targetId?: string,
  ): readonly StoredAnnotation[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (targetType) {
      conditions.push('target_type = ?');
      values.push(targetType);
    }
    if (targetId) {
      conditions.push('target_id = ?');
      values.push(targetId);
    }
    const suffix = conditions.length
      ? ` WHERE ${conditions.join(' AND ')}`
      : '';
    return (
      this.#database
        .prepare(
          `SELECT id, target_type, target_id, label, note, created_at FROM annotations${suffix} ORDER BY created_at ASC`,
        )
        .all(...values) as Row[]
    ).map((row) => ({
      id: String(row.id),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      createdAt: String(row.created_at),
      ...(row.label ? { label: String(row.label) } : {}),
      ...(row.note ? { note: String(row.note) } : {}),
    }));
  }

  /** Replace the mutable user fields of one annotation. */
  updateAnnotation(
    id: string,
    input: Pick<AnnotationInput, 'label' | 'note'>,
  ): boolean {
    assertText(id, 'annotation.id');
    return (
      this.#database
        .prepare('UPDATE annotations SET label = ?, note = ? WHERE id = ?')
        .run(input.label ?? null, input.note ?? null, id).changes > 0
    );
  }

  /** Delete a user annotation; immutable source events are unaffected. */
  deleteAnnotation(id: string): boolean {
    assertText(id, 'annotation.id');
    return (
      this.#database.prepare('DELETE FROM annotations WHERE id = ?').run(id)
        .changes > 0
    );
  }

  /** Store an export-only redaction profile without touching raw originals. */
  createRedactionProfile(input: RedactionProfileInput): void {
    assertText(input.id, 'redactionProfile.id');
    assertText(input.name, 'redactionProfile.name');
    this.#database
      .prepare(
        'INSERT INTO redaction_profiles (id, name, rules_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.name,
        json(input.rules),
        this.#clock.now().toISOString(),
      );
  }

  /** Resolve a custom export profile by immutable ID or human-readable name. */
  getRedactionProfile(idOrName: string): StoredRedactionProfile | undefined {
    assertText(idOrName, 'redactionProfile.idOrName');
    const row = this.#database
      .prepare(
        'SELECT id, name, rules_json, created_at FROM redaction_profiles WHERE id = ? OR name = ? LIMIT 1',
      )
      .get(idOrName, idOrName) as Row | undefined;
    return row
      ? {
          id: String(row.id),
          name: String(row.name),
          rules: fromJson<JsonObject>(row.rules_json),
          createdAt: String(row.created_at),
        }
      : undefined;
  }

  /** True only after an entire portable bundle metadata transaction committed. */
  hasBundleImport(manifestHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(manifestHash))
      throw new Error('Invalid bundle manifest hash.');
    return Boolean(
      this.#database
        .prepare('SELECT 1 FROM bundle_imports WHERE manifest_hash = ?')
        .get(manifestHash),
    );
  }

  /** Record the idempotency marker inside the same transaction as imported data. */
  recordBundleImport(manifestHash: string, sessionId: string): void {
    if (!/^[a-f0-9]{64}$/.test(manifestHash))
      throw new Error('Invalid bundle manifest hash.');
    assertText(sessionId, 'bundleImport.sessionId');
    this.#database
      .prepare(
        'INSERT INTO bundle_imports (manifest_hash, session_id, imported_at) VALUES (?, ?, ?)',
      )
      .run(manifestHash, sessionId, this.#clock.now().toISOString());
  }

  /** Persist blob metadata after a successful encrypted put. */
  recordBlob(info: BlobInfo): void {
    this.#database
      .prepare(
        'INSERT INTO blob_objects (address, key_id, byte_length, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO NOTHING',
      )
      .run(
        info.address,
        info.keyId,
        info.byteLength,
        this.#clock.now().toISOString(),
      );
  }

  /** Create a new active blob-key generation. Existing addresses remain stable. */
  rotateBlobKey(keyId = `blob-${randomUUID()}`): string {
    if (!/^[A-Za-z0-9._-]+$/.test(keyId))
      throw new Error('Invalid blob key identifier.');
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          "UPDATE encryption_keys SET status = 'retired', retired_at = ? WHERE purpose = 'blob' AND status = 'active'",
        )
        .run(this.#clock.now().toISOString());
      this.#database
        .prepare(
          "INSERT INTO encryption_keys (id, purpose, status, created_at) VALUES (?, 'blob', 'active', ?)",
        )
        .run(keyId, this.#clock.now().toISOString());
    });
    transaction();
    this.#activeBlobKeyId = keyId;
    return keyId;
  }
}
