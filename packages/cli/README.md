# @vibetrace/cli

VibeTrace is a local-first forensic debugger for observable Codex coding sessions.

Requires Node.js 22.12 or later. Install the CLI, preview the exact Codex hook changes, then approve them in Codex with `/hooks`:

```bash
npm install --global @vibetrace/cli
vibetrace init codex --dry-run
vibetrace init codex
vibetrace doctor
vibetrace open
```

For opt-in full-fidelity Codex Lab capture, use `--approval-policy prompt` to
review each server approval request. The prompt policy shows bounded,
control-character-sanitized command context and defaults to denial when no
interactive terminal is available. Existing threads can be resumed or forked:

```bash
vibetrace codex app-server --prompt "Inspect the repository" --approval-policy prompt
vibetrace codex app-server --prompt "Continue" --thread-mode resume --thread-id <thread-id>
vibetrace codex app-server --prompt "Try an alternative" --thread-mode fork --thread-id <thread-id> --last-turn-id <turn-id>
```

Captured data stays encrypted on the local machine. Portable bundles are scrubbed derived views and are always protected with standard age passphrase encryption.

See the repository README and security policy for supported platforms, threat boundaries, and disclosure instructions.
