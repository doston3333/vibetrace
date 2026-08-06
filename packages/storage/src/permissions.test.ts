import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { restrictDirectoriesToCurrentUser } from './permissions.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  execFileMock.mockImplementation(
    (
      _file: string,
      _arguments: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, '', ''),
  );
});

afterEach(() => {
  execFileMock.mockReset();
  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform);
});

describe('restrictDirectoriesToCurrentUser', () => {
  it('uses .NET ACL APIs and passes every target through JSON environment data', async () => {
    const paths = [
      'C:\\Vibe Trace\\state; Write-Error injected',
      'C:\\Vibe Trace\\state with "quotes"',
    ];

    await restrictDirectoriesToCurrentUser(paths);

    expect(execFileMock).toHaveBeenCalledOnce();
    const [file, arguments_, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; shell?: boolean },
    ];
    const script = arguments_[arguments_.indexOf('-Command') + 1];

    expect(file).toBe('powershell.exe');
    expect(script).toContain(
      '[System.Security.AccessControl.DirectorySecurity]::new()',
    );
    expect(script).toContain('$acl.SetAccessRuleProtection($true, $false)');
    expect(script).toContain('[void]$acl.AddAccessRule($rule)');
    expect(script).toContain(
      '[System.IO.Directory]::SetAccessControl($path, $acl)',
    );
    expect(script).not.toContain('Get-Acl');
    expect(script).not.toContain('Set-Acl');
    expect(script).not.toContain(paths[0]);
    expect(script).not.toContain(paths[1]);
    expect(options.env.VIBETRACE_ACL_TARGETS).toBe(JSON.stringify(paths));
    expect(options.shell).toBeUndefined();
  });
});
