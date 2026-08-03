import {
  createEventId,
  createSessionId,
  type TraceEvent,
} from '@vibetrace/schema';
import { describe, expect, it } from 'vitest';

import {
  redactArtifactText,
  redactEvent,
  redactJson,
  type ResolvedExportProfile,
} from './redaction.js';

const shareSafe: ResolvedExportProfile = {
  kind: 'share-safe',
  name: 'Share safe',
  base: 'share-safe',
  restorePointers: new Set(),
  redactPointers: new Set(),
  includeArtifacts: true,
  includeBinaryArtifacts: false,
  artifactDenyIds: new Set(),
};

function traceEvent(): TraceEvent {
  const sessionId = createSessionId('codex-hooks', 'redaction-session');
  return {
    schemaVersion: '0.1.0',
    id: createEventId({
      adapter: 'codex-hooks',
      sourceSessionId: 'redaction-session',
      sourceSequence: 1,
      type: 'tool.completed',
    }),
    sessionId,
    sequence: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'tool',
    type: 'tool.completed',
    toolName: 'terminal',
    cwd: '/Users/private/work',
    payload: {
      toolName: 'terminal',
      password: 'not-for-export',
      output:
        'authorization: Bearer abcDEF1234567890abcDEF1234567890 and sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    },
    rawPayload: {
      databaseUrl: 'postgres://operator:secret@localhost/private',
      env: 'SERVICE_TOKEN=abcDEF1234567890abcDEF1234567890',
    },
    provenance: {
      adapter: 'codex-hooks',
      adapterVersion: '0.1.0',
      captureMode: 'full',
      rawEventId: 'private-raw-id',
    },
  };
}

describe('derived redaction views', () => {
  it('detects structured secrets, known keys, headers, connection strings, env values, and private keys', () => {
    const event = redactEvent(traceEvent(), shareSafe);
    const serialized = JSON.stringify(event.value);
    expect(serialized).not.toContain('not-for-export');
    expect(serialized).not.toContain('abcDEF1234567890abcDEF1234567890');
    expect(serialized).not.toContain('postgres://operator:secret');
    expect(serialized).not.toContain(
      'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    );
    expect(serialized).not.toContain('private-raw-id');
    expect(event.redactions.map((item) => item.detector)).toEqual(
      expect.arrayContaining([
        'suspicious-field',
        'authorization-header',
        'connection-string',
        'env-secret',
        'known-key',
      ]),
    );

    const artifact = redactArtifactText(
      'before\n-----BEGIN PRIVATE KEY-----\nsecret body\n-----END PRIVATE KEY-----\nafter',
      shareSafe,
      'terminal-output',
    );
    expect(artifact.value).toBe('before\n[REDACTED:private-key]\nafter');
    expect(artifact.redactions).toContainEqual(
      expect.objectContaining({ detector: 'private-key' }),
    );
  });

  it('restores only the requested derived-view pointer without mutating the source', () => {
    const source = {
      password: 'restore-me',
      nested: { password: 'stay-redacted' },
    } as const;
    const profile: ResolvedExportProfile = {
      ...shareSafe,
      restorePointers: new Set(['/password']),
    };
    const result = redactJson(source, profile);
    expect(result.value).toEqual({
      password: 'restore-me',
      nested: { password: '[REDACTED:suspicious-field]' },
    });
    expect(source.nested.password).toBe('stay-redacted');
  });

  it('projects metadata-only events into schema-valid capture gaps', () => {
    const result = redactEvent(traceEvent(), {
      ...shareSafe,
      kind: 'metadata-only',
      name: 'Metadata only',
      base: 'metadata-only',
      includeArtifacts: false,
    });
    expect(result.value).toMatchObject({
      id: traceEvent().id,
      type: 'capture.gap',
      subtype: 'export.metadata-only.tool.completed',
      provenance: { captureMode: 'partial' },
    });
    expect(JSON.stringify(result.value)).not.toContain('not-for-export');
  });
});
