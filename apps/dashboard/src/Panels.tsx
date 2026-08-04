import { useState, type FormEvent } from 'react';

import type {
  Annotation,
  Artifact,
  CoverageDatum,
  Finding,
  SessionSummary,
  SessionScorecard,
  StoredEvent,
} from './api.js';
import { eventDetail, eventTitle, formatDuration } from './forensics.js';

function aiFindingLabel(finding: Finding): string {
  if (finding.ruleId !== 'ai-analyzer') return 'Deterministic finding';
  const provider =
    finding.analyzerProvider === 'direct-api'
      ? 'Direct API'
      : finding.analyzerProvider === 'codex'
        ? 'Codex'
        : 'AI';
  return `${provider} hypothesis${finding.analyzerModel ? ` · ${finding.analyzerModel}` : ''} · review required`;
}

export function SessionOverview({
  session,
  events,
  findings,
  gaps,
  scorecard,
}: {
  readonly session: SessionSummary;
  readonly events: readonly StoredEvent[];
  readonly findings: readonly Finding[];
  readonly gaps: number;
  readonly scorecard?: SessionScorecard;
}) {
  const failed = events.filter(
    (item) =>
      item.event.status === 'failed' ||
      (typeof (item.event.payload as { exitCode?: unknown }).exitCode ===
        'number' &&
        (item.event.payload as { exitCode: number }).exitCode !== 0),
  ).length;
  return (
    <section className="session-overview" aria-labelledby="session-title">
      <div className="case-heading">
        <div>
          <p className="eyebrow">
            Case file · {session.source} · {session.captureMode} capture
          </p>
          <h1 id="session-title">{session.title ?? session.displayName}</h1>
          <p>
            {session.model ?? 'Model not exposed'} ·{' '}
            {formatDuration(session.startedAt, session.endedAt)} ·{' '}
            {new Date(session.startedAt).toLocaleString()}
          </p>
        </div>
        <div className="outcome-stamp" data-status={session.status}>
          <span>Observed result</span>
          <strong>{session.status.replaceAll('_', ' ')}</strong>
        </div>
      </div>
      <dl className="evidence-totals">
        <div>
          <dt>Events</dt>
          <dd>
            {Math.max(session.eventCount, events.length).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Failures</dt>
          <dd>{failed.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Capture gaps</dt>
          <dd>{gaps.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>
            {Math.max(session.findingCount, findings.length).toLocaleString()}
          </dd>
        </div>
      </dl>
      {findings[0] ? (
        <div className="primary-hypothesis">
          <span>
            {findings[0].ruleId === 'ai-analyzer'
              ? `Primary ${aiFindingLabel(findings[0])}`
              : 'Primary deterministic finding'}
          </span>
          <strong>{findings[0].title}</strong>
          <p>{findings[0].explanation}</p>
        </div>
      ) : (
        <div className="primary-hypothesis is-empty">
          <span>Analysis status</span>
          <strong>No deterministic finding has been persisted yet.</strong>
          <p>
            The timeline remains facts-first; absence of a finding is not a
            quality claim.
          </p>
        </div>
      )}
      {scorecard ? (
        <section
          className="overview-scorecard"
          aria-label="Independent scorecard dimensions"
        >
          <div>
            <span className="eyebrow">Independent scorecard dimensions</span>
            <small>
              Not a universal quality score · v{scorecard.schemaVersion}
            </small>
          </div>
          <div className="overview-scorecard-grid">
            {scorecard.dimensions.map((dimension) => (
              <div key={dimension.id}>
                <span>{dimension.label}</span>
                <strong>
                  {dimension.score === null
                    ? 'Unknown'
                    : `${dimension.score}/100`}
                </strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

export function CoveragePanel({
  coverage,
  onSelect,
}: {
  readonly coverage: readonly CoverageDatum[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <section className="panel-page" aria-labelledby="coverage-title">
      <header>
        <p className="eyebrow">Observable completeness</p>
        <h2 id="coverage-title">Capture coverage</h2>
        <p>
          Missing evidence is shown explicitly. Unknown does not mean absent.
        </p>
      </header>
      <div className="coverage-ledger">
        {coverage.map((item) => (
          <article key={item.dataClass} data-state={item.state}>
            <div className="coverage-status">
              <span aria-hidden="true" />
              <strong>{item.dataClass}</strong>
              <em>{item.state}</em>
            </div>
            <p>
              {item.sources.length > 0
                ? `Observed from ${item.sources.join(', ')}.`
                : 'No canonical source event was observed.'}
            </p>
            {item.gaps.map((gap) => (
              <button
                key={gap.eventId}
                type="button"
                onClick={() => onSelect(gap.eventId)}
              >
                <span>{gap.adapter}</span>
                {gap.reason}
              </button>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

export function ScorecardPanel({
  scorecard,
  onSelect,
}: {
  readonly scorecard: SessionScorecard;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <section
      className="panel-page scorecard-page"
      aria-labelledby="scorecard-title"
    >
      <header>
        <p className="eyebrow">
          Transparent dimensions · v{scorecard.schemaVersion}
        </p>
        <h2 id="scorecard-title">Session scorecard</h2>
        <p>
          Independent evidence dimensions, not a universal quality score. A
          blank value means the required observable signal was not captured.
        </p>
      </header>
      <div className="scorecard-grid">
        {scorecard.dimensions.map((item) => (
          <article key={item.id} className="scorecard-card">
            <div className="scorecard-card-heading">
              <h3>{item.label}</h3>
              <span data-confidence={item.confidence}>{item.confidence}</span>
            </div>
            <strong className="scorecard-value">
              {item.score === null ? 'Unknown' : `${item.score}/100`}
            </strong>
            <p>{item.calculation}</p>
            {item.evidenceEventIds.length > 0 ? (
              <div
                className="scorecard-evidence"
                aria-label={`${item.label} evidence`}
              >
                {item.evidenceEventIds.map((id) => (
                  <button type="button" key={id} onClick={() => onSelect(id)}>
                    Evidence {id.slice(0, 8)}
                  </button>
                ))}
              </div>
            ) : (
              <span className="scorecard-no-evidence">No linked evidence</span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export function ApprovalsPanel({
  events,
  onSelect,
}: {
  readonly events: readonly StoredEvent[];
  readonly onSelect: (id: string) => void;
}) {
  const approvals = events.filter(
    (item) =>
      item.event.type === 'permission.requested' ||
      item.event.type === 'permission.resolved' ||
      item.event.status === 'declined',
  );
  return (
    <section
      className="panel-page approvals-page"
      aria-labelledby="approvals-title"
    >
      <header>
        <p className="eyebrow">Scoped safety evidence</p>
        <h2 id="approvals-title">Approvals</h2>
        <p>
          Requests and observed decisions are shown as facts. An absent
          resolution is a capture gap, never an assumed approval. Command and
          file scope are displayed when the source exposes them; this ledger
          never infers approval from a missing response.
        </p>
      </header>
      {approvals.length === 0 ? (
        <p className="teaching-empty">No approval activity was captured.</p>
      ) : (
        <div className="approval-ledger">
          {approvals.map((item) =>
            (() => {
              const payload = item.event.payload as Record<string, unknown>;
              const scope = [payload.command, payload.path]
                .filter((value): value is string => typeof value === 'string')
                .join(' · ');
              return (
                <button
                  type="button"
                  key={item.id}
                  className="approval-row"
                  onClick={() => onSelect(item.id)}
                >
                  <span>{item.event.type.replaceAll('.', ' ')}</span>
                  <strong>
                    {String(
                      (item.event.payload as Record<string, unknown>)
                        .requestId ??
                        item.event.toolName ??
                        'scoped request',
                    )}
                  </strong>
                  <em>{item.event.status ?? 'observed'}</em>
                  <small>{scope || eventDetail(item.event)}</small>
                </button>
              );
            })(),
          )}
        </div>
      )}
    </section>
  );
}

function payloadText(event: StoredEvent, key: string): string | undefined {
  const value = (event.event.payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Show observed context inputs without implying that repository presence meant model awareness. */
export function ContextMap({
  events,
  onSelect,
}: {
  readonly events: readonly StoredEvent[];
  readonly onSelect: (id: string) => void;
}) {
  const instructions = events.filter((item) =>
    ['instruction.loaded', 'skill.loaded'].includes(item.type),
  );
  const read = events.filter((item) => item.type === 'file.read');
  const changed = events.filter((item) => item.type === 'file.changed');
  const compactions = events.filter((item) =>
    item.type.startsWith('context.compaction'),
  );
  const subagents = events.filter((item) => item.type.startsWith('subagent.'));
  const group = (
    title: string,
    note: string,
    items: readonly StoredEvent[],
  ) => (
    <article className="context-card" key={title}>
      <header>
        <strong>{title}</strong>
        <span>{items.length.toLocaleString()}</span>
      </header>
      <p>{note}</p>
      <ul>
        {items.slice(0, 40).map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onSelect(item.id)}>
              <span>#{item.sequence}</span>
              {payloadText(item, 'name') ??
                payloadText(item, 'path') ??
                payloadText(item, 'subagentId') ??
                item.type}
            </button>
          </li>
        ))}
      </ul>
      {items.length > 40 ? (
        <small>Showing the first 40 observed entries.</small>
      ) : null}
    </article>
  );
  return (
    <section className="panel-page" aria-labelledby="context-map-title">
      <header>
        <p className="eyebrow">Observed context</p>
        <h2 id="context-map-title">Context map</h2>
        <p>
          These are source events that were observed or loaded. Presence in the
          repository alone is never treated as model awareness.
        </p>
      </header>
      <div className="context-grid">
        {group(
          'Instructions and skills',
          'Loaded by the source adapter.',
          instructions,
        )}
        {group(
          'Files read',
          'Read events observed before or during the task.',
          read,
        )}
        {group(
          'Files changed',
          'Changed-file observations, not authorship claims.',
          changed,
        )}
        {group(
          'Compaction boundaries',
          'Context lifecycle events observed by the adapter.',
          compactions,
        )}
        {group(
          'Subagent activity',
          'Subagent lifecycle events exposed by the source.',
          subagents,
        )}
      </div>
    </section>
  );
}

/** Render a conservative evidence chain; every edge is deterministic or explicitly marked as a finding. */
export function CausalGraph({
  events,
  findings,
  onSelect,
}: {
  readonly events: readonly StoredEvent[];
  readonly findings: readonly Finding[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <section className="panel-page" aria-labelledby="causal-graph-title">
      <header>
        <p className="eyebrow">Evidence relationships</p>
        <h2 id="causal-graph-title">Causal evidence graph</h2>
        <p>
          Edges are deterministic links between captured events and findings;
          they are not claims about hidden reasoning.
        </p>
      </header>
      {findings.length === 0 ? (
        <div className="teaching-empty">
          <strong>No evidence-linked chain yet.</strong>
          <p>Run deterministic analysis or review the timeline manually.</p>
        </div>
      ) : (
        <div className="causal-graph" role="list">
          {findings.map((finding) => {
            const evidence = finding.evidenceEventIds
              .map((id) => events.find((event) => event.id === id))
              .filter((event): event is StoredEvent => event !== undefined);
            const first = evidence[0];
            const last = evidence.at(-1);
            return (
              <article
                className="causal-chain"
                key={finding.id}
                role="listitem"
              >
                <button
                  type="button"
                  onClick={() => first && onSelect(first.id)}
                >
                  <span>Observed evidence</span>
                  <strong>
                    {first ? eventTitle(first.event) : 'Unavailable event'}
                  </strong>
                </button>
                <span className="causal-arrow" aria-hidden="true">
                  ↓
                </span>
                <div className="causal-finding">
                  <span>{aiFindingLabel(finding)}</span>
                  <strong>{finding.title}</strong>
                  <p>{finding.explanation}</p>
                </div>
                <span className="causal-arrow" aria-hidden="true">
                  ↓
                </span>
                <button type="button" onClick={() => last && onSelect(last.id)}>
                  <span>Related terminal evidence</span>
                  <strong>
                    {last ? eventTitle(last.event) : 'No linked terminal event'}
                  </strong>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function FindingsPanel({
  findings,
  onSelect,
  onReview,
  savingReview,
}: {
  readonly findings: readonly Finding[];
  readonly onSelect: (id: string) => void;
  readonly onReview: (
    id: string,
    input: {
      decision?: 'open' | 'confirmed' | 'rejected';
      categoryOverride?: string;
    },
  ) => Promise<void>;
  readonly savingReview?: string;
}) {
  return (
    <section className="panel-page" aria-labelledby="findings-title">
      <header>
        <p className="eyebrow">
          Deterministic analysis and optional hypotheses
        </p>
        <h2 id="findings-title">Evidence-linked findings</h2>
        <p>Findings remain separate from source facts and user labels.</p>
      </header>
      <div className="finding-list">
        {findings.length > 0 ? (
          findings.map((finding, index) => (
            <article
              key={finding.id}
              data-severity={finding.severity}
              data-kind={
                finding.ruleId === 'ai-analyzer'
                  ? 'ai-hypothesis'
                  : 'deterministic'
              }
            >
              <span className="finding-number">
                F-{String(index + 1).padStart(2, '0')}
              </span>
              <div>
                <p className="finding-meta">
                  {aiFindingLabel(finding)} · {finding.category} ·{' '}
                  {finding.severity} · {finding.ruleId}
                </p>
                <h3>{finding.title}</h3>
                <p>{finding.explanation}</p>
                <p className="recommendation">
                  <strong>Recommendation:</strong> {finding.recommendation}
                </p>
                <div className="evidence-links">
                  {finding.evidenceEventIds.map((eventId) => (
                    <button
                      type="button"
                      key={eventId}
                      onClick={() => onSelect(eventId)}
                    >
                      View evidence
                    </button>
                  ))}
                </div>
                <FindingReviewControls
                  finding={finding}
                  saving={savingReview === finding.id}
                  onReview={onReview}
                />
              </div>
            </article>
          ))
        ) : (
          <div className="teaching-empty">
            <strong>No findings yet.</strong>
            <p>
              No deterministic rule matched the captured evidence. Observable
              events remain available for manual review.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function FindingReviewControls({
  finding,
  saving,
  onReview,
}: {
  readonly finding: Finding;
  readonly saving: boolean;
  readonly onReview: (
    id: string,
    input: {
      decision?: 'open' | 'confirmed' | 'rejected';
      categoryOverride?: string;
    },
  ) => Promise<void>;
}) {
  const [category, setCategory] = useState(
    finding.review?.categoryOverride ?? finding.category,
  );
  return (
    <div className="finding-review" aria-label={`Review ${finding.title}`}>
      <span>
        Human review · <strong>{finding.state}</strong>
      </span>
      <div>
        {(['confirmed', 'rejected', 'open'] as const).map((decision) => (
          <button
            type="button"
            key={decision}
            disabled={saving}
            aria-pressed={finding.state === decision}
            onClick={() => onReview(finding.id, { decision })}
          >
            {decision === 'open' ? 'Reopen' : decision}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onReview(finding.id, { categoryOverride: category.trim() });
        }}
      >
        <label>
          Review category
          <input
            required
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          />
        </label>
        <button type="submit" disabled={saving || !category.trim()}>
          Save category
        </button>
      </form>
    </div>
  );
}

export function DiffHistory({
  events,
  artifacts,
  findings,
  onSelect,
}: {
  readonly events: readonly StoredEvent[];
  readonly artifacts: readonly Artifact[];
  readonly findings: readonly Finding[];
  readonly onSelect: (id: string) => void;
}) {
  const changes = events.filter((item) =>
    ['file.changed', 'git.snapshot'].includes(item.type),
  );
  return (
    <section className="panel-page" aria-labelledby="diff-title">
      <header>
        <p className="eyebrow">Repository reconstruction</p>
        <h2 id="diff-title">Diff history</h2>
        <p>
          Snapshots are cumulative observations, not automatic tool attribution.
        </p>
      </header>
      <div className="diff-history">
        {changes.map((item) => {
          const linked = artifacts.filter(
            (artifact) => artifact.eventId === item.id,
          );
          const findingCount = findings.filter((finding) =>
            finding.evidenceEventIds.includes(item.id),
          ).length;
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
            >
              <span className="diff-sequence">#{item.sequence}</span>
              <span>
                <strong>{eventTitle(item.event)}</strong>
                <small>{eventDetail(item.event) || item.type}</small>
              </span>
              <em>
                {linked.length} artifacts · {findingCount} findings
              </em>
            </button>
          );
        })}
        {changes.length === 0 ? (
          <div className="teaching-empty">
            <strong>No repository change was observed.</strong>
            <p>
              Check capture coverage to distinguish an unchanged repository from
              missing evidence.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AnnotationsPanel({
  annotations,
  targetId,
  saving,
  onSave,
}: {
  readonly annotations: readonly Annotation[];
  readonly targetId: string;
  readonly saving: boolean;
  readonly onSave: (value: { label: string; note?: string }) => Promise<void>;
}) {
  const [category, setCategory] = useState('outcome');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    await onSave({
      label: `${category}:${label.trim()}`,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setLabel('');
    setNote('');
    setSaved(true);
  };
  return (
    <section
      className="panel-page annotations-page"
      aria-labelledby="annotations-title"
    >
      <header>
        <p className="eyebrow">Human review</p>
        <h2 id="annotations-title">Annotations</h2>
        <p>User labels remain distinct from facts and analyzer findings.</p>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Label type
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="outcome">Outcome</option>
            <option value="primary-cause">Primary cause</option>
            <option value="finding-validity">Finding validity</option>
            <option value="note">Review note</option>
          </select>
        </label>
        <label>
          Label
          <input
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Example: partial failure"
          />
        </label>
        <label className="note-field">
          Evidence note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Explain what supports this label."
          />
        </label>
        <button
          className="ink-button"
          type="submit"
          disabled={saving || !label.trim()}
        >
          {saving ? 'Saving annotation…' : 'Save annotation'}
        </button>
        {saved ? (
          <p role="status">Annotation saved to this local case file.</p>
        ) : null}
      </form>
      <div className="annotation-ledger">
        {annotations
          .filter((annotation) => annotation.targetId === targetId)
          .map((annotation) => (
            <article key={annotation.id}>
              <span>User label</span>
              <strong>{annotation.label ?? 'note'}</strong>
              {annotation.note ? <p>{annotation.note}</p> : null}
              <time dateTime={annotation.createdAt}>
                {new Date(annotation.createdAt).toLocaleString()}
              </time>
            </article>
          ))}
      </div>
    </section>
  );
}
