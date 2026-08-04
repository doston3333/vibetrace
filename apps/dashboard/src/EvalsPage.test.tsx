// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EvalsPage } from './EvalsPage.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params: _params,
    to,
    ...props
  }: {
    children: ReactNode;
    params?: unknown;
    to?: string;
    className?: string;
  }) => (
    <a {...props} href={typeof to === 'string' ? to : '/'}>
      {children}
    </a>
  ),
}));

vi.mock('./api.js', () => ({
  api: {
    evalCases: async () => [
      {
        id: 'case-1',
        name: 'Fixture case',
        manifestBlobHash: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        schemaVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    evalComparison: async () => ({
      comparison: {
        id: 'comparison-1',
        evalCaseId: 'case-1',
        name: 'Repeated runs',
        configuration: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      runs: [
        {
          id: 'run-1',
          evalCaseId: 'case-1',
          status: 'completed',
          configuration: {},
          createdAt: '2026-01-01T00:00:00.000Z',
          outcome: { success: true },
          metrics: {
            durationMs: 42,
            toolCount: 3,
            diffFileCount: 2,
            tokenCount: 120,
            estimatedCostMicros: 7,
          },
        },
      ],
      results: [],
      summary: {
        runCount: 1,
        passedCount: 1,
        failedCount: 0,
        pendingCount: 0,
        successRate: 1,
        durationMs: { median: 42, p95: 42 },
        toolCount: { median: null, p95: null },
        diffFileCount: { median: null, p95: null },
        tokenCount: { median: null, p95: null },
        estimatedCostMicros: { median: null, p95: null },
      },
    }),
  },
}));

describe('evaluation lab', () => {
  it('renders indexed cases and keeps side-by-side runs observable', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <EvalsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Fixture case')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review manifest' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Comparison ID'), {
      target: { value: 'comparison-1' },
    });
    expect(await screen.findByText('Run matrix')).toBeTruthy();
    expect(await screen.findByText(/Tools 3/)).toBeTruthy();
    expect(await screen.findByText(/Tokens 120/)).toBeTruthy();
  });
});
