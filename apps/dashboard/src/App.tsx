import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import {
  api,
  type Annotation,
  type Artifact,
  type CoverageDatum,
  type Finding,
  type SessionSummary,
  type StoredEvent,
} from './api.js';
import { Inspector } from './Inspector.js';
import {
  AnnotationsPanel,
  CoveragePanel,
  DiffHistory,
  FindingsPanel,
  SessionOverview,
} from './Panels.js';
import { Timeline } from './Timeline.js';
import {
  buildTimelineModel,
  matchesEvent,
  TIMELINE_LANES,
  type TimelineLane,
} from './forensics.js';

export function AppShell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to case evidence
      </a>
      <header className="masthead">
        <Link
          className="wordmark"
          to="/"
          aria-label="VibeTrace session archive"
        >
          <span>VIBE</span>
          <strong>TRACE</strong>
        </Link>
        <p>Local evidence recorder · deterministic analysis</p>
        <div className="local-status">
          <span aria-hidden="true" />
          Encrypted locally
        </div>
      </header>
      <Outlet />
    </div>
  );
}

type WorkbenchView =
  'timeline' | 'diffs' | 'coverage' | 'findings' | 'annotations';

export interface ForensicWorkbenchProps {
  readonly session: SessionSummary;
  readonly events: readonly StoredEvent[];
  readonly artifacts: readonly Artifact[];
  readonly coverage: readonly CoverageDatum[];
  readonly findings: readonly Finding[];
  readonly annotations: readonly Annotation[];
  readonly loadingMore?: boolean;
  readonly savingAnnotation?: boolean;
  readonly savingFindingReview?: string;
  readonly onSaveAnnotation: (value: {
    label: string;
    note?: string;
  }) => Promise<void>;
  readonly onReviewFinding: (
    id: string,
    input: {
      decision?: 'open' | 'confirmed' | 'rejected';
      categoryOverride?: string;
    },
  ) => Promise<void>;
}

/** The facts-first forensic workbench; no source HTML is ever interpreted. */
export function ForensicWorkbench({
  session,
  events,
  artifacts,
  coverage,
  findings,
  annotations,
  loadingMore = false,
  savingAnnotation = false,
  savingFindingReview,
  onSaveAnnotation,
  onReviewFinding,
}: ForensicWorkbenchProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<WorkbenchView>('timeline');
  const [search, setSearch] = useState('');
  const [lane, setLane] = useState<TimelineLane | 'all'>('all');
  const [status, setStatus] = useState<'all' | 'failed' | 'gaps'>('all');
  const model = useMemo(() => buildTimelineModel(events), [events]);
  const filtered = useMemo(
    () => model.filter((item) => matchesEvent(item, { search, lane, status })),
    [lane, model, search, status],
  );
  const selected =
    events.find((event) => event.id === selectedId) ?? filtered[0]?.stored;
  const gaps = events.filter((event) => event.type === 'capture.gap').length;
  const selectEvidence = (id: string) => {
    setSelectedId(id);
    setView('timeline');
  };

  return (
    <main id="main-content" className="workbench">
      <SessionOverview
        session={session}
        events={events}
        findings={findings}
        gaps={gaps}
      />
      <nav className="case-nav" aria-label="Session evidence views">
        {(
          [
            ['timeline', 'Timeline'],
            ['diffs', 'Diff history'],
            ['coverage', 'Coverage'],
            ['findings', `Findings ${findings.length}`],
            ['annotations', `Annotations ${annotations.length}`],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            aria-current={view === value ? 'page' : undefined}
            key={value}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {view === 'timeline' ? (
        <>
          <section className="timeline-controls" aria-label="Filter timeline">
            <label className="search-control">
              Search observable evidence
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Prompt, command, file, or event type"
              />
            </label>
            <label>
              Lane
              <select
                value={lane}
                onChange={(event) =>
                  setLane(event.target.value as TimelineLane | 'all')
                }
              >
                <option value="all">All lanes</option>
                {TIMELINE_LANES.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Evidence state
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as typeof status)
                }
              >
                <option value="all">All states</option>
                <option value="failed">Failures</option>
                <option value="gaps">Capture gaps</option>
              </select>
            </label>
            <span className="fact-key">
              <i /> fact <i /> failure <i /> gap
            </span>
          </section>
          {loadingMore ? (
            <p className="progress-note" role="status">
              Reconstructing the remaining event pages…
            </p>
          ) : null}
          <div className="evidence-workspace">
            <Timeline
              items={filtered}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
            <Inspector
              sessionId={session.id}
              selected={selected}
              events={events}
              artifacts={artifacts}
              findings={findings}
              onSelect={setSelectedId}
            />
          </div>
        </>
      ) : null}
      {view === 'diffs' ? (
        <DiffHistory
          events={events}
          artifacts={artifacts}
          findings={findings}
          onSelect={selectEvidence}
        />
      ) : null}
      {view === 'coverage' ? (
        <CoveragePanel coverage={coverage} onSelect={selectEvidence} />
      ) : null}
      {view === 'findings' ? (
        <FindingsPanel
          findings={findings}
          onSelect={selectEvidence}
          onReview={onReviewFinding}
          savingReview={savingFindingReview}
        />
      ) : null}
      {view === 'annotations' ? (
        <AnnotationsPanel
          annotations={annotations}
          targetId={session.id}
          saving={savingAnnotation}
          onSave={onSaveAnnotation}
        />
      ) : null}
    </main>
  );
}

export function SessionPage() {
  const { sessionId } = useParams({ from: '/sessions/$sessionId' });
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId),
  });
  const eventPages = useInfiniteQuery({
    queryKey: ['events', sessionId],
    queryFn: ({ pageParam }) => api.events(sessionId, {}, pageParam),
    initialPageParam: undefined as
      { afterSequence: number; afterId: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const artifacts = useQuery({
    queryKey: ['artifacts', sessionId],
    queryFn: () => api.artifacts(sessionId),
  });
  const coverage = useQuery({
    queryKey: ['coverage', sessionId],
    queryFn: () => api.coverage(sessionId),
  });
  const findings = useQuery({
    queryKey: ['findings', sessionId],
    queryFn: () => api.findings(sessionId),
  });
  const annotations = useQuery({
    queryKey: ['annotations', 'session', sessionId],
    queryFn: () => api.annotations('session', sessionId),
  });
  const saveAnnotation = useMutation({
    mutationFn: (value: { label: string; note?: string }) =>
      api.createAnnotation({
        targetType: 'session',
        targetId: sessionId,
        ...value,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['annotations', 'session', sessionId],
      }),
  });
  const reviewFinding = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: {
        decision?: 'open' | 'confirmed' | 'rejected';
        categoryOverride?: string;
      };
    }) => api.reviewFinding(id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['findings', sessionId] }),
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = eventPages;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  if (
    session.isPending ||
    eventPages.isPending ||
    artifacts.isPending ||
    coverage.isPending ||
    findings.isPending ||
    annotations.isPending
  )
    return (
      <main id="main-content" className="case-loading" role="status">
        <span>Opening encrypted evidence</span>
        <strong>Reconstructing the session chronology…</strong>
      </main>
    );
  if (
    session.isError ||
    eventPages.isError ||
    artifacts.isError ||
    coverage.isError ||
    findings.isError ||
    annotations.isError
  )
    return (
      <main id="main-content" className="page-error" role="alert">
        <strong>This local case file could not be reconstructed.</strong>
        <p>Check the daemon and encryption key, then reload the session.</p>
        <Link to="/">Return to session archive</Link>
      </main>
    );

  return (
    <ForensicWorkbench
      session={session.data}
      events={eventPages.data.pages.flatMap((page) => page.events)}
      artifacts={artifacts.data}
      coverage={coverage.data}
      findings={findings.data}
      annotations={annotations.data}
      loadingMore={eventPages.hasNextPage || eventPages.isFetchingNextPage}
      savingAnnotation={saveAnnotation.isPending}
      savingFindingReview={
        reviewFinding.isPending ? reviewFinding.variables?.id : undefined
      }
      onSaveAnnotation={async (value) => {
        await saveAnnotation.mutateAsync(value);
      }}
      onReviewFinding={async (id, input) => {
        await reviewFinding.mutateAsync({ id, input });
      }}
    />
  );
}
