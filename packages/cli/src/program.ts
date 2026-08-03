import { Command } from 'commander';

export const cliVersion = '0.0.0';

/** Creates the VibeTrace foundation CLI program. */
export function createProgram(): Command {
  return new Command()
    .name('vibetrace')
    .description('VibeTrace foundation command-line placeholder.')
    .version(cliVersion);
}
