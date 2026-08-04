import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { getTraceEventJsonSchema } = await import(
  `${root}/packages/schema/dist/index.js`
);
const destination = `${root}/packages/schema/generated/trace-event.schema.json`;
await mkdir(dirname(destination), { recursive: true });
await writeFile(
  destination,
  `${JSON.stringify(getTraceEventJsonSchema(), null, 2)}\n`,
  { mode: 0o644 },
);
