import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, type AiAnalysisRequest } from './api.js';

type AiProvider = AiAnalysisRequest['provider'];

const DEFAULT_DIRECT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The AI review could not be completed.';
  const messages: Record<string, string> = {
    AI_PROVIDER_TIMEOUT: 'The provider did not finish before the time limit.',
    AI_PROVIDER_REQUEST_FAILED:
      'The direct provider could not be reached. Check the endpoint and network.',
    AI_PROVIDER_RESPONSE_REJECTED:
      'The provider rejected the request. Check the API key, model, and quota.',
    AI_PROVIDER_RESPONSE_INVALID:
      'The provider returned data that did not match the evidence schema.',
    AI_PROVIDER_RESPONSE_TOO_LARGE:
      'The provider response exceeded the 2 MiB safety limit.',
    AI_PROVIDER_OUTPUT_TOO_LARGE:
      'Codex produced more output than the safety limit permits.',
    AI_PROVIDER_EXECUTION_FAILED:
      'Codex could not start or finish. Confirm it is installed and signed in.',
    AI_ANALYSIS_IN_PROGRESS:
      'This session already has an AI analysis in progress.',
  };
  return messages[error.message] ?? error.message;
}

function validDirectEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function AiReviewPanel({ sessionId }: { readonly sessionId: string }) {
  const queryClient = useQueryClient();
  const prompt = useQuery({
    queryKey: ['ai-prompt', sessionId],
    queryFn: () => api.aiPrompt(sessionId),
  });
  const [provider, setProvider] = useState<AiProvider>('codex');
  const [endpoint, setEndpoint] = useState(DEFAULT_DIRECT_ENDPOINT);
  const [directModel, setDirectModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [consent, setConsent] = useState(false);
  const [codexModel, setCodexModel] = useState('');
  const [status, setStatus] = useState<string>();
  const [validationError, setValidationError] = useState<string>();

  const analyze = useMutation({
    mutationFn: (request: AiAnalysisRequest) =>
      api.runAiAnalysis(sessionId, request),
    onSuccess: async (result) => {
      setApiKey('');
      setValidationError(undefined);
      setStatus(
        `Saved ${result.hypotheses.length} evidence-linked ${result.hypotheses.length === 1 ? 'issue' : 'issues'} from ${result.provider}${result.model ? ` · ${result.model}` : ''}.`,
      );
      await queryClient.invalidateQueries({
        queryKey: ['findings', sessionId],
      });
    },
  });

  const runAnalysis = () => {
    setStatus(undefined);
    setValidationError(undefined);
    if (!prompt.data) return;
    if (provider === 'direct-api') {
      if (!validDirectEndpoint(endpoint)) {
        setValidationError(
          'Enter an HTTPS chat-completions endpoint without credentials or a fragment.',
        );
        return;
      }
      if (!directModel.trim() || !apiKey) {
        setValidationError('The direct API model and API key are required.');
        return;
      }
      if (!consent) {
        setValidationError(
          'Confirm that this session may be sent to the selected endpoint.',
        );
        return;
      }
      analyze.mutate({
        provider: 'direct-api',
        endpoint,
        apiKey,
        model: directModel.trim(),
        consent: true,
      });
      return;
    }
    analyze.mutate({
      provider: 'codex',
      ...(codexModel.trim() ? { model: codexModel.trim() } : {}),
    });
  };

  return (
    <section
      className="panel-page ai-review-page"
      aria-labelledby="ai-review-title"
    >
      <header>
        <p className="eyebrow">Model-assisted forensic synthesis</p>
        <h2 id="ai-review-title">AI evidence review</h2>
        <p>
          Reconstruct the complete observable session and return up to five
          material problems or capture limitations, each tied to exact event
          IDs. Praise and neutral observations are excluded. Analysis is opt-in:
          both choices send the bounded evidence prompt to the selected AI
          service.
        </p>
      </header>

      {prompt.isPending ? (
        <p className="teaching-empty">Preparing the evidence dossier…</p>
      ) : null}
      {prompt.isError ? (
        <p role="alert" className="panel-error">
          Could not prepare the evidence: {errorMessage(prompt.error)}
        </p>
      ) : null}

      {prompt.data ? (
        <>
          <div className="ai-review-meta">
            <span>Analyzer {prompt.data.analyzerVersion}</span>
            <span>Prompt {prompt.data.promptDigest.slice(0, 16)}…</span>
            <span>Evidence IDs required</span>
          </div>

          <fieldset className="ai-provider-picker">
            <legend>Choose one analysis provider</legend>
            <label className={provider === 'codex' ? 'selected' : undefined}>
              <input
                type="radio"
                name="ai-provider"
                value="codex"
                checked={provider === 'codex'}
                onChange={() => setProvider('codex')}
              />
              <span>
                <strong>Use Codex</strong>
                <small>Existing local Codex installation and sign-in</small>
              </span>
            </label>
            <label
              className={provider === 'direct-api' ? 'selected' : undefined}
            >
              <input
                type="radio"
                name="ai-provider"
                value="direct-api"
                checked={provider === 'direct-api'}
                onChange={() => setProvider('direct-api')}
              />
              <span>
                <strong>Use direct API</strong>
                <small>OpenAI-compatible HTTPS endpoint with your key</small>
              </span>
            </label>
          </fieldset>

          {provider === 'codex' ? (
            <div className="ai-provider-form">
              <label>
                Codex model <small>Optional; blank uses your default</small>
                <input
                  aria-label="Codex model"
                  value={codexModel}
                  onChange={(event) => setCodexModel(event.target.value)}
                  placeholder="Use configured default"
                  autoComplete="off"
                />
              </label>
              <p className="ai-privacy-note">
                VibeTrace starts an ephemeral Codex task in an empty read-only
                workspace with a sanitized environment. Codex is still an agent
                runtime; use direct API when you require the stricter
                inference-only boundary.
              </p>
            </div>
          ) : (
            <div className="ai-provider-form">
              <label>
                Chat completions endpoint
                <input
                  aria-label="Direct API endpoint"
                  type="url"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  spellCheck={false}
                  autoComplete="url"
                />
              </label>
              <label>
                Model
                <input
                  aria-label="Direct API model"
                  value={directModel}
                  onChange={(event) => setDirectModel(event.target.value)}
                  placeholder="Provider model ID"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label>
                API key <small>Held in memory for this run; never stored</small>
                <input
                  aria-label="Direct API key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="ai-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  Send this bounded session dossier to{' '}
                  <strong>
                    {validDirectEndpoint(endpoint)
                      ? new URL(endpoint).host
                      : 'the selected host'}
                  </strong>
                  .
                </span>
              </label>
            </div>
          )}

          <details className="ai-prompt-preview">
            <summary>Preview the exact bounded evidence prompt</summary>
            <pre>{prompt.data.prompt.user}</pre>
          </details>

          <button
            className="ink-button"
            type="button"
            onClick={runAnalysis}
            disabled={analyze.isPending}
          >
            {analyze.isPending ? 'Analyzing session…' : 'Analyze session'}
          </button>
          {validationError ? <p role="alert">{validationError}</p> : null}
          {status ? <p role="status">{status}</p> : null}
          {analyze.isError ? (
            <p role="alert" className="panel-error">
              Analysis failed: {errorMessage(analyze.error)}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
