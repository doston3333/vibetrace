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

function requireMatrixPair(source, os, node, file) {
  const escapedOs = os.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedNode = node.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pair = new RegExp(
    `- os: ${escapedOs}\\s+node: ${escapedNode}(?:\\s|$)`,
    'mu',
  );
  if (!pair.test(source))
    throw new Error(
      `Release configuration missing ${os} / Node ${node} in ${file}.`,
    );
}

const ci = await workflow('ci.yml');
const native = await workflow('native-smoke.yml');
const release = await workflow('release-gate.yml');

for (const [os, node] of [
  ['ubuntu-latest', '22.12.0'],
  ['ubuntu-latest', '24'],
  ['macos-14-large', '24'],
  ['macos-14', '24'],
  ['windows-latest', '24'],
])
  requireMatrixPair(ci, os, node, 'ci.yml');
for (const [os, node] of [
  ['ubuntu-latest', '24'],
  ['macos-14-large', '24'],
  ['macos-14', '24'],
  ['windows-latest', '24'],
])
  requireMatrixPair(native, os, node, 'native-smoke.yml');

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
