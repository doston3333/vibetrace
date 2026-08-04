import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { api } from './api.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function list(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseDraft(
  value: string,
):
  | { readonly value: unknown; readonly error?: undefined }
  | { readonly value?: undefined; readonly error: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { error: 'Manifest must be a JSON object.' };
    return { value: parsed };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Invalid JSON.',
    };
  }
}

export function EvalCasePage() {
  const { caseId } = useParams({ from: '/evals/$caseId' });
  const queryClient = useQueryClient();
  const manifestQuery = useQuery({
    queryKey: ['eval-case-manifest', caseId],
    queryFn: () => api.evalCaseManifest(caseId),
  });
  const casesQuery = useQuery({
    queryKey: ['eval-cases'],
    queryFn: api.evalCases,
    staleTime: 5_000,
  });
  const [draftOverride, setDraftOverride] = useState<string>();
  const [editing, setEditing] = useState(false);
  const draft =
    draftOverride ??
    (manifestQuery.data === undefined
      ? ''
      : JSON.stringify(manifestQuery.data, null, 2));
  const draftResult = useMemo(() => parseDraft(draft), [draft]);
  const updateManifest = useMutation({
    mutationFn: () => {
      if (draftResult.error !== undefined)
        throw new Error(`Manifest JSON is invalid: ${draftResult.error}`);
      return api.updateEvalCaseManifest(caseId, draftResult.value);
    },
    onSuccess: async (result) => {
      setDraftOverride(JSON.stringify(result.manifest, null, 2));
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['eval-case-manifest', caseId],
        }),
        queryClient.invalidateQueries({ queryKey: ['eval-cases'] }),
      ]);
    },
  });

  if (manifestQuery.isPending)
    return (
      <main id="main-content" className="case-loading" role="status">
        <span>Opening encrypted evaluation case</span>
        <strong>Loading the reviewed manifest…</strong>
      </main>
    );
  if (manifestQuery.isError)
    return (
      <main id="main-content" className="page-error" role="alert">
        <strong>This evaluation manifest could not be opened.</strong>
        <p>It may have been deleted or failed its integrity check.</p>
        <Link to="/evals">Return to evaluation lab</Link>
      </main>
    );

  const manifest = record(manifestQuery.data);
  const task = record(manifest.task);
  const repository = record(manifest.repository);
  const configuration = record(manifest.configuration);
  const sourceEvidence = record(manifest.sourceEvidence);
  const success = record(manifest.success);
  const capturedFailure = record(manifest.capturedFailure);
  const summary = casesQuery.data?.find((item) => item.id === caseId);
  const constraints = list(task.constraints);
  const corrections = list(task.corrections);
  const inferredFields = [
    ...list(task.inferredFields),
    ...list(configuration.inferredFields),
    ...list(success.inferredFields),
  ];
  const assertions = Array.isArray(success.assertions)
    ? success.assertions
    : [];

  const formatDraft = (): void => {
    if (draftResult.error === undefined)
      setDraftOverride(JSON.stringify(draftResult.value, null, 2));
  };
  const downloadDraft = (): void => {
    const blob = new Blob([draft], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const filename =
      (text(manifest.name) ?? 'eval-manifest')
        .replace(/[^A-Za-z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 96) || 'eval-manifest';
    link.download = `${filename}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <main id="main-content" className="sessions-page eval-case-page">
      <header className="sessions-intro">
        <div>
          <Link className="text-link" to="/evals">
            ← Evaluation lab
          </Link>
          <p className="eyebrow">Reviewed evaluation case</p>
          <h1>{text(manifest.name) ?? summary?.name ?? 'Untitled case'}</h1>
          <p>
            Edit the derived evidence contract, validate it at the encrypted
            daemon boundary, then hand the exact manifest to an isolated run.
          </p>
        </div>
        <div className="archive-count">
          <span>Schema</span>
          <strong>{text(manifest.schemaVersion) ?? 'unknown'}</strong>
        </div>
      </header>

      <section
        className="comparison-panel eval-review"
        aria-labelledby="eval-review-title"
      >
        <div className="eval-review-heading">
          <div>
            <h2 id="eval-review-title">Manifest review</h2>
            <p>
              Facts are derived from the source session; inferred fields remain
              explicitly marked for human confirmation.
            </p>
          </div>
          <span className={editing ? 'review-state is-dirty' : 'review-state'}>
            {editing ? 'Unsaved edits' : 'Stored and integrity-checked'}
          </span>
        </div>
        <dl className="eval-fact-grid">
          <div>
            <dt>Case ID</dt>
            <dd>{caseId}</dd>
          </div>
          <div>
            <dt>Source session</dt>
            <dd>{text(manifest.sourceSessionId) ?? 'Not linked'}</dd>
          </div>
          <div>
            <dt>Base commit</dt>
            <dd>{text(repository.baseCommit) ?? 'Missing'}</dd>
          </div>
          <div>
            <dt>Evidence events</dt>
            <dd>
              {Array.isArray(sourceEvidence.eventIds)
                ? sourceEvidence.eventIds.length.toLocaleString()
                : '0'}
            </dd>
          </div>
          <div>
            <dt>Prompt</dt>
            <dd>{text(task.prompt) ?? 'Missing — required before running'}</dd>
          </div>
          <div>
            <dt>Expected outcome</dt>
            <dd>{text(task.expectedOutcome) ?? 'Not captured'}</dd>
          </div>
        </dl>

        <div className="eval-review-columns">
          <section aria-labelledby="constraints-title">
            <h3 id="constraints-title">Constraints and corrections</h3>
            {constraints.length > 0 || corrections.length > 0 ? (
              <ul>
                {constraints.map((item) => (
                  <li key={`constraint-${item}`}>{item}</li>
                ))}
                {corrections.map((item) => (
                  <li key={`correction-${item}`}>Correction: {item}</li>
                ))}
              </ul>
            ) : (
              <p className="muted-copy">
                None captured; review this section before running.
              </p>
            )}
          </section>
          <section aria-labelledby="assertions-title">
            <h3 id="assertions-title">Success assertions</h3>
            {assertions.length > 0 ? (
              <ul>
                {assertions.map((item, index) => (
                  <li key={index}>
                    {text(record(item).type) ?? 'Unspecified assertion'}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-copy">No assertions captured.</p>
            )}
          </section>
          <section aria-labelledby="configuration-title">
            <h3 id="configuration-title">Execution configuration</h3>
            <p>
              Model: {text(configuration.model) ?? 'inherited'} · Approval:{' '}
              {text(configuration.approvalPolicy) ?? 'inherited'} · Sandbox:{' '}
              {text(configuration.sandboxPolicy) ?? 'inherited'}
            </p>
            {text(capturedFailure.category) ? (
              <p>Captured failure: {text(capturedFailure.category)}</p>
            ) : null}
          </section>
        </div>
        {inferredFields.length > 0 ? (
          <p className="capture-gap-note">
            Review required for inferred fields:{' '}
            {[...new Set(inferredFields)].join(', ')}
          </p>
        ) : null}
      </section>

      <section
        className="comparison-panel eval-editor"
        aria-labelledby="eval-editor-title"
      >
        <div className="eval-review-heading">
          <div>
            <h2 id="eval-editor-title">Validated manifest editor</h2>
            <p>
              This editor is a portable handoff format. Saving replaces only the
              encrypted derived view; the original session evidence stays
              immutable.
            </p>
          </div>
          <div className="eval-editor-actions">
            <button
              type="button"
              onClick={formatDraft}
              disabled={draftResult.error !== undefined}
            >
              Format draft
            </button>
            <button
              type="button"
              onClick={downloadDraft}
              disabled={draft.length === 0}
            >
              Download manifest
            </button>
          </div>
        </div>
        <label htmlFor="eval-manifest-editor">Manifest JSON</label>
        <textarea
          id="eval-manifest-editor"
          value={draft}
          maxLength={2_000_000}
          spellCheck={false}
          onChange={(event) => {
            setEditing(true);
            setDraftOverride(event.target.value);
          }}
          rows={24}
        />
        {draftResult.error !== undefined ? (
          <p className="page-error" role="alert">
            Invalid JSON: {draftResult.error}
          </p>
        ) : null}
        {updateManifest.isError ? (
          <p className="page-error" role="alert">
            {updateManifest.error instanceof Error
              ? updateManifest.error.message
              : 'The manifest was rejected by the encrypted daemon.'}
          </p>
        ) : null}
        {updateManifest.isSuccess ? (
          <p role="status">Reviewed manifest saved and integrity-checked.</p>
        ) : null}
        <button
          type="button"
          className="primary-action"
          onClick={() => void updateManifest.mutateAsync()}
          disabled={
            updateManifest.isPending ||
            draftResult.error !== undefined ||
            !editing
          }
        >
          {updateManifest.isPending
            ? 'Validating and saving…'
            : 'Save reviewed manifest'}
        </button>
      </section>
    </main>
  );
}
