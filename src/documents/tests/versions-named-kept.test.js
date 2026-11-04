import { it, expect, beforeEach, afterEach } from 'vitest';
import { saveVersion, listVersions, readVersionMeta, writeVersionMeta } from '../src/lib/versions.js';

/** An in-memory Puter file system, enough for version folders. */
const fakePuter = () => {
  const files = new Map();
  const notFound = () => Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' });
  return {
    files, env: 'web',
    fs: {
      async readdir(p) {
        if (![...files.keys()].some(k => k.startsWith(`${p}/`))) throw notFound();
        return [...files.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map(([k, v]) => ({ name: k.split('/').pop(), path: k, size: v.size, modified: 1 }));
      },
      async read(p) { if (!files.has(p)) throw notFound(); return files.get(p); },
      async write(p, blob, { overwrite = true } = {}) { if (files.has(p) && !overwrite) throw new Error('Already exists'); files.set(p, blob); return { path: p, name: p.split('/').pop() }; },
      async delete(p) { if (!files.has(p)) throw notFound(); files.delete(p); },
      async stat(p) { if (files.has(p)) return { path: p }; throw notFound(); },
    },
  };
};
let pf;
beforeEach(() => { pf = fakePuter(); globalThis.puter = pf; });
afterEach(() => { delete globalThis.puter; });
const T0 = Date.UTC(2026, 7, 28, 9, 0, 0, 0);
const blob = s => new Blob([s]);

/**
 * A version someone named (Save a Version Now, or "Before the shared changes") is one they meant to keep: the newest
 * unnamed versions still make way for new ones, but a named one does not go when it is no longer among them.
 */
it('keeps named versions when it trims the oldest', async () => {
  const named = await saveVersion('Documents/A.docx', blob('draft for review'), { now: T0, keep: 3, meta: { author: 'ada', label: 'Draft for review' } });
  const authored = await saveVersion('Documents/A.docx', blob('autosaved'), { now: T0 + 1000, keep: 3, meta: { author: 'ada' } });
  for (let i = 2; i < 8; i++) await saveVersion('Documents/A.docx', blob(String(i)), { now: T0 + i * 1000, keep: 3, meta: { author: 'ada' } });
  const list = await listVersions('Documents/A.docx');
  expect(list.map(v => v.time)).toEqual([T0 + 7000, T0 + 6000, T0 + 5000, T0]);
  expect(list.at(-1).path).toBe(named.path);
  expect((await readVersionMeta(list.at(-1))).label).toBe('Draft for review');
  // Unnamed ones went, with their details.
  expect(pf.files.has(authored.path)).toBe(false);
  expect(pf.files.has(authored.path.replace(/\.docx$/, '.json'))).toBe(false);
  // A name given later keeps a version too.
  await writeVersionMeta(list[2], { author: 'ada', label: 'Final' });
  await saveVersion('Documents/A.docx', blob('8'), { now: T0 + 8000, keep: 3 });
  expect((await listVersions('Documents/A.docx')).map(v => v.time)).toEqual([T0 + 8000, T0 + 7000, T0 + 6000, T0 + 5000, T0]);
});
