import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { api, type EvalRunSummary, type StoredEvent } from './api.js';

export function EvalsPage() {
  const queryClient = useQueryClient();
  const cases = useQuery({
    queryKey: ['eval-cases'],
    queryFn: api.evalCases,
    staleTime: 5_000,
  });
  const sessions = useQuery({
    queryKey: ['sessions', { limit: 10_000 }],
    queryFn: () => api.sessions(),
    staleTime: 5_000,
  });
  const [sourceSessionId, setSourceSessionId] = useState('');
  const [manifestName, setManifestName] = useState('');
  const createCase = useMutation({
    mutationFn: () =>
      api.createEvalCaseFromSession(sourceSessionId, manifestName.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['eval-cases'] });
      setManifestName('');
    },
  });
  const [comparisonId, setComparisonId] = useState('');
  const [leftRunId, setLeftRunId] = useState('');
  const [rightRunId, setRightRunId] = useState('');
  const comparison = useQuery({
    queryKey: ['eval-comparison', comparisonId],
    queryFn: () => api.evalComparison(comparisonId),
    enabled: comparisonId.length > 0,
  });
  return (
    <main id="main-content" className="sessions-page evals-page">
      <header className="sessions-intro">
        <div>
          <p className="eyebrow">Controlled evaluation</p>
          <h1>Evaluation lab</h1>
          <p>
            Reviewable manifests and repeatable outcomes, kept separate from
            forensic session facts.
          </p>
        </div>
        <div className="archive-count">
          <span>Cases indexed locally</span>
          <strong>{(cases.data ?? []).length.toLocaleString()}</strong>
        </div>
      </header>
      {cases.isPending ? (
        <div className="session-loading" role="status">
          Opening encrypted evaluation cases…
        </div>
      ) : null}
      {cases.isError ? (
        <div className="page-error" role="alert">
          <strong>The evaluation index could not be opened.</strong>
          <p>Check the daemon and local encryption key, then reload.</p>
        </div>
      ) : null}
      {!cases.isPending && !cases.isError && cases.data?.length === 0 ? (
        <div className="teaching-empty">
          <strong>No evaluation cases yet.</strong>
          <p>
            Use <code>vibetrace eval create</code> to derive a reviewed case
            from a captured session.
          </p>
        </div>
      ) : null}
      <section
        className="comparison-panel eval-builder"
        aria-labelledby="eval-builder-title"
      >
        <div>
          <h2 id="eval-builder-title">Turn a session into an eval</h2>
          <p>
            VibeTrace derives an editable, evidence-linked manifest from the
            observable session. The source remains unchanged.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (sourceSessionId && manifestName.trim())
              void createCase.mutateAsync();
          }}
        >
          <label>
            Source session
            <select
              required
              value={sourceSessionId}
              onChange={(event) => setSourceSessionId(event.target.value)}
              disabled={sessions.isPending || createCase.isPending}
            >
              <option value="">Choose a session…</option>
              {sessions.data?.map((session) => (
                <option value={session.id} key={session.id}>
                  {(session.title ?? session.displayName).slice(0, 96)} ·{' '}
                  {session.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Manifest name
            <input
              required
              maxLength={512}
              value={manifestName}
              onChange={(event) => setManifestName(event.target.value)}
              placeholder="Regression: failed verification session"
              disabled={createCase.isPending}
            />
          </label>
          <button
            type="submit"
            disabled={
              createCase.isPending || !sourceSessionId || !manifestName.trim()
            }
          >
            {createCase.isPending ? 'Deriving manifest…' : 'Create eval case'}
          </button>
        </form>
        {createCase.isError ? (
          <p className="page-error" role="alert">
            Could not derive the case. The session needs a captured Git base
            commit and at least one event.
          </p>
        ) : null}
        {createCase.isSuccess ? (
          <p role="status">Eval case created: {createCase.data.name}</p>
        ) : null}
      </section>
      {(cases.data?.length ?? 0) > 0 ? (
        <section className="session-index" aria-labelledby="eval-case-title">
          <div className="session-index-heading">
            <h2 id="eval-case-title">Manifest cases</h2>
            <span>Encrypted manifests; raw blobs are never rendered</span>
          </div>
          <div className="eval-case-list">
            {cases.data?.map((item) => (
              <article className="eval-case-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {item.id} · schema {item.schemaVersion}
                  </small>
                </div>
                <code>{item.manifestHash.slice(0, 16)}…</code>
                {item.sourceSessionId ? (
                  <small>Source session {item.sourceSessionId}</small>
                ) : null}
                <Link
                  className="text-link"
                  to="/evals/$caseId"
                  params={{ caseId: item.id }}
                >
                  Review manifest
                </Link>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <section className="comparison-panel" aria-labelledby="comparison-title">
        <div>
          <h2 id="comparison-title">Compare repeated runs</h2>
          <p>
            Enter a comparison ID to inspect outcomes, operational metrics, and
            the first evidence divergence.
          </p>
        </div>
        <label>
          Comparison ID
          <input
            value={comparisonId}
            onChange={(event) => setComparisonId(event.target.value.trim())}
            placeholder="UUID"
          />
        </label>
        {comparison.isError ? (
          <p className="page-error" role="alert">
            That comparison could not be loaded.
          </p>
        ) : null}
        {comparison.data ? (
          <div className="comparison-results">
            <h3>{comparison.data.comparison.name}</h3>
            <p className="comparison-dimensions">
              Dimensions:{' '}
              {Array.isArray(
                comparison.data.comparison.configuration.dimensions,
              )
                ? comparison.data.comparison.configuration.dimensions.join(
                    ' · ',
                  )
                : 'not declared'}
            </p>
            <dl>
              <div>
                <dt>Runs</dt>
                <dd>{comparison.data.summary.runCount}</dd>
              </div>
              <div>
                <dt>Success rate</dt>
                <dd>
                  {comparison.data.summary.successRate === null
                    ? 'Not enough definitive runs'
                    : `${Math.round(comparison.data.summary.successRate * 100)}%`}
                </dd>
              </div>
              <div>
                <dt>Median duration</dt>
                <dd>
                  {comparison.data.summary.durationMs.median === null
                    ? 'Not captured'
                    : `${comparison.data.summary.durationMs.median} ms`}
                </dd>
              </div>
              <div>
                <dt>Median tokens</dt>
                <dd>
                  {comparison.data.summary.tokenCount.median === null
                    ? 'Not captured'
                    : comparison.data.summary.tokenCount.median.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Median cost</dt>
                <dd>
                  {comparison.data.summary.estimatedCostMicros.median === null
                    ? 'Not captured'
                    : `${comparison.data.summary.estimatedCostMicros.median.toLocaleString()} μ$`}
                </dd>
              </div>
            </dl>
            <div
              className="comparison-side-by-side"
              aria-label="Run side by side"
            >
              <h4>Run matrix</h4>
              <div className="comparison-run-grid">
                {comparison.data.runs.map((run) => {
                  const result = comparison.data.results.find(
                    (item) => item.evalRunId === run.id,
                  )?.result;
                  const checks = Array.isArray(run.outcome?.checks)
                    ? run.outcome.checks
                    : [];
                  return (
                    <article key={run.id}>
                      <strong>{run.id.slice(0, 12)}…</strong>
                      <span>{run.status}</span>
                      {typeof result?.variantId === 'string' ? (
                        <small>
                          Variant {result.variantId} · repetition{' '}
                          {typeof result.repetition === 'number'
                            ? result.repetition
                            : '—'}
                        </small>
                      ) : null}
                      <small>
                        {run.outcome?.success === true
                          ? 'passed'
                          : run.outcome?.success === false
                            ? 'failed'
                            : 'pending'}
                      </small>
                      {run.metrics?.durationMs !== undefined ? (
                        <small>{String(run.metrics.durationMs)} ms</small>
                      ) : null}
                      <small>
                        Tools {metricText(run.metrics?.toolCount)} · Files{' '}
                        {metricText(run.metrics?.diffFileCount)} · Tests{' '}
                        {metricText(run.metrics?.verificationCount)}
                      </small>
                      <small>
                        Findings {metricText(run.metrics?.findingCount)} ·
                        Tokens {metricText(run.metrics?.tokenCount)} · Cost{' '}
                        {metricText(run.metrics?.estimatedCostMicros)} μ$
                      </small>
                      {checks.length > 0 ? (
                        <small>
                          Checks:{' '}
                          {checks
                            .map((check) =>
                              check && typeof check === 'object'
                                ? String(
                                    (check as Record<string, unknown>).status ??
                                      'unknown',
                                  )
                                : 'unknown',
                            )
                            .join(' · ')}
                        </small>
                      ) : null}
                      <pre className="comparison-run-config">
                        {JSON.stringify(run.configuration, null, 2)}
                      </pre>
                      {run.sourceSessionId ? (
                        <a
                          href={`/sessions/${encodeURIComponent(run.sourceSessionId)}`}
                        >
                          Open evidence session
                        </a>
                      ) : (
                        <small>Session capture not attached</small>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
            <ComparisonEvidence
              runs={comparison.data.runs}
              leftRunId={
                comparison.data.runs.some((run) => run.id === leftRunId)
                  ? leftRunId
                  : (comparison.data.runs[0]?.id ?? '')
              }
              rightRunId={
                comparison.data.runs.some((run) => run.id === rightRunId)
                  ? rightRunId
                  : (comparison.data.runs[1]?.id ?? '')
              }
              firstDivergence={comparison.data.summary.firstDivergence}
              onLeftRunChange={setLeftRunId}
              onRightRunChange={setRightRunId}
            />
            {comparison.data.summary.firstDivergence ? (
              <p>
                First divergence at event{' '}
                {comparison.data.summary.firstDivergence.index}:{' '}
                {comparison.data.summary.firstDivergence.reason}
              </p>
            ) : (
              <p>
                No first divergence has been computed yet. Submit bounded event
                streams with <code>vibetrace eval compare-divergence</code> to
                record evidence.
              </p>
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}

interface ComparisonEvidenceProps {
  readonly runs: readonly EvalRunSummary[];
  readonly leftRunId: string;
  readonly rightRunId: string;
  readonly firstDivergence?: {
    readonly index: number;
    readonly reason: string;
    readonly leftEventId?: string;
    readonly rightEventId?: string;
  };
  readonly onLeftRunChange: (id: string) => void;
  readonly onRightRunChange: (id: string) => void;
}

function ComparisonEvidence({
  runs,
  leftRunId,
  rightRunId,
  firstDivergence,
  onLeftRunChange,
  onRightRunChange,
}: ComparisonEvidenceProps) {
  const leftRun = runs.find((run) => run.id === leftRunId);
  const rightRun = runs.find((run) => run.id === rightRunId);
  const leftEvents = useComparisonEvents(leftRun);
  const rightEvents = useComparisonEvents(rightRun);
  if (!leftRun || !rightRun || leftRun.id === rightRun.id)
    return (
      <section className="comparison-evidence" aria-labelledby="evidence-title">
        <h4 id="evidence-title">Side-by-side evidence</h4>
        <p className="muted-copy">
          Select two persisted runs with captured sessions to inspect their
          paired evidence here.
        </p>
      </section>
    );
  return (
    <section className="comparison-evidence" aria-labelledby="evidence-title">
      <div className="comparison-evidence-heading">
        <div>
          <h4 id="evidence-title">Side-by-side evidence</h4>
          <p className="muted-copy">
            The first event page is loaded lazily from each encrypted session;
            the marked row is the persisted divergence candidate.
          </p>
        </div>
        <div className="comparison-run-selectors">
          <label>
            Left run
            <select
              value={leftRun.id}
              onChange={(event) => onLeftRunChange(event.target.value)}
            >
              {runs.map((run) => (
                <option value={run.id} key={`left-${run.id}`}>
                  {run.id.slice(0, 12)}…
                </option>
              ))}
            </select>
          </label>
          <label>
            Right run
            <select
              value={rightRun.id}
              onChange={(event) => onRightRunChange(event.target.value)}
            >
              {runs.map((run) => (
                <option value={run.id} key={`right-${run.id}`}>
                  {run.id.slice(0, 12)}…
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="comparison-evidence-grid">
        <EvidenceColumn
          run={leftRun}
          page={leftEvents}
          eventId={firstDivergence?.leftEventId}
          index={firstDivergence?.index}
        />
        <EvidenceColumn
          run={rightRun}
          page={rightEvents}
          eventId={firstDivergence?.rightEventId}
          index={firstDivergence?.index}
        />
      </div>
    </section>
  );
}

function useComparisonEvents(run: EvalRunSummary | undefined): {
  readonly events: readonly StoredEvent[];
  readonly isPending: boolean;
  readonly isError: boolean;
} {
  const query = useQuery({
    queryKey: ['comparison-events', run?.id],
    queryFn: async () => {
      if (!run?.sourceSessionId) return [] as readonly StoredEvent[];
      const page = await api.events(run.sourceSessionId, {});
      return page.events;
    },
    enabled: Boolean(run?.sourceSessionId),
  });
  return {
    events: query.data ?? [],
    isPending: query.isPending,
    isError: query.isError,
  };
}

function EvidenceColumn({
  run,
  page,
  eventId,
  index,
}: {
  readonly run: EvalRunSummary;
  readonly page: ReturnType<typeof useComparisonEvents>;
  readonly eventId?: string;
  readonly index?: number;
}) {
  const fallbackId = index === undefined ? undefined : page.events[index]?.id;
  const highlightedId = eventId ?? fallbackId;
  return (
    <article className="comparison-evidence-column">
      <header>
        <strong>{run.id.slice(0, 12)}…</strong>
        {run.sourceSessionId ? (
          <a href={`/sessions/${encodeURIComponent(run.sourceSessionId)}`}>
            Open session evidence
          </a>
        ) : (
          <span>No captured session</span>
        )}
      </header>
      {page.isPending ? <p className="muted-copy">Loading evidence…</p> : null}
      {page.isError ? (
        <p className="page-error" role="alert">
          Evidence could not be loaded.
        </p>
      ) : null}
      {!page.isPending && !page.isError && page.events.length === 0 ? (
        <p className="muted-copy">
          No session events are attached to this run.
        </p>
      ) : null}
      {page.events.length > 0 ? (
        <ol className="comparison-evidence-list">
          {page.events.slice(0, 200).map((item) => (
            <li
              key={item.id}
              className={
                item.id === highlightedId ? 'is-divergence' : undefined
              }
            >
              <span>{item.sequence}</span>
              <strong>{item.type}</strong>
              <p>{eventPreview(item)}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

function eventPreview(item: StoredEvent): string {
  const payload = item.event.payload as Record<string, unknown>;
  const value = ['content', 'message', 'text', 'command', 'output']
    .map((key) => payload[key])
    .find((candidate): candidate is string => typeof candidate === 'string');
  return (value ?? 'No text exposed').replace(/\s+/gu, ' ').slice(0, 240);
}

function metricText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : 'not captured';
}
