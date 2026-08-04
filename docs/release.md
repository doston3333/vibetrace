# Release gate

VibeTrace publishes the production local-first CLI as the `@vibetrace/cli`
npm package. The package contains the command-line entry point, loopback
daemon, compiled dashboard assets, source adapters, isolated eval runner, and
comparison tooling. The SQLCipher-compatible database and OS keyring bindings
remain platform-native npm dependencies.

## Supported matrix

| Platform                      | Architecture | CI runtime                       |
| ----------------------------- | ------------ | -------------------------------- |
| macOS 14+                     | x64, arm64   | Node 24 (`macos-13`, `macos-14`) |
| Ubuntu-compatible glibc Linux | x64          | Node 22.12.0, Node 24            |
| Windows 11                    | x64          | Node 24                          |

WSL2 follows the Linux path. Node 22.12.0 is the minimum supported runtime.

## Required verification

Every release candidate must pass:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm test:performance
pnpm pack:smoke
```

`pnpm pack:smoke` builds and packs the exact npm artifact, installs it into a
temporary global prefix, and exercises initialization, hook collection,
daemon authentication and lifecycle, dashboard serving, encrypted export and
import, a clean-worktree eval run with a mock Codex executable and effective
policy assertions, and ownership-safe hook uninstall. It uses isolated
VibeTrace and Codex homes and removes them afterward.

`pnpm test:performance` combines scale fixtures with explicit elapsed-time
budgets for 20,000-event timeline construction, deterministic analysis,
10,000-session storage indexing, and 100 independently paired subagent
branches. The 100 MB streaming-blob case has a bounded test timeout and avoids
constructing a 100 MB input buffer.

To produce native Codex evidence, authenticate the Codex CLI without putting a
key in arguments, then run the isolated smoke harness. It packs and installs
the exact local CLI tarball, creates a disposable Git checkout and Codex home,
executes one read-only lifecycle-hook session and one read-only app-server
session, verifies captured event provenance through the authenticated daemon
API, and prints only metadata (never prompts or model output):

```bash
printf '%s\n' "$OPENAI_API_KEY" | CODEX_HOME="$TMPDIR/vibetrace-codex-home" codex login --with-api-key
VIBETRACE_CODEX_AUTH_HOME="$TMPDIR/vibetrace-codex-home" \
  VIBETRACE_NATIVE_SMOKE_OUTPUT="$TMPDIR/vibetrace-native-smoke.json" \
  pnpm native:smoke
```

The reusable `Native Codex smoke` workflow runs this harness on Ubuntu, both
supported macOS runner architectures, and Windows, and uploads one
metadata-only evidence artifact per runner. It also verifies that a wrong
storage passphrase is rejected and that the correct passphrase can unlock the
same local envelope afterward. It requires the repository's
`CODEX_OPENAI_API_KEY` secret and is intentionally separate from ordinary
pull-request CI because it invokes a real model. The `Release gate` workflow
calls both the full cross-platform CI matrix and this native-smoke workflow for
version tags or an explicit manual run. The native harness exercises both the
Codex lifecycle-hook path and the opt-in `codex app-server` path, aggregating
bounded evidence when a server emits a provisional capture gap before its
thread identifier is known.

The release workflow is complete only after the CI matrix passes and a native
Codex smoke session has been recorded on macOS, Linux, and Windows. A local
pass on one operating system is not evidence for the other two.
