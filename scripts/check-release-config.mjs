import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

const workflow = async (name) =>
  readFile(join(repositoryDirectory, '.github', 'workflows', name), 'utf8');

function requireText(source, requirement, file) {
  if (!source.includes(requirement))
    throw new Error(`Release configuration missing ${requirement} in ${file}.`);
}

const ci = await workflow('ci.yml');
const native = await workflow('native-smoke.yml');
const release = await workflow('release-gate.yml');

for (const requirement of [
  'ubuntu-latest',
  'node: 22.12.0',
  'node: 24',
  'macos-14-large',
  'macos-14',
  'windows-latest',
])
  requireText(ci, requirement, 'ci.yml');
for (const requirement of [
  'ubuntu-latest',
  'macos-14-large',
  'macos-14',
  'windows-latest',
  'node: 24',
])
  requireText(native, requirement, 'native-smoke.yml');

requireText(
  native,
  'npm install --global @openai/codex@0.144.3',
  'native-smoke.yml',
);
requireText(native, 'VIBETRACE_NATIVE_SMOKE_OUTPUT:', 'native-smoke.yml');
requireText(native, 'actions/upload-artifact@v4', 'native-smoke.yml');
requireText(native, 'if-no-files-found: error', 'native-smoke.yml');
requireText(release, 'uses: ./.github/workflows/ci.yml', 'release-gate.yml');
requireText(
  release,
  'uses: ./.github/workflows/native-smoke.yml',
  'release-gate.yml',
);
requireText(release, 'CODEX_OPENAI_API_KEY:', 'release-gate.yml');

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: 'passed',
      requiredCiRunners: [
        'ubuntu-latest / Node 22.12.0',
        'ubuntu-latest / Node 24',
        'macos-14-large / Node 24',
        'macos-14 / Node 24',
        'windows-latest / Node 24',
      ],
      nativeCodexVersion: '0.144.3',
      nativeEvidenceUpload: true,
      releaseGateWiring: true,
    },
    null,
    2,
  )}\n`,
);
