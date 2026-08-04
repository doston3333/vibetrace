import {
  CaptureProfilePolicySchema,
  captureProfilePolicy,
  RawSourceEventSchema,
  TraceEventSchema,
  type CaptureProfilePolicy,
  type EventType,
  type JsonObject,
  type JsonValue,
  type RawSourceEvent,
  type TraceEvent,
} from '@vibetrace/schema';

export interface AdapterCapabilities {
  readonly prompts: boolean;
  readonly messages: boolean;
  readonly plans: boolean;
  readonly reasoning: boolean;
  readonly toolInputs: boolean;
  readonly toolOutputs: boolean;
  readonly approvals: boolean;
  readonly compaction: boolean;
  readonly subagents: boolean;
  readonly tokenUsage: boolean;
  readonly diffs: boolean;
  readonly verification: boolean;
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly capabilities: AdapterCapabilities;
}

export interface AdapterMappedEvent {
  readonly raw: RawSourceEvent;
  readonly event: TraceEvent;
}

export interface SourceAdapter<Input = unknown> {
  readonly descriptor: AdapterDescriptor;
  capture(input: Input): AsyncIterable<AdapterMappedEvent>;
}

/**
 * The policy used when an external adapter does not receive an explicit
 * daemon policy. It still redacts credentials and omits environment values.
 */
export const DEFAULT_CAPTURE_PROFILE_POLICY: CaptureProfilePolicy =
  CaptureProfilePolicySchema.parse(captureProfilePolicy('standard'));

const sensitiveKeyPattern =
  /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|connection(?:string)?)/iu;
const environmentKeyPattern = /^(?:env|environment|environ|variables)$/iu;
const privateKeyPattern =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu;
const basicPattern = /\bBasic\s+[A-Za-z0-9+/=]{12,}/giu;
const knownTokenPattern =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})\b/gu;
const environmentAssignmentPattern =
  /(^|\n)([A-Za-z_][A-Za-z0-9_]{1,63})=(?:"[^"\n]*"|'[^'\n]*'|[^\n]*)/gu;
const assignmentSecretPattern =
  /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)\s*[:=]\s*)(["']?)([^\s"',;}]+)\2/giu;

interface SanitizationResult {
  readonly value: JsonValue;
  readonly redactions: readonly {
    readonly path: string;
    readonly detector: string;
    readonly replacement: string;
  }[];
}

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function omittedValue(reason: string): string {
  return `[OMITTED:${reason}]`;
}

function redactText(
  input: string,
  path: string,
  policy: CaptureProfilePolicy,
): SanitizationResult {
  if (!policy.redactSecrets) return { value: input, redactions: [] };
  let value = input;
  const redactions: SanitizationResult['redactions'][number][] = [];
  const replace = (
    pattern: RegExp,
    detector: string,
    replacement = `[REDACTED:${detector}]`,
  ): void => {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return;
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
    redactions.push({ path, detector, replacement });
  };
  replace(privateKeyPattern, 'private-key');
  replace(bearerPattern, 'authorization-header');
  replace(basicPattern, 'authorization-header');
  replace(knownTokenPattern, 'known-token');
  assignmentSecretPattern.lastIndex = 0;
  if (assignmentSecretPattern.test(value)) {
    assignmentSecretPattern.lastIndex = 0;
    const replacement = '[REDACTED:secret]';
    value = value.replace(
      assignmentSecretPattern,
      (_match, prefix: string, quote: string) =>
        `${prefix}${quote}${replacement}${quote}`,
    );
    redactions.push({
      path,
      detector: 'secret-assignment',
      replacement,
    });
  }
  environmentAssignmentPattern.lastIndex = 0;
  if (environmentAssignmentPattern.test(value)) {
    environmentAssignmentPattern.lastIndex = 0;
    const replacement = '[REDACTED:environment-value]';
    value = value.replace(
      environmentAssignmentPattern,
      (_match, prefix: string, key: string) => `${prefix}${key}=${replacement}`,
    );
    redactions.push({
      path,
      detector: 'environment-assignment',
      replacement,
    });
  }
  return { value, redactions };
}

function shouldOmitField(
  key: string,
  eventType: EventType | undefined,
  policy: CaptureProfilePolicy,
): string | undefined {
  const normalized = key.replaceAll('-', '_').toLowerCase();
  if (
    environmentKeyPattern.test(normalized) &&
    !policy.captureEnvironmentMetadata
  )
    return 'environment';
  if (
    (normalized === 'prompt' ||
      (normalized === 'content' && eventType === 'message.user')) &&
    !policy.capturePrompts
  )
    return 'profile-minimal';
  if (
    (normalized === 'content' || normalized === 'last_assistant_message') &&
    eventType !== 'message.user' &&
    !policy.captureMessages
  )
    return 'profile-minimal';
  if (
    (normalized === 'tool_input' || normalized === 'toolinput') &&
    !policy.captureToolInputs
  )
    return 'profile-minimal';
  if (
    (normalized === 'tool_response' ||
      normalized === 'toolresponse' ||
      normalized === 'output' ||
      normalized === 'stdout' ||
      normalized === 'stderr') &&
    !policy.captureToolOutputs
  )
    return 'profile-minimal';
  if (
    (normalized === 'diff' ||
      normalized === 'cumulativediff' ||
      normalized === 'patch') &&
    !policy.captureDiffs
  )
    return 'profile-minimal';
  if (sensitiveKeyPattern.test(normalized)) return 'secret-field';
  return undefined;
}

function sanitizeValue(
  value: JsonValue,
  path: string,
  policy: CaptureProfilePolicy,
  eventType?: EventType,
  key?: string,
): SanitizationResult {
  const omission = key ? shouldOmitField(key, eventType, policy) : undefined;
  if (omission) {
    const replacement = omittedValue(omission);
    return {
      value: replacement,
      redactions: [{ path, detector: omission, replacement }],
    };
  }
  if (typeof value === 'string') return redactText(value, path, policy);
  if (Array.isArray(value)) {
    const redactions: SanitizationResult['redactions'][number][] = [];
    const output = value.map((child, index) => {
      const result = sanitizeValue(
        child,
        `${path}/${index}`,
        policy,
        eventType,
        key,
      );
      redactions.push(...result.redactions);
      return result.value;
    });
    return { value: output, redactions };
  }
  if (value !== null && typeof value === 'object') {
    const redactions: SanitizationResult['redactions'][number][] = [];
    const output: Record<string, JsonValue> = {};
    for (const [childKey, child] of Object.entries(value)) {
      const result = sanitizeValue(
        child,
        `${path}/${pointerPart(childKey)}`,
        policy,
        eventType,
        childKey,
      );
      redactions.push(...result.redactions);
      output[childKey] = result.value;
    }
    return { value: output, redactions };
  }
  return { value, redactions: [] };
}

/**
 * Apply the active local capture policy at a source adapter boundary. This
 * keeps raw fields useful for forensics while ensuring credentials and fields
 * disabled by the profile never reach a spool or repository.
 */
export function applyCaptureProfileToMappedEvent(
  mapped: AdapterMappedEvent,
  policy: CaptureProfilePolicy = DEFAULT_CAPTURE_PROFILE_POLICY,
): AdapterMappedEvent {
  const parsedPolicy = CaptureProfilePolicySchema.parse(policy);
  const eventPayload = sanitizeValue(
    mapped.event.payload as JsonObject,
    '/payload',
    parsedPolicy,
    mapped.event.type,
  );
  const rawPayload = sanitizeValue(
    mapped.raw.payload,
    '/rawPayload',
    parsedPolicy,
    mapped.event.type,
  );
  const redactions = [
    ...(mapped.event.redactions ?? []),
    ...eventPayload.redactions,
    ...rawPayload.redactions,
  ];
  const event = TraceEventSchema.parse({
    ...mapped.event,
    payload: eventPayload.value as JsonObject,
    rawPayload: rawPayload.value as JsonObject,
    ...(redactions.length > 0 ? { redactions } : {}),
  });
  return validateMappedEvent({
    raw: { ...mapped.raw, payload: rawPayload.value as JsonObject },
    event,
  });
}

/** Validate an adapter output before it reaches a spool or repository. */
export function validateMappedEvent(
  value: AdapterMappedEvent,
): AdapterMappedEvent {
  return {
    raw: RawSourceEventSchema.parse(value.raw),
    event: TraceEventSchema.parse(value.event),
  };
}

/** Minimal conformance oracle reusable by external adapters and fixtures. */
export async function assertAdapterConformance(
  adapter: SourceAdapter,
  input: unknown,
): Promise<readonly AdapterMappedEvent[]> {
  const seen = new Set<string>();
  const output: AdapterMappedEvent[] = [];
  let previousSequence = 0;
  for await (const candidate of adapter.capture(input)) {
    const mapped = validateMappedEvent(candidate);
    if (mapped.event.provenance.adapter !== adapter.descriptor.id)
      throw new Error('Mapped event provenance does not identify the adapter.');
    if (mapped.event.sequence <= previousSequence)
      throw new Error('Adapter event sequence is not strictly increasing.');
    previousSequence = mapped.event.sequence;
    if (seen.has(mapped.event.id))
      throw new Error('Adapter emitted duplicate event IDs.');
    seen.add(mapped.event.id);
    output.push(mapped);
  }
  return output;
}
