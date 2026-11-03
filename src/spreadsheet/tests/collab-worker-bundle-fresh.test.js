import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

// The room worker that owners deploy is the committed bundle, not the source: a change to what the worker checks
// (a sheet setting added to the shared ones, say) that is not rebuilt into it has every browser's change refused.
it('the committed room worker bundle is the one its source builds', async () => {
  const out = await build({ root, configFile: `${root}vite.worker.config.js`, logLevel: 'silent', build: { write: false } });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk' && o.isEntry);
  const committed = readFileSync(`${root}public/worker/spreadsheet-worker.js`, 'utf8');
  expect(committed.split('\n', 1)[0]).toBe(chunk.code.split('\n', 1)[0]);
  expect(committed === chunk.code).toBe(true);
}, 30_000);
