# Contributing to VibeTrace

Thank you for contributing. Please read the [product plan](docs/product/product-plan.md), the [architecture overview](docs/architecture/overview.md), and the repository guidance in `AGENTS.md` before starting work.

## Before opening a change

1. Keep the change focused; avoid unrelated refactors.
2. Preserve raw trace events and represent missing data as explicit capture gaps.
3. Validate untrusted input at runtime and do not add network upload or telemetry by default.
4. Add or update tests and documentation when behavior changes.

Run the full local verification suite:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Report security vulnerabilities privately according to the [security policy](SECURITY.md). By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
