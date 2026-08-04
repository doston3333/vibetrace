import { z } from 'zod';

/** The earliest app-server contract validated by this adapter. */
export const CODEX_APP_SERVER_BASELINE_VERSION = '0.144.3' as const;
export const CODEX_APP_SERVER_VALIDATED_VERSIONS = [
  '0.144.3',
  '0.145.0',
  '0.146.0',
] as const;

export const AppServerRpcEnvelopeSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    method: z.string().min(1).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown().optional(),
    error: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type AppServerRpcEnvelope = z.infer<typeof AppServerRpcEnvelopeSchema>;

export interface AppServerSchemaDescriptor {
  readonly schemaVersion: string;
  readonly minimumCodexVersion: typeof CODEX_APP_SERVER_BASELINE_VERSION;
  /** Packaged generated envelope schema for this validated contract. */
  readonly artifactPath: `schemas/${string}.json`;
  readonly validated: boolean;
  readonly compatibility: 'validated';
}

export const CODEX_APP_SERVER_SCHEMA_REGISTRY: readonly AppServerSchemaDescriptor[] =
  Object.freeze(
    CODEX_APP_SERVER_VALIDATED_VERSIONS.map((schemaVersion) => ({
      schemaVersion,
      minimumCodexVersion: CODEX_APP_SERVER_BASELINE_VERSION,
      artifactPath: `schemas/${schemaVersion}.json` as `schemas/${string}.json`,
      validated: true,
      compatibility: 'validated' as const,
    })),
  );

function version(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compare(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Resolve an exact packaged schema; unknown versions must become capture gaps. */
export function resolveAppServerSchema(
  codexVersion: string,
): AppServerSchemaDescriptor | undefined {
  const requested = version(codexVersion);
  if (!requested) return undefined;
  return CODEX_APP_SERVER_SCHEMA_REGISTRY.find((item) => {
    const itemVersion = version(item.schemaVersion);
    return itemVersion !== undefined && compare(itemVersion, requested) === 0;
  });
}

/** Return a stable error for unsupported or malformed app-server versions. */
export function assertSupportedAppServerVersion(
  codexVersion: string,
): AppServerSchemaDescriptor {
  const resolved = resolveAppServerSchema(codexVersion);
  if (!resolved)
    throw new Error(
      `Codex app-server version ${codexVersion} has no validated contract. Supported versions: ${CODEX_APP_SERVER_VALIDATED_VERSIONS.join(', ')}.`,
    );
  return resolved;
}
