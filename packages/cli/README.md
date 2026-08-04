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

Captured data stays encrypted on the local machine. Portable bundles are scrubbed derived views and are always protected with standard age passphrase encryption.

See the repository README and security policy for supported platforms, threat boundaries, and disclosure instructions.
