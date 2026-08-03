import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';

import { api, type SessionFilters } from './api.js';
import { formatDuration } from './forensics.js';

export function SessionsPage() {
  const [filters, setFilters] = useState<SessionFilters>({});
  const sessions = useQuery({
    queryKey: ['sessions', filters],
    queryFn: () => api.sessions(filters),
    staleTime: 5_000,
  });
  const scroll = useRef<HTMLDivElement>(null);
  const rows = sessions.data ?? [];
  // React Compiler deliberately skips this hook; TanStack Virtual owns its mutable measurements.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 104,
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  const update = (key: keyof SessionFilters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value || undefined }));

  return (
    <main id="main-content" className="sessions-page">
      <header className="sessions-intro">
        <div>
          <p className="eyebrow">Local forensic archive</p>
          <h1>Session case files</h1>
          <p>Observable evidence from Codex, encrypted on this machine.</p>
        </div>
        <div className="archive-count">
          <span>Indexed locally</span>
          <strong>{rows.length.toLocaleString()}</strong>
        </div>
      </header>
      <section className="session-filters" aria-label="Filter sessions">
        <label>
          Project
          <input
            value={filters.project ?? ''}
            onChange={(event) => update('project', event.target.value)}
            placeholder="Exact project name"
          />
        </label>
        <label>
          Model
          <input
            value={filters.model ?? ''}
            onChange={(event) => update('model', event.target.value)}
            placeholder="Exact model"
          />
        </label>
        <label>
          Result
          <select
            value={filters.result ?? ''}
            onChange={(event) => update('result', event.target.value)}
          >
            <option value="">Any result</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="interrupted">Interrupted</option>
          </select>
        </label>
        <label>
          Finding category
          <input
            value={filters.category ?? ''}
            onChange={(event) => update('category', event.target.value)}
            placeholder="Example: verification"
          />
        </label>
        <label>
          Capture mode
          <select
            value={filters.captureMode ?? ''}
            onChange={(event) => update('captureMode', event.target.value)}
          >
            <option value="">Any mode</option>
            <option value="full">Full</option>
            <option value="standard">Standard</option>
            <option value="partial">Partial</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      </section>
      {sessions.isPending ? (
        <div className="session-loading" role="status">
          Opening the encrypted session index…
        </div>
      ) : null}
      {sessions.isError ? (
        <div className="page-error" role="alert">
          <strong>The local session index could not be opened.</strong>
          <p>
            Check that the VibeTrace daemon is running, then reload this page.
          </p>
        </div>
      ) : null}
      {!sessions.isPending && !sessions.isError && rows.length === 0 ? (
        <div className="teaching-empty">
          <strong>No session matches these filters.</strong>
          <p>
            Clear a filter, or capture a Codex session to create the first case
            file.
          </p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <section
          className="session-index"
          aria-labelledby="session-index-title"
        >
          <div className="session-index-heading">
            <h2 id="session-index-title">Case index</h2>
            <span>Virtualized for up to 10,000 sessions</span>
          </div>
          <div className="session-list" ref={scroll}>
            <div
              className="session-list-space"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const session = rows[virtualRow.index];
                if (!session) return null;
                return (
                  <Link
                    className="session-row"
                    key={session.id}
                    params={{ sessionId: session.id }}
                    to="/sessions/$sessionId"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <span className="session-date">
                      {new Date(session.startedAt).toLocaleDateString([], {
                        month: 'short',
                        day: '2-digit',
                      })}
                    </span>
                    <span className="session-identity">
                      <strong>{session.title ?? session.displayName}</strong>
                      <small>
                        {session.displayName} ·{' '}
                        {session.model ?? session.source}
                      </small>
                    </span>
                    <span
                      className="session-result"
                      data-status={session.status}
                    >
                      {session.status}
                      <small>
                        {formatDuration(session.startedAt, session.endedAt)}
                      </small>
                    </span>
                    <span className="session-evidence">
                      {session.eventCount.toLocaleString()} events
                      <small>
                        {session.primaryFinding ??
                          `${session.findingCount} findings`}
                      </small>
                    </span>
                    <span className="capture-mark">{session.captureMode}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
