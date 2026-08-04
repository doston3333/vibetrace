import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, type AiHypothesisDraft } from './api.js';

const MAX_HYPOTHESES_BYTES = 2 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The AI review could not be completed.';
}

export function AiReviewPanel({ sessionId }: { readonly sessionId: string }) {
  const queryClient = useQueryClient();
  const prompt = useQuery({
    queryKey: ['ai-prompt', sessionId],
    queryFn: () => api.aiPrompt(sessionId),
  });
  const [hypothesesJson, setHypothesesJson] = useState('[]');
  const [validationError, setValidationError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const submit = useMutation({
    mutationFn: (hypotheses: readonly AiHypothesisDraft[]) =>
      api.submitAiFindings(sessionId, {
        analyzerVersion: prompt.data?.analyzerVersion ?? '0.1.0',
        promptDigest: prompt.data?.promptDigest ?? '',
        hypotheses,
      }),
    onSuccess: async (result) => {
      setValidationError(undefined);
      await queryClient.invalidateQueries({
        queryKey: ['findings', sessionId],
      });
      setValidationError(
        `Verified and saved ${result.hypotheses.length} ${result.hypotheses.length === 1 ? 'hypothesis' : 'hypotheses'}.`,
      );
    },
  });

  const copyPrompt = async () => {
    if (!prompt.data) return;
    const value = `${prompt.data.prompt.system}\n\n${prompt.data.prompt.user}`;
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const submitHypotheses = () => {
    setValidationError(undefined);
    if (!prompt.data) return;
    if (
      new TextEncoder().encode(hypothesesJson).byteLength > MAX_HYPOTHESES_BYTES
    ) {
      setValidationError('Provider output exceeds the 2 MiB review limit.');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(hypothesesJson);
      if (!Array.isArray(parsed))
        throw new Error('Provider output must be a JSON array.');
      submit.mutate(parsed as readonly AiHypothesisDraft[]);
    } catch (error) {
      setValidationError(errorMessage(error));
    }
  };

  return (
    <section
      className="panel-page ai-review-page"
      aria-labelledby="ai-review-title"
    >
      <header>
        <p className="eyebrow">Optional model-assisted synthesis</p>
        <h2 id="ai-review-title">AI evidence review</h2>
        <p>
          VibeTrace prepares a bounded, untrusted-data prompt and verifies only
          hypotheses that cite events from this session. No provider call or
          network access is made by the local dashboard.
        </p>
      </header>
      {prompt.isPending ? (
        <p className="teaching-empty">Preparing the local evidence prompt…</p>
      ) : null}
      {prompt.isError ? (
        <p role="alert" className="panel-error">
          Could not prepare the prompt: {errorMessage(prompt.error)}
        </p>
      ) : null}
      {prompt.data ? (
        <>
          <div className="ai-review-meta">
            <span>Analyzer {prompt.data.analyzerVersion}</span>
            <span>Prompt {prompt.data.promptDigest.slice(0, 16)}…</span>
            <span>Tools disabled · network disabled</span>
          </div>
          <div className="ai-prompt-actions">
            <button type="button" onClick={() => void copyPrompt()}>
              {copied ? 'Prompt copied' : 'Copy provider prompt'}
            </button>
            <small>
              Paste the prompt into your approved provider, then paste its JSON
              array below.
            </small>
          </div>
          <details className="ai-prompt-preview">
            <summary>Preview the bounded prompt</summary>
            <pre>{prompt.data.prompt.user}</pre>
          </details>
          <label className="ai-output-editor">
            Provider hypotheses JSON
            <textarea
              aria-label="Provider hypotheses JSON"
              value={hypothesesJson}
              onChange={(event) => setHypothesesJson(event.target.value)}
              spellCheck={false}
              rows={12}
            />
          </label>
          <button
            className="ink-button"
            type="button"
            onClick={submitHypotheses}
            disabled={submit.isPending}
          >
            {submit.isPending ? 'Verifying…' : 'Verify and save hypotheses'}
          </button>
          {validationError ? (
            <p role={submit.isError ? 'alert' : 'status'}>{validationError}</p>
          ) : null}
          {submit.isError ? (
            <p role="alert" className="panel-error">
              Verification failed: {errorMessage(submit.error)}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
