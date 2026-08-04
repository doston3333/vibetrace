// @vitest-environment jsdom

import { performance } from 'node:perf_hooks';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createSyntheticTrace } from '@vibetrace/test-fixtures';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ForensicWorkbench } from './App.js';
import { FindingsPanel } from './Panels.js';
import type {
  CoverageDatum,
  Finding,
  SessionSummary,
  SessionScorecard,
  StoredEvent,
} from './api.js';
import {
  buildTimelineModel,
  eventDetail,
  matchesEvent,
  safeDisplayText,
} from './forensics.js';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 640,
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      bottom: 640,
      height: 640,
      left: 0,
      right: 1200,
      top: 0,
      width: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterEach(() => {
  cleanup();
});

const trace = createSyntheticTrace({
  eventCount: 20000,
  scenario: 'code-change-tests',
  seed: 501,
});
const events: readonly StoredEvent[] = trace.events.map((event) => ({
  id: event.id,
  rawEventId: event.provenance.rawEventId ?? `raw-${event.sequence}`,
  sessionId: event.sessionId,
  sequence: event.sequence,
  timestamp: event.timestamp,
  type: event.type,
  ...(event.toolName ? { toolName: event.toolName } : {}),
  event,
}));
const session: SessionSummary = {
  id: trace.sessionId,
  projectId: 'vibetrace',
  displayName: 'VibeTrace',
  source: 'codex-hooks',
  sourceSessionId: 'opaque',
  startedAt: events[0]!.timestamp,
  endedAt: events.at(-1)!.timestamp,
  status: 'completed',
  captureMode: 'standard',
  title: 'Reconstruct authorization failure',
  model: 'gpt-5.6-codex',
  eventCount: events.length,
  findingCount: 1,
  primaryFinding: 'No tests after final change',
};
const coverage: readonly CoverageDatum[] = [
  {
    dataClass: 'conversation',
    state: 'captured',
    sources: ['user · codex-hooks'],
    gaps: [],
  },
  {
    dataClass: 'context',
    state: 'partial',
    sources: ['harness · codex-hooks'],
    gaps: [
      {
        eventId: events[8]!.id,
        state: 'partial',
        reason: 'Transcript enrichment was incomplete.',
        adapter: 'codex-hooks',
      },
    ],
  },
  {
    dataClass: 'tools',
    state: 'captured',
    sources: ['tool · codex-hooks'],
    gaps: [],
  },
  {
    dataClass: 'code',
    state: 'captured',
    sources: ['vcs · codex-hooks'],
    gaps: [],
  },
  {
    dataClass: 'verification',
    state: 'captured',
    sources: ['tool · codex-hooks'],
    gaps: [],
  },
];
const findings: readonly Finding[] = [
  {
    id: 'finding-1',
    sessionId: trace.sessionId,
    ruleId: 'no-tests-after-final-change',
    detectorVersion: '0.1.0',
    category: 'verification',
    severity: 'high',
    title: 'No tests after final change',
    explanation: 'A later file change has no observed verification.',
    recommendation: 'Run the relevant test command after the final change.',
    evidenceEventIds: [events[6]!.id],
    counterevidenceEventIds: [],
    state: 'open',
  },
];
const scorecard: SessionScorecard = {
  schemaVersion: '0.1.0',
  sessionId: trace.sessionId,
  dimensions: [
    'outcome-correctness',
    'context-utilization',
    'tool-reliability',
    'verification-quality',
    'efficiency',
    'recovery-behavior',
    'instruction-adherence',
    'safety-permissions',
    'human-effort',
    'capture-confidence',
  ].map((id) => ({
    id,
    label: id,
    score: null,
    confidence: 'unknown' as const,
    calculation: 'Observable evidence only.',
    evidenceEventIds: [],
  })),
};

function renderWorkbench(
  save = vi.fn(async () => undefined),
  review = vi.fn(async () => undefined),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    save,
    review,
    ...render(
      <QueryClientProvider client={client}>
        <ForensicWorkbench
          session={session}
          events={events}
          artifacts={[]}
          coverage={coverage}
          findings={findings}
          scorecard={scorecard}
          annotations={[]}
          onSaveAnnotation={save}
          onReviewFinding={review}
        />
      </QueryClientProvider>,
    ),
  };
}

describe('forensic dashboard', () => {
  it('builds and filters the 20,000-event timeline within a bounded interaction budget', () => {
    const started = performance.now();
    const model = buildTimelineModel(events);
    const matches = model.filter((item) =>
      matchesEvent(item, {
        search: 'pnpm test',
        lane: 'all',
        status: 'all',
      }),
    );
    const elapsed = performance.now() - started;
    expect(model).toHaveLength(20_000);
    expect(matches.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(750);
    expect(safeDisplayText('\u001b[31m-removed\n+added\u001b[0m')).toBe(
      '-removed\n+added',
    );
    expect(eventDetail(events[0]!.event)).not.toMatch(/^\s*\{/u);
    const duplicate = {
      ...events[0]!,
      id: 'duplicate-agent-message',
      type: 'message.agent',
      event: {
        ...events[0]!.event,
        id: 'duplicate-agent-message',
        type: 'message.agent',
        source: 'agent',
        payload: {
          content: 'Repeated final answer.',
          duplicateOfEventId: events[0]!.id,
        },
      },
    } as StoredEvent;
    expect(buildTimelineModel([...events, duplicate])).toHaveLength(20_000);
  });

  it('renders a virtualized five-lane workbench and keeps untrusted markup inert', async () => {
    const { container } = renderWorkbench();
    expect(
      screen.getByRole('heading', { name: 'Evidence timeline' }),
    ).toBeTruthy();
    expect(screen.getByText('20,000 observable events')).toBeTruthy();
    expect(
      screen.getByRole('listbox', { name: /Use arrow keys/ }),
    ).toBeTruthy();
    expect(container.querySelectorAll('.timeline-row').length).toBeLessThan(
      200,
    );
    expect(
      (container.querySelector('.timeline-virtual-space') as HTMLElement).style
        .height,
    ).toBe('1440000px');
    expect(container.querySelector('synthetic-trace-content')).toBeNull();

    const friendly = screen.getByRole('tab', { name: 'friendly' });
    const raw = screen.getByRole('tab', { name: 'raw' });
    friendly.focus();
    fireEvent.keyDown(friendly, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(raw);
    expect(raw.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'event-tab-raw',
    );
    expect(screen.getByText(/synthetic-trace-content/)).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });

  it('supports keyboard evidence navigation, findings jumps, coverage, and annotations', async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => undefined);
    const review = vi.fn(async () => undefined);
    renderWorkbench(save, review);
    const timeline = screen.getByRole('listbox', { name: /Use arrow keys/ });
    fireEvent.keyDown(timeline, { key: 'ArrowDown' });
    expect(screen.getByRole('heading', { name: 'File changed' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Findings 1/ }));
    expect(
      screen.getByRole('heading', { name: 'No tests after final change' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'confirmed' }));
    expect(review).toHaveBeenCalledWith('finding-1', {
      decision: 'confirmed',
    });
    expect(screen.queryByRole('button', { name: 'Reopen review' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Supports/ }));
    expect(
      screen.getByRole('heading', { name: 'Evidence timeline' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Coverage' }));
    expect(
      screen.getByText('Transcript enrichment was incomplete.'),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Annotations 0/ }));
    await user.type(screen.getByLabelText('Label'), 'partial failure');
    await user.type(
      screen.getByLabelText('Evidence note'),
      'Tests were not rerun.',
    );
    await user.click(screen.getByRole('button', { name: 'Save annotation' }));
    expect(save).toHaveBeenCalledWith({
      label: 'outcome:partial failure',
      note: 'Tests were not rerun.',
    });
  });

  it('renders independent scorecard dimensions without a universal score', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'Scorecard' }));
    expect(
      screen.getByRole('heading', { name: 'Session scorecard' }),
    ).toBeTruthy();
    expect(screen.getByText(/not a universal quality score/)).toBeTruthy();
    const panel = screen
      .getByRole('heading', { name: 'Session scorecard' })
      .closest('section');
    expect(panel).toBeTruthy();
    expect(within(panel as HTMLElement).getAllByText('Unknown')).toHaveLength(
      10,
    );
  });

  it('labels AI hypotheses separately from deterministic findings', () => {
    render(
      <FindingsPanel
        events={events}
        findings={[
          {
            ...findings[0]!,
            id: 'finding-ai',
            ruleId: 'ai-analyzer',
            title: 'Possible repeated tool loop',
          },
        ]}
        onSelect={() => undefined}
        onReview={async () => undefined}
      />,
    );
    expect(
      screen.getByText(/AI problem hypothesis · review required/),
    ).toBeTruthy();
    expect(document.querySelector('[data-kind="ai-problem"]')).toBeTruthy();
  });

  it('presents capture limitations separately and only reopens closed reviews', () => {
    render(
      <FindingsPanel
        events={events}
        findings={[
          {
            ...findings[0]!,
            id: 'finding-capture',
            ruleId: 'ai-analyzer',
            findingKind: 'capture_limitation',
            title: 'Shell exit status was not exposed',
            impact: 'Command success cannot be established.',
            state: 'rejected',
          },
        ]}
        onSelect={() => undefined}
        onReview={async () => undefined}
      />,
    );
    expect(
      document.querySelector('[data-kind="capture-limitation"]'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reopen review' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'confirmed' })).toBeNull();
  });
});
