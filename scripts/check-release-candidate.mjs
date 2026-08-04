import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(
  repositoryDirectory,
  'packages',
  'cli',
  'package.json',
);
const expectedPackage = '@vibetrace/cli';
const expectedRepository = 'git+https://github.com/doston3333/vibetrace.git';
const expectedHomepage = 'https://github.com/doston3333/vibetrace#readme';
const expectedBugsUrl = 'https://github.com/doston3333/vibetrace/issues';
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Release candidate rejected: ${message}`);
}

export function validateReleaseCandidate(packageJson, tag) {
  requireValue(
    packageJson.name === expectedPackage,
    `package name must be ${expectedPackage}.`,
  );
  requireValue(
    typeof packageJson.version === 'string' &&
      stableVersion.test(packageJson.version),
    'package version must be a stable semantic version.',
  );
  requireValue(
    tag === `v${packageJson.version}`,
    `tag must be v${packageJson.version}.`,
  );
  requireValue(
    packageJson.publishConfig?.access === 'public',
    'publishConfig.access must be public.',
  );
  requireValue(
    packageJson.repository === expectedRepository,
    `repository must be ${expectedRepository}.`,
  );
  requireValue(
    packageJson.homepage === expectedHomepage,
    `homepage must be ${expectedHomepage}.`,
  );
  requireValue(
    packageJson.bugs?.url === expectedBugsUrl,
    `bugs.url must be ${expectedBugsUrl}.`,
  );

  return { packageName: packageJson.name, version: packageJson.version, tag };
}

async function requireCleanTrackedCheckout() {
  const { stdout } = await executeFile('git', ['status', '--porcelain'], {
    cwd: repositoryDirectory,
  });
  requireValue(
    stdout.trim().length === 0,
    'release checkout has tracked or untracked changes.',
  );
}

async function requireUnpublishedVersion(packageName, version) {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const response = await fetch(registryUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return;
  if (response.ok)
    throw new Error(
      `Release candidate rejected: ${packageName}@${version} is already published.`,
    );
  throw new Error(
    `Release candidate rejected: npm registry returned ${response.status} while checking ${packageName}@${version}.`,
  );
}

function parseArguments(argumentsList) {
  const options = {
    checkPublished: false,
    requireClean: false,
    tag: undefined,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--check-published') options.checkPublished = true;
    else if (argument === '--require-clean') options.requireClean = true;
    else if (argument === '--tag') {
      options.tag = argumentsList[index + 1];
      index += 1;
    } else throw new Error(`Unknown release candidate option: ${argument}`);
  }
  requireValue(typeof options.tag === 'string', '--tag is required.');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const candidate = validateReleaseCandidate(packageJson, options.tag);

  if (options.requireClean) await requireCleanTrackedCheckout();
  if (options.checkPublished)
    await requireUnpublishedVersion(candidate.packageName, candidate.version);

  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, status: 'passed', ...candidate }, null, 2)}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
