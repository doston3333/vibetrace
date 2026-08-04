import {
  getTraceEventJsonSchema,
  type RunFingerprint,
  type TraceEvent,
} from '@vibetrace/schema';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Current version of the portable, reviewable evaluation manifest. */
export const EVAL_SCHEMA_VERSION = '1.0.0' as const;

const safeRelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Path contains NUL.')
  .refine((value) => !value.startsWith('/'), 'Path must be relative.')
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), 'Path must be relative.')
  .refine(
    (value) => !value.split(/[\\/]/u).some((part) => part === '..'),
    'Path traversal is not allowed.',
  );

const sourceEvidenceSchema = z
  .object({
    eventIds: z.array(z.string().uuid()).max(100_000),
    artifactBlobHashes: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(100_000),
    runFingerprintHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    captureGapIds: z.array(z.string().uuid()).max(100_000),
  })
  .strict();

const repositorySchema = z
  .object({
    remote: z.string().url().optional(),
    baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    preTaskPatchBlobHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    preTaskPatchSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.preTaskPatchBlobHash && !value.preTaskPatchSha256)
      context.addIssue({
        code: 'custom',
        path: ['preTaskPatchSha256'],
        message: 'A pre-task patch blob requires its content hash.',
      });
    if (value.preTaskPatchSha256 && !value.preTaskPatchBlobHash)
      context.addIssue({
        code: 'custom',
        path: ['preTaskPatchBlobHash'],
        message: 'A pre-task patch hash requires its encrypted blob.',
      });
  });

const taskSchema = z
  .object({
    prompt: z.string().min(1).max(1_000_000),
    constraints: z.array(z.string().min(1).max(16_384)).max(1_000),
    inferredFields: z.array(z.string().regex(/^\//)).max(10_000),
  })
  .strict();

export const EvalExecutionApprovalPolicySchema = z.enum([
  'untrusted',
  'on-request',
  'never',
]);
export const EvalExecutionSandboxPolicySchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export const EvalExecutionNetworkPolicySchema = z.enum(['enabled', 'disabled']);

const MAX_EXECUTION_EXTRA_ARGS = 64;
const MAX_EXECUTION_EXTRA_ARG_LENGTH = 4_096;
const safeExecutionBooleanArgs = new Set([
  '--ephemeral',
  '--ignore-rules',
  '--ignore-user-config',
  '--oss',
  '--strict-config',
]);

/** Reject exec arguments that could alter the isolated execution contract. */
export function validateEvalExecutionExtraArgs(args: readonly string[]): void {
  if (args.length > MAX_EXECUTION_EXTRA_ARGS)
    throw new Error(
      `execution.extraArgs exceeds the ${MAX_EXECUTION_EXTRA_ARGS}-argument limit.`,
    );
  for (const [index, argument] of args.entries()) {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      argument.length > MAX_EXECUTION_EXTRA_ARG_LENGTH ||
      argument.includes('\0') ||
      /[\r\n]/u.test(argument)
    )
      throw new Error(`execution.extraArgs[${index}] is not a safe argument.`);
    const normalized = argument.toLowerCase();
    const reserved =
      normalized === 'exec' ||
      normalized === 'e' ||
      normalized === '--json' ||
      normalized.startsWith('--json=') ||
      normalized === '--model' ||
      normalized.startsWith('--model=') ||
      normalized === '--sandbox' ||
      normalized.startsWith('--sandbox=') ||
      normalized === '--ask-for-approval' ||
      normalized.startsWith('--ask-for-approval=') ||
      normalized === '--config' ||
      normalized.startsWith('--config=') ||
      normalized === '-m' ||
      normalized.startsWith('-m') ||
      normalized === '-s' ||
      normalized.startsWith('-s') ||
      normalized === '-a' ||
      normalized.startsWith('-a') ||
      normalized === '-c' ||
      normalized.startsWith('-c') ||
      normalized === '--dangerously-bypass-approvals-and-sandbox' ||
      normalized === '--dangerously-bypass-hook-trust' ||
      normalized === '--full-auto' ||
      normalized === '--cd' ||
      normalized.startsWith('--cd=') ||
      normalized === '--add-dir' ||
      normalized.startsWith('--add-dir=') ||
      normalized === '--output-last-message' ||
      normalized.startsWith('--output-last-message=') ||
      normalized === '-o' ||
      normalized === '--output-schema' ||
      normalized.startsWith('--output-schema=') ||
      normalized === '--image' ||
      normalized.startsWith('--image=') ||
      normalized === '-i';
    if (reserved)
      throw new Error(
        `execution.extraArgs[${index}] overrides a reserved exec or policy option.`,
      );
    if (
      safeExecutionBooleanArgs.has(normalized) ||
      /^--color=(?:always|never|auto)$/u.test(normalized)
    )
      continue;
    throw new Error(
      `execution.extraArgs[${index}] is not an allowed non-policy exec option.`,
    );
  }
}

/** Validated Codex execution recipe; absent for legacy, capture-only manifests. */
export const EvalExecutionConfigurationSchema = z
  .object({
    model: z.string().min(1).max(512).optional(),
    approvalPolicy: EvalExecutionApprovalPolicySchema.optional(),
    sandboxPolicy: EvalExecutionSandboxPolicySchema.optional(),
    networkPolicy: EvalExecutionNetworkPolicySchema.optional(),
    extraArgs: z
      .array(z.string().min(1).max(MAX_EXECUTION_EXTRA_ARG_LENGTH))
      .max(MAX_EXECUTION_EXTRA_ARGS)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateEvalExecutionExtraArgs(value.extraArgs ?? []);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['extraArgs'],
        message:
          error instanceof Error
            ? error.message
            : 'execution.extraArgs is invalid.',
      });
    }
    if (
      value.networkPolicy === 'enabled' &&
      value.sandboxPolicy !== 'workspace-write'
    )
      context.addIssue({
        code: 'custom',
        path: ['networkPolicy'],
        message:
          'networkPolicy "enabled" requires sandboxPolicy "workspace-write" so it can be applied explicitly.',
      });
    if (
      value.networkPolicy === 'disabled' &&
      value.sandboxPolicy === 'danger-full-access'
    )
      context.addIssue({
        code: 'custom',
        path: ['networkPolicy'],
        message:
          'networkPolicy "disabled" cannot be guaranteed with sandboxPolicy "danger-full-access".',
      });
  });
export type EvalExecutionConfiguration = z.infer<
  typeof EvalExecutionConfigurationSchema
>;

const configurationSchema = z
  .object({
    model: z.string().min(1).max(512).optional(),
    codexVersion: z.string().min(1).max(128).optional(),
    skills: z
      .array(
        z
          .object({
            name: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(10_000),
    instructionHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
    approvalPolicy: z.string().min(1).max(128).optional(),
    sandboxPolicy: z.string().min(1).max(128).optional(),
    networkPolicy: z.string().min(1).max(128).optional(),
    execution: EvalExecutionConfigurationSchema.optional(),
    environmentFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    inferredFields: z.array(z.string().regex(/^\//)).max(10_000),
  })
  .strict();

const commandAssertionSchema = z
  .object({
    type: z.literal('command_exit_code'),
    command: z.string().min(1).max(16_384),
    expected: z.number().int(),
  })
  .strict();
const testCommandAssertionSchema = z
  .object({
    type: z.literal('test_command'),
    command: z.string().min(1).max(16_384),
    expectedExitCode: z.number().int().default(0),
  })
  .strict();
const fileAssertionSchema = z
  .object({
    type: z.enum(['file_exists', 'file_absent']),
    path: safeRelativePath,
  })
  .strict();
const regexAssertionSchema = z
  .object({
    type: z.literal('regex_match'),
    path: safeRelativePath,
    pattern: z.string().min(1).max(16_384),
    flags: z
      .string()
      .regex(/^[dgimsuvy]*$/)
      .optional(),
  })
  .strict();
const diffAssertionSchema = z
  .object({
    type: z.literal('diff_constraints'),
    allowedPaths: z.array(safeRelativePath).max(10_000),
    maxChangedFiles: z.number().int().nonnegative().max(100_000).optional(),
    maxAddedLines: z.number().int().nonnegative().max(10_000_000).optional(),
    maxDeletedLines: z.number().int().nonnegative().max(10_000_000).optional(),
  })
  .strict();
const humanRatingAssertionSchema = z
  .object({
    type: z.literal('human_rating'),
    prompt: z.string().min(1).max(16_384),
    minimum: z.number().int().min(0).max(100),
  })
  .strict();

export const SuccessAssertionSchema = z.discriminatedUnion('type', [
  commandAssertionSchema,
  testCommandAssertionSchema,
  fileAssertionSchema,
  regexAssertionSchema,
  diffAssertionSchema,
  humanRatingAssertionSchema,
]);

export const EvalManifestSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    id: z.string().uuid(),
    name: z.string().min(1).max(512),
    sourceSessionId: z.string().uuid().optional(),
    sourceEvidence: sourceEvidenceSchema,
    repository: repositorySchema,
    task: taskSchema,
    configuration: configurationSchema,
    success: z
      .object({
        assertions: z.array(SuccessAssertionSchema).min(1).max(10_000),
      })
      .strict(),
    capturedFailure: z
      .object({
        category: z.string().min(1).max(128),
        onsetEventId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.iso.datetime().refine((value) => value.endsWith('Z')),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.capturedFailure?.onsetEventId &&
      !value.sourceEvidence.eventIds.includes(
        value.capturedFailure.onsetEventId,
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['capturedFailure', 'onsetEventId'],
        message: 'Failure onset must reference source evidence.',
      });
  });

export type EvalManifest = z.infer<typeof EvalManifestSchema>;
export type SuccessAssertion = z.infer<typeof SuccessAssertionSchema>;

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

/** Stable content hash used by encrypted repositories and portable tooling. */
export function hashEvalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Hash a validated manifest independently of formatting or key order. */
export function hashEvalManifest(manifest: EvalManifest): string {
  return hashEvalJson(manifest);
}

export interface EvalManifestDraft {
  readonly id: string;
  readonly name: string;
  readonly sourceSessionId?: string;
  readonly sourceEvidence: EvalManifest['sourceEvidence'];
  readonly repository: EvalManifest['repository'];
  readonly task: EvalManifest['task'];
  readonly configuration: EvalManifest['configuration'];
  readonly success: EvalManifest['success'];
  readonly capturedFailure?: EvalManifest['capturedFailure'];
  readonly createdAt?: string;
}

/** Parse and normalize a user-reviewed manifest at the trust boundary. */
export function parseEvalManifest(input: unknown): EvalManifest {
  return EvalManifestSchema.parse(input);
}

/** Return the generated JSON Schema used by adapters and portable tooling. */
export function getEvalManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EvalManifestSchema) as Record<string, unknown>;
}

/** Create a validated manifest while preserving explicit inferred-field markers. */
export function createEvalManifest(
  draft: EvalManifestDraft,
  now = new Date().toISOString(),
): EvalManifest {
  return EvalManifestSchema.parse({
    schemaVersion: EVAL_SCHEMA_VERSION,
    ...draft,
    createdAt: draft.createdAt ?? now,
  });
}

/** Build a minimal editable manifest from observable session events only. */
export function manifestFromSession(input: {
  readonly id: string;
  readonly name: string;
  readonly sessionId: string;
  readonly repository: EvalManifest['repository'];
  readonly events: readonly TraceEvent[];
  readonly runFingerprint?: RunFingerprint;
  readonly successAssertions?: readonly SuccessAssertion[];
  readonly now?: string;
}): EvalManifest {
  const prompts = input.events.filter((event) => event.type === 'message.user');
  const prompt = prompts
    .map((event) =>
      typeof event.payload.content === 'string' ? event.payload.content : '',
    )
    .filter(Boolean)
    .at(0);
  const gaps = input.events.filter((event) => event.type === 'capture.gap');
  const sourceEventIds = input.events.map((event) => event.id);
  const inferredFields = prompt ? [] : ['/task/prompt'];
  const configuration = {
    ...(input.runFingerprint?.model
      ? { model: input.runFingerprint.model }
      : {}),
    ...(input.runFingerprint?.codexVersion
      ? { codexVersion: input.runFingerprint.codexVersion }
      : {}),
    skills:
      input.runFingerprint?.instructionHashes
        .filter((item) => item.kind === 'skill')
        .map((item) => ({ name: item.sha256, sha256: item.sha256 })) ?? [],
    instructionHashes:
      input.runFingerprint?.instructionHashes.map((item) => item.sha256) ?? [],
    inferredFields: input.runFingerprint ? [] : ['/configuration'],
  };
  const assertions = input.successAssertions?.length
    ? [...input.successAssertions]
    : [
        {
          type: 'human_rating' as const,
          prompt: 'Did the session achieve the requested outcome?',
          minimum: 0,
        },
      ];
  const failure = input.events.find(
    (event) => event.type === 'error' || event.status === 'failed',
  );
  return createEvalManifest(
    {
      id: input.id,
      name: input.name,
      sourceSessionId: input.sessionId,
      sourceEvidence: {
        eventIds: sourceEventIds,
        artifactBlobHashes: [],
        captureGapIds: gaps.map((event) => event.id),
      },
      repository: input.repository,
      task: {
        prompt:
          prompt ??
          'Review and complete the captured task; the original prompt was not observed.',
        constraints: [],
        inferredFields,
      },
      configuration,
      success: { assertions },
      ...(failure
        ? {
            capturedFailure: {
              category: 'unknown',
              onsetEventId: failure.id,
            },
          }
        : {}),
      createdAt: input.now,
    },
    input.now,
  );
}

/** Expose the source event schema for tools that build manifest evidence pickers. */
export { getTraceEventJsonSchema };
