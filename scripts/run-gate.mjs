import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const vitest = join(
  repositoryDirectory,
  'node_modules',
  'vitest',
  'vitest.mjs',
);
const gates = {
  integration: [
    'packages/schema/src/index.test.ts',
    'packages/storage/src/index.test.ts',
    'packages/daemon/src/index.test.ts',
    'packages/adapter-codex/src/index.test.ts',
    'packages/adapter-codex-app-server/src/index.test.ts',
    'packages/adapter-generic-jsonl/src/index.test.ts',
    'packages/bundle/src/index.test.ts',
    'packages/eval-runner/src/index.test.ts',
    'packages/eval-compare/src/index.test.ts',
    'packages/analyzer-ai/src/index.test.ts',
    'packages/diagnostics/src/scorecard.test.ts',
  ],
  e2e: [
    'apps/dashboard/src/App.test.tsx',
    'apps/dashboard/src/EvalsPage.test.tsx',
    'packages/cli/src/program.test.ts',
  ],
  security: [
    'packages/storage/src/index.test.ts',
    'packages/daemon/src/index.test.ts',
    'packages/bundle/src/codec.test.ts',
    'packages/bundle/src/redaction.test.ts',
    'packages/bundle/src/index.test.ts',
    'packages/analyzer-ai/src/index.test.ts',
    'packages/adapter-codex-app-server/src/index.test.ts',
  ],
  performance: [
    'packages/test-fixtures/src/index.test.ts',
    'packages/storage/src/index.test.ts',
    'packages/enrichment/src/index.test.ts',
    'packages/diagnostics/src/index.test.ts',
    'packages/diagnostics/src/scorecard.test.ts',
    'packages/eval-runner/src/index.test.ts',
    'apps/dashboard/src/App.test.tsx',
  ],
};

const gate = process.argv[2];
const files = gates[gate];
if (!files) throw new Error(`Unknown verification gate: ${gate ?? '(none)'}.`);

const child = spawn(
  process.execPath,
  [
    vitest,
    'run',
    ...files,
    '--config',
    join(repositoryDirectory, 'vitest.config.ts'),
  ],
  { cwd: repositoryDirectory, stdio: 'inherit' },
);
child.once('error', (error) => {
  throw error;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
