import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from './api.js';

export function EvalsPage() {
  const cases = useQuery({
    queryKey: ['eval-cases'],
    queryFn: api.evalCases,
    staleTime: 5_000,
  });
  const [comparisonId, setComparisonId] = useState('');
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
                {comparison.data.runs.map((run) => (
                  <article key={run.id}>
                    <strong>{run.id.slice(0, 12)}…</strong>
                    <span>{run.status}</span>
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
                      {metricText(run.metrics?.diffFileCount)}
                    </small>
                    <small>
                      Tokens {metricText(run.metrics?.tokenCount)} · Cost{' '}
                      {metricText(run.metrics?.estimatedCostMicros)} μ$
                    </small>
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
                ))}
              </div>
            </div>
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

function metricText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : 'not captured';
}
