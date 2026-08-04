import {
  integer,
  real,
  sqliteTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Drizzle table declarations mirror the committed, forward-only SQL migrations. */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
  pathHash: text('path_hash'),
  vcsRemoteHash: text('vcs_remote_hash'),
  rootPathEncrypted: text('root_path_encrypted'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    source: text('source').notNull(),
    sourceSessionId: text('source_session_id').notNull(),
    title: text('title'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    deletedAt: text('deleted_at'),
    status: text('status').notNull(),
    captureMode: text('capture_mode').notNull(),
    captureScore: real('capture_score'),
    model: text('model'),
    sourceVersion: text('source_version'),
    baseCommit: text('base_commit'),
    finalCommit: text('final_commit'),
    runFingerprintJson: text('run_fingerprint_json'),
  },
  (table) => [
    uniqueIndex('sessions_source_identity').on(
      table.source,
      table.sourceSessionId,
    ),
  ],
);

export const turns = sqliteTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    sourceTurnId: text('source_turn_id'),
    sequence: integer('sequence').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    status: text('status').notNull(),
  },
  (table) => [
    uniqueIndex('turns_session_sequence').on(table.sessionId, table.sequence),
  ],
);

export const rawEvents = sqliteTable(
  'raw_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    identityHash: text('identity_hash').notNull(),
    adapter: text('adapter').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    sourceVersion: text('source_version'),
    sourceSessionId: text('source_session_id').notNull(),
    sourceTurnId: text('source_turn_id'),
    sourceEventId: text('source_event_id'),
    payloadJson: text('payload_json').notNull(),
    payloadHash: text('payload_hash').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (table) => [uniqueIndex('raw_events_identity_hash').on(table.identityHash)],
);

export const normalizedEvents = sqliteTable(
  'normalized_events',
  {
    id: text('id').primaryKey(),
    rawEventId: text('raw_event_id')
      .notNull()
      .references(() => rawEvents.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    turnId: text('turn_id').references(() => turns.id),
    parentEventId: text('parent_event_id'),
    sequence: integer('sequence').notNull(),
    timestamp: text('timestamp').notNull(),
    type: text('type').notNull(),
    source: text('source').notNull(),
    subtype: text('subtype'),
    status: text('status'),
    toolName: text('tool_name'),
    payloadJson: text('payload_json').notNull(),
    rawPayloadJson: text('raw_payload_json').notNull(),
    provenanceJson: text('provenance_json').notNull(),
    normalizerId: text('normalizer_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    eventJson: text('event_json').notNull(),
  },
  (table) => [
    uniqueIndex('normalized_events_raw_normalizer_schema').on(
      table.rawEventId,
      table.normalizerId,
      table.schemaVersion,
    ),
  ],
);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  eventId: text('event_id').references(() => normalizedEvents.id),
  kind: text('kind').notNull(),
  pathEncrypted: text('path_encrypted'),
  pathHash: text('path_hash'),
  contentHash: text('content_hash'),
  blobHash: text('blob_hash'),
  metadataJson: text('metadata_json').notNull(),
});

export const findings = sqliteTable('findings', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  ruleId: text('rule_id').notNull(),
  detectorVersion: text('detector_version').notNull(),
  analyzerProvider: text('analyzer_provider'),
  analyzerModel: text('analyzer_model'),
  promptDigest: text('prompt_digest'),
  findingKind: text('finding_kind').notNull().default('problem'),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  confidence: real('confidence'),
  title: text('title').notNull(),
  explanation: text('explanation').notNull(),
  evidenceEventIdsJson: text('evidence_event_ids_json').notNull(),
  counterevidenceEventIdsJson: text('counterevidence_event_ids_json').notNull(),
  recommendation: text('recommendation').notNull(),
  impact: text('impact'),
  state: text('state').notNull(),
});

export const findingReviews = sqliteTable('finding_reviews', {
  findingId: text('finding_id').primaryKey(),
  decision: text('decision'),
  categoryOverride: text('category_override'),
  note: text('note'),
  updatedAt: text('updated_at').notNull(),
});

export const annotations = sqliteTable('annotations', {
  id: text('id').primaryKey(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  label: text('label'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
});

export const redactionProfiles = sqliteTable(
  'redaction_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    rulesJson: text('rules_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('redaction_profiles_name').on(table.name)],
);

export const bundleImports = sqliteTable('bundle_imports', {
  manifestHash: text('manifest_hash').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  importedAt: text('imported_at').notNull(),
});

export const blobObjects = sqliteTable('blob_objects', {
  address: text('address').primaryKey(),
  keyId: text('key_id').notNull(),
  byteLength: integer('byte_length').notNull(),
  createdAt: text('created_at').notNull(),
});

export const encryptionKeys = sqliteTable('encryption_keys', {
  id: text('id').primaryKey(),
  purpose: text('purpose').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  retiredAt: text('retired_at'),
});

export const evalCases = sqliteTable(
  'eval_cases',
  {
    id: text('id').primaryKey(),
    sourceSessionId: text('source_session_id').references(() => sessions.id),
    name: text('name').notNull(),
    manifestBlobHash: text('manifest_blob_hash').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    schemaVersion: text('schema_version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('eval_cases_manifest_hash').on(table.manifestHash)],
);

export const evalRuns = sqliteTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    evalCaseId: text('eval_case_id')
      .notNull()
      .references(() => evalCases.id),
    sourceSessionId: text('source_session_id').references(() => sessions.id),
    configurationJson: text('configuration_json').notNull(),
    configurationHash: text('configuration_hash').notNull(),
    worktreeFingerprintHash: text('worktree_fingerprint_hash').notNull(),
    status: text('status').notNull(),
    outcomeJson: text('outcome_json'),
    metricsJson: text('metrics_json'),
    outputBlobHash: text('output_blob_hash'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('eval_runs_deterministic').on(
      table.evalCaseId,
      table.configurationHash,
      table.worktreeFingerprintHash,
    ),
  ],
);

export const evalComparisons = sqliteTable('eval_comparisons', {
  id: text('id').primaryKey(),
  evalCaseId: text('eval_case_id')
    .notNull()
    .references(() => evalCases.id),
  name: text('name').notNull(),
  configurationJson: text('configuration_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const evalComparisonResults = sqliteTable(
  'eval_comparison_results',
  {
    comparisonId: text('comparison_id')
      .notNull()
      .references(() => evalComparisons.id),
    evalRunId: text('eval_run_id')
      .notNull()
      .references(() => evalRuns.id),
    ordinal: integer('ordinal').notNull(),
    resultJson: text('result_json').notNull(),
  },
  (table) => [primaryKey({ columns: [table.comparisonId, table.evalRunId] })],
);

export const captureProfiles = sqliteTable(
  'capture_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    mode: text('mode').notNull(),
    settingsJson: text('settings_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('capture_profiles_name').on(table.name)],
);

export const retentionPolicies = sqliteTable(
  'retention_policies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    retentionDays: integer('retention_days').notNull(),
    maxSessions: integer('max_sessions'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('retention_policies_name').on(table.name)],
);

/** FTS, raw-event immutability triggers, and schema_migrations remain committed raw SQL. */
