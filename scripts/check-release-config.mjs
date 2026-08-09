import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = async (name) =>
  readFile(join(repositoryDirectory, '.github', 'workflows', name), 'utf8');

function requireText(source, requirement, file) {
  if (!source.includes(requirement))
    throw new Error(`Release configuration missing ${requirement} in ${file}.`);
}

function requireAbsent(source, forbidden, file) {
  if (source.includes(forbidden))
    throw new Error(
      `Release configuration must not contain ${forbidden} in ${file}.`,
    );
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

function jobBlock(workflowSource, jobName) {
  const matcher = new RegExp(
    `^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|(?![\\s\\S]))`,
    'mu',
  );
  const match = workflowSource.match(matcher);
  if (!match) throw new Error(`Release configuration missing ${jobName} job.`);
  return match[0];
}

const actionPins = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
  gitleaks:
    'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0',
  pnpm: 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6',
  setupNode: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7',
  uploadArtifact:
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4',
};
const externalActionPins = new Map(
  Object.values(actionPins).map((pin) => {
    const [reference, comment] = pin.split(' # ');
    return [reference, comment];
  }),
);

function requirePinnedExternalActions(source, file) {
  const actionUses = source.matchAll(
    /^\s*-\s+uses:\s+([^\s#]+)(?:\s+#\s*(.+))?\s*$/gmu,
  );
  for (const match of actionUses) {
    const [, reference, comment] = match;
    if (reference.startsWith('./')) continue;
    const requiredComment = externalActionPins.get(reference);
    if (requiredComment !== comment)
      throw new Error(
        `Release configuration requires a pinned, version-commented external action in ${file}: ${reference}.`,
      );
  }
}

const ci = await workflow('ci.yml');
const native = await workflow('native-smoke.yml');
const release = await workflow('release-gate.yml');
const gitleaksIgnore = await readFile(
  join(repositoryDirectory, '.gitleaksignore'),
  'utf8',
);
const packageDirectories = await readdir(
  join(repositoryDirectory, 'packages'),
  {
    withFileTypes: true,
  },
);
for (const directory of packageDirectories) {
  if (!directory.isDirectory()) continue;
  const manifest = JSON.parse(
    await readFile(
      join(repositoryDirectory, 'packages', directory.name, 'package.json'),
      'utf8',
    ),
  );
  if (manifest.name === '@vibetrace/cli') {
    if (manifest.private === true)
      throw new Error('The public CLI package must not be private.');
  } else if (manifest.private !== true) {
    throw new Error(`${manifest.name ?? directory.name} must be private.`);
  }
}

for (const [os, node] of [
  ['ubuntu-latest', '22.12.0'],
  ['ubuntu-latest', '24'],
  ['macos-15-intel', '24'],
  ['macos-15', '24'],
  ['windows-latest', '24'],
])
  requireMatrixPair(ci, os, node, 'ci.yml');
for (const [os, node] of [
  ['ubuntu-latest', '24'],
  ['macos-15-intel', '24'],
  ['macos-15', '24'],
  ['windows-latest', '24'],
])
  requireMatrixPair(native, os, node, 'native-smoke.yml');

for (const [file, source, requiredPins] of [
  [
    'ci.yml',
    ci,
    [
      actionPins.checkout,
      actionPins.gitleaks,
      actionPins.pnpm,
      actionPins.setupNode,
      actionPins.uploadArtifact,
    ],
  ],
  [
    'native-smoke.yml',
    native,
    [
      actionPins.checkout,
      actionPins.pnpm,
      actionPins.setupNode,
      actionPins.uploadArtifact,
    ],
  ],
  [
    'release-gate.yml',
    release,
    [actionPins.checkout, actionPins.pnpm, actionPins.setupNode],
  ],
]) {
  requirePinnedExternalActions(source, file);
  for (const pin of requiredPins) requireText(source, pin, file);
}

const gitleaks = jobBlock(ci, 'gitleaks');
requireText(gitleaks, 'fetch-depth: 0', 'ci.yml gitleaks job');
requireText(gitleaks, actionPins.gitleaks, 'ci.yml gitleaks job');
const browserE2e = jobBlock(ci, 'browser-e2e');
requireText(
  browserE2e,
  'pnpm exec playwright install --with-deps chromium',
  'ci.yml browser-e2e job',
);
requireText(browserE2e, 'pnpm test:browser', 'ci.yml browser-e2e job');
requireText(
  gitleaks,
  'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  'ci.yml gitleaks job',
);
requireText(
  gitleaks,
  "GITLEAKS_ENABLE_COMMENTS: 'false'",
  'ci.yml gitleaks job',
);
const approvedGitleaksIgnore =
  'c839a3c2e33b259f0d0c466df57ddb41d14a9232:packages/bundle/src/redaction.test.ts:generic-api-key:51';
if (gitleaksIgnore.trim() !== approvedGitleaksIgnore)
  throw new Error(
    'Release configuration requires exactly one narrow gitleaks ignore.',
  );
requireText(
  native,
  'npm install --global @openai/codex@0.146.1',
  'native-smoke.yml',
);
requireText(native, 'VIBETRACE_NATIVE_SMOKE_OUTPUT:', 'native-smoke.yml');
requireText(native, 'if-no-files-found: error', 'native-smoke.yml');
requireText(release, 'uses: ./.github/workflows/ci.yml', 'release-gate.yml');
requireText(
  release,
  'uses: ./.github/workflows/native-smoke.yml',
  'release-gate.yml',
);

const candidate = jobBlock(release, 'release-candidate');
requireText(candidate, 'needs: [verify, native-smoke]', 'release-gate.yml');
requireText(candidate, "github.ref_type == 'tag'", 'release-gate.yml');
requireText(candidate, 'timeout-minutes: 5', 'release-gate.yml');
requireText(
  candidate,
  'node scripts/check-release-candidate.mjs --tag "$GITHUB_REF_NAME" --require-clean --check-published',
  'release-gate.yml',
);

const publish = jobBlock(release, 'publish');
for (const requirement of [
  'needs: [verify, native-smoke, release-candidate]',
  "needs.release-candidate.outputs.exact_tag == 'true'",
  'runs-on: ubuntu-latest',
  'timeout-minutes: 15',
  'contents: read',
  'id-token: write',
  'environment: npm-production',
  'node-version: 24',
  'package-manager-cache: false',
  'registry-url: https://registry.npmjs.org',
  'npm install --global npm@11.17.0',
  'test "$(npm --version)" = \'11.17.0\'',
  'pnpm --filter @vibetrace/cli pack --pack-destination "$RUNNER_TEMP"',
  'npm publish "$RUNNER_TEMP/vibetrace-cli-${GITHUB_REF_NAME#v}.tgz" --access public',
  'npm view "@vibetrace/cli@${GITHUB_REF_NAME#v}" version',
])
  requireText(publish, requirement, 'release-gate.yml');
requireAbsent(publish, '\n          cache:', 'release-gate.yml publish job');
requireAbsent(release, 'NPM_TOKEN', 'release-gate.yml');
requireAbsent(candidate, 'CODEX_', 'release-gate.yml release-candidate job');
requireAbsent(publish, 'CODEX_', 'release-gate.yml publish job');

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: 'passed',
      actionPins: true,
      historyAwareGitleaks: true,
      trustedPublishing: true,
      releaseCandidateGate: true,
      packagePrivacy: true,
    },
    null,
    2,
  )}\n`,
);
