# VibeTrace — Full Product Plan

**Working title:** VibeTrace  
**Tagline:** Turn every AI coding session into an eval.  
**Document status:** Build-ready product and technical plan  
**Initial integration:** Codex  
**Product model:** Open-source, local-first developer tool

---

## 1. Executive summary

VibeTrace is a local-first forensic debugger and evaluation environment for AI-assisted coding. It records the complete **observable** trajectory of an AI coding session—user prompts, exposed instructions, plans, provider-exposed reasoning summaries or reasoning content, tool calls, tool outputs, terminal activity, approvals, code changes, tests, context compaction, subagent activity, errors, retries, and human corrections—and presents the session in a developer-friendly dashboard.

The product does not stop at logging. It helps answer:

- Where did this session first begin to go wrong?
- Was the primary problem the prompt, context, model, harness, skill, tool, environment, verification process, or human intervention?
- Which conclusions are supported by observable evidence?
- What should the user change next time?
- Does that change actually improve the result when the task is replayed?

The core product progression is:

```text
Capture → Reconstruct → Diagnose → Compare → Replay → Evaluate
```

The first public release should focus on **reliable Codex capture, session reconstruction, a polished timeline, and deterministic diagnostics**. Counterfactual replay, cross-model matrices, and additional agent adapters should follow only after capture quality is trustworthy.

The strongest positioning is:

> VibeTrace is DevTools for debugging the developer, prompt, model, skills, harness, and coding environment together.

---

## 2. Product thesis

AI coding failures are difficult to diagnose because the final answer or final diff hides the trajectory that produced it. A failed feature may have originated much earlier:

- The user omitted an important requirement.
- The agent never read the relevant file.
- A skill supplied stale instructions.
- Context compaction removed a constraint.
- A command failed and the agent ignored it.
- The harness truncated a tool result.
- The model reached an incorrect conclusion despite having enough information.
- The test suite did not validate the behavior that mattered.

Most users currently judge sessions from memory and intuition. They say things like “the model is bad,” “my prompt was weak,” or “the agent got confused,” without being able to isolate the cause.

VibeTrace turns that subjective postmortem into an evidence-backed process.

### Core thesis

A coding-agent session should be treated as a reproducible engineering artifact, not a disposable chat transcript.

Every session can become:

1. A replayable timeline.
2. A failure postmortem.
3. A source of prompt and skill improvements.
4. A regression evaluation.
5. A benchmark case for comparing models and harnesses.

---

## 3. Product principles

### 3.1 Evidence over vibes

Every diagnosis must link to concrete events. VibeTrace should never display “Model failure” without showing what information was available, what action was taken, and why the inference is reasonable.

### 3.2 Observable execution, not imaginary access

VibeTrace records only information exposed by the model provider, agent, tool, operating environment, or user. It must never claim access to private hidden reasoning that was not exposed. The UI should distinguish:

- Visible agent messages
- Plans
- Provider-exposed reasoning summaries
- Provider-exposed reasoning content, when available
- Tool activity
- Inferred causal hypotheses

### 3.3 Local-first by default

Source code, prompts, terminal output, credentials, and internal URLs are sensitive. The default product should work without an account, cloud upload, or external telemetry.

### 3.4 Deterministic analysis before LLM judgment

The first layer of analysis should use transparent rules and measurable signals. Model-assisted diagnosis can synthesize and interpret evidence, but it should not replace deterministic checks.

### 3.5 Reproduction beats scoring

A static score can be misleading. The strongest evidence comes from a controlled rerun that changes one variable while keeping the rest fixed.

### 3.6 Vendor-neutral core

Codex is the first integration, not the permanent boundary. The event schema, diagnostic engine, eval bundle, and UI should support future adapters.

### 3.7 Never become employee surveillance

VibeTrace evaluates sessions and configurations, not developer worth. Team features must avoid productivity rankings, keystroke monitoring, or simplistic “developer performance” scores.

### 3.8 Capture gaps must be explicit

When an adapter cannot observe something, the product should show a capture gap instead of silently pretending the record is complete.

---

## 4. Goals and non-goals

## 4.1 Initial goals

1. Record Codex sessions with minimal setup.
2. Normalize events into a stable open schema.
3. Reconstruct a chronological, searchable session timeline.
4. Show what the agent read, changed, executed, and verified.
5. Detect common failure patterns using deterministic rules.
6. Let users annotate outcomes and root causes.
7. Export a scrubbed session bundle for sharing.
8. Convert a real session into a reproducible eval case.
9. Compare prompt, skill, model, and harness variants in controlled runs.
10. Build an open adapter and diagnostic-rule ecosystem.

## 4.2 Explicit non-goals for the first release

- Replacing Codex as the primary coding interface
- Supporting every coding agent immediately
- Uploading repositories to a hosted service
- Producing one universal “AI quality score”
- Claiming certainty about root causes from one session
- Capturing unavailable private chain-of-thought
- Automatically fixing every detected issue
- Enterprise-wide team analytics
- Autonomous execution outside the user’s configured sandbox
- Becoming a general-purpose LLM observability platform

---

## 5. Target users

### Persona A: AI-first developer or vibecoder

Uses Codex for significant portions of implementation and debugging. Needs to understand why sessions succeed, fail, or become unnecessarily expensive.

**Jobs to be done:**

- Review a failed session without rereading thousands of lines.
- Improve prompting based on real evidence.
- Determine whether a skill is helping.
- Understand why the agent edited the wrong files.
- Compare two approaches without relying on memory.

### Persona B: Agent harness builder

Builds a custom agent, IDE extension, orchestration layer, or coding workflow.

**Jobs to be done:**

- Identify context-injection failures.
- Measure tool-call reliability.
- Detect truncation, retry loops, and approval problems.
- Compare harness versions on identical tasks.
- Build regression suites from production failures.

### Persona C: Skill and instruction author

Maintains `AGENTS.md`, reusable skills, MCP tools, or repository instructions.

**Jobs to be done:**

- See whether a skill was loaded, followed, ignored, or harmful.
- Compare old and revised skill versions.
- Find contradictory instructions.
- Turn repeated corrections into durable guidance.

### Persona D: Open-source maintainer

Reviews AI-generated contributions and uses coding agents for issue triage, fixes, releases, and maintenance.

**Jobs to be done:**

- Attach a scrubbed execution trace to a pull request or issue.
- Reproduce a failed agent-generated patch.
- Evaluate whether repository guidance improves agent contributions.
- Maintain regression tasks for common bugs.

### Persona E: Model evaluator or researcher

Studies coding-agent behavior across models and configurations.

**Jobs to be done:**

- Collect structured trajectories.
- Label failure onset and causes.
- Run controlled ablations.
- Export privacy-preserving benchmark data.

---

## 6. Core product objects

VibeTrace should have a small, clear conceptual model.

### Project

A repository or workspace being modified.

### Session

One continuous AI coding conversation, including one or more user turns and agent turns.

### Turn

A user request and the agent activity that follows it until completion, interruption, or failure.

### Event

A timestamped observable occurrence such as a prompt, message, tool call, command output, approval, file change, test result, compaction, or error.

### Artifact

A file diff, terminal log, screenshot, test report, plan, schema, or other object produced or observed during the session.

### Finding

An evidence-backed diagnostic observation generated by a deterministic rule, a model-assisted analyzer, or the user.

### Annotation

A human label, comment, outcome rating, or correction attached to a session, turn, event, or finding.

### Run fingerprint

A reproducibility record describing the model, Codex version, repository state, instructions, skills, tool configuration, sandbox policy, environment, and relevant dependency versions.

### Eval case

A reproducible task generated from a session, containing the initial state, prompt, constraints, success checks, and optional captured failure.

### Eval run

One execution of an eval case under a specific model, prompt, skill, or harness configuration.

---

## 7. Primary user experience

## 7.1 First-run flow

```text
Install CLI
→ Run `vibetrace init codex`
→ Review exactly which Codex hooks/config changes will be made
→ Start local daemon/dashboard
→ Use Codex normally
→ Open captured session
→ Review timeline and findings
```

The installer must be reversible and must never silently overwrite user configuration. It should:

1. Detect the Codex home directory.
2. Read existing hooks and configuration.
3. Generate a patch preview.
4. Back up files before modification.
5. Add only VibeTrace-owned entries.
6. Provide `vibetrace uninstall codex`.
7. Run `vibetrace doctor` to verify capture.

## 7.2 Session review flow

```text
Session list
→ Session overview
→ Unified timeline
→ Click a finding
→ Jump to supporting events
→ Inspect prompt/context/tool/diff/test evidence
→ Confirm, reject, or edit diagnosis
→ Generate recommendation or eval
```

## 7.3 Improvement flow

```text
Select failed session
→ Choose “Create experiment”
→ Pick variable to change:
   prompt / model / skill / harness / context / permissions
→ Generate clean worktree
→ Run controlled variant
→ Compare outcome and trajectory
```

## 7.4 Sharing flow

```text
Select session
→ Export
→ Choose privacy profile
→ Preview every included field and artifact
→ Apply redactions
→ Generate portable bundle
```

---

## 8. Capture completeness model

VibeTrace should show a visible capture-quality badge for every session.

### Full-fidelity

Captured through a rich event stream. Includes available messages, plans, provider-exposed reasoning data, tool events, command output, file changes, approvals, token usage, compaction, and subagents.

### Standard

Captured through lifecycle hooks plus repository observation and transcript enrichment. Most prompts, local tool calls, tool outputs, file changes, and final responses are present, but some hosted or internal events may be unavailable.

### Partial

Imported from an existing transcript or log. Some timing, tool, environment, or configuration data is missing.

### Unknown

The source format was incomplete or unsupported.

Every session should include a capture matrix:

| Data type | Captured | Source | Notes |
|---|---:|---|---|
| User prompts | Yes | Hook | Complete |
| Agent messages | Yes | Transcript | Final messages only |
| Tool inputs | Yes | Hook | Local tools |
| Tool outputs | Yes | Hook | Local tools |
| Hosted web search | No | — | Adapter gap |
| File diffs | Yes | Git observer | Complete |
| Token usage | Partial | Telemetry | Prompt text disabled |

This honesty is itself a product advantage.

---

## 9. Codex integration strategy

Codex should be supported through three complementary modes.

## 9.1 Mode A: Observe existing Codex usage

This is the default user experience.

Use Codex lifecycle hooks to capture:

- Session start and end
- User prompt submission
- Pre-tool and post-tool events
- Tool input and output
- Permission requests
- Context compaction
- Subagent start and stop
- Turn stopping and final visible message

The hook process should be extremely small. It receives JSON on stdin and appends it to a local spool or sends it to a local Unix socket. It should not perform analysis inside the hook.

At session end, the adapter can use the provided transcript path for best-effort enrichment. Because transcript internals are not guaranteed to remain stable, transcript parsing must be versioned and treated as a compatibility adapter rather than the canonical interface.

## 9.2 Mode B: Full-fidelity Lab session

For controlled experiments and maximum observability, VibeTrace launches Codex through `codex app-server` over stdio and acts as the client.

This mode can capture rich streamed events such as:

- Thread and turn lifecycle
- User and agent messages
- Plans
- Provider-exposed reasoning summaries or raw reasoning when supported
- Command execution and streamed output
- File-change items and aggregate turn diffs
- MCP and dynamic tool calls
- Web-search events
- Context compaction
- Approval requests and resolutions
- Token usage
- Errors and model rerouting

This mode should initially be used for VibeTrace experiments rather than replacing the user’s normal Codex interface.

## 9.3 Mode C: Batch eval execution

Use the Codex SDK or `codex exec --json` for repeatable eval runs. This mode is optimized for:

- Running the same task across configurations
- CI
- Prompt and skill ablations
- Regression suites
- Structured outcome collection

## 9.4 Optional OpenTelemetry enrichment

VibeTrace can optionally receive Codex OpenTelemetry output for usage, request, approval, and tool metadata. Telemetry must remain opt-in, and prompt contents should remain disabled unless the user explicitly enables them.

## 9.5 Codex capability fingerprint

Each session should record:

```yaml
source: codex
codex_version: "..."
client_surface: cli | ide | app | app-server | exec | sdk
model: "..."
model_provider: "..."
reasoning_effort: "..."
approval_policy: "..."
sandbox_policy: "..."
network_policy: "..."
project_root: "..."
base_commit: "..."
dirty_patch_hash: "..."
agents_md_hashes: []
skill_hashes: []
plugin_hashes: []
mcp_servers: []
config_digest: "..."
os: "..."
architecture: "..."
runtime_versions: {}
lockfile_hashes: {}
```

This fingerprint is essential for fair comparisons.

---

## 10. Canonical event specification

The canonical schema should be open, versioned, append-only, and source-neutral.

```typescript
export type EventSource =
  | "user"
  | "agent"
  | "harness"
  | "tool"
  | "environment"
  | "vcs"
  | "vibetrace";

export type EventType =
  | "session.started"
  | "session.completed"
  | "turn.started"
  | "turn.completed"
  | "message.user"
  | "message.agent"
  | "message.plan"
  | "reasoning.summary"
  | "reasoning.exposed"
  | "instruction.loaded"
  | "skill.loaded"
  | "subagent.started"
  | "subagent.completed"
  | "tool.requested"
  | "tool.started"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "file.read"
  | "file.changed"
  | "git.snapshot"
  | "test.completed"
  | "build.completed"
  | "context.compaction.started"
  | "context.compaction.completed"
  | "user.steered"
  | "error"
  | "capture.gap";

export interface TraceEvent<TPayload = unknown> {
  schemaVersion: string;
  id: string;
  sessionId: string;
  turnId?: string;
  parentEventId?: string;
  sourceEventId?: string;
  sequence: number;
  timestamp: string;
  monotonicNs?: string;

  source: EventSource;
  type: EventType;
  subtype?: string;
  status?: "pending" | "running" | "completed" | "failed" | "declined";

  model?: string;
  toolName?: string;
  cwd?: string;
  durationMs?: number;

  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    estimatedCostMicros?: number;
  };

  payload: TPayload;
  rawPayloadRef?: string;
  sensitivity?: "public" | "internal" | "secret" | "unknown";
  redactions?: Array<{
    path: string;
    detector: string;
    replacement: string;
  }>;

  provenance: {
    adapter: string;
    adapterVersion: string;
    sourceVersion?: string;
    captureMode: "full" | "standard" | "partial";
  };
}
```

### Schema rules

1. Raw source events are immutable.
2. Normalized events are derived and versioned.
3. Analyzer results must reference normalized event IDs.
4. Unknown fields must be preserved in the raw payload.
5. Large outputs should be stored in a content-addressed blob store.
6. Event order should use both source timestamps and a local monotonic sequence.
7. Redaction must never mutate the private original; it creates an export view.
8. Unsupported data must generate `capture.gap` events where useful.

---

## 11. Functional requirements

## 11.1 Capture requirements

### P0

- Install and remove Codex hook integration safely.
- Capture session, turn, prompt, tool, permission, compaction, subagent, stop, and end events.
- Persist events even when the dashboard is closed.
- Recover from daemon unavailability using an append-only spool.
- Record repository root and Git state.
- Record changed files and diffs.
- Record commands, exit codes, durations, and output.
- Detect likely test, lint, build, and typecheck commands.
- Import a captured session into the canonical schema.
- Display capture gaps.

### P1

- Full-fidelity app-server capture.
- Optional OpenTelemetry ingestion.
- Live streaming into the dashboard.
- Exact installed-version schema generation and validation.
- Support resumed and forked Codex threads.

### P2

- Additional coding-agent adapters.
- Adapter SDK and conformance tests.
- Team-managed adapter policies.

## 11.2 Dashboard requirements

### P0

- Session list with project, status, model, duration, outcome, and finding count.
- Session overview.
- Unified chronological timeline.
- Filters by event type, tool, file, turn, and status.
- Event inspector showing raw and normalized payloads.
- Conversation lane.
- Tool and terminal lane.
- Code-change lane.
- Verification lane.
- Diff viewer.
- Search across prompts, outputs, commands, and files.
- Finding cards linked to evidence.
- User annotations.
- Export preview.

### P1

- Context map showing files and instructions observed by the agent.
- Causal graph.
- Side-by-side session comparison.
- Eval builder.
- Live session view.

### P2

- Team review and shared annotations.
- Repository-level trends.
- Self-hosted collaboration.

## 11.3 Analysis requirements

### P0 deterministic rules

- No tests run after code changes
- Final success claim despite failed command
- Repeated identical or near-identical failed command
- Repeated tool error loop
- Large code churn relative to task size
- Modified file without observed read or inspection
- Test suite run before final change but not after it
- User correction immediately after unsupported success claim
- Context compaction followed by forgotten requirement signal
- Skill or instruction loaded but apparently contradicted
- Approval declined followed by repeated equivalent action
- Pre-existing repository failure distinguished from introduced failure
- Unresolved error present at session completion
- Excessive search with little state change
- Relevant file discovered only after implementation began

### P1 model-assisted diagnosis

- Root-cause hypotheses
- Failure-onset candidates
- Prompt-quality critique
- Context-selection critique
- Harness and tool hypotheses
- Suggested controlled experiments
- Suggested `AGENTS.md` or skill changes

Every model-assisted output must contain:

```typescript
interface DiagnosticHypothesis {
  category:
    | "prompt"
    | "context"
    | "instruction_or_skill"
    | "model"
    | "harness"
    | "tool"
    | "environment"
    | "verification"
    | "human_intervention"
    | "unknown";
  confidence: number;
  title: string;
  explanation: string;
  evidenceEventIds: string[];
  counterEvidenceEventIds: string[];
  recommendedExperiment?: string;
}
```

No hypothesis should be shown as fact merely because an LLM produced it.

---

## 12. Root-cause taxonomy

### Prompt failure

The requested outcome, constraints, or acceptance criteria were missing, contradictory, or ambiguous.

### Context failure

Relevant information was not retrieved, was retrieved too late, was dropped, or was overwhelmed by irrelevant context.

### Instruction or skill failure

A reusable instruction was stale, conflicting, overly broad, not activated, or actively harmful.

### Model failure

The model reached an incorrect conclusion despite sufficient, correctly represented information and functioning tools.

### Harness failure

The orchestration layer selected the wrong context, truncated data, retried poorly, mishandled state, or represented tools incorrectly.

### Tool failure

A search, shell, patch, browser, MCP, or other tool failed or returned misleading results.

### Environment failure

Dependencies, runtime versions, services, secrets, network, fixtures, or pre-existing repository state prevented success.

### Verification failure

The session lacked appropriate tests, ran the wrong checks, ignored failures, or accepted weak evidence of completion.

### Human-intervention failure

The user changed scope, supplied incorrect facts, interrupted a valid path, or approved a result without adequate review.

### Unknown or multi-causal

The available evidence is insufficient or multiple causes materially contributed.

---

## 13. Analysis engine design

The analyzer should have five stages.

## 13.1 Stage 1: Event validation

- Validate schema version.
- Detect missing parents, duplicate sequence values, invalid timestamps, and malformed payloads.
- Generate capture gaps.

## 13.2 Stage 2: Feature extraction

Create derived features such as:

- Commands by category
- Failed-command signatures
- Tool retry clusters
- Files read and modified
- Diff size and churn
- Test/build/lint/typecheck outcomes
- Time spent by lane
- Token and cost distribution
- User correction count
- Approval patterns
- Context compaction positions
- Subagent tree
- Instruction and skill hashes
- Repository state before and after

## 13.3 Stage 3: Deterministic rules

Rules should be small, independently testable, and versioned.

```typescript
export interface DiagnosticRule {
  id: string;
  version: string;
  title: string;
  category: string;
  evaluate(context: AnalysisContext): Finding[];
}
```

Example rule:

```typescript
const claimedSuccessAfterFailure: DiagnosticRule = {
  id: "verification.claimed-success-after-failure",
  version: "1.0.0",
  title: "Success claimed after unresolved failure",
  category: "verification",
  evaluate(ctx) {
    const finalMessage = ctx.finalAgentMessage();
    const unresolved = ctx.failedCommandsAfterLastSuccessfulVerification();

    if (!finalMessage || unresolved.length === 0) return [];
    if (!ctx.messageClaimsSuccess(finalMessage)) return [];

    return [ctx.finding({
      severity: "high",
      confidence: 0.95,
      evidenceEventIds: [finalMessage.id, ...unresolved.map(e => e.id)],
      recommendation: "Resolve or explicitly disclose the failed verification before declaring completion."
    })];
  }
};
```

## 13.4 Stage 4: Optional model-assisted synthesis

The model receives:

- A redacted structured event summary
- Deterministic findings
- Selected evidence snippets
- User-provided outcome labels

The direct API model must not receive tools or permission to execute code during diagnosis. The optional Codex provider runs in an empty ephemeral working directory with a read-only sandbox, ignored user configuration/rules, a sanitized environment, and a strict output schema; because Codex remains an agent runtime, the UI must disclose that its boundary is broader than direct inference. Trace content must always be treated as untrusted data to reduce prompt-injection risk.

Use a two-pass structure:

1. Candidate generator proposes hypotheses.
2. Evidence verifier accepts, weakens, or rejects each hypothesis.

## 13.5 Stage 5: Human feedback

Users can:

- Confirm finding
- Reject finding
- Change category
- Add missing evidence
- Mark primary and secondary causes
- State the real outcome

This feedback becomes an anonymized local precision report and can optionally improve rule development.

---

## 14. Session scorecard

Avoid a single aggregate number. Show separate dimensions:

| Dimension | Meaning |
|---|---|
| Outcome correctness | Whether the requested behavior was achieved |
| Context utilization | Whether relevant repository information was found and used |
| Tool reliability | Whether tools succeeded and outputs were handled correctly |
| Verification quality | Strength and completeness of checks |
| Efficiency | Repetition, unnecessary work, and time/cost |
| Recovery behavior | Ability to respond to failures and corrections |
| Instruction adherence | Compliance with repository guidance and skills |
| Safety and permissions | Respect for sandbox and approval boundaries |
| Human effort | Amount of steering or correction required |
| Capture confidence | Completeness of the observable record |

Each score must show how it was calculated and which signals are uncertain.

---

## 15. Replay and evaluation system

## 15.1 Eval creation

A user selects a session and chooses “Create eval.” VibeTrace extracts:

- Baseline repository commit
- Dirty patch before the task, if any
- Original prompt
- User corrections
- Relevant constraints
- Skills and instruction hashes
- Environment fingerprint
- Verification commands
- Expected outcomes
- Captured failure category and onset candidate

The user reviews and edits the generated manifest.

```yaml
schema_version: "1"
name: database-backed-role-authorization
source_session_id: vt_session_123

repository:
  remote: optional
  base_commit: 61b75ac
  pre_task_patch: patches/pre-task.diff

task:
  prompt_file: prompt.md
  constraints:
    - Roles must come from the database.
    - Existing JWT behavior must remain compatible.
    - Unauthenticated requests return 401.
    - Unauthorized requests return 403.

configuration:
  model: inherited
  codex_version: inherited
  skills: inherited
  agents_md: inherited

success:
  commands:
    - npm test
    - npm run test:integration
  assertions:
    - type: file_exists
      path: tests/integration/admin-access.test.ts
    - type: command_exit_code
      command: npm run test:integration
      expected: 0

captured_failure:
  category: context
  onset_event_id: event_00038
```

## 15.2 Isolated execution

Every eval run should use a clean Git worktree or container. It must never replay directly in the user’s active checkout.

## 15.3 Experiment dimensions

- Prompt A vs prompt B
- Model A vs model B
- Skill disabled vs current vs revised
- `AGENTS.md` version A vs B
- Harness version A vs B
- Different context-selection policies
- Different approval or sandbox settings
- Subagents enabled vs disabled

## 15.4 Comparison metrics

- Outcome success
- Test results
- Human rating
- Files changed
- Diff size and churn
- Tool calls
- Repeated failures
- Time
- Tokens and estimated cost
- Human interventions
- Verification quality
- New diagnostics introduced

## 15.5 Important reproducibility limitation

Model outputs are nondeterministic. VibeTrace should support repeated runs and report success rates rather than presenting one replay as absolute proof.

---

## 16. Dashboard information architecture

## 16.1 Sessions page

Fields:

- Session title
- Project
- Date
- Source and model
- Duration
- Outcome label
- Capture quality
- Primary finding
- Cost/tokens when available
- Tags

Filters:

- Project
- Model
- Result
- Finding category
- Capture mode
- Date
- Skill or instruction version

## 16.2 Session overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Implement database-backed role authorization                │
│ Partial failure · Codex · 23 min · Standard capture         │
├──────────────────────────────────────────────────────────────┤
│ Primary hypothesis                                           │
│ Context retrieval failure · High confidence                  │
│ The role schema was never inspected before implementation.   │
├──────────────────────────────────────────────────────────────┤
│ Outcome   Context   Verification   Efficiency   Recovery      │
│   62%       48%         35%            81%          70%       │
├──────────────────────────────────────────────────────────────┤
│ Capture coverage                                             │
│ Prompts ✓ Tools ✓ Diffs ✓ Tests ✓ Reasoning summaries ◐     │
└──────────────────────────────────────────────────────────────┘
```

## 16.3 Unified timeline

Use synchronized lanes:

```text
Time      Conversation      Context       Tools       Code       Verify
────────────────────────────────────────────────────────────────────────
10:04     User prompt
10:05                       auth.ts read
10:06                                     grep roles
10:09     Assumes JWT role
10:12                                                auth.ts +42/-11
10:15                                     npm test                pass
10:20     Final response
10:23     User correction
```

Required behavior:

- Virtualized rendering for long sessions
- Collapsible tool output
- Jump from finding to evidence
- Highlight event ancestry
- Mark capture gaps
- Show duration and token hotspots
- Pin events for comparison

## 16.4 Event inspector

Tabs:

- Friendly view
- Raw event
- Provenance
- Related events
- Files and diffs
- Analyzer findings
- Redaction preview

## 16.5 Context map

Show:

- Instructions loaded
- Skills loaded
- Files read
- Files modified
- Files referenced but not read
- Context compaction boundaries
- Subagent-specific context

Do not imply that the model “knew” something merely because it existed in the repository. Use terms such as “observed,” “loaded,” “referenced,” and “not observed.”

## 16.6 Causal graph

```text
Role schema not inspected
          │
          ▼
Incorrect assumption about role source
          │
          ├───────────────┐
          ▼               ▼
Wrong middleware      Incomplete tests
          │               │
          └───────┬───────┘
                  ▼
          Incorrect final feature
```

Every edge should show whether it is deterministic, user-labeled, or model-inferred.

## 16.7 Compare screen

Side-by-side views for:

- Timeline
- Findings
- Diff
- Commands
- Tests
- Cost and duration
- Run fingerprint

The compare screen should identify the first meaningful divergence between runs.

---

## 17. Local architecture

```text
Codex hooks / app-server / exec JSON / OTel
                    │
                    ▼
              Source adapters
                    │
                    ▼
          Append-only local ingest spool
                    │
                    ▼
              VibeTrace daemon
     ┌──────────────┼──────────────────┐
     ▼              ▼                  ▼
Normalizer     Git/environment     Secret detector
     │              enricher             │
     └──────────────┼─────────────────────┘
                    ▼
             SQLite + blob store
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
 Deterministic analyzer   Local API/event stream
         │                     │
         ▼                     ▼
 Optional AI analyzer      React dashboard
         │
         ▼
 Findings / eval builder / export
```

## 17.1 Ingest spool

Hooks must not depend on the daemon being available. Each hook invocation should append one event to a local JSONL spool using an atomic write strategy. The daemon imports and checkpoints the spool.

Properties:

- Append-only
- Crash-safe
- Per-session files
- Rotation and retention
- File permissions restricted to the user
- Deduplication by source event ID or payload hash

## 17.2 Local daemon

Responsibilities:

- Receive events
- Normalize and enrich
- Persist data
- Stream updates to UI
- Run analyzers
- Manage exports and evals
- Report adapter health

Bind to a Unix socket where possible. If HTTP is used, bind only to loopback and require a random local auth token.

## 17.3 Storage

Use SQLite in WAL mode for metadata and queryable events. Store large payloads and artifacts in a content-addressed blob directory.

Suggested layout:

```text
~/.vibetrace/
  config.toml
  state.db
  auth-token
  spool/
  blobs/
  exports/
  logs/
```

## 17.4 Database tables

### projects

- id
- display_name
- root_path_encrypted
- path_hash
- vcs_remote_hash
- created_at

### sessions

- id
- source
- source_session_id
- project_id
- title
- started_at
- ended_at
- status
- capture_mode
- capture_score
- model
- source_version
- base_commit
- final_commit
- run_fingerprint_json

### turns

- id
- session_id
- source_turn_id
- sequence
- started_at
- ended_at
- status

### events

- id
- session_id
- turn_id
- parent_event_id
- sequence
- timestamp
- source
- type
- subtype
- status
- tool_name
- summary
- duration_ms
- usage_json
- payload_blob_hash
- raw_blob_hash
- sensitivity
- provenance_json

### artifacts

- id
- session_id
- event_id
- kind
- path_encrypted
- path_hash
- content_hash
- blob_hash
- metadata_json

### findings

- id
- session_id
- rule_id
- detector_version
- category
- severity
- confidence
- title
- explanation
- evidence_event_ids_json
- counterevidence_event_ids_json
- recommendation
- state

### annotations

- id
- target_type
- target_id
- label
- note
- created_at

### eval_cases

- id
- source_session_id
- name
- manifest_blob_hash
- created_at

### eval_runs

- id
- eval_case_id
- configuration_json
- source_session_id
- status
- outcome_json
- metrics_json

### redaction_profiles

- id
- name
- rules_json

---

## 18. Recommended technology stack

### Language and monorepo

- TypeScript
- pnpm workspaces
- Turborepo or Nx; prefer Turborepo for a smaller initial surface

### CLI

- Node.js
- Commander or Clipanion
- Zod for configuration and command validation

### Daemon and local API

- Fastify or Hono on Node.js
- WebSocket or Server-Sent Events for live updates
- Unix-domain socket for hook ingestion where available

### Database

- SQLite
- Drizzle ORM
- WAL mode
- FTS5 for local search

### UI

- React
- Vite
- TanStack Router
- TanStack Query
- TanStack Virtual
- Tailwind CSS
- Monaco or a focused diff component
- React Flow for causal graphs

### Validation

- Zod for runtime validation
- JSON Schema export for adapters and bundles

### Tests

- Vitest
- Playwright
- Testcontainers only where necessary
- Golden trace fixtures

### Packaging

- Start as CLI + browser dashboard
- Add a Tauri desktop wrapper only after the local web experience is stable

### Why not Electron or Tauri immediately?

A desktop shell introduces updater, signing, native dependency, and cross-platform complexity before the product has proven its core value. The first release should optimize for capture correctness and analysis quality.

---

## 19. Monorepo structure

```text
vibetrace/
  AGENTS.md
  README.md
  LICENSE
  CONTRIBUTING.md
  SECURITY.md
  CODE_OF_CONDUCT.md

  apps/
    dashboard/
    docs/

  packages/
    cli/
    daemon/
    schema/
    core/
    storage/
    adapter-sdk/
    adapter-codex-hooks/
    adapter-codex-app-server/
    adapter-codex-exec/
    git-observer/
    environment-fingerprint/
    analyzer-core/
    analyzer-rules/
    analyzer-ai/
    redaction/
    export-bundle/
    eval-spec/
    eval-runner/
    ui-components/
    test-fixtures/

  docs/
    product/
      product-plan.md
    architecture/
      overview.md
      event-schema.md
      capture-modes.md
      privacy.md
    decisions/
      0001-local-first.md
      0002-canonical-event-schema.md
      0003-codex-first.md
      0004-deterministic-analysis-first.md
    adapters/
      codex.md
    rules/
      authoring.md
    evals/
      format.md

  examples/
    sample-traces/
    sample-evals/

  rfcs/
```

---

## 20. CLI design

```bash
# Setup
vibetrace init codex
vibetrace doctor
vibetrace uninstall codex

# Local application
vibetrace start
vibetrace stop
vibetrace open
vibetrace status

# Sessions
vibetrace sessions list
vibetrace sessions show <session-id>
vibetrace import <path>
vibetrace delete <session-id>

# Export
vibetrace export <session-id> --profile share-safe
vibetrace export <session-id> --profile metadata-only

# Evals
vibetrace eval create <session-id>
vibetrace eval validate <eval-path>
vibetrace eval run <eval-path>
vibetrace eval compare <run-id-a> <run-id-b>

# Adapters
vibetrace adapters list
vibetrace adapters doctor codex
```

Example configuration:

```toml
[storage]
retention_days = 90
capture_file_contents = false
capture_diffs = true
capture_tool_outputs = true

[privacy]
secret_detection = true
path_mode = "encrypted"
redact_env_values = true

[analysis]
deterministic = true
ai_assisted = false

[adapters.codex]
enabled = true
capture_mode = "hooks"
transcript_enrichment = true
otel_enrichment = false
```

---

## 21. Privacy and security plan

## 21.1 Default privacy posture

- No account required
- No external network requests required
- No cloud upload
- No product analytics by default
- No raw environment-variable values
- No automatic sharing
- Local retention controls

## 21.2 Capture profiles

### Minimal

Stores metadata, event types, timing, hashes, and exit codes. Does not store prompt text, full tool output, or diffs.

### Standard local

Stores prompts, messages, tool inputs/outputs, and diffs locally. Does not store complete repository snapshots.

### Full forensics

Stores selected file snapshots and richer environment details. Requires explicit opt-in.

## 21.3 Secret detection

Scan before persistence and before export for:

- Common API-key formats
- Private keys
- Password-like fields
- Authorization headers
- High-entropy tokens
- `.env` contents
- Database connection strings

Secret detection is imperfect. The export preview must make that clear and require explicit user confirmation.

## 21.4 Encryption

- Encrypt sensitive paths and blobs at rest.
- Store the encryption key in the OS keychain where possible.
- Provide passphrase fallback.
- Encrypt portable bundles.

## 21.5 Local service security

- Bind only to loopback or Unix socket.
- Require a random local token.
- Apply strict CORS.
- Escape all rendered trace content.
- Never execute imported trace content.
- Defend against path traversal in imported bundles.
- Set size limits for payloads and archives.

## 21.6 AI analyzer security

Trace content may contain prompt injections. The analyzer must:

- Receive data in a structured envelope.
- Be instructed that trace content is untrusted evidence.
- Give the direct API provider no tools or callback access.
- Run the Codex provider only in its documented empty, ephemeral, read-only sandbox with sanitized environment and no trace content in argv.
- Produce schema-validated hypotheses only.
- Never follow instructions found inside captured prompts or tool output.

---

## 22. Milestone roadmap with exit criteria

The project should progress through sequential milestones. Do not start the next milestone until the exit criteria are met.

## Milestone 0: Product and schema foundation

### Deliverables

- Monorepo
- Product plan and architecture docs
- Canonical event schema v0
- Synthetic trace generator
- Five representative sample traces
- Basic dashboard shell
- CI, formatting, linting, and tests

### Exit criteria

- A synthetic session with at least 1,000 events validates and renders.
- Schema changes require migration tests.
- Dashboard can open a static trace and inspect an event.

## Milestone 1: Codex hook capture

### Deliverables

- Safe hook installer and uninstaller
- Hook collector executable
- Append-only spool
- Session/turn correlation
- Prompt, tool, permission, compaction, subagent, stop, and end capture
- Adapter health checks

### Exit criteria

- Ten representative Codex sessions are captured.
- Daemon downtime does not lose hook events.
- Existing Codex hook configuration survives install and uninstall.
- Every event has provenance and source version.

## Milestone 2: Repository and verification enrichment

### Deliverables

- Git baseline and final state
- File-change and diff enrichment
- Command classification
- Test/build/lint/typecheck parsing
- Environment fingerprint
- Instruction and skill hashing

### Exit criteria

- The system correctly identifies changed files and verification commands in fixture sessions.
- Pre-existing repository failures can be distinguished from newly introduced failures in controlled fixtures.

## Milestone 3: Useful dashboard

### Deliverables

- Sessions page
- Session overview
- Unified timeline
- Event inspector
- Conversation, tool, code, and verification lanes
- Diff viewer
- Search and filters
- Capture coverage panel
- Annotations

### Exit criteria

- A 20,000-event session remains usable.
- A user can locate the first failed command, related diff, and final claim without opening raw JSON.
- Every missing data class is visibly represented as a capture gap.

## Milestone 4: Deterministic diagnostics

### Deliverables

- Rule SDK
- Initial rule pack
- Evidence-linked findings
- Finding feedback
- Local labeled fixture corpus

### Exit criteria

- At least ten rules have positive, negative, and edge-case tests.
- Findings never appear without evidence IDs.
- A labeled test set reports precision and recall per rule.

## Milestone 5: Redaction and portable bundles

### Deliverables

- Secret scanner
- Redaction profiles
- Export preview
- Encrypted portable bundle
- Bundle importer

### Exit criteria

- Standard export excludes raw repository file contents by default.
- Known test secrets are redacted.
- Importing an untrusted bundle cannot write outside the designated import directory.

## Milestone 6: Full-fidelity Codex Lab mode

### Deliverables

- App-server stdio client
- Rich streamed item support
- Approval handling
- Plans and provider-exposed reasoning support
- Token usage
- Turn diff updates
- Version-specific schema generation

### Exit criteria

- A controlled session can be run from VibeTrace and reconstructed without transcript parsing.
- The UI clearly distinguishes reasoning summaries, exposed reasoning content, and model messages.

## Milestone 7: Eval creation and replay

### Deliverables

- Eval manifest
- Session-to-eval wizard
- Git worktree runner
- Success checks
- Codex batch execution
- Run result storage

### Exit criteria

- A failed session can become an eval and rerun from a clean worktree.
- The active checkout is never modified.
- Verification commands and outcomes are stored.

## Milestone 8: Controlled comparison

### Deliverables

- Prompt/model/skill configuration matrix
- Repeated runs
- Side-by-side comparison
- First-divergence detection
- Aggregate success-rate reporting

### Exit criteria

- Users can compare at least two prompt or skill variants on the same eval.
- Results show outcome, cost, time, tools, changes, and findings.

## Milestone 9: Adapter ecosystem

### Deliverables

- Adapter SDK
- Conformance tests
- Documentation
- Second coding-agent adapter
- Public RFC process

### Exit criteria

- A third party can build an adapter without modifying the core.
- Adapter capability gaps appear correctly in the UI.

---

## 23. First build backlog for Codex

Do not ask Codex to “build the whole product.” Give it one vertical slice at a time.

### Task 1: Bootstrap the repository

Deliver:

- pnpm monorepo
- TypeScript configuration
- lint, format, test, and build commands
- minimal React dashboard
- minimal CLI
- CI

Verify:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### Task 2: Implement canonical schema

Deliver:

- Event types
- Zod schemas
- JSON Schema output
- version field
- migration interface
- fixture generator

Verify:

- Valid fixtures pass.
- Invalid fixtures fail with useful paths.
- JSON round trips preserve unknown raw fields.

### Task 3: Build storage layer

Deliver:

- SQLite migrations
- sessions, turns, events, artifacts
- blob store
- repository abstraction
- integration tests

Verify:

- Import 10,000 events.
- Query by session, type, tool, and time.
- Restart process without data loss.

### Task 4: Build ingest spool and daemon

Deliver:

- atomic append spool
- daemon importer
- deduplication
- local health endpoint
- crash recovery

Verify:

- Kill daemon during event write.
- Restart and confirm all events import exactly once.

### Task 5: Build Codex hook adapter

Deliver:

- hook executable
- event mapping
- installer preview
- backup and uninstall
- doctor command

Verify:

- Existing hooks remain intact.
- Install is idempotent.
- Uninstall removes only VibeTrace entries.
- Prompt and tool fixture payloads normalize correctly.

### Task 6: Build session list and event inspector

Deliver:

- local API
- sessions page
- event list
- event inspector
- search

Verify:

- Browser can inspect imported trace.
- Raw and normalized payloads are visible.
- UI handles large outputs without freezing.

### Task 7: Build unified timeline

Deliver:

- lane model
- virtualized timeline
- event grouping
- filters
- keyboard navigation

Verify:

- 20,000-event fixture remains responsive.
- Clicking an event synchronizes all lanes.

### Task 8: Add Git and command enrichment

Deliver:

- baseline commit
- dirty patch hash
- changed files
- command classification
- test result extraction

Verify:

- Fixtures correctly classify npm, pnpm, pytest, cargo, and go test commands.
- File-change timeline matches Git diffs.

### Task 9: Implement first five diagnostic rules

Recommended first rules:

1. No tests after final code change
2. Success claim after unresolved failure
3. Repeated identical failed command
4. Modified file without observed read
5. Unresolved error at session end

Verify:

- Positive and negative fixtures for every rule.
- Findings link to event IDs.
- Rule output is deterministic.

### Task 10: Build annotations and outcome labels

Deliver:

- session outcome
- finding confirm/reject
- primary cause
- notes

Verify:

- Feedback survives reload.
- Analyzer reruns preserve user decisions where appropriate.

### Task 11: Build redacted export

Deliver:

- metadata-only and share-safe profiles
- secret scanning
- preview UI
- portable bundle

Verify:

- Test keys are removed.
- Excluded artifacts do not exist in archive.
- Bundle imports correctly.

### Task 12: Build eval manifest only

Before implementing execution, create the format and wizard.

Verify:

- A captured session generates a valid editable manifest.
- All inferred constraints are marked as inferred.

---

## 24. Using Codex effectively to build VibeTrace

## 24.1 Repository guidance

Use a root `AGENTS.md` for permanent rules:

- Architecture boundaries
- Commands
- Test expectations
- Privacy constraints
- Definition of done
- Prohibition on unrelated refactors

Use nested `AGENTS.md` or overrides only when a package needs specialized instructions.

## 24.2 One thread per coherent slice

Do not keep the entire product in one endless Codex thread. Create separate threads for:

- Schema
- Storage
- Hook adapter
- Timeline UI
- Analyzer rules
- Export security
- Eval runner

Each thread should start from the relevant product-plan section and end with verification evidence.

## 24.3 Recommended Codex prompt structure

```text
Goal
Implement [one vertical slice].

Context
Read AGENTS.md and these docs:
- docs/architecture/...
- docs/product/...

Scope
Files/packages allowed to change: ...
Do not change: ...

Requirements
1. ...
2. ...

Acceptance criteria
- ...
- ...

Verification
Run:
- pnpm lint
- pnpm typecheck
- pnpm test --filter ...

Process
First inspect the existing implementation and write a brief plan.
Then implement in small commits or logical steps.
Do not declare completion unless every acceptance criterion is checked.
```

## 24.4 Use subagents selectively

Good parallel work:

- Researching Codex event mappings
- Designing fixtures
- Reviewing database migrations
- Reviewing UI accessibility
- Threat modeling export/import

Bad parallel work:

- Multiple agents editing the same schema
- Multiple agents changing shared migrations
- Building UI before API contracts are stable

## 24.5 Separate implementer and reviewer

For important slices:

1. Implementer thread writes code.
2. Reviewer thread receives the diff and requirements.
3. Reviewer looks for correctness, security, migration, and test gaps.
4. Implementer addresses only actionable findings.

## 24.6 Persist recurring corrections

When Codex repeats a mistake, update `AGENTS.md`, a focused skill, or an architecture decision. Do not rely on remembering the correction in future prompts.

---

## 25. Testing strategy

## 25.1 Golden trace fixtures

Maintain fixtures for:

- Successful simple edit
- Failed test ignored
- User correction
- Context compaction
- Subagent delegation
- Tool denial
- Repeated command failure
- Pre-existing broken repository
- Large terminal output
- Missing transcript data
- Unsupported adapter event

Every adapter change should rerun these fixtures.

## 25.2 Contract tests

- Source event → canonical event mapping
- Schema migration
- Export/import round trip
- Adapter capability declaration
- Diagnostic finding schema

## 25.3 Property tests

Useful invariants:

- Event sequence remains total and stable.
- Importing the same raw event twice is idempotent.
- Export never includes excluded blobs.
- Redaction never modifies the private original.
- Findings never reference nonexistent events.

## 25.4 Performance tests

Target scenarios:

- 20,000 events per session
- 100 MB of terminal output
- 1,000 changed files
- 100 concurrent subagent branches in a synthetic trace
- 10,000 locally stored sessions

## 25.5 Security tests

- Path traversal archives
- Zip bombs and oversized payloads
- HTML/script injection in prompts and terminal output
- Malicious ANSI sequences
- Secret formats
- Symlink attacks
- Corrupt SQLite and partial spool writes
- Prompt injection against AI analyzer

---

## 26. Product metrics

## 26.1 Activation

- User completes Codex setup.
- First session is captured.
- First session is opened in the dashboard.
- First finding is reviewed.

## 26.2 Core value

- Percentage of sessions with user-confirmed useful findings
- Time from opening session to identifying a likely failure origin
- Percentage of failed sessions converted into evals
- Percentage of experiments that produce a clear configuration difference

## 26.3 Quality

- Capture completeness by adapter and version
- Event-loss rate
- Finding precision and recall by rule
- False-secret-detection rate
- Export safety incidents
- UI performance on large traces

## 26.4 Retention

- Weekly active local installations, only if user opts into anonymous telemetry
- Sessions reviewed per active user
- Repeat eval usage
- Number of community adapters and rules

Do not collect usage telemetry by default. Local metrics should still be available to the user.

---

## 27. Open-source strategy

## 27.1 License

Use Apache-2.0 for the codebase because it includes an explicit patent grant and is friendly to broad commercial and open-source adoption.

## 27.2 Open components

Keep these open:

- Canonical event specification
- All local adapters
- Local dashboard
- Deterministic analyzer
- Diagnostic rule SDK
- Eval bundle format
- Local eval runner
- Redaction and export

## 27.3 Community contribution surfaces

- New source adapters
- New command parsers
- Diagnostic rules
- Trace fixtures
- UI panels
- Language and framework-specific verification logic
- Eval cases for open-source repositories

## 27.4 Governance

- Public roadmap
- RFC folder
- Architecture decision records
- Maintainer guide
- Stable contribution labels
- Regular releases and changelogs
- Security reporting policy

## 27.5 Avoid fake growth

The project should earn adoption through usefulness. Do not optimize for superficial stars at the expense of a stable product. Meaningful signals include:

- Real captured sessions
- External issues and fixes
- Third-party adapters
- Reusable eval cases
- Package downloads
- Downstream integrations
- Maintainer activity

---

## 28. Launch strategy

## 28.1 Launch message

> You spend hours coding with AI, but when a session fails you are left with a chat transcript and a bad diff. VibeTrace records the observable execution, reconstructs the session, links failures to evidence, and turns the result into a replayable eval.

## 28.2 Launch demo

The first demo should show one concrete failure:

1. Codex receives a feature request.
2. It never inspects the relevant schema.
3. It makes a wrong assumption.
4. Unit tests pass but integration behavior fails.
5. VibeTrace identifies the first likely failure point.
6. The user creates a revised skill.
7. The eval reruns and succeeds.

This tells the entire product story in one sequence.

## 28.3 README structure

1. One-sentence value proposition
2. GIF or short video
3. Install command
4. “Record your first Codex session”
5. Screenshots
6. Privacy promise
7. Supported capture matrix
8. Example diagnostics
9. Roadmap
10. Contributing

## 28.4 Initial adoption wedge

Start with people who already use Codex intensively and care about:

- Prompt quality
- Skills
- Agent workflows
- Open-source maintenance
- Coding-agent comparisons

The strongest early users are not casual chatbot users. They are developers who already experience expensive or confusing agent failures.

---

## 29. Business model, later

The open-source local product should remain fully useful.

Possible paid layers:

- Encrypted team synchronization
- Self-hosted team server
- Shared annotations and review workflows
- Managed eval runners
- Scheduled regression suites
- Organization policies
- Long-term artifact retention
- SSO and audit controls
- Private adapter distribution

Do not put basic capture, local diagnosis, or eval creation behind a paywall. Those are the adoption engine and the open-source value.

---

## 30. Major risks and mitigations

### Risk: Capture APIs change

**Mitigation:** Version every adapter, preserve raw events, generate installed-version schemas where supported, maintain golden fixtures, and visibly report capability gaps.

### Risk: Product becomes only a pretty log viewer

**Mitigation:** Prioritize evidence-linked diagnostics and eval conversion immediately after timeline quality.

### Risk: Root-cause attribution is unreliable

**Mitigation:** Separate deterministic facts from hypotheses, show counterevidence, collect user feedback, and recommend controlled experiments.

### Risk: Privacy concerns block adoption

**Mitigation:** Local-first defaults, transparent capture profiles, export preview, encryption, no telemetry by default, and no account requirement.

### Risk: Too much scope for a solo builder

**Mitigation:** Codex-first, browser dashboard, deterministic rules, no team cloud, and strict milestone exit criteria.

### Risk: The UI cannot handle long sessions

**Mitigation:** Virtualized timeline, blob storage, progressive loading, precomputed summaries, and performance fixtures from the beginning.

### Risk: LLM analyzer follows malicious trace instructions

**Mitigation:** No tools, structured input, explicit untrusted-data boundary, schema validation, and evidence verifier pass.

### Risk: Replay damages user code

**Mitigation:** Mandatory clean worktrees or containers and refusal to run evals in the active checkout.

### Risk: Users blame models incorrectly

**Mitigation:** Require strong evidence before assigning model failure and prefer “insufficient evidence” when prompt, context, or harness explanations remain plausible.

---

## 31. Definition of MVP

The MVP is complete when a user can:

1. Install the Codex integration safely.
2. Use Codex normally.
3. Open a captured session locally.
4. See prompts, local tool calls, tool outputs, terminal commands, diffs, tests, approvals, compaction, subagents, and final responses when exposed.
5. See a transparent capture-coverage report.
6. Navigate a unified timeline.
7. Inspect code and verification history.
8. Receive at least five useful deterministic findings linked to evidence.
9. Annotate the real outcome and root cause.
10. Export a scrubbed portable trace.

The MVP does **not** require:

- Multiple agent integrations
- Hosted accounts
- Team collaboration
- Automatic replay
- Cross-model matrices
- A desktop installer

---

## 32. Definition of product-market signal

Before expanding scope, look for these signals:

- Users repeatedly inspect sessions rather than opening the dashboard once.
- Users confirm that findings reveal mistakes they missed manually.
- Users share scrubbed bundles in GitHub issues or discussions.
- Users maintain eval cases generated from real failures.
- External contributors add rules or adapters.
- Users revise prompts, `AGENTS.md`, or skills based on VibeTrace evidence.

The strongest signal is not downloads. It is that users change their AI coding workflow because VibeTrace showed them something they could not easily see before.

---

## 33. Codex for Open Source positioning

VibeTrace can become a credible candidate because it directly supports open-source maintenance workflows:

- Debugging AI-generated patches
- Reviewing agent tool use and verification
- Creating reusable regression evals from issue fixes
- Improving repository instructions and skills
- Sharing scrubbed traces with contributors
- Comparing maintainer automations

A future application should be based on real evidence:

- Public repository
- Active releases
- External users
- Issues and pull requests
- Third-party rules or adapters
- Download or usage metrics
- Examples of maintainers using it in real repositories

Potential API-credit use:

- Optional evidence-grounded diagnosis
- Eval reruns
- Pull-request trace summaries
- Maintainer regression suites
- Release and issue workflow evaluation

---

## 34. Final product decisions

1. **Working name:** VibeTrace.
2. **Core promise:** Turn every AI coding session into an eval.
3. **First customer:** Serious Codex users, not generic chatbot users.
4. **First integration:** Codex lifecycle hooks.
5. **First UI:** Local browser dashboard.
6. **First database:** SQLite plus content-addressed blobs.
7. **First analysis:** Deterministic rules.
8. **First advanced feature:** Session-to-eval conversion.
9. **Privacy:** Local, accountless, no telemetry by default.
10. **Open-source core:** Schema, adapters, analyzer, UI, and eval runner.
11. **Hard boundary:** Never claim unavailable hidden reasoning.
12. **Hard safety rule:** Never replay in the active checkout.
13. **Scope rule:** Do not add a second agent until the Codex adapter and timeline are reliable.
14. **Quality rule:** No diagnosis without evidence links.
15. **Build rule:** One vertical slice per Codex thread, with explicit acceptance criteria and verification.

---

## 35. Immediate next action

Start with Milestone 0 and Task 1 only. Create the repository, add the product documentation, establish the canonical schema package, generate synthetic traces, and render one static session in the dashboard.

Do not begin with AI diagnosis, replay, cloud sync, or multiple adapters. The quality of every later feature depends on a trustworthy event model and a timeline that can explain one session clearly.
