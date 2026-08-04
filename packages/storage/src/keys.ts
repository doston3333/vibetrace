import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SERVICE = 'dev.vibetrace';
const ACCOUNT = 'storage-root-v1';
const ENVELOPE_NAME = 'key-envelope.v1.json';
const ROOT_SECRET_BYTES = 32;

/** Supplies the 32-byte storage root secret without exposing it to callers. */
export interface KeyProvider {
  /** Load the existing root secret, or return undefined when none is initialized. */
  getRootSecret(): Promise<Uint8Array | undefined>;
  /** Persist a newly generated root secret. */
  setRootSecret(secret: Uint8Array): Promise<void>;
}

/** Test-friendly key provider which never writes to the host keychain. */
export class MemoryKeyProvider implements KeyProvider {
  #secret?: Buffer;

  async getRootSecret(): Promise<Uint8Array | undefined> {
    return this.#secret ? Buffer.from(this.#secret) : undefined;
  }

  async setRootSecret(secret: Uint8Array): Promise<void> {
    this.#secret = validateRootSecret(secret);
  }
}

/** OS keychain provider using the VibeTrace service/account namespace. */
export class OsKeyringProvider implements KeyProvider {
  async getRootSecret(): Promise<Uint8Array | undefined> {
    const entry = await keyringEntry();
    return (await entry.getSecret()) ?? undefined;
  }

  async setRootSecret(secret: Uint8Array): Promise<void> {
    const entry = await keyringEntry();
    await entry.setSecret(validateRootSecret(secret));
  }
}

interface AsyncKeyringEntry {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(secret: Uint8Array): Promise<void>;
}

async function keyringEntry(): Promise<AsyncKeyringEntry> {
  const module = await import('@napi-rs/keyring');
  if (typeof module.AsyncEntry !== 'function') {
    throw new Error('The operating-system keyring is unavailable.');
  }
  return new module.AsyncEntry(SERVICE, ACCOUNT);
}

interface Envelope {
  readonly version: 1;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function validateRootSecret(secret: Uint8Array): Buffer {
  const copy = Buffer.from(secret);
  if (copy.length !== ROOT_SECRET_BYTES) {
    throw new Error('Storage root secret must be exactly 32 bytes.');
  }
  return copy;
}

function envelopePath(stateDir: string): string {
  return join(stateDir, ENVELOPE_NAME);
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

async function recoverEnvelopeState(stateDir: string): Promise<void> {
  const path = envelopePath(stateDir);
  const backup = `${path}.swap-backup`;
  try {
    await access(path);
    await rm(backup, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await rename(backup, path);
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT')
        throw backupError;
    }
  }
  const entries = await readdir(stateDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(`.${ENVELOPE_NAME}.`) &&
          entry.name.endsWith('.tmp'),
      )
      .map((entry) => rm(join(stateDir, entry.name), { force: true })),
  );
  await syncDirectory(stateDir);
}

async function hasEnvelope(stateDir: string): Promise<boolean> {
  try {
    const status = await lstat(envelopePath(stateDir));
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

async function passphraseKey(
  passphrase: string,
  salt: Buffer,
): Promise<Buffer> {
  if (passphrase.length === 0)
    throw new Error('A non-empty storage passphrase is required.');
  return new Promise((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      32,
      { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(Buffer.from(key));
      },
    );
  });
}

/** Create or replace the passphrase envelope without changing the root secret. */
export async function writePassphraseEnvelope(
  stateDir: string,
  passphrase: string,
  secret: Uint8Array,
): Promise<void> {
  const root = validateRootSecret(secret);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    await passphraseKey(passphrase, salt),
    nonce,
  );
  const ciphertext = Buffer.concat([cipher.update(root), cipher.final()]);
  const envelope: Envelope = {
    version: 1,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  const path = envelopePath(stateDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await recoverEnvelopeState(stateDir);
  const temporary = join(
    dirname(path),
    `.${ENVELOPE_NAME}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let file: FileHandle | undefined;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(envelope), 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    const backup = `${path}.swap-backup`;
    try {
      await access(path);
      await rename(path, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      try {
        await rename(backup, path);
      } catch {
        // A surviving backup is restored by recoverEnvelopeState on next use.
      }
      throw error;
    }
    await rm(backup, { force: true });
    await syncDirectory(dirname(path));
  } catch (error) {
    try {
      await file?.close();
    } finally {
      await rm(temporary, { force: true });
    }
    throw error;
  }
}

/** Unlock the root secret from a locally stored passphrase envelope. */
export async function readPassphraseEnvelope(
  stateDir: string,
  passphrase: string,
): Promise<Buffer> {
  let envelope: Envelope;
  try {
    await recoverEnvelopeState(stateDir);
    const status = await lstat(envelopePath(stateDir));
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('unsafe');
    envelope = JSON.parse(
      await readFile(envelopePath(stateDir), 'utf8'),
    ) as Envelope;
  } catch {
    throw new Error('Storage passphrase envelope is unavailable or invalid.');
  }
  if (
    envelope.version !== 1 ||
    !envelope.salt ||
    !envelope.nonce ||
    !envelope.ciphertext ||
    !envelope.tag
  ) {
    throw new Error('Storage passphrase envelope is invalid.');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      await passphraseKey(passphrase, Buffer.from(envelope.salt, 'base64')),
      Buffer.from(envelope.nonce, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return validateRootSecret(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]),
    );
  } catch {
    throw new Error(
      'Storage could not be unlocked with the supplied passphrase.',
    );
  }
}

/** Resolve a root secret using a supplied provider, OS keychain, or passphrase envelope. */
export async function resolveRootSecret(options: {
  readonly stateDir: string;
  readonly keyProvider?: KeyProvider;
  readonly passphrase?: string;
  readonly create: boolean;
}): Promise<Buffer> {
  // An explicit passphrase is an operator request to use the local envelope.
  // Do not probe a potentially unavailable or interactive OS keychain first:
  // headless starts must remain bounded and deterministic across platforms.
  if (options.passphrase !== undefined) {
    if (await hasEnvelope(options.stateDir))
      return readPassphraseEnvelope(options.stateDir, options.passphrase);
    if (!options.create)
      throw new Error('Storage passphrase envelope is unavailable or invalid.');
    const root = randomBytes(ROOT_SECRET_BYTES);
    await writePassphraseEnvelope(options.stateDir, options.passphrase, root);
    return root;
  }
  const provider = options.keyProvider ?? new OsKeyringProvider();
  try {
    const existing = await provider.getRootSecret();
    if (existing) return validateRootSecret(existing);
    if (!options.create) throw new Error('Storage has not been initialized.');
    const root = randomBytes(ROOT_SECRET_BYTES);
    await provider.setRootSecret(root);
    return root;
  } catch (error) {
    throw error instanceof Error && error.message.includes('initialized')
      ? error
      : new Error(
          'Operating-system keyring is unavailable; a passphrase is required.',
        );
  }
}
