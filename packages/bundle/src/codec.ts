import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  rename,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Decrypter, Encrypter } from 'age-encryption';
import { z } from 'zod';

export const BUNDLE_MAGIC = Buffer.from('VIBETRACE-BUNDLE\n', 'ascii');

export interface BundleLimits {
  readonly maxCiphertextBytes: number;
  readonly maxPlaintextBytes: number;
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly maxHeaderBytes: number;
  readonly maxScryptWorkFactor: number;
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = Object.freeze({
  maxCiphertextBytes: 1_100_000_000,
  maxPlaintextBytes: 1_000_000_000,
  maxRecordBytes: 268_435_456,
  maxRecords: 100_000,
  maxHeaderBytes: 65_536,
  maxScryptWorkFactor: 18,
});

export const BundleRecordHeaderSchema = z
  .object({
    version: z.literal(1),
    entryType: z.literal('file'),
    kind: z.enum(['manifest', 'events', 'findings', 'annotations', 'artifact']),
    path: z.string().min(1).max(1_024),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type BundleRecordHeader = z.infer<typeof BundleRecordHeaderSchema>;

export interface PreparedRecord {
  readonly header: BundleRecordHeader;
  readonly contentPath: string;
}

export type ExtractedRecord = PreparedRecord;

function safeRecordPath(path: string): boolean {
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    posix.isAbsolute(path)
  )
    return false;
  const parts = path.split('/');
  return (
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    posix.normalize(path) === path
  );
}

async function* plaintextRecords(
  records: readonly PreparedRecord[],
): AsyncGenerator<Buffer> {
  yield BUNDLE_MAGIC;
  for (const record of records) {
    const header = Buffer.from(JSON.stringify(record.header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.byteLength);
    yield length;
    yield header;
    for await (const chunk of createReadStream(record.contentPath))
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

function asWebStream(input: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(input) as ReadableStream<Uint8Array>;
}

function asNodeStream(input: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(input as never);
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 10 || passphrase.length > 1_024)
    throw new Error(
      'Bundle passphrases must be between 10 and 1024 characters.',
    );
}

async function validateAgePassphraseHeader(
  source: string,
  limits: BundleLimits,
): Promise<void> {
  const handle = await open(source, 'r');
  try {
    const buffer = Buffer.alloc(limits.maxHeaderBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const prefix = buffer.subarray(0, bytesRead);
    const headerEnd = prefix.indexOf('\n--- ');
    if (headerEnd < 0)
      throw new Error('Bundle age header is missing or oversized.');
    const header = prefix.subarray(0, headerEnd).toString('ascii');
    const stanzas = header.split('\n').filter((line) => line.startsWith('-> '));
    if (stanzas.length !== 1)
      throw new Error('Bundle must use exactly one age passphrase recipient.');
    const fields = stanzas[0]!.split(' ');
    if (
      fields.length !== 4 ||
      fields[0] !== '->' ||
      fields[1] !== 'scrypt' ||
      !/^\d{1,2}$/.test(fields[3]!)
    )
      throw new Error('Bundle must use age passphrase encryption.');
    const workFactor = Number(fields[3]);
    if (workFactor > limits.maxScryptWorkFactor)
      throw new Error('Bundle age scrypt work factor exceeds the safe limit.');
  } finally {
    await handle.close();
  }
}

/** Encrypt the prepared record stream as a standard passphrase age file. */
export async function encryptRecordStream(
  records: readonly PreparedRecord[],
  destination: string,
  passphrase: string,
  options: { readonly scryptWorkFactor?: number } = {},
): Promise<void> {
  validatePassphrase(passphrase);
  if (!destination.endsWith('.vibetrace.age'))
    throw new Error('Bundle destination must end in .vibetrace.age.');
  const parent = dirname(destination);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink())
    throw new Error('Bundle destination parent must be a regular directory.');
  if (await lstat(destination).catch(() => undefined))
    throw new Error('Bundle destination already exists.');
  const temporary = join(
    parent,
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let output:
    | ReturnType<Awaited<ReturnType<typeof open>>['createWriteStream']>
    | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    const encrypter = new Encrypter();
    encrypter.setPassphrase(passphrase);
    encrypter.setScryptWorkFactor(options.scryptWorkFactor ?? 18);
    const plaintext = asWebStream(Readable.from(plaintextRecords(records)));
    const ciphertext = await encrypter.encrypt(plaintext);
    output = handle.createWriteStream({ autoClose: false, emitClose: false });
    await pipeline(asNodeStream(ciphertext), output);
    await handle.sync();
    output.destroy();
    await handle.close();
    handle = undefined;
    // The temporary file lives beside the destination, so rename is atomic on
    // the supported filesystems and works on Windows without requiring
    // unprivileged hard-link creation.
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    output?.destroy();
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

class BoundedReader {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer = Buffer.alloc(0);
  #ended = false;
  #total = 0;

  constructor(
    input: AsyncIterable<unknown>,
    private readonly maxTotal: number,
  ) {
    this.#iterator = input[Symbol.asyncIterator]();
  }

  async #fill(): Promise<void> {
    if (this.#ended) return;
    const next = await this.#iterator.next();
    if (next.done) {
      this.#ended = true;
      return;
    }
    const source = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(next.value as Uint8Array);
    const chunk = Buffer.from(source);
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  #count(bytes: number): void {
    this.#total += bytes;
    if (this.#total > this.maxTotal)
      throw new Error('Bundle plaintext exceeds the configured size limit.');
  }

  async readExact(size: number, allowEof = false): Promise<Buffer | undefined> {
    while (this.#buffer.length < size && !this.#ended) await this.#fill();
    if (this.#buffer.length === 0 && this.#ended && allowEof) return undefined;
    if (this.#buffer.length < size)
      throw new Error('Bundle stream is truncated.');
    const output = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    this.#count(size);
    return output;
  }

  async writeExact(
    size: number,
    path: string,
  ): Promise<{ readonly byteLength: number; readonly sha256: string }> {
    const handle = await open(path, 'wx', 0o600);
    const digest = createHash('sha256');
    let remaining = size;
    try {
      while (remaining > 0) {
        if (this.#buffer.length === 0) await this.#fill();
        if (this.#buffer.length === 0 && this.#ended)
          throw new Error('Bundle record is truncated.');
        const count = Math.min(remaining, this.#buffer.length);
        const chunk = this.#buffer.subarray(0, count);
        await handle.write(chunk);
        digest.update(chunk);
        this.#buffer = this.#buffer.subarray(count);
        remaining -= count;
        this.#count(count);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { byteLength: size, sha256: digest.digest('hex') };
  }
}

/** Decrypt and stage bounded regular-file records under generated safe names. */
export async function decryptRecordStream(
  source: string,
  passphrase: string,
  options: {
    readonly limits?: BundleLimits;
    readonly temporaryRoot?: string;
  } = {},
): Promise<{
  readonly directory: string;
  readonly records: readonly ExtractedRecord[];
}> {
  validatePassphrase(passphrase);
  if (!source.toLowerCase().endsWith('.vibetrace.age'))
    throw new Error('Bundle source must end in .vibetrace.age.');
  const configuredLimits = options.limits ?? DEFAULT_BUNDLE_LIMITS;
  const limits: BundleLimits = {
    ...configuredLimits,
    maxScryptWorkFactor: Math.min(
      configuredLimits.maxScryptWorkFactor,
      DEFAULT_BUNDLE_LIMITS.maxScryptWorkFactor,
    ),
  };
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Bundle source must be a regular non-symlink file.');
  if (metadata.size > limits.maxCiphertextBytes)
    throw new Error('Bundle ciphertext exceeds the configured size limit.');
  await validateAgePassphraseHeader(source, limits);
  const directory = await mkdtemp(
    join(options.temporaryRoot ?? tmpdir(), 'vibetrace-import-'),
  );
  await chmod(directory, 0o700);
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    const decrypted = await decrypter.decrypt(
      asWebStream(createReadStream(source)),
    );
    const reader = new BoundedReader(
      asNodeStream(decrypted),
      limits.maxPlaintextBytes,
    );
    const magic = await reader.readExact(BUNDLE_MAGIC.length);
    if (!magic?.equals(BUNDLE_MAGIC)) throw new Error('Invalid bundle magic.');
    const records: ExtractedRecord[] = [];
    const paths = new Set<string>();
    for (let index = 0; ; index += 1) {
      const encodedHeaderLength = await reader.readExact(4, true);
      if (!encodedHeaderLength) break;
      if (index >= limits.maxRecords)
        throw new Error('Bundle contains too many records.');
      const headerLength = encodedHeaderLength.readUInt32BE();
      if (headerLength < 2 || headerLength > limits.maxHeaderBytes)
        throw new Error('Bundle record header exceeds its size limit.');
      const encodedHeader = await reader.readExact(headerLength);
      let candidate: unknown;
      try {
        candidate = JSON.parse(encodedHeader!.toString('utf8'));
      } catch {
        throw new Error('Bundle record header is malformed.');
      }
      const header = BundleRecordHeaderSchema.parse(candidate);
      if (!safeRecordPath(header.path))
        throw new Error('Bundle record path is unsafe.');
      if (paths.has(header.path))
        throw new Error('Bundle record path is duplicated.');
      paths.add(header.path);
      if (header.byteLength > limits.maxRecordBytes)
        throw new Error('Bundle record exceeds its size limit.');
      if (
        index === 0 &&
        (header.kind !== 'manifest' || header.path !== 'manifest.json')
      )
        throw new Error('Bundle manifest must be the first record.');
      if (index > 0 && header.kind === 'manifest')
        throw new Error('Bundle contains more than one manifest.');
      const contentPath = join(directory, `record-${index}`);
      const actual = await reader.writeExact(header.byteLength, contentPath);
      if (actual.sha256 !== header.sha256)
        throw new Error(
          'Bundle record content hash does not match its header.',
        );
      records.push({ header, contentPath });
    }
    if (records.length === 0) throw new Error('Bundle contains no records.');
    return { directory, records };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export async function readBoundedJson(
  record: ExtractedRecord,
  maxBytes: number,
): Promise<unknown> {
  if (record.header.byteLength > maxBytes)
    throw new Error('Bundle JSON record exceeds its size limit.');
  try {
    return JSON.parse(await readFile(record.contentPath, 'utf8'));
  } catch {
    throw new Error('Bundle JSON record is malformed.');
  }
}
