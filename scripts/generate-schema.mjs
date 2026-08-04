import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { getTraceEventJsonSchema } = await import(
  `${root}/packages/schema/dist/index.js`
);
const { getEvalManifestJsonSchema } = await import(
  `${root}/packages/eval-spec/dist/index.js`
);
const schemas = [
  [
    `${root}/packages/schema/generated/trace-event.schema.json`,
    getTraceEventJsonSchema(),
  ],
  [
    `${root}/packages/eval-spec/generated/eval-manifest.schema.json`,
    getEvalManifestJsonSchema(),
  ],
];
for (const [destination, schema] of schemas) {
  await mkdir(dirname(destination), { recursive: true });
  const contents = await prettier.format(JSON.stringify(schema, null, 2), {
    parser: 'json',
  });
  await writeFile(destination, contents, {
    mode: 0o644,
  });
}
