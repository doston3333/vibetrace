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
  {
    id: 3,
    sql: `
CREATE TABLE finding_reviews (
  finding_id TEXT PRIMARY KEY, decision TEXT, category_override TEXT, note TEXT,
  updated_at TEXT NOT NULL,
  CHECK(decision IS NULL OR decision IN ('open', 'confirmed', 'rejected'))
);
`,
  },
  {
    id: 4,
    sql: `
CREATE TABLE bundle_imports (
  manifest_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  imported_at TEXT NOT NULL
);
`,
  },
  {
    id: 5,
    sql: `
CREATE TABLE eval_cases (
 id TEXT PRIMARY KEY, source_session_id TEXT REFERENCES sessions(id), name TEXT NOT NULL,
 manifest_blob_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL UNIQUE, schema_version TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE eval_runs (
 id TEXT PRIMARY KEY, eval_case_id TEXT NOT NULL REFERENCES eval_cases(id), source_session_id TEXT REFERENCES sessions(id),
 configuration_json TEXT NOT NULL, configuration_hash TEXT NOT NULL, worktree_fingerprint_hash TEXT NOT NULL,
 status TEXT NOT NULL, outcome_json TEXT, metrics_json TEXT, output_blob_hash TEXT,
 started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL,
 UNIQUE(eval_case_id, configuration_hash, worktree_fingerprint_hash)
);
CREATE TABLE eval_comparisons (
 id TEXT PRIMARY KEY, eval_case_id TEXT NOT NULL REFERENCES eval_cases(id), name TEXT NOT NULL,
 configuration_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE eval_comparison_results (
 comparison_id TEXT NOT NULL REFERENCES eval_comparisons(id), eval_run_id TEXT NOT NULL REFERENCES eval_runs(id),
 ordinal INTEGER NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(comparison_id, eval_run_id)
);
CREATE INDEX eval_runs_case_created ON eval_runs(eval_case_id, created_at);
    `,
  },
  {
    id: 6,
    sql: `
CREATE TABLE capture_profiles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, mode TEXT NOT NULL,
 settings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE retention_policies (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, retention_days INTEGER NOT NULL,
 max_sessions INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
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
