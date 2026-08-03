import { describe, expect, it } from 'vitest';

import { cliVersion, createProgram } from './program.js';

describe('createProgram', () => {
  it('exposes the VibeTrace command name, version, and help surface', () => {
    const program = createProgram();

    expect(program.name()).toBe('vibetrace');
    expect(program.version()).toBe(cliVersion);
    expect(program.helpInformation()).toContain(
      'VibeTrace foundation command-line placeholder.',
    );
  });
});
