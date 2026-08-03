import type Database from 'better-sqlite3';

/** A committed, append-only database migration. */
export interface SqlMigration {
  readonly id: number;
  readonly sql: string;
}

/** The initial encrypted metadata schema. Never edit committed migration SQL. */
export const migrations: readonly SqlMigration[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, root_path_encrypted TEXT,
  path_hash TEXT, vcs_remote_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), source TEXT NOT NULL,
  source_session_id TEXT NOT NULL, title TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, capture_mode TEXT NOT NULL, capture_score REAL, model TEXT,
  source_version TEXT, base_commit TEXT, final_commit TEXT, run_fingerprint_json TEXT,
  UNIQUE(source, source_session_id)
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), source_turn_id TEXT,
  sequence INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE TABLE raw_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL, source_version TEXT, source_session_id TEXT NOT NULL,
  source_turn_id TEXT, source_event_id TEXT, received_at TEXT NOT NULL, payload_json TEXT NOT NULL,
  identity_hash TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL
);
CREATE TABLE normalized_events (
  id TEXT PRIMARY KEY, raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT REFERENCES turns(id),
  parent_event_id TEXT, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, source TEXT NOT NULL,
  type TEXT NOT NULL, subtype TEXT, status TEXT, tool_name TEXT, payload_json TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL, provenance_json TEXT NOT NULL, normalizer_id TEXT NOT NULL,
  schema_version TEXT NOT NULL, event_json TEXT NOT NULL,
  UNIQUE(raw_event_id, normalizer_id, schema_version)
);
CREATE INDEX normalized_events_session_type_time ON normalized_events(session_id, type, timestamp);
CREATE INDEX normalized_events_session_tool_time ON normalized_events(session_id, tool_name, timestamp);
CREATE INDEX normalized_events_raw_event ON normalized_events(raw_event_id);
CREATE VIRTUAL TABLE normalized_event_search USING fts5(event_id UNINDEXED, session_id UNINDEXED, type UNINDEXED, content);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  event_id TEXT REFERENCES normalized_events(id), kind TEXT NOT NULL, path_encrypted TEXT,
  path_hash TEXT, content_hash TEXT, blob_hash TEXT, metadata_json TEXT NOT NULL
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), rule_id TEXT NOT NULL,
  detector_version TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, confidence REAL,
  title TEXT NOT NULL, explanation TEXT NOT NULL, evidence_event_ids_json TEXT NOT NULL,
  counterevidence_event_ids_json TEXT NOT NULL, recommendation TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE annotations (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, label TEXT,
  note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE redaction_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, rules_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE blob_objects (
  address TEXT PRIMARY KEY, key_id TEXT NOT NULL, byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE encryption_keys (
  id TEXT PRIMARY KEY, purpose TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TRIGGER raw_events_no_update BEFORE UPDATE ON raw_events BEGIN SELECT RAISE(ABORT, 'raw_events are immutable'); END;
CREATE TRIGGER raw_events_no_delete BEFORE DELETE ON raw_events BEGIN SELECT RAISE(ABORT, 'raw_events are immutable'); END;`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
CREATE INDEX sessions_visible_started_at ON sessions(deleted_at, started_at);
`,
  },
];

/** Apply only migrations not already recorded in the encrypted database. */
export function runMigrations(database: Database.Database, now: string): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set<number>(
    database
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => (row as { id: number }).id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, now);
    });
    apply();
  }
}
