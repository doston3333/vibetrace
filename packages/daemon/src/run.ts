import { startDaemon } from './index.js';

async function stdinPassphrase(maxBytes = 4_096): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error('Storage passphrase is too large.');
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/[\r\n]+$/, '');
  if (value.length === 0) throw new Error('Storage passphrase is empty.');
  return value;
}

const storagePassphrase = process.argv.includes('--storage-passphrase-stdin')
  ? await stdinPassphrase()
  : undefined;
const daemon = await startDaemon({
  ...(storagePassphrase ? { storagePassphrase } : {}),
});
const shutdown = (): void => {
  void daemon.close().finally(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGBREAK', shutdown);
