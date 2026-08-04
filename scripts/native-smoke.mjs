import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliDirectory = join(repositoryDirectory, 'packages', 'cli');
const codexBinary = 'codex';
const temporary = await mkdtemp(join(tmpdir(), 'vibetrace-native-smoke-'));
const packDirectory = join(temporary, 'pack output');
const installPrefix = join(temporary, 'global install');
const sourceHome = join(temporary, 'vibetrace-home');
const codexHome = join(temporary, 'codex-home');
const checkout = join(temporary, 'checkout');
const reportPath = process.env.VIBETRACE_NATIVE_SMOKE_OUTPUT
  ? resolve(process.env.VIBETRACE_NATIVE_SMOKE_OUTPUT)
  : undefined;
const storagePassphrase = `native-smoke-${randomBytes(24).toString('hex')}`;
const keepTemporary = process.env.VIBETRACE_KEEP_NATIVE_SMOKE === '1';

function extractVersion(value) {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(value)?.[1];
}

function supportsCodexVersion(value) {
  const parts = value?.split('.').slice(0, 3).map(Number);
  if (
    !parts ||
    parts.length !== 3 ||
    parts.some((part) => !Number.isInteger(part))
  )
    return false;
  const [major, minor, patch] = parts;
  return (
    major > 0 || (major === 0 && (minor > 144 || (minor === 144 && patch >= 3)))
  );
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${options.label ?? command} timed out.`)));
    }, options.timeoutMs ?? 180_000);
    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes <= maxOutputBytes) stdout.push(buffer);
      else {
        child.kill();
        finish(() =>
          reject(
            new Error(`${options.label ?? command} exceeded output limit.`),
          ),
        );
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        child.kill();
        finish(() =>
          reject(
            new Error(`${options.label ?? command} exceeded error limit.`),
          ),
        );
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      finish(() =>
        reject(new Error(`${options.label ?? command}: ${error.message}`)),
      );
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      finish(() => {
        if (code !== 0)
          reject(
            new Error(
              `${options.label ?? command} failed (${signal ?? code ?? 'unknown'}).`,
            ),
          );
        else
          resolveRun({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stdoutBytes,
          });
      });
    });
    child.stdin.end(options.input);
  });
}

const windowsNpmCli = join(
  dirname(process.execPath),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
const npm = (args, options = {}) =>
  process.platform === 'win32'
    ? run(process.execPath, [windowsNpmCli, ...args], options)
    : run('npm', args, options);

const git = (args, cwd) =>
  run('git', ['-C', cwd, ...args], { cwd, label: 'git' });

let installedCli;
function cliCommand() {
  if (process.platform !== 'win32') return installedCli;
  return 'powershell.exe';
}
function cliArgs(args) {
  if (process.platform !== 'win32') return args;
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    installedCli,
    ...args,
  ];
}
function cli(args, options = {}) {
  return run(cliCommand(), cliArgs(args), {
    ...options,
    label: options.label ?? `vibetrace ${args.join(' ')}`,
  });
}

async function waitForStatus(env, expected) {
  // Native SQLCipher/keyring bindings can take several seconds to initialize
  // after a clean npm install. Allow cold-start variance without masking a
  // daemon that genuinely fails to become healthy.
  const deadline = Date.now() + 30_000;
  do {
    const result = await cli(['status'], { env });
    if (result.stdout.trim() === expected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  } while (Date.now() < deadline);
  throw new Error(`VibeTrace daemon did not reach ${expected} state.`);
}

async function waitForSessions(
  env,
  predicate,
  minimumEvents,
  label,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    const result = await cli(['sessions', 'list', '--json'], { env });
    const parsed = JSON.parse(result.stdout);
    latest = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const matching = latest.filter(predicate);
    const eventCount = matching.reduce(
      (total, session) => total + Number(session.eventCount ?? 0),
      0,
    );
    if (matching.length > 0 && eventCount >= minimumEvents) return matching;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `Native Codex ${label} did not produce complete captured sessions (expected=${minimumEvents} actual=${latest
      .filter(predicate)
      .reduce(
        (total, session) => total + Number(session.eventCount ?? 0),
        0,
      )} sessions=${latest
      .map(
        (session) =>
          `${session.source ?? 'unknown'}:${session.eventCount ?? 0}`,
      )
      .join(',')}).`,
  );
}

async function stop(env) {
  try {
    await cli(['stop'], { env, timeoutMs: 15_000 });
    await waitForStatus(env, 'stopped');
  } catch {
    // Cleanup is best effort after a failed smoke step.
  }
}

async function copyCodexAuth(env) {
  const authHome = process.env.VIBETRACE_CODEX_AUTH_HOME;
  if (authHome) {
    const source = join(resolve(authHome), 'auth.json');
    const metadata = await lstat(source);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 2 * 1024 * 1024
    )
      throw new Error(
        'VIBETRACE_CODEX_AUTH_HOME/auth.json is not a safe bounded file.',
      );
    await copyFile(source, join(codexHome, 'auth.json'));
    if (process.platform !== 'win32')
      await chmod(join(codexHome, 'auth.json'), 0o600);
    return 'copied-auth-file';
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    await run(codexBinary, ['login', '--with-api-key'], {
      env,
      input: `${apiKey}\n`,
      label: 'codex login',
    });
    return 'api-key-stdin';
  }
  const accessToken = process.env.CODEX_ACCESS_TOKEN;
  if (accessToken) {
    await run(codexBinary, ['login', '--with-access-token'], {
      env,
      input: `${accessToken}\n`,
      label: 'codex login',
    });
    return 'access-token-stdin';
  }
  throw new Error(
    'Native smoke needs VIBETRACE_CODEX_AUTH_HOME, OPENAI_API_KEY, or CODEX_ACCESS_TOKEN.',
  );
}

async function writeReport(report) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
    await writeFile(reportPath, text, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(text);
}

let env;
let daemonStarted = false;
try {
  if (process.env.VIBETRACE_CODEX_BIN)
    throw new Error(
      'VIBETRACE_CODEX_BIN is not accepted by release smoke; install the tested Codex binary on PATH.',
    );
  await access(join(cliDirectory, 'dist', 'index.js'));
  await mkdir(packDirectory, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(checkout, { recursive: true, mode: 0o700 });

  const packResult = await npm(
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    { cwd: cliDirectory, label: 'npm pack' },
  );
  const metadata = JSON.parse(packResult.stdout)[0];
  const tarball = join(packDirectory, metadata.filename);
  await access(tarball);
  await npm(['install', '--global', '--prefix', installPrefix, tarball], {
    timeoutMs: 180_000,
    label: 'npm install tarball',
  });
  const installedPackage =
    process.platform === 'win32'
      ? join(installPrefix, 'node_modules', '@vibetrace', 'cli')
      : join(installPrefix, 'lib', 'node_modules', '@vibetrace', 'cli');
  await access(join(installedPackage, 'dist', 'index.js'));
  installedCli =
    process.platform === 'win32'
      ? join(installPrefix, 'vibetrace.ps1')
      : join(installPrefix, 'bin', 'vibetrace');
  await access(installedCli);

  const pathEntry =
    process.platform === 'win32' ? installPrefix : join(installPrefix, 'bin');
  env = {
    ...process.env,
    CODEX_HOME: codexHome,
    VIBETRACE_HOME: sourceHome,
    PATH: [pathEntry, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
  };
  const authMode = await copyCodexAuth(env);
  const codexVersionOutput = (
    await run(codexBinary, ['--version'], { env, label: 'codex --version' })
  ).stdout
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.slice(0, 128);
  const codexVersion = extractVersion(codexVersionOutput ?? '');
  if (!codexVersion || !supportsCodexVersion(codexVersion))
    throw new Error('Native smoke requires Codex 0.144.3 or later.');

  await git(['init', '-q'], checkout);
  await git(['config', 'user.email', 'native-smoke@example.invalid'], checkout);
  await git(['config', 'user.name', 'VibeTrace Native Smoke'], checkout);
  await writeFile(join(checkout, 'README.md'), 'Native smoke fixture.\n');
  await git(['add', 'README.md'], checkout);
  await git(['commit', '-qm', 'native smoke baseline'], checkout);

  await cli(['init', 'codex', '--dry-run'], { env });
  await cli(['init', 'codex'], { env });

  const prompt =
    'Inspect README.md in this repository and respond with exactly SMOKE_OK. Do not modify files and do not use the network.';
  const codexArgs = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--config',
    'approval_policy="never"',
    '--dangerously-bypass-hook-trust',
    '--json',
    '-C',
    checkout,
  ];
  const model = process.env.VIBETRACE_CODEX_MODEL;
  if (model) codexArgs.push('--model', model);
  codexArgs.push(prompt);
  const codexRun = await run(codexBinary, codexArgs, {
    env,
    timeoutMs: Number(process.env.VIBETRACE_NATIVE_SMOKE_TIMEOUT_MS ?? 300_000),
    maxOutputBytes: 16 * 1024 * 1024,
    label: 'codex native session',
  });
  const checkoutStatus = await git(['status', '--porcelain'], checkout);
  if (checkoutStatus.stdout.trim() !== '')
    throw new Error('Native Codex smoke modified its read-only checkout.');
  const codexEventTypes = new Set();
  for (const line of codexRun.stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.type === 'string')
        codexEventTypes.add(value.type);
    } catch {
      // Codex may emit human-readable diagnostics alongside JSONL.
    }
  }

  await cli(['start', '--storage-passphrase-stdin'], {
    env,
    input: `${storagePassphrase}\n`,
  });
  daemonStarted = true;
  await waitForStatus(env, 'running');
  const list = JSON.parse(
    (await cli(['sessions', 'list', '--json'], { env })).stdout,
  );
  const session = list.sessions?.find(
    (candidate) =>
      candidate.source === 'codex-hooks' && candidate.eventCount > 0,
  );
  if (!session)
    throw new Error('Native Codex run did not produce a captured session.');

  const descriptor = JSON.parse(
    await readFile(join(sourceHome, 'daemon.json'), 'utf8'),
  );
  const token = (await readFile(join(sourceHome, 'auth-token'), 'utf8')).trim();
  const eventsResponse = await fetch(
    `${descriptor.origin}/api/v1/sessions/${encodeURIComponent(session.id)}/events?limit=2000`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!eventsResponse.ok) throw new Error('Native smoke event query failed.');
  const eventsBody = await eventsResponse.json();
  const events = Array.isArray(eventsBody.events) ? eventsBody.events : [];
  const adapters = new Set(
    events
      .map((item) => item?.event?.provenance?.adapter)
      .filter((value) => typeof value === 'string'),
  );
  const sourceVersions = new Set(
    events
      .map((item) => item?.event?.provenance?.sourceVersion)
      .filter((value) => typeof value === 'string'),
  );
  if (!adapters.has('codex-hooks') || !sourceVersions.has(codexVersion))
    throw new Error('Native smoke events are missing Codex provenance.');

  // Exercise the opt-in full-fidelity app-server path with the installed
  // native Codex binary. The read-only prompt and decline policy keep this
  // acceptance run from modifying the checkout or requesting unsafe access.
  const appServerRun = await cli(
    [
      'codex',
      'app-server',
      '--prompt',
      'Inspect README.md and respond with exactly APP_SERVER_SMOKE_OK. Do not modify files and do not use the network.',
      '--cwd',
      checkout,
      '--approval-policy',
      'decline',
    ],
    {
      env,
      timeoutMs: Number(
        process.env.VIBETRACE_NATIVE_APP_SERVER_TIMEOUT_MS ??
          process.env.VIBETRACE_NATIVE_SMOKE_TIMEOUT_MS ??
          300_000,
      ),
      maxOutputBytes: 16 * 1024 * 1024,
      label: 'codex native app-server session',
    },
  );
  const appServerSummary = JSON.parse(appServerRun.stdout.trim());
  if (
    appServerSummary.adapter !== 'codex-app-server' ||
    !Number.isInteger(appServerSummary.eventCount) ||
    appServerSummary.eventCount < 1
  )
    throw new Error('Native app-server command returned an invalid summary.');
  const appServerCheckoutStatus = await git(
    ['status', '--porcelain'],
    checkout,
  );
  if (appServerCheckoutStatus.stdout.trim() !== '')
    throw new Error('Native app-server smoke modified its read-only checkout.');
  const appServerSessions = await waitForSessions(
    env,
    (candidate) =>
      candidate.source === 'codex-app-server' && candidate.eventCount > 0,
    appServerSummary.eventCount,
    'app-server',
  );
  const appServerEvents = [];
  const appServerSessionRecords = [];
  for (const appServerSession of appServerSessions) {
    const appServerEventsResponse = await fetch(
      `${descriptor.origin}/api/v1/sessions/${encodeURIComponent(appServerSession.id)}/events?limit=2000`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!appServerEventsResponse.ok)
      throw new Error('Native app-server event query failed.');
    const appServerEventsBody = await appServerEventsResponse.json();
    if (Array.isArray(appServerEventsBody.events)) {
      appServerEvents.push(...appServerEventsBody.events);
      appServerSessionRecords.push({
        id: appServerSession.id,
        sourceSessionId: appServerSession.sourceSessionId,
        eventCount: appServerSession.eventCount,
        eventTypes: [
          ...new Set(
            appServerEventsBody.events
              .map((item) => item?.event?.type)
              .filter((value) => typeof value === 'string'),
          ),
        ].sort(),
      });
    }
  }
  const appServerEventTypes = new Set(
    appServerEvents
      .map((item) => item?.event?.type)
      .filter((value) => typeof value === 'string'),
  );
  const appServerAdapters = new Set(
    appServerEvents
      .map((item) => item?.event?.provenance?.adapter)
      .filter((value) => typeof value === 'string'),
  );
  const appServerSourceVersions = new Set(
    appServerEvents
      .map((item) => item?.event?.provenance?.sourceVersion)
      .filter((value) => typeof value === 'string'),
  );
  if (
    !appServerAdapters.has('codex-app-server') ||
    !appServerSourceVersions.has(codexVersion) ||
    !appServerEventTypes.has('session.started') ||
    !appServerEventTypes.has('turn.started') ||
    !appServerEventTypes.has('turn.completed') ||
    !(
      appServerEventTypes.has('message.agent') ||
      appServerEventTypes.has('command.started') ||
      appServerEventTypes.has('capture.gap')
    )
  )
    throw new Error(
      `Native app-server events are missing rich provenance (types=${[...appServerEventTypes].sort().join(',') || 'none'} adapters=${[...appServerAdapters].sort().join(',') || 'none'} sourceVersions=${[...appServerSourceVersions].sort().join(',') || 'none'}).`,
    );
  const appServerGapCount = appServerEvents.filter(
    (item) => item?.event?.type === 'capture.gap',
  ).length;

  // Verify that a bad passphrase cannot unlock the existing envelope, then
  // prove that the same local state remains recoverable with the right one.
  await stop(env);
  daemonStarted = false;
  await waitForStatus(env, 'stopped');
  await cli(['start', '--storage-passphrase-stdin'], {
    env,
    input: `${storagePassphrase}-wrong\n`,
    timeoutMs: 15_000,
  });
  await waitForStatus(env, 'stopped');
  await cli(['start', '--storage-passphrase-stdin'], {
    env,
    input: `${storagePassphrase}\n`,
  });
  daemonStarted = true;
  await waitForStatus(env, 'running');

  await writeReport({
    schemaVersion: 1,
    status: 'passed',
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    codexVersion,
    authMode,
    sessionId: session.id,
    eventCount: events.length,
    eventTypes: [
      ...new Set(events.map((item) => item?.event?.type).filter(Boolean)),
    ].sort(),
    codexOutputEventTypes: [...codexEventTypes].sort(),
    adapters: [...adapters].sort(),
    sourceVersions: [...sourceVersions].sort(),
    appServer: {
      status: 'passed',
      sessionId: appServerSessions[0]?.id,
      sessionIds: appServerSessions.map((candidate) => candidate.id).sort(),
      sessionRecords: appServerSessionRecords.sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      eventCount: appServerEvents.length,
      eventTypes: [...appServerEventTypes].sort(),
      gapCount: appServerGapCount,
      adapters: [...appServerAdapters].sort(),
      sourceVersions: [...appServerSourceVersions].sort(),
    },
    storagePassphraseRecovery: 'verified',
  });
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  await writeReport({
    schemaVersion: 1,
    status: 'failed',
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    error: message,
  });
  process.exitCode = 1;
} finally {
  if (daemonStarted && env) await stop(env);
  if (!keepTemporary) await rm(temporary, { force: true, recursive: true });
}
