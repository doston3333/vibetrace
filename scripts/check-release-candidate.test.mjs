import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReleaseCandidate } from './check-release-candidate.mjs';

const candidate = {
  bugs: { url: 'https://github.com/doston3333/vibetrace/issues' },
  homepage: 'https://github.com/doston3333/vibetrace#readme',
  name: '@vibetrace/cli',
  publishConfig: { access: 'public' },
  repository: 'git+https://github.com/doston3333/vibetrace.git',
  version: '0.1.0',
};

test('accepts an exact release tag for the public CLI package', () => {
  assert.deepEqual(validateReleaseCandidate(candidate, 'v0.1.0'), {
    packageName: '@vibetrace/cli',
    tag: 'v0.1.0',
    version: '0.1.0',
  });
});

test('rejects a tag that does not match the CLI version', () => {
  assert.throws(
    () => validateReleaseCandidate(candidate, 'v0.1.1'),
    /tag must be v0\.1\.0/u,
  );
});

test('rejects a non-stable package version before constructing a release tag', () => {
  assert.throws(
    () =>
      validateReleaseCandidate(
        { ...candidate, version: '0.1.0-next.1' },
        'v0.1.0-next.1',
      ),
    /stable semantic version/u,
  );
});
