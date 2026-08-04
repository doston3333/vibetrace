// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiReviewPanel } from './AiReviewPanel.js';
import { api } from './api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const prompt = {
  analyzerVersion: '0.1.0',
  promptDigest: 'a'.repeat(64),
  prompt: {
    system: 'You are a read-only analyst.',
    user: '{"trace":[]}',
    tools: [] as const,
    networkAllowed: false as const,
  },
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiReviewPanel sessionId="session-1" />
    </QueryClientProvider>,
  );
}

describe('AiReviewPanel', () => {
  it('prepares a local prompt and verifies pasted evidence-linked output', async () => {
    vi.spyOn(api, 'aiPrompt').mockResolvedValue(prompt);
    const submit = vi.spyOn(api, 'submitAiFindings').mockResolvedValue({
      hypotheses: [],
    });
    renderPanel();

    expect(await screen.findByText('AI evidence review')).toBeTruthy();
    const editor = await screen.findByLabelText('Provider hypotheses JSON');
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify([
          {
            id: 'hypothesis-1',
            category: 'verification',
            title: 'A check was skipped',
            explanation: 'The evidence shows no later verification.',
            confidence: 0.8,
            evidenceEventIds: ['00000000-0000-4000-8000-000000000001'],
            counterEvidenceEventIds: [],
          },
        ]),
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Verify and save hypotheses' }),
    );

    expect(
      await screen.findByText(/Verified and saved 0 hypotheses/),
    ).toBeTruthy();
    expect(submit).toHaveBeenCalledWith('session-1', {
      analyzerVersion: '0.1.0',
      promptDigest: 'a'.repeat(64),
      hypotheses: expect.arrayContaining([
        expect.objectContaining({ id: 'hypothesis-1' }),
      ]),
    });
  });

  it('rejects malformed provider output before the daemon is called', async () => {
    vi.spyOn(api, 'aiPrompt').mockResolvedValue(prompt);
    const submit = vi.spyOn(api, 'submitAiFindings');
    renderPanel();
    await screen.findByText('AI evidence review');
    fireEvent.change(await screen.findByLabelText('Provider hypotheses JSON'), {
      target: { value: '{not json' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Verify and save hypotheses' }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });
});
