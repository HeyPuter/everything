// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Doc, versioning } from '../src/lib/doc.js';
import { listVersions, versionName } from '../src/lib/versions.js';
import { importFiles } from '../src/lib/importfiles.js';

vi.mock('../src/ui/toast.js', () => ({ toast: () => ({ dismiss() {} }) }));

// A document deleted (or moved away) outside the app leaves its history under its name, Documents/.versions/<name>.
// A new document saved under that name ("Untitled document", most often) listed the gone document's versions as its
// own, offered to restore them over its own text, and took no first version itself, since the newest one looked
// recent. A file the app makes under a name no file had now starts with a history of its own.

const OLD = Date.UTC(2026, 10, 23, 9, 0, 0, 0);
const missing = () => Object.assign(new Error('Not found'), { code: 'subject_does_not_exist' });
function drive(entries) {
  const files = new Map(entries);
  vi.stubGlobal('puter', { env: 'web', fs: {
    stat: async (path) => { if (!files.has(path) && ![...files.keys()].some(k => k.startsWith(`${path}/`))) throw missing(); return { path, modified: 1, size: files.get(path)?.size }; },
    readdir: async (dir) => [...files].filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map(([path, blob]) => ({ path, name: path.slice(dir.length + 1), size: blob.size })),
    read: async (path) => { if (!files.has(path)) throw missing(); return files.get(path); },
    write: async (path, blob, { overwrite = true } = {}) => { if (files.has(path) && !overwrite) throw new Error('exists'); files.set(path, blob); return { path, name: path.split('/').pop(), modified: 2 }; },
    delete: async (path, { recursive = false } = {}) => {
      const gone = [...files.keys()].filter(key => key === path || recursive && key.startsWith(`${path}/`));
      if (!gone.length) throw missing();
      for (const key of gone) files.delete(key);
    },
  } });
  return files;
}
const staleHistory = () => [[`Documents/.versions/Untitled document/${versionName(OLD)}`, new Blob(['someone else\'s letter'])]];

let doc;
afterEach(() => { doc?.destroy(); vi.unstubAllGlobals(); versioning.enabled = true; });

it('a new document saved under the name of a deleted one starts its own history', async () => {
  const files = drive(staleHistory());
  doc = Doc.blank();
  doc.attach(async () => new Blob(['my new text']));
  expect(await doc.save()).toBe(true);
  expect(doc.path).toBe('Documents/Untitled document.docx');
  await vi.waitFor(() => expect(doc._snapshotting).toBeNull());
  const versions = await listVersions(doc.path);
  expect(versions).toHaveLength(1);
  expect(versions[0].time).toBeGreaterThan(OLD);
  expect(files.get(versions[0].path).size).toBe('my new text'.length);
});

it('a copy saved under the name of a deleted document has no versions of that one', async () => {
  drive([['Documents/Plan.docx', new Blob(['plan'])], [`Documents/.versions/Copy/${versionName(OLD)}`, new Blob(['gone'])]]);
  doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx', blob: new Blob(['plan']) });
  doc.attach(async () => new Blob(['plan']));
  expect(await doc.saveAs('Copy')).toBeNull();
  expect(doc.path).toBe('Documents/Copy.docx');
  expect(await listVersions(doc.path)).toEqual([]);
});

it('a document imported among several under the name of a deleted one has no versions of that one', async () => {
  const files = drive([[`Documents/.versions/Report/${versionName(OLD)}`, new Blob(['gone'])]]);
  const word = name => new File([new Uint8Array([0x50, 0x4b, 3, 4])], name);
  await importFiles([word('Report.docx'), word('Other.docx')], { openFile: async () => {} });
  expect(files.has('Documents/Report.docx')).toBe(true);
  expect(await listVersions('Documents/Report.docx')).toEqual([]);
});

it('an existing document keeps its history when it saves', async () => {
  drive([['Documents/Kept.docx', new Blob(['v1'])], [`Documents/.versions/Kept/${versionName(OLD)}`, new Blob(['v0'])]]);
  doc = new Doc({ name: 'Kept', path: 'Documents/Kept.docx', blob: new Blob(['v1']) });
  doc.attach(async () => new Blob(['v2']));
  doc.changed();
  expect(await doc.save()).toBe(true);
  await vi.waitFor(() => expect(doc._snapshotting).toBeNull());
  expect((await listVersions(doc.path)).map(v => v.time)).toContain(OLD);
});
