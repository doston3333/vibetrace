import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';
import {
  RawSourceEventSchema,
  TraceEventSchema,
  type JsonObject,
  type RawSourceEvent,
  type TraceEvent,
} from '@vibetrace/schema';

import { BlobStore, type BlobInfo } from './blobs.js';
import {
  type KeyProvider,
  resolveRootSecret,
  writePassphraseEnvelope,
} from './keys.js';
import { runMigrations } from './migrations.js';

export { BlobStore, type BlobInfo } from './blobs.js';
export {
  MemoryKeyProvider,
  OsKeyringProvider,
  type KeyProvider,
} from './keys.js';
export { migrations, type SqlMigration } from './migrations.js';
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
  readonly status: string;
  readonly captureMode: string;
  readonly title?: string;
  readonly model?: string;
  readonly sourceVersion?: string;
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
  readonly limit?: number;
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

/** A user-controlled export redaction profile. */
export interface RedactionProfileInput {
  readonly id: string;
  readonly name: string;
  readonly rules: JsonObject;
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
    await chmod(options.stateDir, 0o700);
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
    this.#database
      .prepare(
        'INSERT INTO sessions (id, project_id, source, source_session_id, title, started_at, status, capture_mode, model, source_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.projectId,
        input.source,
        input.sourceSessionId,
        input.title ?? null,
        input.startedAt,
        input.status,
        input.captureMode,
        input.model ?? null,
        input.sourceVersion ?? null,
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
    const limit = filter.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('filter.limit must be between 1 and 10000.');
    values.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT id, raw_event_id, session_id, sequence, timestamp, type, tool_name, event_json FROM normalized_events WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`,
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
        'SELECT n.id, n.raw_event_id, n.session_id, n.sequence, n.timestamp, n.type, n.tool_name, n.event_json FROM normalized_event_search s JOIN normalized_events n ON n.id = s.event_id WHERE s.session_id = ? AND normalized_event_search MATCH ? ORDER BY n.sequence ASC LIMIT ?',
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
