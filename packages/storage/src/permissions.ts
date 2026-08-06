import { execFile as execFileCallback } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ACL_TARGETS_VARIABLE = 'VIBETRACE_ACL_TARGETS';

const WINDOWS_OWNER_ONLY_ACL = [
  `$paths = ConvertFrom-Json -InputObject $env:${ACL_TARGETS_VARIABLE};`,
  '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name;',
  "$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit';",
  'foreach ($path in @($paths)) {',
  "if ([string]::IsNullOrWhiteSpace($path)) { throw 'ACL target is missing.' };",
  '$acl = [System.Security.AccessControl.DirectorySecurity]::new();',
  '$acl.SetAccessRuleProtection($true, $false);',
  '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);',
  '[void]$acl.AddAccessRule($rule);',
  '[System.IO.Directory]::SetAccessControl($path, $acl);',
  '}',
].join(' ');

/** Apply owner-only directory boundaries on every supported operating system. */
export async function restrictDirectoriesToCurrentUser(
  paths: readonly string[],
): Promise<void> {
  if (process.platform !== 'win32') {
    await Promise.all(paths.map((path) => chmod(path, 0o700)));
    return;
  }
  await execFile(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_OWNER_ONLY_ACL,
    ],
    {
      env: {
        ...process.env,
        [ACL_TARGETS_VARIABLE]: JSON.stringify(paths),
      },
      timeout: 5_000,
      windowsHide: true,
    },
  );
}

/** Apply an owner-only directory boundary on every supported operating system. */
export async function restrictDirectoryToCurrentUser(
  path: string,
): Promise<void> {
  await restrictDirectoriesToCurrentUser([path]);
}
