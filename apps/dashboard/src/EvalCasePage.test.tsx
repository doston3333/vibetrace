// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EvalCasePage } from './EvalCasePage.js';

const { updateEvalCaseManifest } = vi.hoisted(() => ({
  updateEvalCaseManifest: vi.fn(async (_id: string, manifest: unknown) => ({
    case: {
      id: 'case-1',
      name: (manifest as { name: string }).name,
      manifestBlobHash: 'c'.repeat(64),
      manifestHash: 'd'.repeat(64),
      schemaVersion: '1.0.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    },
    manifest,
  })),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    to,
    ...props
  }: {
    children: ReactNode;
    params?: unknown;
    to?: string;
    className?: string;
  }) => {
    void params;
    void to;
    return <a {...props}>{children}</a>;
  },
  useParams: () => ({ caseId: 'case-1' }),
}));

vi.mock('./api.js', () => ({
  api: {
    evalCaseManifest: async () => ({
      schemaVersion: '1.0.0',
      id: 'case-1',
      name: 'Fixture case',
      sourceSessionId: 'source-1',
      sourceEvidence: {
        eventIds: [],
        artifactBlobHashes: [],
        captureGapIds: [],
      },
      repository: { baseCommit: 'a'.repeat(40) },
      task: {
        prompt: 'Review the fixture.',
        constraints: ['Keep it deterministic.'],
        inferredFields: [],
      },
      configuration: {
        skills: [],
        instructionHashes: [],
        inferredFields: [],
      },
      success: {
        assertions: [{ type: 'human_rating' }],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
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
    updateEvalCaseManifest,
  },
}));

describe('evaluation case review', () => {
  it('renders evidence facts and persists a reviewed manifest through the API', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <EvalCasePage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Review the fixture.')).toBeTruthy();
    const editor = await screen.findByLabelText('Manifest JSON');
    const reviewed = JSON.parse((editor as HTMLTextAreaElement).value) as {
      name: string;
    };
    reviewed.name = 'Reviewed fixture case';
    fireEvent.change(editor, {
      target: { value: JSON.stringify(reviewed, null, 2) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save reviewed manifest' }),
    );

    expect(
      await screen.findByText('Reviewed manifest saved and integrity-checked.'),
    ).toBeTruthy();
    expect(updateEvalCaseManifest).toHaveBeenCalledWith(
      'case-1',
      expect.objectContaining({ name: 'Reviewed fixture case' }),
    );
  });
});
