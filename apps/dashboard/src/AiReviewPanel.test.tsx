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
  analyzerVersion: '0.2.0',
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
  it('runs an evidence-linked review through the existing Codex login', async () => {
    vi.spyOn(api, 'aiPrompt').mockResolvedValue(prompt);
    const run = vi.spyOn(api, 'runAiAnalysis').mockResolvedValue({
      analyzerVersion: '0.2.0',
      promptDigest: 'a'.repeat(64),
      provider: 'codex',
      hypotheses: [],
    });
    renderPanel();

    expect(await screen.findByText('AI evidence review')).toBeTruthy();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Analyze session' }),
    );

    expect((await screen.findByRole('status')).textContent).toContain(
      'Saved 0 evidence-linked hypotheses from codex.',
    );
    expect(run).toHaveBeenCalledWith('session-1', { provider: 'codex' });
    expect(screen.queryByLabelText('Provider hypotheses JSON')).toBeNull();
  });

  it('sends a consented direct API request and clears the ephemeral key', async () => {
    vi.spyOn(api, 'aiPrompt').mockResolvedValue(prompt);
    const run = vi.spyOn(api, 'runAiAnalysis').mockResolvedValue({
      analyzerVersion: '0.2.0',
      promptDigest: 'a'.repeat(64),
      provider: 'direct-api',
      model: 'deep-model',
      hypotheses: [],
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('radio', { name: /Use direct API/ }),
    );
    fireEvent.change(screen.getByLabelText('Direct API model'), {
      target: { value: 'deep-model' },
    });
    const key = screen.getByLabelText('Direct API key');
    fireEvent.change(key, { target: { value: 'ephemeral-secret' } });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Send this bounded session dossier/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Analyze session' }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'Saved 0 evidence-linked hypotheses from direct-api · deep-model.',
    );
    expect(run).toHaveBeenCalledWith('session-1', {
      provider: 'direct-api',
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey: 'ephemeral-secret',
      model: 'deep-model',
      consent: true,
    });
    expect((key as HTMLInputElement).value).toBe('');
  });

  it('requires explicit consent before calling a direct provider', async () => {
    vi.spyOn(api, 'aiPrompt').mockResolvedValue(prompt);
    const run = vi.spyOn(api, 'runAiAnalysis');
    renderPanel();
    fireEvent.click(
      await screen.findByRole('radio', { name: /Use direct API/ }),
    );
    fireEvent.change(screen.getByLabelText('Direct API model'), {
      target: { value: 'deep-model' },
    });
    fireEvent.change(screen.getByLabelText('Direct API key'), {
      target: { value: 'ephemeral-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze session' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Confirm that this session may be sent',
    );
    expect(run).not.toHaveBeenCalled();
  });
});
