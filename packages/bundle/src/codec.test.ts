import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BUNDLE_LIMITS,
  decryptRecordStream,
  encryptRecordStream,
  type BundleRecordHeader,
  type PreparedRecord,
} from './codec.js';

const roots: string[] = [];
const PASSPHRASE = 'test bundle passphrase';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vibetrace-codec-'));
  roots.push(path);
  return path;
}

async function preparedRecord(
  directory: string,
  overrides: Record<string, unknown> = {},
): Promise<PreparedRecord> {
  const contentPath = join(directory, `content-${crypto.randomUUID()}`);
  const content = Buffer.from('{"format":"test"}', 'utf8');
  await writeFile(contentPath, content, { mode: 0o600 });
  return {
    header: {
      version: 1,
      entryType: 'file',
      kind: 'manifest',
      path: 'manifest.json',
      byteLength: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      ...overrides,
    } as BundleRecordHeader,
    contentPath,
  };
}

async function encrypted(
  directory: string,
  record: PreparedRecord,
  name: string = crypto.randomUUID(),
): Promise<string> {
  const destination = join(directory, `${name}.vibetrace.age`);
  await encryptRecordStream([record], destination, PASSPHRASE, {
    scryptWorkFactor: 10,
  });
  return destination;
}

describe('bounded age record codec', () => {
  it('round-trips regular records while rejecting wrong passphrases, tampering, symlinks, and overwrite', async () => {
    const directory = await root();
    const record = await preparedRecord(directory);
    const source = await encrypted(directory, record, 'valid');
    const extracted = await decryptRecordStream(source, PASSPHRASE, {
      temporaryRoot: directory,
    });
    expect(extracted.records).toHaveLength(1);
    expect(await readFile(extracted.records[0]!.contentPath, 'utf8')).toBe(
      '{"format":"test"}',
    );
    await rm(extracted.directory, { force: true, recursive: true });

    await expect(
      decryptRecordStream(source, 'incorrect passphrase', {
        temporaryRoot: directory,
      }),
    ).rejects.toThrow();
    const tampered = join(directory, 'tampered.vibetrace.age');
    const bytes = await readFile(source);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(tampered, bytes);
    await expect(
      decryptRecordStream(tampered, PASSPHRASE, { temporaryRoot: directory }),
    ).rejects.toThrow();

    const link = join(directory, 'linked.vibetrace.age');
    await symlink(source, link);
    await expect(
      decryptRecordStream(link, PASSPHRASE, { temporaryRoot: directory }),
    ).rejects.toThrow('non-symlink');
    await expect(
      encryptRecordStream([record], source, PASSPHRASE, {
        scryptWorkFactor: 10,
      }),
    ).rejects.toThrow('already exists');

    const wrongExtension = join(directory, 'bundle.age');
    await writeFile(wrongExtension, await readFile(source));
    await expect(
      decryptRecordStream(wrongExtension, PASSPHRASE, {
        temporaryRoot: directory,
      }),
    ).rejects.toThrow('.vibetrace.age');
  }, 15_000);

  it.each(['../escape', '/absolute', 'folder\\escape', 'folder//file'])(
    'rejects unsafe record path %s before staging user-controlled names',
    async (path) => {
      const directory = await root();
      const source = await encrypted(
        directory,
        await preparedRecord(directory, { path }),
      );
      await expect(
        decryptRecordStream(source, PASSPHRASE, {
          temporaryRoot: directory,
        }),
      ).rejects.toThrow('unsafe');
    },
  );

  it.each(['symlink', 'hardlink', 'character-device'])(
    'rejects unsupported archive-like entry type %s',
    async (entryType) => {
      const directory = await root();
      const source = await encrypted(
        directory,
        await preparedRecord(directory, { entryType }),
      );
      await expect(
        decryptRecordStream(source, PASSPHRASE, {
          temporaryRoot: directory,
        }),
      ).rejects.toThrow();
    },
  );

  it('enforces declared record limits and authenticated content hashes', async () => {
    const directory = await root();
    const oversized = await encrypted(
      directory,
      await preparedRecord(directory),
      'oversized',
    );
    await expect(
      decryptRecordStream(oversized, PASSPHRASE, {
        temporaryRoot: directory,
        limits: { ...DEFAULT_BUNDLE_LIMITS, maxRecordBytes: 4 },
      }),
    ).rejects.toThrow('record exceeds');

    const hashMismatch = await encrypted(
      directory,
      await preparedRecord(directory, { sha256: '0'.repeat(64) }),
      'bad-hash',
    );
    await expect(
      decryptRecordStream(hashMismatch, PASSPHRASE, {
        temporaryRoot: directory,
      }),
    ).rejects.toThrow('content hash');
  });

  it('rejects excessive age scrypt work before invoking the expensive key derivation', async () => {
    const directory = await root();
    const source = await encrypted(
      directory,
      await preparedRecord(directory),
      'safe-work-factor',
    );
    const bytes = await readFile(source);
    const prefix = bytes.subarray(0, 4_096).toString('ascii');
    const stanza = /-> scrypt [^\n]+ 10\n/.exec(prefix);
    expect(stanza).not.toBeNull();
    const factorOffset = stanza!.index + stanza![0].lastIndexOf('10');
    bytes.write('20', factorOffset, 'ascii');
    const hostile = join(directory, 'hostile-work-factor.vibetrace.age');
    await writeFile(hostile, bytes, { mode: 0o600 });
    await expect(
      decryptRecordStream(hostile, PASSPHRASE, {
        temporaryRoot: directory,
      }),
    ).rejects.toThrow('scrypt work factor');
  });
});
