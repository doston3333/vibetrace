import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliDirectory = join(repositoryDirectory, 'packages', 'cli');
const temporary = await mkdtemp(join(tmpdir(), 'vibetrace-pack-smoke-'));
const packDirectory = join(temporary, 'pack output');
const installPrefix = join(temporary, 'global install');
const sourceHome = join(temporary, 'source-home');
const targetHome = join(temporary, 'target-home');
const codexHome = join(temporary, 'codex-home');
const evalCheckout = join(temporary, 'eval checkout');
const evalManifest = join(temporary, 'eval-manifest.json');
const evalCodex = join(temporary, 'codex-eval-mock.mjs');
const bundlePath = join(temporary, 'smoke.vibetrace.age');
const storagePassphrase = 'pack smoke storage passphrase';
const bundlePassphrase = 'pack smoke bundle passphrase';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: options.shell ?? false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, options.timeoutMs ?? 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errors = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ stdout: output, stderr: errors });
      else
        reject(
          new Error(
            `${command} failed (${signal ?? code ?? 'unknown'}).\n${errors}${output}`,
          ),
        );
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

const git = (args, cwd) => run('git', ['-C', cwd, ...args], { cwd });

let installedCli;
const cli = (args, options = {}) =>
  process.platform === 'win32'
    ? run(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          installedCli,
          ...args,
        ],
        options,
      )
    : run(installedCli, args, options);

async function waitForStatus(env, expected) {
  // A freshly installed native runtime may need several seconds to load its
  // SQLCipher/keyring bindings on a cold machine (especially Node 22/24 on
  // macOS and Windows). Keep polling long enough to distinguish cold start
  // latency from a genuinely failed daemon without weakening the smoke gate.
  const deadline = Date.now() + 30_000;
  do {
    const result = await cli(['status'], { env });
    if (result.stdout.trim() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Daemon did not reach ${expected} state.`);
}

async function stop(env) {
  try {
    await cli(['stop'], { env });
    await waitForStatus(env, 'stopped');
  } catch {
    // Best-effort cleanup after an earlier smoke failure.
  }
}

async function assertOwnerOnlyWindowsAcl(path) {
  if (process.platform !== 'win32') return;
  const targetVariable = 'VIBETRACE_SMOKE_ACL_TARGET';
  const script = [
    `$acl = Get-Acl -LiteralPath $env:${targetVariable};`,
    '$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name;',
    '$identities = @($acl.Access | ForEach-Object { $_.IdentityReference.Value });',
    '[PSCustomObject]@{ protected = $acl.AreAccessRulesProtected; current = $current; identities = $identities } | ConvertTo-Json -Compress;',
  ].join(' ');
  const result = await run(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      env: { ...process.env, [targetVariable]: path },
    },
  );
  const acl = JSON.parse(result.stdout);
  const identities = Array.isArray(acl.identities)
    ? acl.identities
    : [acl.identities];
  if (
    acl.protected !== true ||
    identities.length === 0 ||
    identities.some(
      (identity) =>
        String(identity).toLowerCase() !== String(acl.current).toLowerCase(),
    )
  )
    throw new Error(`Directory does not have an owner-only ACL: ${path}`);
}

try {
  if (process.platform === 'win32') await access(windowsNpmCli);
  await mkdir(packDirectory, { mode: 0o700 });
  await run(process.execPath, [join(cliDirectory, 'scripts', 'build.mjs')]);
  const packResult = await npm(
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    { cwd: cliDirectory },
  );
  const metadata = JSON.parse(packResult.stdout)[0];
  const paths = new Set(metadata.files.map((file) => file.path));
  for (const required of [
    'dist/index.js',
    'dist/daemon.js',
    'dist/dashboard/index.html',
    'dist/LICENSE',
  ])
    if (!paths.has(required))
      throw new Error(`Packed CLI is missing ${required}.`);
  if ([...paths].some((path) => /(?:test|\.map|node_modules)/i.test(path)))
    throw new Error(
      'Packed CLI contains a test, source map, or dependency tree.',
    );
  const tarball = join(packDirectory, metadata.filename);
  await access(tarball);

  await npm(['install', '--global', '--prefix', installPrefix, tarball], {
    timeoutMs: 180_000,
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
  const installedManifest = JSON.parse(
    await readFile(join(installedPackage, 'package.json'), 'utf8'),
  );
  if (
    JSON.stringify(installedManifest.dependencies ?? {}).includes(
      'workspace:',
    ) ||
    installedManifest.engines?.node !== '>=22.12.0'
  )
    throw new Error('Installed package metadata is not release-safe.');
  if ((await cli(['--version'])).stdout.trim() !== installedManifest.version)
    throw new Error('Packed CLI reports the wrong version.');
  if (!(await cli(['--help'])).stdout.includes('export'))
    throw new Error('Packed CLI help is incomplete.');
  const adapterList = JSON.parse(
    (await cli(['adapters', 'list', '--json'])).stdout,
  );
  const adapterIds = new Set(
    Array.isArray(adapterList.adapters)
      ? adapterList.adapters.map((adapter) => adapter?.id)
      : [],
  );
  if (!adapterIds.has('claude-code') || !adapterIds.has('codex-app-server'))
    throw new Error('Packed CLI is missing a bundled coding-agent adapter.');

  const sourceEnv = {
    ...process.env,
    VIBETRACE_HOME: sourceHome,
    CODEX_HOME: codexHome,
  };

  // Exercise the installed tarball's real eval runner in a clean Git checkout.
  // The mock is a bounded Node script so this assertion is deterministic and
  // does not require Codex credentials or a network connection.
  await mkdir(evalCheckout, { mode: 0o700 });
  await git(['init', '-q'], evalCheckout);
  await git(
    ['config', 'user.email', 'pack-smoke@example.invalid'],
    evalCheckout,
  );
  await git(['config', 'user.name', 'VibeTrace Pack Smoke'], evalCheckout);
  await writeFile(join(evalCheckout, 'README.md'), 'baseline\n');
  await git(['add', 'README.md'], evalCheckout);
  await git(['commit', '-qm', 'baseline'], evalCheckout);
  const baseCommit = (
    await git(['rev-parse', 'HEAD'], evalCheckout)
  ).stdout.trim();
  await writeFile(
    evalCodex,
    "import { writeFile } from 'node:fs/promises';\nawait writeFile('eval-result.txt', 'passed\\n', { flag: 'wx' });\nprocess.stdout.write(JSON.stringify({ type: 'turn.completed', source: 'agent', payload: {} }) + '\\n');\n",
    { mode: 0o700 },
  );
  await chmod(evalCodex, 0o700);
  await writeFile(
    evalManifest,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        id: '00000000-0000-5000-8000-000000000901',
        name: 'Pack smoke evaluation',
        sourceEvidence: {
          eventIds: [],
          artifactBlobHashes: [],
          captureGapIds: [],
        },
        repository: { baseCommit },
        task: {
          prompt: 'Create the evaluation result.',
          constraints: [],
          inferredFields: [],
        },
        configuration: {
          skills: [],
          instructionHashes: [],
          inferredFields: [],
        },
        success: {
          assertions: [{ type: 'file_exists', path: 'eval-result.txt' }],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const evalRun = await cli(
    [
      'eval',
      'run',
      evalManifest,
      '--cwd',
      evalCheckout,
      '--codex',
      evalCodex,
      '--no-persist',
      '--json',
    ],
    { env: sourceEnv, timeoutMs: 120_000 },
  );
  const evalResult = JSON.parse(evalRun.stdout);
  if (
    evalResult.success !== true ||
    evalResult.execution?.configuration?.approvalPolicy !== 'never' ||
    evalResult.execution?.configuration?.sandboxPolicy !== 'workspace-write' ||
    evalResult.execution?.configuration?.networkPolicy !== 'disabled'
  )
    throw new Error(
      'Packed CLI eval did not enforce effective execution policy.',
    );
  if (evalResult.checks?.[0]?.status !== 'passed')
    throw new Error('Packed CLI eval assertion did not pass.');

  await cli(['init', 'codex', '--dry-run'], { env: sourceEnv });
  await cli(['init', 'codex'], { env: sourceEnv });
  await assertOwnerOnlyWindowsAcl(sourceHome);
  await assertOwnerOnlyWindowsAcl(codexHome);
  for (const directory of ['', 'incoming', 'archive', 'quarantine'])
    await assertOwnerOnlyWindowsAcl(
      join(sourceHome, 'spool', ...(directory ? [directory] : [])),
    );
  const hooks = await readFile(join(codexHome, 'hooks.json'), 'utf8');
  if (
    !hooks.includes('commandWindows') ||
    !hooks.includes('vibetrace hook collect')
  )
    throw new Error('Packed CLI did not install cross-platform Codex hooks.');
  await cli(['hook', 'collect'], {
    env: sourceEnv,
    input: `${JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'pack-smoke-session',
      transcript_path: null,
      cwd: repositoryDirectory,
      model: 'pack-smoke-model',
      permission_mode: 'default',
      source: 'startup',
    })}\n`,
  });
  await cli(['start', '--storage-passphrase-stdin'], {
    env: sourceEnv,
    input: `${storagePassphrase}\n`,
  });
  await waitForStatus(sourceEnv, 'running');

  const descriptor = JSON.parse(
    await readFile(join(sourceHome, 'daemon.json'), 'utf8'),
  );
  const token = (await readFile(join(sourceHome, 'auth-token'), 'utf8')).trim();
  const authorization = { authorization: `Bearer ${token}` };
  const health = await fetch(`${descriptor.origin}/api/v1/health`, {
    headers: authorization,
  });
  if (!health.ok) throw new Error('Packed daemon health request failed.');
  const ticketResponse = await fetch(
    `${descriptor.origin}/api/v1/auth/tickets`,
    { method: 'POST', headers: authorization },
  );
  const ticket = await ticketResponse.json();
  const handoff = await fetch(
    `${descriptor.origin}/api/v1/auth/browser-handoff`,
    {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: ticket.ticket }),
    },
  );
  if (!handoff.ok) throw new Error('Browser handoff failed.');
  const handoffBody = await handoff.json();
  if (typeof handoffBody.handoffToken !== 'string')
    throw new Error('Browser handoff did not return a single-use token.');
  const browserSession = await fetch(
    `${descriptor.origin}/api/v1/auth/browser-session`,
    {
      method: 'POST',
      headers: {
        origin: descriptor.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ handoffToken: handoffBody.handoffToken }),
    },
  );
  const cookie = browserSession.headers.get('set-cookie');
  const dashboard = await fetch(`${descriptor.origin}/`, {
    headers: { cookie: cookie ?? '' },
  });
  if (!dashboard.ok || !(await dashboard.text()).includes('id="root"'))
    throw new Error('Packed dashboard assets were not served.');

  let sessions;
  const sessionDeadline = Date.now() + 10_000;
  do {
    sessions = JSON.parse(
      (await cli(['sessions', 'list', '--json'], { env: sourceEnv })).stdout,
    ).sessions;
    if (sessions.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < sessionDeadline);
  const sessionId = sessions?.[0]?.id;
  if (!sessionId) throw new Error('Packed hook event was not imported.');
  await cli(
    [
      'export',
      sessionId,
      '--profile',
      'share-safe',
      '--output',
      bundlePath,
      '--passphrase-stdin',
    ],
    { env: sourceEnv, input: `${bundlePassphrase}\n`, timeoutMs: 60_000 },
  );
  await access(bundlePath);
  await stop(sourceEnv);

  const targetEnv = {
    ...process.env,
    VIBETRACE_HOME: targetHome,
    CODEX_HOME: codexHome,
  };
  await cli(['start', '--storage-passphrase-stdin'], {
    env: targetEnv,
    input: `${storagePassphrase}\n`,
  });
  await waitForStatus(targetEnv, 'running');
  const imported = await cli(['import', bundlePath, '--passphrase-stdin'], {
    env: targetEnv,
    input: `${bundlePassphrase}\n`,
    timeoutMs: 60_000,
  });
  if (!imported.stdout.includes('Imported session'))
    throw new Error('Packed CLI did not import its exported bundle.');
  if (!(await cli(['sessions', 'show', sessionId], { env: targetEnv })).stdout)
    throw new Error('Imported session is unavailable.');
  await stop(targetEnv);

  await cli(['uninstall', 'codex'], { env: sourceEnv });
  if (
    (await readFile(join(codexHome, 'hooks.json'), 'utf8')).includes(
      'vibetrace hook collect',
    )
  )
    throw new Error('Packed CLI uninstall left an owned Codex handler.');
  process.stdout.write(
    `Pack smoke passed for ${installedManifest.name}@${installedManifest.version}.\n`,
  );
} finally {
  if (installedCli) {
    await stop({
      ...process.env,
      VIBETRACE_HOME: sourceHome,
      CODEX_HOME: codexHome,
    });
    await stop({
      ...process.env,
      VIBETRACE_HOME: targetHome,
      CODEX_HOME: codexHome,
    });
  }
  await rm(temporary, { force: true, recursive: true });
}
