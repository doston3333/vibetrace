import {
  TraceEventSchema,
  type JsonObject,
  type JsonValue,
  type TraceEvent,
} from '@vibetrace/schema';
import { z } from 'zod';

export const ExportProfileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metadata-only') }).strict(),
  z
    .object({
      kind: z.literal('share-safe'),
      restorePointers: z.array(z.string().min(1)).max(1_000).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('custom'),
      id: z.string().min(1).max(128),
      restorePointers: z.array(z.string().min(1)).max(1_000).default([]),
    })
    .strict(),
]);
export type ExportProfile = z.infer<typeof ExportProfileSchema>;

export const CustomProfileRulesSchema = z
  .object({
    base: z.enum(['metadata-only', 'share-safe']).default('share-safe'),
    restorePointers: z.array(z.string().min(1)).max(1_000).default([]),
    redactPointers: z.array(z.string().min(1)).max(1_000).default([]),
    includeArtifacts: z.boolean().default(true),
    includeBinaryArtifacts: z.boolean().default(false),
    artifactAllowIds: z.array(z.string().min(1)).max(10_000).optional(),
    artifactDenyIds: z.array(z.string().min(1)).max(10_000).default([]),
  })
  .strict();
export type CustomProfileRules = z.infer<typeof CustomProfileRulesSchema>;

export interface ResolvedExportProfile {
  readonly kind: ExportProfile['kind'];
  readonly id?: string;
  readonly name: string;
  readonly base: 'metadata-only' | 'share-safe';
  readonly restorePointers: ReadonlySet<string>;
  readonly redactPointers: ReadonlySet<string>;
  readonly includeArtifacts: boolean;
  readonly includeBinaryArtifacts: boolean;
  readonly artifactAllowIds?: ReadonlySet<string>;
  readonly artifactDenyIds: ReadonlySet<string>;
}

export interface RedactionRecord {
  readonly path: string;
  readonly detector: string;
  readonly replacement: string;
}

export interface RedactionResult<T> {
  readonly value: T;
  readonly redactions: readonly RedactionRecord[];
}

const REPLACEMENT = (detector: string): string => `[REDACTED:${detector}]`;
const SUSPICIOUS_FIELD =
  /^(?:authorization|proxy[-_]?authorization|password|passwd|passphrase|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|private[-_]?key|cookie|set[-_]?cookie)$/i;
const PRIVATE_KEY =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const AUTHORIZATION =
  /\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[A-Za-z0-9+/_=.~:-]+/gi;
const CONNECTION_STRING =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/:@]+:[^\s@]+@[^\s]+/gi;
const ENV_SECRET =
  /^([A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=\s*)([^\r\n]+)$/gim;
const KNOWN_KEYS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
] as const;
const ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isHighEntropy(value: string): boolean {
  if (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/_=-]/].filter((pattern) =>
    pattern.test(value),
  ).length;
  return classes >= 3 && entropy(value) >= 4;
}

function replacePattern(
  input: string,
  pattern: RegExp,
  detector: string,
  record: () => void,
  replacer?: (...values: string[]) => string,
): string {
  pattern.lastIndex = 0;
  return input.replace(pattern, (...arguments_) => {
    record();
    const values = arguments_.slice(0, -2) as string[];
    return replacer ? replacer(...values) : REPLACEMENT(detector);
  });
}

function redactText(
  input: string,
  path: string,
  key: string | undefined,
  profile: ResolvedExportProfile,
  records: RedactionRecord[],
): string {
  if (profile.restorePointers.has(path)) return input;
  const seen = new Set<string>();
  const record = (detector: string): void => {
    if (seen.has(detector)) return;
    seen.add(detector);
    records.push({ path, detector, replacement: REPLACEMENT(detector) });
  };
  if (profile.redactPointers.has(path) || (key && SUSPICIOUS_FIELD.test(key))) {
    record(
      profile.redactPointers.has(path) ? 'custom-field' : 'suspicious-field',
    );
    return REPLACEMENT(
      profile.redactPointers.has(path) ? 'custom-field' : 'suspicious-field',
    );
  }
  let output = replacePattern(input, PRIVATE_KEY, 'private-key', () =>
    record('private-key'),
  );
  output = replacePattern(
    output,
    AUTHORIZATION,
    'authorization-header',
    () => record('authorization-header'),
    (_match, prefix) => `${prefix}${REPLACEMENT('authorization-header')}`,
  );
  output = replacePattern(output, CONNECTION_STRING, 'connection-string', () =>
    record('connection-string'),
  );
  output = replacePattern(
    output,
    ENV_SECRET,
    'env-secret',
    () => record('env-secret'),
    (_match, prefix) => `${prefix}${REPLACEMENT('env-secret')}`,
  );
  for (const pattern of KNOWN_KEYS)
    output = replacePattern(output, pattern, 'known-key', () =>
      record('known-key'),
    );
  ENTROPY_TOKEN.lastIndex = 0;
  output = output.replace(ENTROPY_TOKEN, (candidate) => {
    if (!isHighEntropy(candidate)) return candidate;
    record('high-entropy-token');
    return REPLACEMENT('high-entropy-token');
  });
  return output;
}

function redactValue(
  input: JsonValue,
  path: string,
  key: string | undefined,
  profile: ResolvedExportProfile,
  records: RedactionRecord[],
): JsonValue {
  if (typeof input === 'string')
    return redactText(input, path, key, profile, records);
  if (Array.isArray(input))
    return input.map((value, index) =>
      redactValue(value, `${path}/${index}`, undefined, profile, records),
    );
  if (input !== null && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input).map(([childKey, value]) => [
        childKey,
        redactValue(
          value,
          `${path}/${pointerPart(childKey)}`,
          childKey,
          profile,
          records,
        ),
      ]),
    );
  return input;
}

/** Redact a JSON value without mutating the private source value. */
export function redactJson<T extends JsonValue>(
  input: T,
  profile: ResolvedExportProfile,
  root = '',
): RedactionResult<T> {
  const records: RedactionRecord[] = [];
  return {
    value: redactValue(input, root, undefined, profile, records) as T,
    redactions: records,
  };
}

/** Produce a schema-valid derived event view for one export profile. */
export function redactEvent(
  input: TraceEvent,
  profile: ResolvedExportProfile,
): RedactionResult<TraceEvent> {
  if (profile.base === 'metadata-only') {
    const redactions: RedactionRecord[] = [
      { path: '/payload', detector: 'metadata-only', replacement: '[OMITTED]' },
      {
        path: '/rawPayload',
        detector: 'metadata-only',
        replacement: '[OMITTED]',
      },
    ];
    const event = TraceEventSchema.parse({
      schemaVersion: input.schemaVersion,
      id: input.id,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.parentEventId ? { parentEventId: input.parentEventId } : {}),
      sequence: input.sequence,
      timestamp: input.timestamp,
      source: 'vibetrace',
      type: 'capture.gap',
      subtype: `export.metadata-only.${input.type}`,
      payload: {
        dataClass: 'messages',
        state: 'absent',
        reason: 'Event payload omitted by the metadata-only export profile.',
        observedSources: ['vibetrace-export'],
        affectedEventTypes: [input.type],
      },
      rawPayload: {},
      sensitivity: input.sensitivity ?? 'unknown',
      redactions,
      provenance: {
        adapter: input.provenance.adapter,
        adapterVersion: input.provenance.adapterVersion,
        ...(input.provenance.sourceVersion
          ? { sourceVersion: input.provenance.sourceVersion }
          : {}),
        captureMode: 'partial',
      },
    });
    return { value: event, redactions };
  }
  const records: RedactionRecord[] = [];
  const payload = redactValue(
    input.payload as JsonValue,
    '/payload',
    undefined,
    profile,
    records,
  ) as JsonObject;
  const rawPayload = redactValue(
    input.rawPayload as JsonValue,
    '/rawPayload',
    undefined,
    profile,
    records,
  ) as JsonObject;
  const cwd = input.cwd
    ? redactText(input.cwd, '/cwd', 'cwd', profile, records)
    : undefined;
  const model = input.model
    ? redactText(input.model, '/model', 'model', profile, records)
    : undefined;
  const toolName = input.toolName
    ? redactText(input.toolName, '/toolName', 'toolName', profile, records)
    : undefined;
  const subtype = input.subtype
    ? redactText(input.subtype, '/subtype', 'subtype', profile, records)
    : undefined;
  const adapter = redactText(
    input.provenance.adapter,
    '/provenance/adapter',
    'adapter',
    profile,
    records,
  );
  const adapterVersion = redactText(
    input.provenance.adapterVersion,
    '/provenance/adapterVersion',
    'adapterVersion',
    profile,
    records,
  );
  const sourceVersion = input.provenance.sourceVersion
    ? redactText(
        input.provenance.sourceVersion,
        '/provenance/sourceVersion',
        'sourceVersion',
        profile,
        records,
      )
    : undefined;
  const event = TraceEventSchema.parse({
    ...input,
    sourceEventId: undefined,
    rawPayloadRef: undefined,
    payload,
    rawPayload,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(toolName ? { toolName } : {}),
    ...(subtype ? { subtype } : {}),
    provenance: {
      adapter,
      adapterVersion,
      ...(sourceVersion ? { sourceVersion } : {}),
      captureMode: input.provenance.captureMode,
    },
    ...(records.length > 0
      ? { redactions: [...(input.redactions ?? []), ...records] }
      : {}),
  });
  return { value: event, redactions: records };
}

/** Redact standalone text artifacts with the same deterministic detectors. */
export function redactArtifactText(
  input: string,
  profile: ResolvedExportProfile,
  artifactId: string,
): RedactionResult<string> {
  const records: RedactionRecord[] = [];
  return {
    value: redactText(
      input,
      `/artifacts/${pointerPart(artifactId)}/content`,
      undefined,
      profile,
      records,
    ),
    redactions: records,
  };
}
