# VibeTrace

VibeTrace is currently a repository foundation only. The dashboard is a visible placeholder and the CLI exposes its identity, version, and help; trace capture, storage, diagnostics, exports, and evaluations are not implemented yet.

## Requirements

- Node.js 22.12.0 or later
- pnpm 10.33.4

## Workspace layout

- `apps/dashboard` — React and Vite dashboard placeholder
- `packages/cli` — `vibetrace` command-line placeholder

## Commands

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Local use

Start the dashboard placeholder:

```bash
pnpm --filter @vibetrace/dashboard dev
```

Build the CLI, then inspect its available commands:

```bash
pnpm --filter @vibetrace/cli build
pnpm exec vibetrace --help
pnpm exec vibetrace --version
```
