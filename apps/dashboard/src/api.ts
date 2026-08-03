import type { JsonObject, RunFingerprint, TraceEvent } from '@vibetrace/schema';

export interface SessionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly source: string;
  readonly sourceSessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: string;
  readonly captureMode: string;
  readonly title?: string;
  readonly model?: string;
  readonly sourceVersion?: string;
  readonly baseCommit?: string;
  readonly finalCommit?: string;
  readonly runFingerprint?: RunFingerprint;
  readonly eventCount: number;
  readonly findingCount: number;
  readonly primaryFinding?: string;
}

export interface StoredEvent {
  readonly id: string;
  readonly rawEventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly toolName?: string;
  readonly event: TraceEvent;
}

export interface Artifact {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly metadata: JsonObject;
  readonly eventId?: string;
  readonly contentHash?: string;
  readonly blobHash?: string;
}

export interface Finding {
  readonly id: string;
  readonly sessionId: string;
  readonly ruleId: string;
  readonly detectorVersion: string;
  readonly category: string;
  readonly severity: string;
  readonly confidence?: number;
  readonly title: string;
  readonly explanation: string;
  readonly recommendation: string;
  readonly evidenceEventIds: readonly string[];
  readonly counterevidenceEventIds: readonly string[];
  readonly state: string;
}

export interface Annotation {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly label?: string;
  readonly note?: string;
}

export interface CoverageDatum {
  readonly dataClass:
    'conversation' | 'context' | 'tools' | 'code' | 'verification';
  readonly state: 'captured' | 'partial' | 'absent' | 'unknown';
  readonly sources: readonly string[];
  readonly gaps: readonly {
    readonly eventId: string;
    readonly state: string;
    readonly reason: string;
    readonly adapter: string;
  }[];
}

interface EventCursor {
  readonly afterSequence: number;
  readonly afterId: string;
}

export interface EventPage {
  readonly events: readonly StoredEvent[];
  readonly nextCursor?: EventCursor;
}

export interface SessionFilters {
  readonly project?: string;
  readonly model?: string;
  readonly result?: string;
  readonly category?: string;
  readonly captureMode?: string;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const code = await response
      .json()
      .then((value: unknown) =>
        value && typeof value === 'object' && 'code' in value
          ? String(value.code)
          : `HTTP_${response.status}`,
      )
      .catch(() => `HTTP_${response.status}`);
    throw new Error(code);
  }
  return (await response.json()) as T;
}

function query(values: Record<string, string | number | undefined>): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') result.set(key, String(value));
  const encoded = result.toString();
  return encoded ? `?${encoded}` : '';
}

export const api = {
  async sessions(
    filters: SessionFilters = {},
  ): Promise<readonly SessionSummary[]> {
    const response = await jsonRequest<{ sessions: readonly SessionSummary[] }>(
      `/api/v1/sessions${query({ limit: 10_000, ...filters })}`,
    );
    return response.sessions;
  },
  async session(id: string): Promise<SessionSummary> {
    const response = await jsonRequest<{ session: SessionSummary }>(
      `/api/v1/sessions/${encodeURIComponent(id)}`,
    );
    return response.session;
  },
  events(
    id: string,
    filters: {
      readonly type?: string;
      readonly toolName?: string;
      readonly from?: string;
      readonly to?: string;
    },
    cursor?: EventCursor,
  ): Promise<EventPage> {
    return jsonRequest(
      `/api/v1/sessions/${encodeURIComponent(id)}/events${query({
        limit: 2_000,
        ...filters,
        ...cursor,
      })}`,
    );
  },
  async searchEvents(
    id: string,
    search: string,
  ): Promise<readonly StoredEvent[]> {
    const response = await jsonRequest<{ events: readonly StoredEvent[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/events/search${query({ q: search, limit: 1_000 })}`,
    );
    return response.events;
  },
  async artifacts(id: string): Promise<readonly Artifact[]> {
    const response = await jsonRequest<{ artifacts: readonly Artifact[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/artifacts`,
    );
    return response.artifacts;
  },
  async artifactText(sessionId: string, artifactId: string): Promise<string> {
    const response = await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
      { credentials: 'same-origin', headers: { accept: 'text/plain' } },
    );
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.text();
  },
  async coverage(id: string): Promise<readonly CoverageDatum[]> {
    const response = await jsonRequest<{ coverage: readonly CoverageDatum[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/coverage`,
    );
    return response.coverage;
  },
  async findings(id: string): Promise<readonly Finding[]> {
    const response = await jsonRequest<{ findings: readonly Finding[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/findings`,
    );
    return response.findings;
  },
  async annotations(
    targetType?: string,
    targetId?: string,
  ): Promise<readonly Annotation[]> {
    const response = await jsonRequest<{ annotations: readonly Annotation[] }>(
      `/api/v1/annotations${query({ targetType, targetId })}`,
    );
    return response.annotations;
  },
  async createAnnotation(input: {
    targetType: string;
    targetId: string;
    label?: string;
    note?: string;
  }): Promise<Annotation> {
    const response = await jsonRequest<{ annotation: Annotation }>(
      '/api/v1/annotations',
      { method: 'POST', body: JSON.stringify(input) },
    );
    return response.annotation;
  },
  async updateAnnotation(
    id: string,
    input: { label?: string; note?: string },
  ): Promise<void> {
    await jsonRequest(`/api/v1/annotations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
};
