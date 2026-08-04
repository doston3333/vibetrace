import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  api,
  type Annotation,
  type Artifact,
  type CoverageDatum,
  type Finding,
  type SessionSummary,
  type SessionScorecard,
  type StoredEvent,
} from './api.js';
import { AiReviewPanel } from './AiReviewPanel.js';
import { Inspector } from './Inspector.js';
import {
  AnnotationsPanel,
  ApprovalsPanel,
  CausalGraph,
  CoveragePanel,
  ContextMap,
  DiffHistory,
  FindingsPanel,
  SessionOverview,
  ScorecardPanel,
} from './Panels.js';
import { Timeline } from './Timeline.js';
import {
  buildTimelineModel,
  matchesEvent,
  TIMELINE_LANES,
  type TimelineLane,
} from './forensics.js';

type WorkbenchView =
  | 'timeline'
  | 'diffs'
  | 'coverage'
  | 'scorecard'
  | 'approvals'
  | 'context'
  | 'causal'
  | 'findings'
  | 'annotations'
  | 'ai-review';

type NavIconName =
  | 'timeline'
  | 'ai'
  | 'diff'
  | 'coverage'
  | 'approval'
  | 'findings'
  | 'scorecard'
  | 'context'
  | 'causal'
  | 'annotation';

interface NavigationItem {
  readonly value: WorkbenchView;
  readonly label: string;
  readonly icon: NavIconName;
  readonly badge?: number;
}

interface NavigationGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

function NavIcon({ name }: { readonly name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    timeline: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <path d="M7 4v4M12 10v4M17 16v4" />
      </>
    ),
    ai: (
      <>
        <path d="M12 3v18M3 12h18" />
        <path d="m5 5 14 14M19 5 5 19" />
      </>
    ),
    diff: (
      <>
        <path d="m8 5-3 3 3 3M16 5l3 3-3 3M13 4l-2 16" />
      </>
    ),
    coverage: (
      <>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
      </>
    ),
    approval: (
      <>
        <path d="m5 12 4 4L19 6" />
        <path d="M4 4h16v16H4z" />
      </>
    ),
    findings: (
      <>
        <path d="M12 3 3 20h18L12 3Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    scorecard: (
      <>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
        <path d="M3 20h19" />
      </>
    ),
    context: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </>
    ),
    causal: (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="12" r="2" />
        <circle cx="6" cy="18" r="2" />
        <path d="m8 7 8 4M8 17l8-4" />
      </>
    ),
    annotation: (
      <>
        <path d="M5 4h14v16H5z" />
        <path d="M8 9h8M8 13h6" />
      </>
    ),
  };
  return (
    <svg
      className="nav-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

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
          <span className="brand-glyph" aria-hidden="true">
            V
          </span>
          <strong>VibeTrace</strong>
        </Link>
        <nav className="app-nav" aria-label="Primary navigation">
          <Link to="/">Sessions</Link>
          <Link to="/evals">Evaluation lab</Link>
        </nav>
        <div className="local-status">
          <span aria-hidden="true" />
          Encrypted locally
        </div>
      </header>
      <Outlet />
    </div>
  );
}

export interface ForensicWorkbenchProps {
  readonly session: SessionSummary;
  readonly events: readonly StoredEvent[];
  readonly artifacts: readonly Artifact[];
  readonly coverage: readonly CoverageDatum[];
  readonly findings: readonly Finding[];
  readonly scorecard?: SessionScorecard;
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
  scorecard,
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
  const navigation: readonly NavigationGroup[] = [
    {
      label: 'Review',
      items: [
        { value: 'timeline', label: 'Timeline', icon: 'timeline' },
        { value: 'ai-review', label: 'AI review', icon: 'ai' },
      ],
    },
    {
      label: 'Evidence',
      items: [
        { value: 'diffs', label: 'Diff history', icon: 'diff' },
        { value: 'coverage', label: 'Coverage', icon: 'coverage' },
        { value: 'approvals', label: 'Approvals', icon: 'approval' },
      ],
    },
    {
      label: 'Analysis',
      items: [
        {
          value: 'findings',
          label: 'Findings',
          icon: 'findings',
          badge: findings.length,
        },
        ...(scorecard
          ? [
              {
                value: 'scorecard' as const,
                label: 'Scorecard',
                icon: 'scorecard' as const,
              },
            ]
          : []),
        { value: 'context', label: 'Context map', icon: 'context' },
        { value: 'causal', label: 'Causal graph', icon: 'causal' },
      ],
    },
    {
      label: 'Record',
      items: [
        {
          value: 'annotations',
          label: 'Annotations',
          icon: 'annotation',
          badge: annotations.length,
        },
      ],
    },
  ];
  const currentView = navigation
    .flatMap((group) => group.items)
    .find((item) => item.value === view);

  return (
    <main id="main-content" className="workbench">
      <SessionOverview
        session={session}
        events={events}
        findings={findings}
        gaps={gaps}
        scorecard={scorecard}
      />
      <div className="case-mobile-context">
        <a href="/" className="case-back">
          Back to archive
        </a>
        <label>
          View
          <select
            value={view}
            onChange={(event) => setView(event.target.value as WorkbenchView)}
            aria-label="View case evidence"
          >
            {navigation.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                    {item.badge !== undefined ? ` (${item.badge})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <div className="workbench-layout">
        <aside className="case-rail" aria-label="Case navigation">
          <a href="/" className="case-back">
            Back to archive
          </a>
          <div className="case-rail-context">
            <span>Case</span>
            <strong>{session.title ?? session.displayName}</strong>
            <small>{events.length.toLocaleString()} observed events</small>
          </div>
          <nav aria-label="Session evidence views">
            {navigation.map((group) => (
              <div className="case-nav-group" key={group.label}>
                <p>{group.label}</p>
                {group.items.map((item) => (
                  <button
                    type="button"
                    aria-label={
                      item.badge !== undefined
                        ? `${item.label} ${item.badge}`
                        : item.label
                    }
                    aria-current={view === item.value ? 'page' : undefined}
                    key={item.value}
                    onClick={() => setView(item.value)}
                  >
                    <NavIcon name={item.icon} />
                    <span>{item.label}</span>
                    {item.badge !== undefined ? (
                      <b className="nav-badge">{item.badge}</b>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <section
          className="workbench-content"
          aria-label={`${currentView?.label ?? 'Case'} evidence`}
        >
          {view === 'timeline' ? (
            <>
              <section
                className="timeline-controls"
                aria-label="Filter timeline"
              >
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
          {view === 'scorecard' && scorecard ? (
            <ScorecardPanel scorecard={scorecard} onSelect={selectEvidence} />
          ) : null}
          {view === 'approvals' ? (
            <ApprovalsPanel events={events} onSelect={selectEvidence} />
          ) : null}
          {view === 'context' ? (
            <ContextMap events={events} onSelect={selectEvidence} />
          ) : null}
          {view === 'causal' ? (
            <CausalGraph
              events={events}
              findings={findings}
              onSelect={selectEvidence}
            />
          ) : null}
          {view === 'findings' ? (
            <FindingsPanel
              events={events}
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
          {view === 'ai-review' ? (
            <AiReviewPanel sessionId={session.id} />
          ) : null}
        </section>
      </div>
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
  const scorecard = useQuery({
    queryKey: ['scorecard', sessionId],
    queryFn: () => api.scorecard(sessionId),
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
  useEffect(() => {
    const stream = new EventSource(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`,
    );
    stream.onmessage = () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['events', sessionId] }),
        queryClient.invalidateQueries({ queryKey: ['coverage', sessionId] }),
        queryClient.invalidateQueries({ queryKey: ['findings', sessionId] }),
        queryClient.invalidateQueries({ queryKey: ['scorecard', sessionId] }),
      ]);
    };
    return () => stream.close();
  }, [queryClient, sessionId]);

  if (
    session.isPending ||
    eventPages.isPending ||
    artifacts.isPending ||
    coverage.isPending ||
    findings.isPending ||
    scorecard.isPending ||
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
    scorecard.isError ||
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
      scorecard={scorecard.data}
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
