import { staticDashboardTrace } from '@vibetrace/test-fixtures/static-dashboard';
import { useState } from 'react';

const PAGE_SIZE = 25;

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Static Milestone-0 session inspector backed by a deterministic local fixture. */
export function App() {
  const [page, setPage] = useState(0);
  const [selectedSequence, setSelectedSequence] = useState(1);
  const eventCount = staticDashboardTrace.events.length;
  const pageCount = Math.ceil(eventCount / PAGE_SIZE);
  const events = staticDashboardTrace.events.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );
  const selected =
    staticDashboardTrace.events.find(
      (event) => event.sequence === selectedSequence,
    ) ?? staticDashboardTrace.events[0];

  if (selected === undefined) {
    throw new Error(
      'Static dashboard fixture unexpectedly contains no events.',
    );
  }

  return (
    <main aria-label="Static VibeTrace session">
      <h1>VibeTrace</h1>
      <p>Milestone-0 static inspector. This sample is not live capture.</p>
      <section aria-labelledby="session-summary">
        <h2 id="session-summary">Synthetic session</h2>
        <p>
          <strong>{eventCount.toLocaleString()}</strong> captured fixture events
          · capture mode: <strong>{selected.provenance.captureMode}</strong>
        </p>
        <p>Scenario signature: {staticDashboardTrace.signature}</p>
      </section>
      <section aria-labelledby="chronology">
        <h2 id="chronology">Chronology</h2>
        <ol start={page * PAGE_SIZE + 1}>
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => setSelectedSequence(event.sequence)}
              >
                {event.sequence}: {event.type}
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>{' '}
        <span>
          Page {page + 1} of {pageCount}
        </span>{' '}
        <button
          type="button"
          disabled={page + 1 === pageCount}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </section>
      <section aria-labelledby="event-inspector">
        <h2 id="event-inspector">Event inspector</h2>
        <p>
          Event {selected.sequence}: <strong>{selected.type}</strong>
        </p>
        <h3>Provenance</h3>
        <pre>{formatJson(selected.provenance)}</pre>
        <h3>Raw JSON</h3>
        <pre>{formatJson(selected.rawPayload)}</pre>
      </section>
    </main>
  );
}
