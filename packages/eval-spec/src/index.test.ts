import {
  createEventId,
  createSessionId,
  TraceEventSchema,
} from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  EVAL_SCHEMA_VERSION,
  EvalManifestSchema,
  getEvalManifestJsonSchema,
  manifestFromSession,
  parseEvalManifest,
} from './index.js';

const sessionId = createSessionId('fixture', 'session-1');
const eventId = createEventId({
  adapter: 'fixture',
  sourceSessionId: 'session-1',
  sourceEventId: 'prompt-1',
  sourceSequence: 1,
  type: 'message.user',
});
const base = {
  schemaVersion: EVAL_SCHEMA_VERSION,
  id: createSessionId('eval', 'case-1'),
  name: 'Example case',
  sourceSessionId: sessionId,
  sourceEvidence: {
    eventIds: [eventId],
    artifactBlobHashes: [],
    captureGapIds: [],
  },
  repository: { baseCommit: 'a'.repeat(40) },
  task: {
    prompt: 'Implement the requested change.',
    constraints: ['Keep the API stable.'],
    inferredFields: [],
  },
  configuration: {
    skills: [],
    instructionHashes: [],
    inferredFields: [],
  },
  success: {
    assertions: [
      { type: 'command_exit_code' as const, command: 'pnpm test', expected: 0 },
    ],
  },
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('eval manifest schema', () => {
  it('round-trips a reviewed manifest and emits JSON Schema', () => {
    const manifest = parseEvalManifest(base);
    expect(manifest.schemaVersion).toBe(EVAL_SCHEMA_VERSION);
    expect(getEvalManifestJsonSchema()).toMatchObject({ type: 'object' });
    expect(
      EvalManifestSchema.parse(JSON.parse(JSON.stringify(manifest))),
    ).toEqual(manifest);
  });

  it('marks unsafe assertion paths and missing failure evidence precisely', () => {
    const result = EvalManifestSchema.safeParse({
      ...base,
      success: {
        assertions: [{ type: 'file_exists', path: '../secret' }],
      },
      capturedFailure: {
        category: 'context',
        onsetEventId: createSessionId('fixture', 'missing'),
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.path.includes('path')),
    ).toBe(true);
    expect(
      result.error.issues.some((issue) => issue.path.includes('onsetEventId')),
    ).toBe(true);
  });

  it('validates explicit, executable Codex configuration without changing legacy manifests', () => {
    const manifest = parseEvalManifest({
      ...base,
      configuration: {
        ...base.configuration,
        execution: {
          model: 'gpt-5.6-codex',
          approvalPolicy: 'never',
          sandboxPolicy: 'workspace-write',
          networkPolicy: 'disabled',
          extraArgs: ['--ephemeral', '--color=never'],
        },
      },
    });
    expect(manifest.configuration.execution).toMatchObject({
      model: 'gpt-5.6-codex',
      approvalPolicy: 'never',
      sandboxPolicy: 'workspace-write',
      networkPolicy: 'disabled',
    });
    expect(
      EvalManifestSchema.safeParse({
        ...base,
        configuration: {
          ...base.configuration,
          execution: { extraArgs: ['--json'] },
        },
      }).success,
    ).toBe(false);
    expect(
      EvalManifestSchema.safeParse({
        ...base,
        configuration: {
          ...base.configuration,
          execution: { networkPolicy: 'enabled' },
        },
      }).success,
    ).toBe(false);
    expect(
      EvalManifestSchema.safeParse({
        ...base,
        configuration: {
          ...base.configuration,
          execution: {
            sandboxPolicy: 'read-only',
            networkPolicy: 'disabled',
          },
        },
      }).success,
    ).toBe(true);
    expect(
      EvalManifestSchema.safeParse({
        ...base,
        configuration: {
          ...base.configuration,
          execution: {
            sandboxPolicy: 'danger-full-access',
            networkPolicy: 'disabled',
          },
        },
      }).success,
    ).toBe(false);
    expect(parseEvalManifest(base).configuration.execution).toBeUndefined();
  });

  it('creates a reviewable case from observed prompts, gaps, and failures', () => {
    const events = [
      TraceEventSchema.parse({
        schemaVersion: '0.1.0',
        id: eventId,
        sessionId,
        sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'user',
        type: 'message.user',
        payload: { content: 'Fix the authorization flow.' },
        rawPayload: { source: { unknown: true } },
        provenance: {
          adapter: 'fixture',
          adapterVersion: '1.0.0',
          captureMode: 'standard',
        },
      }),
      TraceEventSchema.parse({
        schemaVersion: '0.1.0',
        id: createEventId({
          adapter: 'fixture',
          sourceSessionId: 'session-1',
          sourceEventId: 'error-1',
          sourceSequence: 2,
          type: 'error',
        }),
        sessionId,
        sequence: 2,
        timestamp: '2026-01-01T00:00:01.000Z',
        source: 'tool',
        type: 'error',
        status: 'failed',
        payload: { message: 'verification failed' },
        rawPayload: {},
        provenance: {
          adapter: 'fixture',
          adapterVersion: '1.0.0',
          captureMode: 'standard',
        },
      }),
    ];
    const manifest = manifestFromSession({
      id: createSessionId('eval', 'derived-1'),
      name: 'Derived authorization case',
      sessionId,
      repository: { baseCommit: 'a'.repeat(40) },
      events,
      now: '2026-01-01T00:01:00.000Z',
    });
    expect(manifest.task.prompt).toBe('Fix the authorization flow.');
    expect(manifest.task.inferredFields).toEqual([
      '/task/corrections',
      '/task/constraints',
      '/task/expectedOutcome',
    ]);
    expect(manifest.sourceEvidence.eventIds).toEqual([eventId, events[1]?.id]);
    expect(manifest.sourceEvidence.captureGapIds).toEqual([]);
    expect(manifest.capturedFailure?.onsetEventId).toBe(events[1]?.id);
    expect(manifest.capturedFailure?.category).toBe('unknown');
    expect(manifest.success.inferredFields).toEqual([
      '/success/commands',
      '/success/assertions',
    ]);
  });

  it('extracts corrections, constraints, verification, and fingerprint evidence', () => {
    const commandId = createEventId({
      adapter: 'fixture',
      sourceSessionId: 'session-1',
      sourceEventId: 'command-1',
      sourceSequence: 2,
      type: 'command.completed',
    });
    const correctionId = createEventId({
      adapter: 'fixture',
      sourceSessionId: 'session-1',
      sourceEventId: 'correction-1',
      sourceSequence: 3,
      type: 'message.user',
    });
    const events = [
      TraceEventSchema.parse({
        ...baseEvent('prompt-2', 1, 'message.user'),
        payload: {
          content:
            'Implement roles.\n- Roles must come from the database.\nExpected outcome: integration tests pass.',
        },
      }),
      TraceEventSchema.parse({
        ...baseEvent('command-1', 2, 'command.completed'),
        id: commandId,
        source: 'tool',
        payload: {
          command: 'pnpm test:integration',
          category: 'test',
          exitCode: 0,
        },
      }),
      TraceEventSchema.parse({
        ...baseEvent('correction-1', 3, 'message.user'),
        id: correctionId,
        payload: { content: 'Keep existing JWT behavior compatible.' },
      }),
    ];
    const manifest = manifestFromSession({
      id: createSessionId('eval', 'derived-2'),
      name: 'Derived extraction case',
      sessionId,
      repository: { baseCommit: 'a'.repeat(40) },
      events,
      runFingerprint: {
        source: 'codex',
        clientSurface: 'exec',
        model: 'gpt-5.6-codex',
        codexVersion: '0.144.3',
        instructionHashes: [],
        lockfileHashes: [],
        captureOmissions: [],
        os: 'darwin',
        architecture: 'arm64',
        runtimeVersions: { node: '24.0.0' },
      },
      now: '2026-01-01T00:01:00.000Z',
    });
    expect(manifest.task.corrections).toEqual([
      'Keep existing JWT behavior compatible.',
    ]);
    expect(manifest.task.constraints).toEqual([
      'Roles must come from the database.',
      'Keep existing JWT behavior compatible.',
    ]);
    expect(manifest.task.expectedOutcome).toBe('integration tests pass.');
    expect(manifest.success.commands?.[0]).toMatchObject({
      command: 'pnpm test:integration',
      category: 'test',
      sourceEventId: commandId,
    });
    expect(manifest.success.assertions).toEqual([
      {
        type: 'command_exit_code',
        command: 'pnpm test:integration',
        expected: 0,
      },
    ]);
    expect(manifest.sourceEvidence.runFingerprintHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(manifest.configuration.environmentFingerprint).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });
});

function baseEvent(
  sourceEventId: string,
  sequence: number,
  type: 'message.user' | 'command.completed',
) {
  return {
    schemaVersion: '0.1.0',
    id: createEventId({
      adapter: 'fixture',
      sourceSessionId: 'session-1',
      sourceEventId,
      sourceSequence: sequence,
      type,
    }),
    sessionId,
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    source: type === 'message.user' ? 'user' : 'tool',
    type,
    payload: type === 'message.user' ? { content: 'prompt' } : {},
    rawPayload: {},
    provenance: {
      adapter: 'fixture',
      adapterVersion: '1.0.0',
      captureMode: 'standard',
    },
  };
}
