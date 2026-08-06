import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { api, type Artifact, type Finding, type StoredEvent } from './api.js';
import {
  eventDetail,
  eventDiff,
  eventTitle,
  formatClock,
  redactionPreview,
  relatedEvents,
  safeDisplayText,
} from './forensics.js';

const TABS = [
  'friendly',
  'raw',
  'provenance',
  'related',
  'diffs',
  'redaction',
] as const;
type InspectorTab = (typeof TABS)[number];
const RAW_PREVIEW_LIMIT = 50_000;

interface InspectorProps {
  readonly sessionId: string;
  readonly selected?: StoredEvent;
  readonly events: readonly StoredEvent[];
  readonly artifacts: readonly Artifact[];
  readonly findings: readonly Finding[];
  readonly onSelect: (id: string) => void;
}

function TextDiff({ text }: { readonly text: string }) {
  const safe = safeDisplayText(text);
  const lines = safe.split('\n').slice(0, 3_000);
  const truncated =
    safe.length < text.length || safe.split('\n').length > 3_000;
  return (
    <div
      className="text-diff"
      role="region"
      aria-label="Text-safe diff preview"
    >
      <pre>
        {lines.map((line, index) => (
          <span
            className={
              line.startsWith('+')
                ? 'diff-add'
                : line.startsWith('-')
                  ? 'diff-remove'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : undefined
            }
            key={`${index}-${line.slice(0, 16)}`}
          >
            <b aria-hidden="true">{String(index + 1).padStart(4, ' ')}</b>
            {line || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
      {truncated ? (
        <p className="payload-limit">
          Preview stopped at the safe display limit.
        </p>
      ) : null}
    </div>
  );
}

function JsonPreview({
  value,
  label,
}: {
  readonly value: unknown;
  readonly label: string;
}) {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  const safe = safeDisplayText(serialized, RAW_PREVIEW_LIMIT);
  const truncated = safe.length < serialized.length;
  return (
    <>
      <pre className="json-view" aria-label={label}>
        {safe}
      </pre>
      {truncated ? (
        <p className="payload-limit" role="status">
          Preview stopped at the safe display limit. The preserved source is
          unchanged.
        </p>
      ) : null}
    </>
  );
}

function CopyableId({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="copyable-id">
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
        <button
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
          onClick={() => void navigator.clipboard?.writeText(value)}
        >
          Copy
        </button>
      </dd>
    </div>
  );
}

function ArtifactText({
  sessionId,
  artifact,
}: {
  readonly sessionId: string;
  readonly artifact: Artifact;
}) {
  const content = useQuery({
    queryKey: ['artifact-content', sessionId, artifact.id],
    queryFn: () => api.artifactText(sessionId, artifact.id),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (content.isPending)
    return <div className="payload-skeleton">Decrypting artifact locally…</div>;
  if (content.isError)
    return (
      <p className="inline-error">
        Artifact could not be decrypted. Check the local key and retry.
      </p>
    );
  return <TextDiff text={content.data} />;
}

/** Progressive, text-only inspection of one canonical event and its evidence. */
export function Inspector({
  sessionId,
  selected,
  events,
  artifacts,
  findings,
  onSelect,
}: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('friendly');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!selected)
    return (
      <aside
        className="inspector inspector-empty"
        aria-labelledby="inspector-heading"
      >
        <p className="eyebrow">Event inspector</p>
        <h2 id="inspector-heading">Select observable evidence</h2>
        <p>
          Choose an event from the chronology. Facts, linked findings, and safe
          text previews appear here without interpreting source HTML.
        </p>
      </aside>
    );
  const related = relatedEvents(selected, events);
  const linkedArtifacts = artifacts.filter(
    (artifact) => artifact.eventId === selected.id,
  );
  const linkedFindings = findings.filter(
    (finding) =>
      finding.evidenceEventIds.includes(selected.id) ||
      finding.counterevidenceEventIds.includes(selected.id),
  );
  const inlineDiff = eventDiff(selected.event);
  const tabIndex = TABS.indexOf(tab);

  return (
    <aside className="inspector" aria-labelledby="inspector-heading">
      <div className="inspector-title">
        <div>
          <p className="eyebrow">Event inspector · #{selected.sequence}</p>
          <h2 id="inspector-heading">{eventTitle(selected.event)}</h2>
        </div>
        <time dateTime={selected.timestamp}>
          {formatClock(selected.timestamp)}
        </time>
      </div>
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="Event evidence views"
        onKeyDown={(event) => {
          if (
            event.key !== 'ArrowLeft' &&
            event.key !== 'ArrowRight' &&
            event.key !== 'Home' &&
            event.key !== 'End'
          )
            return;
          event.preventDefault();
          const nextIndex =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? TABS.length - 1
                : (tabIndex +
                    (event.key === 'ArrowRight' ? 1 : -1) +
                    TABS.length) %
                  TABS.length;
          setTab(TABS[nextIndex]!);
          tabs.current[nextIndex]?.focus();
        }}
      >
        {TABS.map((value) => (
          <button
            type="button"
            role="tab"
            id={`event-tab-${value}`}
            aria-controls="event-tabpanel"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            key={value}
            ref={(element) => {
              tabs.current[TABS.indexOf(value)] = element;
            }}
            onClick={() => setTab(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <div
        className="inspector-body"
        id="event-tabpanel"
        role="tabpanel"
        aria-labelledby={`event-tab-${tab}`}
      >
        {tab === 'friendly' ? (
          <div className="friendly-view">
            <p className="event-lede">
              {eventDetail(selected.event) ||
                'No friendly preview is available.'}
            </p>
            <dl className="fact-grid">
              <CopyableId label="Canonical event ID" value={selected.id} />
              <CopyableId label="Raw event ID" value={selected.rawEventId} />
              <div>
                <dt>Canonical type</dt>
                <dd>{selected.type}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selected.event.source}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selected.event.status ?? 'observed fact'}</dd>
              </div>
              <div>
                <dt>Adapter</dt>
                <dd>{selected.event.provenance.adapter}</dd>
              </div>
            </dl>
            {linkedFindings.length > 0 ? (
              <section className="linked-findings" aria-label="Linked findings">
                <h3>Evidence-linked findings</h3>
                {linkedFindings.map((finding) => (
                  <p key={finding.id}>
                    <strong>{finding.title}</strong> ·{' '}
                    {finding.findingKind === 'capture_limitation'
                      ? 'capture limitation'
                      : 'problem'}{' '}
                    · {finding.severity}
                    {finding.confidence !== undefined
                      ? ` · ${Math.round(finding.confidence * 100)}% confidence`
                      : ''}
                  </p>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
        {tab === 'raw' ? (
          <JsonPreview
            value={selected.event.rawPayload}
            label="Safe raw event preview"
          />
        ) : null}
        {tab === 'provenance' ? (
          <JsonPreview
            value={selected.event.provenance}
            label="Safe provenance preview"
          />
        ) : null}
        {tab === 'related' ? (
          <div className="related-list">
            {related.length > 0 ? (
              related.map((event) => (
                <button
                  type="button"
                  key={event.id}
                  onClick={() => onSelect(event.id)}
                >
                  <span>#{event.sequence}</span>
                  <strong>{eventTitle(event.event)}</strong>
                  <small>{event.type}</small>
                </button>
              ))
            ) : (
              <p>No parent, child, or matching source event was observed.</p>
            )}
          </div>
        ) : null}
        {tab === 'diffs' ? (
          <div className="diff-stack">
            {inlineDiff ? <TextDiff text={inlineDiff} /> : null}
            {linkedArtifacts.map((artifact) => (
              <section key={artifact.id}>
                <h3>{artifact.kind.replaceAll('-', ' ')}</h3>
                <ArtifactText sessionId={sessionId} artifact={artifact} />
              </section>
            ))}
            {!inlineDiff && linkedArtifacts.length === 0 ? (
              <p>No diff or output artifact is attached to this event.</p>
            ) : null}
          </div>
        ) : null}
        {tab === 'redaction' ? (
          <>
            <p className="tab-note">
              Preview only. The encrypted local source remains unchanged.
            </p>
            <JsonPreview
              value={redactionPreview(selected.event)}
              label="Safe redaction preview"
            />
          </>
        ) : null}
      </div>
    </aside>
  );
}
