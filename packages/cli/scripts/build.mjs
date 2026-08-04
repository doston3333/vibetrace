import { readFile, rm, chmod, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(scriptDirectory);
const repositoryDirectory = join(packageDirectory, '..', '..');
const outputDirectory = join(packageDirectory, 'dist');
const dashboardDirectory = join(repositoryDirectory, 'apps', 'dashboard');

await rm(outputDirectory, { force: true, recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22.12',
  format: 'esm',
  conditions: ['development', 'node', 'import'],
  external: ['@napi-rs/keyring', 'better-sqlite3-multiple-ciphers'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  legalComments: 'eof',
  logLevel: 'info',
};

await Promise.all([
  esbuild({
    ...common,
    entryPoints: [join(packageDirectory, 'src', 'index.ts')],
    outfile: join(outputDirectory, 'index.js'),
  }),
  esbuild({
    ...common,
    entryPoints: [
      join(repositoryDirectory, 'packages', 'daemon', 'src', 'run.ts'),
    ],
    outfile: join(outputDirectory, 'daemon.js'),
  }),
  viteBuild({
    root: dashboardDirectory,
    configFile: join(dashboardDirectory, 'vite.config.ts'),
    build: {
      outDir: join(outputDirectory, 'dashboard'),
      emptyOutDir: true,
    },
  }),
]);

await copyFile(
  join(repositoryDirectory, 'LICENSE'),
  join(outputDirectory, 'LICENSE'),
);
await chmod(join(outputDirectory, 'index.js'), 0o755);

for (const file of ['index.js', 'daemon.js']) {
  const source = await readFile(join(outputDirectory, file), 'utf8');
  if (/from\s+["']@vibetrace\//.test(source))
    throw new Error(`${file} still contains a workspace runtime import.`);
}
