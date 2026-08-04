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

The daemon stores the manifest as an authenticated encrypted blob and records
its stable content hash. The manifest endpoint verifies both blob decryption
and the canonical manifest hash before returning it. A pre-task patch is
bounded to 16 MiB and is SHA-256 checked before it leaves the daemon.

## Isolated execution

`@vibetrace/eval-runner` creates a detached Git worktree beside the active
checkout using argument-based subprocess calls with `shell: false`. It applies
only a verified pre-task patch inside that worktree, runs Codex batch execution
or a supplied executor, evaluates bounded assertions, stores a worktree
fingerprint, and removes the worktree in a `finally` path. Shell operators,
absolute paths, traversal, oversized assertion files, and unbounded command
output are rejected.

Human assertions remain `pending_review`; they are not silently converted into
failures. Captured command output is uploaded to the encrypted blob store and
linked from the persisted run.

## Comparisons

Comparison matrices link selected runs for one eval case. Summaries report
pass/fail/pending counts, success rate over definitive runs, duration, tool,
diff, token, and estimated-cost distributions. There is intentionally no
universal quality score. `@vibetrace/eval-compare` compares normalized
observable events while ignoring transport timing and IDs, and reports the
first meaningful divergence with evidence IDs. The authenticated
`/api/v1/eval/comparisons/:id/divergence` endpoint and
`vibetrace eval compare-divergence` command accept bounded, schema-validated
event streams, compute the divergence, and persist it with the comparison;
until that operation runs, the dashboard reports that divergence is not yet
computed rather than claiming the runs are identical.

## Trust boundaries

Eval manifests, prompts, tool output, and model output are untrusted data.
Imported manifests are schema-validated before persistence, and captured text
is never interpolated into a shell. The optional AI analyzer receives a bounded
read-only prompt with no tools or network access and can persist only
structured hypotheses whose evidence IDs exist in the local session.
