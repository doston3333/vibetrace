import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('VTB1');
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A stored encrypted blob's public, non-secret metadata. */
export interface BlobInfo {
  readonly address: string;
  readonly byteLength: number;
  readonly keyId: string;
}

/** Resolves a derived encryption key for a key identifier. */
export type BlobKeyResolver = (keyId: string) => Buffer;

interface ParsedHeader {
  readonly header: Buffer;
  readonly keyId: string;
}

interface StagedBlob {
  readonly info: BlobInfo;
  readonly temporary: string;
}

function safeAddress(address: string): string {
  if (!/^[a-f0-9]{64}$/.test(address)) throw new Error('Invalid blob address.');
  return address;
}

function headerFor(keyId: string, nonce: Buffer): Buffer {
  const key = Buffer.from(keyId, 'utf8');
  if (key.length === 0 || key.length > 255 || nonce.length !== NONCE_BYTES)
    throw new Error('Invalid blob encryption header.');
  return Buffer.concat([MAGIC, Buffer.from([VERSION, key.length]), key, nonce]);
}

function parseHeader(value: Buffer): ParsedHeader {
  if (
    value.length < 6 + NONCE_BYTES ||
    !value.subarray(0, 4).equals(MAGIC) ||
    value[4] !== VERSION
  )
    throw new Error('Invalid encrypted blob header.');
  const keyLength = value[5];
  if (
    keyLength === undefined ||
    keyLength === 0 ||
    value.length !== 6 + keyLength + NONCE_BYTES
  )
    throw new Error('Invalid encrypted blob header.');
  const keyId = value.subarray(6, 6 + keyLength).toString('utf8');
  if (!/^[A-Za-z0-9._-]+$/.test(keyId))
    throw new Error('Invalid encrypted blob key identifier.');
  return { header: value, keyId };
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error('Blob directory is unsafe.');
  await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch {
    // Directory sync is not available on every supported filesystem.
  } finally {
    await directory?.close();
  }
}

class HashingTransform extends Transform {
  readonly hash: ReturnType<typeof createHmac>;
  byteLength = 0;
  constructor(key: Buffer) {
    super();
    this.hash = createHmac('sha256', key);
  }
  override _transform(
    chunk: Buffer,
    _: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.hash.update(chunk);
    this.byteLength += chunk.length;
    callback(null, chunk);
  }
}

async function* decryptChunks(
  path: string,
  header: Buffer,
  key: Buffer,
): AsyncGenerator<Buffer> {
  const nonce = header.subarray(header.length - NONCE_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(path, {
      start: header.length,
    })) {
      const joined = Buffer.concat([tail, Buffer.from(chunk)]);
      if (joined.length <= TAG_BYTES) {
        tail = joined;
        continue;
      }
      const ciphertext = joined.subarray(0, joined.length - TAG_BYTES);
      tail = joined.subarray(joined.length - TAG_BYTES);
      const plaintext = decipher.update(ciphertext);
      if (plaintext.length > 0) yield plaintext;
    }
    if (tail.length !== TAG_BYTES)
      throw new Error('Encrypted blob is truncated.');
    decipher.setAuthTag(tail);
    const final = decipher.final();
    if (final.length > 0) yield final;
  } catch {
    throw new Error('Encrypted blob integrity verification failed.');
  }
}

/** Streaming, encrypted, content-addressed blob store. */
export class BlobStore {
  readonly #root: string;
  readonly #addressKey: Buffer;
  readonly #keyForId: BlobKeyResolver;
  readonly #activeKeyId: () => string;
  #initialization?: Promise<void>;

  constructor(options: {
    stateDir: string;
    addressKey: Buffer;
    keyForId: BlobKeyResolver;
    activeKeyId: () => string;
  }) {
    this.#root = join(options.stateDir, 'blobs');
    this.#addressKey = Buffer.from(options.addressKey);
    this.#keyForId = options.keyForId;
    this.#activeKeyId = options.activeKeyId;
  }

  async initialize(): Promise<void> {
    await this.#ensureInitialized();
  }

  async #ensureInitialized(): Promise<void> {
    if (!this.#initialization) {
      const pending = this.#recoverInitialState();
      this.#initialization = pending;
      try {
        await pending;
      } catch (error) {
        if (this.#initialization === pending) this.#initialization = undefined;
        throw error;
      }
      return;
    }
    await this.#initialization;
  }

  async #recoverInitialState(): Promise<void> {
    await directory(this.#root);
    const entries = await readdir(this.#root, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name.endsWith('.tmp') && entry.isFile())
        .map((entry) => rm(join(this.#root, entry.name), { force: true })),
    );
    const prefixes = await readdir(this.#root, { withFileTypes: true });
    await Promise.all(
      prefixes
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            /^[a-f0-9]{2}$/.test(entry.name),
        )
        .map((entry) => this.#recoverSwaps(join(this.#root, entry.name))),
    );
  }

  pathFor(address: string): string {
    return join(
      this.#root,
      safeAddress(address).slice(0, 2),
      safeAddress(address).slice(2),
    );
  }

  async #recoverSwaps(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith('.swap-backup'),
        )
        .map(async (entry) => {
          const backup = join(directoryPath, entry.name);
          const target = join(
            directoryPath,
            entry.name.slice(0, -'.swap-backup'.length),
          );
          try {
            const status = await lstat(target);
            if (!status.isFile() || status.isSymbolicLink())
              throw new Error('Encrypted blob is unavailable.');
            await rm(backup, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await rename(backup, target);
          }
        }),
    );
    await syncDirectory(directoryPath);
  }

  async #stage(input: Readable): Promise<StagedBlob> {
    const keyId = this.#activeKeyId();
    const nonce = randomBytes(NONCE_BYTES);
    const header = headerFor(keyId, nonce);
    const temporary = join(
      this.#root,
      `${randomBytes(16).toString('hex')}.tmp`,
    );
    let headerFile: FileHandle | undefined;
    try {
      headerFile = await open(temporary, 'wx', 0o600);
      await headerFile.write(header);
      await headerFile.close();
      headerFile = undefined;
      const hashing = new HashingTransform(this.#addressKey);
      const cipher = createCipheriv(
        'aes-256-gcm',
        this.#keyForId(keyId),
        nonce,
      );
      cipher.setAAD(header);
      await pipeline(
        input,
        hashing,
        cipher,
        createWriteStream(temporary, { flags: 'a', mode: 0o600 }),
      );
      const file = await open(temporary, 'a');
      try {
        await file.write(cipher.getAuthTag());
        await file.sync();
      } finally {
        await file.close();
      }
      const address = hashing.hash.digest('hex');
      return {
        info: { address, byteLength: hashing.byteLength, keyId },
        temporary,
      };
    } catch (error) {
      try {
        await headerFile?.close();
      } finally {
        await rm(temporary, { force: true });
      }
      throw error;
    }
  }

  async #publishNew(staged: StagedBlob): Promise<BlobInfo> {
    const target = this.pathFor(staged.info.address);
    const parent = join(this.#root, staged.info.address.slice(0, 2));
    await directory(parent);
    try {
      const status = await lstat(target);
      if (!status.isFile() || status.isSymbolicLink())
        throw new Error('Encrypted blob is unavailable.');
      await rm(staged.temporary, { force: true });
      return staged.info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await rename(staged.temporary, target);
        await chmod(target, 0o600);
        await syncDirectory(parent);
        return staged.info;
      } catch (publishError) {
        try {
          const status = await lstat(target);
          if (!status.isFile() || status.isSymbolicLink()) throw publishError;
          await rm(staged.temporary, { force: true });
          return staged.info;
        } catch {
          await rm(staged.temporary, { force: true });
          throw publishError;
        }
      }
    }
  }

  async #replaceVerified(
    staged: StagedBlob,
    expectedAddress: string,
  ): Promise<void> {
    if (staged.info.address !== expectedAddress) {
      await rm(staged.temporary, { force: true });
      throw new Error('Blob address changed during re-encryption.');
    }
    const target = this.pathFor(expectedAddress);
    await this.#recoverSwaps(join(this.#root, expectedAddress.slice(0, 2)));
    const status = await lstat(target);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error('Encrypted blob is unavailable.');
    const backup = `${target}.swap-backup`;
    try {
      await rename(target, backup);
      try {
        await rename(staged.temporary, target);
      } catch (error) {
        try {
          await rename(backup, target);
        } catch {
          // Startup recovery restores a remaining target-local backup.
        }
        throw error;
      }
      await rm(backup, { force: true });
      await chmod(target, 0o600);
      await syncDirectory(join(this.#root, expectedAddress.slice(0, 2)));
    } catch (error) {
      await rm(staged.temporary, { force: true });
      throw error;
    }
  }

  /** Encrypt and atomically add a stream. Existing equal-address blobs are deduplicated. */
  async put(input: Readable): Promise<BlobInfo> {
    await this.#ensureInitialized();
    return this.#publishNew(await this.#stage(input));
  }

  /** Open and authenticate a blob as a plaintext stream; no complete blob is buffered. */
  async open(address: string): Promise<Readable> {
    const path = this.pathFor(address);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error('Encrypted blob is unavailable.');
    const handle = await open(path, 'r');
    try {
      const fixed = Buffer.alloc(6);
      await handle.read(fixed, 0, 6, 0);
      const keyLength = fixed[5];
      if (keyLength === undefined)
        throw new Error('Invalid encrypted blob header.');
      const header = Buffer.alloc(6 + keyLength + NONCE_BYTES);
      await handle.read(header, 0, header.length, 0);
      const parsed = parseHeader(header);
      return Readable.from(
        decryptChunks(path, parsed.header, this.#keyForId(parsed.keyId)),
      );
    } finally {
      await handle.close();
    }
  }

  /** Re-encrypt a blob under the current key without changing its stable address. */
  async reencrypt(address: string): Promise<BlobInfo> {
    await this.#ensureInitialized();
    const plaintext = await this.open(address);
    const staged = await this.#stage(plaintext);
    await this.#replaceVerified(staged, safeAddress(address));
    return staged.info;
  }
}
