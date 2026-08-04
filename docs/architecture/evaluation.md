# Evaluation and comparison architecture

VibeTrace treats an evaluation as a reviewed, versioned artifact derived from
observable session evidence. The evaluator never replays directly in the
active checkout.

## Manifest and evidence

`@vibetrace/eval-spec` validates schema `1.0.0` manifests. A manifest records
the source evidence IDs, repository base commit, optional encrypted pre-task
patch, prompt and constraints, configuration fingerprint, and one or more
success assertions. Unknown source fields remain in the encrypted source event
payload; inferred manifest fields are marked explicitly for review.

The generated JSON Schema is published alongside the package at
`packages/eval-spec/generated/eval-manifest.schema.json` so external tooling
can validate manifests without importing the TypeScript implementation.

The authenticated `POST /api/v1/eval/cases/from-session/:id` endpoint and the
dashboard's Evaluation Lab use the same `manifestFromSession` conversion. They
require a captured Git base commit, preserve every source event ID and capture
gap, and create an encrypted manifest blob with a canonical content hash.
Users can review the resulting case before creating runs; a session without a
base commit is reported as an explicit prerequisite failure.

The daemon stores the manifest as an authenticated encrypted blob and records
its stable content hash. The manifest endpoint verifies both blob decryption
and the canonical manifest hash before returning it. Manifest JSON is bounded
to 2 MiB at create and review-update boundaries. A pre-task patch is bounded
to 16 MiB and is SHA-256 checked before it leaves the daemon.

## Isolated execution

`@vibetrace/eval-runner` creates a detached Git worktree beside the active
checkout using argument-based subprocess calls with `shell: false`. It applies
only a verified pre-task patch inside that worktree, runs Codex batch execution
or a supplied executor, evaluates bounded assertions, stores a worktree
fingerprint, and removes the worktree in a `finally` path. Shell operators,
absolute paths, traversal, oversized assertion files, and unbounded command
output are rejected.

Codex runs resolve an explicit `configuration.execution` block into the exact
argv and effective model/approval/sandbox/network policy recorded on the run.
Legacy flat fields remain readable, conflicting fields are rejected, and extra
arguments may not override `exec`, JSON output, working-directory, approval,
sandbox, or output controls. Unsupported policy values fail closed rather than
being silently ignored. When a CLI run is persisted, the effective invocation
is stored alongside the reviewed manifest configuration for later comparison.
Runnable legacy manifests that omit execution settings receive the fail-closed
defaults `approvalPolicy=never`, `sandboxPolicy=workspace-write`, and
`networkPolicy=disabled`; explicit `danger-full-access` runs cannot claim that
network access is disabled. A detached worktree protects the active checkout,
but is not an operating-system sandbox: untrusted eval code must only run when
the host's Codex sandbox or container boundary is trusted.

Human assertions remain `pending_review`; they are not silently converted into
failures. Captured command output is uploaded to the encrypted blob store and
linked from the persisted run. The bounded JSONL transcript is also normalized
into a `vibetrace-eval` session: canonical records are retained, while
unrecognized records become explicit capture gaps with their raw payloads
preserved. Re-submitting the same run events is idempotent.

## Comparisons

Comparison matrices link selected runs for one eval case. Matrix configuration
is schema-checked for dimensions such as model, reasoning effort, policies,
instruction/skill sets, environment fingerprint, and repetition. Summaries report
pass/fail/pending counts, success rate over definitive runs, duration, tool,
diff, token, and estimated-cost distributions. There is intentionally no
universal quality score. `@vibetrace/eval-compare` compares normalized
observable events while ignoring transport timing and IDs, and reports the
first meaningful divergence with evidence IDs. The authenticated
`/api/v1/eval/comparisons/:id/divergence` endpoint and
`vibetrace eval compare-divergence` command accept bounded, schema-validated
event streams, compute the divergence, and persist it with the comparison. If
captured eval sessions are available, the comparison API derives the first
divergence directly from those sessions; otherwise the dashboard reports that
divergence is not yet computed rather than claiming the runs are identical.
Captured streams also derive per-run tool, changed-file, verification, token,
cost, duration, and evidence-linked finding metrics. The dashboard renders
those values beside each run and links back to the captured session for the
full timeline and findings.

The CLI can execute a reviewed matrix directly with
`vibetrace eval matrix <manifest> <matrix.json>`. Matrix files contain a name,
at least two validated variants, and optional repetitions. Variants may change
the prompt, model, execution policies, bounded extra arguments, or reviewed
skill hash set. The runner executes arms sequentially, creates a fresh detached
worktree for every repetition, and records variant/repetition metadata in the
comparison result. Safety limits are 100 variants, 100 repetitions, and 1,000
total runs; no active checkout is reused as an execution worktree.

## Trust boundaries

Eval manifests, prompts, tool output, and model output are untrusted data.
Imported manifests are schema-validated before persistence, and captured text
is never interpolated into a shell. The optional AI analyzer receives a bounded
read-only prompt with no tools or network access and can persist only
structured hypotheses whose evidence IDs exist in the local session. The
dashboard's copy/paste review workflow binds the provider response to the
current prompt digest and analyzer version; stale responses are rejected before
findings are replaced.
