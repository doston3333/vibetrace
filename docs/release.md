# Release gate

VibeTrace's release workflow publishes the local-first CLI as the
`@vibetrace/cli` npm package. The package contains the command-line entry point, loopback
daemon, compiled dashboard assets, source adapters, isolated eval runner, and
comparison tooling. The SQLCipher-compatible database and OS keyring bindings
remain platform-native npm dependencies.

## Supported matrix

| Platform                      | Architecture | CI runtime                             |
| ----------------------------- | ------------ | -------------------------------------- |
| macOS 14+                     | x64, arm64   | Node 24 (`macos-15-intel`, `macos-15`) |
| Ubuntu-compatible glibc Linux | x64          | Node 22.12.0, Node 24                  |
| Windows 11                    | x64          | Node 24                                |

WSL2 follows the Linux path. Node 22.12.0 is the minimum supported runtime.

## Required verification

Every release candidate must pass:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm schema:check
pnpm release:config-check
pnpm test:release-candidate-check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:e2e
pnpm test:browser
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

`pnpm test:browser` builds the bundled CLI/dashboard, starts a real isolated
loopback daemon, redeems a single-use browser handoff in Chromium, navigates
from the session archive into evidence, verifies canonical/raw IDs and
filtering, and fails on browser console or page errors. CI retains its trace,
screenshot, and video on failure.

`pnpm test:performance` combines scale fixtures with explicit elapsed-time
budgets for 20,000-event timeline construction, deterministic analysis,
10,000-session storage indexing, and 100 independently paired subagent
branches. The 100 MB streaming-blob case has a bounded test timeout and avoids
constructing a 100 MB input buffer.

Before tagging, produce native Codex evidence from a maintainer workstation
that is already signed in to Codex with ChatGPT. The isolated smoke harness
copies only the bounded local `auth.json` into its temporary Codex home, strips
credential variables from the child environment, packs and installs the exact
local CLI tarball, and runs read-only lifecycle-hook and app-server sessions.
It verifies captured event provenance through the authenticated daemon API and
prints only metadata (never prompts, model output, or credentials):

```bash
codex login status
env -u OPENAI_API_KEY -u CODEX_ACCESS_TOKEN \
  VIBETRACE_CODEX_AUTH_HOME="${CODEX_AUTH_HOME:-$HOME/.codex}" \
  VIBETRACE_CODEX_MODEL=gpt-5.6-terra \
  VIBETRACE_NATIVE_SMOKE_OUTPUT="$TMPDIR/vibetrace-native-smoke.json" \
  npm exec --yes --package=@openai/codex@0.146.1 -- \
  sh -c 'codex --version && codex login status && pnpm native:smoke'
```

The auth file is never committed, uploaded as a GitHub secret, or included in
the metadata report. The harness also verifies wrong-passphrase rejection and
recovery with the correct local envelope. The default smoke model is
`gpt-5.6-terra`, a current Codex CLI model for ChatGPT sign-in, so a different
workstation default cannot silently alter the release evidence. Hosted GitHub
runners deliberately do not invoke a live model because a local ChatGPT Codex
session cannot be safely transferred to them. Cross-platform behavior remains
covered by the deterministic Ubuntu, macOS x64/arm64, and Windows CI matrix;
the maintainer-local smoke is the live Codex acceptance record for the exact
candidate commit.

## npm trusted publishing

Version-tag pushes run `.github/workflows/release-gate.yml`. After
cross-platform verification passes, its release-candidate step requires the
exact `v<packages/cli version>` tag, validates the public CLI
metadata, rejects tracked checkout changes, and confirms that the npm version is
not already published. The publishing job packs one tarball and publishes that
same tarball with `npm publish --access public`; it then checks the exact
registry version.

Publishing uses npm trusted publishing, not an `NPM_TOKEN`. Configure npm with
these exact trusted-publisher values:

| Setting           | Value                  |
| ----------------- | ---------------------- |
| GitHub owner      | `doston3333`           |
| GitHub repository | `doston3333/vibetrace` |
| workflow          | `release-gate.yml`     |
| environment       | `npm-production`       |
| action            | `npm publish`          |

The job runs on a GitHub-hosted Ubuntu runner with Node 24, npm `11.17.0`,
`contents: read`, and `id-token: write`. It does not use a dependency cache or
store a registry token. npm trusted publishing must be configured in npm before
the workflow can publish. In particular, npm cannot configure a trusted
publisher for a package that has not yet been published, so the first public
publication must be completed through npm’s approved bootstrap process before
this automated path can publish later versions.

### First-publication bootstrap

Do this only after the release PR's cross-platform CI and maintainer-local
Codex-auth evidence are green. The bootstrap exists solely to create the npm
package so trusted publishing can be configured; it is not the stable release.

1. Create a clean temporary checkout at the verified commit. In that checkout,
   set only `packages/cli/package.json` to `0.1.0-bootstrap.0` and build the CLI.
2. Run `npm pack --dry-run` and inspect the file list, then create the tarball
   with `pnpm --filter @vibetrace/cli pack --pack-destination <private-temp-dir>`.
3. From a maintainer workstation authenticated with npm 2FA, publish that exact
   tarball with `npm publish <tarball> --access public --tag bootstrap`.
4. Confirm `npm view @vibetrace/cli@0.1.0-bootstrap.0 version`, then configure
   the trusted publisher values above and remove any temporary automation token.
5. Leave the repository's stable version at `0.1.0`. Push `v0.1.0` only after
   the trusted publisher and `npm-production` environment protections are in
   place; the release workflow then publishes the stable package with OIDC.

Never commit the bootstrap version to `main`, reuse the bootstrap tag as
`latest`, or bypass the Codex-auth/cross-platform release evidence.
