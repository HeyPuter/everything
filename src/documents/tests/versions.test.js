import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as P from '../src/lib/puter.js';
import { rememberDocumentRoot } from '../src/lib/document-paths.js';
import { versionsFolder, versionName, parseVersionTime, shouldSnapshot, listVersions, saveVersion, snapshotIfDue, renameVersions, deleteVersions, VERSION_INTERVAL_MS, MAX_VERSIONS } from '../src/lib/versions.js';

/** An in-memory Puter file system with folders. */
const fakePuter = () => {
  const files = new Map();
  const dirs = new Set();
  const notFound = () => Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' });
  return {
    files, dirs,
    env: 'web',
    fs: {
      async mkdir(p) { dirs.add(p); },
      async readdir(p) {
        if (!dirs.has(p) && ![...files.keys()].some((k) => k.startsWith(`${p}/`))) throw notFound();
        return [...files.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map(([k, v]) => ({ name: k.split('/').pop(), path: k, size: v.size, modified: 1 }));
      },
      async write(p, blob, { overwrite = true, dedupeName = false } = {}) {
        const requested = p;
        let n = 1;
        while (files.has(p) && dedupeName) p = requested.replace(/\.docx$/, ` (${n++}).docx`);
        if (files.has(p) && !overwrite) throw new Error('Already exists');
        files.set(p, blob); dirs.add(p.split('/').slice(0, -1).join('/')); return { path: p, name: p.split('/').pop() };
      },
      async delete(p, { recursive } = {}) { if (!files.has(p) && !dirs.has(p) && ![...files.keys()].some((k) => k.startsWith(`${p}/`))) throw notFound(); files.delete(p); if (recursive) for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k); dirs.delete(p); },
      async rename(p, newName) {
        if (!dirs.has(p) && !files.has(p) && ![...files.keys()].some((k) => k.startsWith(`${p}/`))) throw notFound();
        const target = `${p.split('/').slice(0, -1).join('/')}/${newName}`;
        for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) { files.set(`${target}${k.slice(p.length)}`, files.get(k)); files.delete(k); }
        dirs.delete(p); dirs.add(target);
      },
      async stat(p) { if (files.has(p) || dirs.has(p)) return { path: p }; throw notFound(); },
    },
  };
};

describe('version naming', () => {
  it('maps document paths to a snapshot folder inside the app folder only', () => {
    expect(versionsFolder('Documents/Report.docx')).toBe('Documents/.versions/Report');
    expect(versionsFolder('Documents/Q1.final.docx')).toBe('Documents/.versions/Q1.final');
    expect(versionsFolder('Desktop/Report.docx')).toBeNull();
    expect(versionsFolder('Documents/sub/Report.docx')).toBeNull();
    expect(versionsFolder(null)).toBeNull();
  });

  it.each(['.docx', '..docx', '...docx'])('never maps %s to the history root or its parent', (name) => {
    expect(versionsFolder(`Documents/${name}`)).toBeNull();
  });

  it.each(['Report.hwp', 'Report.hwpx', 'Report.dotx', 'Report.docm'])('does not give %s the history of Report.docx', (name) => {
    expect(versionsFolder(`Documents/${name}`)).toBeNull();
  });

  it('round-trips snapshot times through file names', () => {
    const t = Date.UTC(2026, 7, 28, 9, 15, 30, 123);
    expect(versionName(t)).toBe('2026-08-28T09-15-30-123Z.docx');
    expect(parseVersionTime(versionName(t))).toBe(t);
    expect(parseVersionTime('notes.docx')).toBeNull();
    expect(parseVersionTime('')).toBeNull();
  });

  it('snapshots when none exists or the last is old enough', () => {
    expect(shouldSnapshot(null, 1000)).toBe(true);
    expect(shouldSnapshot(0, VERSION_INTERVAL_MS - 1)).toBe(false);
    expect(shouldSnapshot(0, VERSION_INTERVAL_MS)).toBe(true);
    expect(shouldSnapshot(500, 800, 300)).toBe(true);
  });
});

describe('snapshots on Puter', () => {
  let pf;
  beforeEach(() => { pf = fakePuter(); globalThis.puter = pf; });
  afterEach(() => { delete globalThis.puter; });
  const blob = (s) => new Blob([s]);
  const T0 = Date.UTC(2026, 7, 28, 9, 0, 0, 0);

  it('lists nothing for a fresh document and newest first once saved', async () => {
    expect(await listVersions('Documents/A.docx')).toEqual([]);
    await saveVersion('Documents/A.docx', blob('one'), { now: T0 });
    await saveVersion('Documents/A.docx', blob('two!'), { now: T0 + 60000 });
    const list = await listVersions('Documents/A.docx');
    expect(list.map((v) => v.time)).toEqual([T0 + 60000, T0]);
    expect(list[0].path).toBe(`Documents/.versions/A/${versionName(T0 + 60000)}`);
    expect(list[0].size).toBe(4);
    expect(await saveVersion('Desktop/x.docx', blob('x'))).toBeNull();
  });

  it('trims the oldest beyond the cap', async () => {
    for (let i = 0; i < MAX_VERSIONS + 3; i++) await saveVersion('Documents/A.docx', blob(String(i)), { now: T0 + i * 1000, keep: MAX_VERSIONS });
    const list = await listVersions('Documents/A.docx');
    expect(list).toHaveLength(MAX_VERSIONS);
    expect(list.at(-1).time).toBe(T0 + 3000);
  });

  it('preserves concurrent snapshots taken in the same millisecond and lists the newest first', async () => {
    const versions = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      saveVersion('Documents/A.docx', blob(`revision ${i}`), { now: T0 })));
    expect(new Set(versions.map((v) => v.path)).size).toBe(12);
    for (const [i, version] of versions.entries()) {
      expect(await pf.files.get(version.path).text()).toBe(`revision ${i}`);
    }
    const list = await listVersions('Documents/A.docx');
    expect(list.map((v) => v.path)).toEqual(versions.map((v) => v.path).reverse());
    expect(list.map((v) => v.time)).toEqual(Array.from({ length: 12 }, (_, i) => T0 + 11 - i));
  });

  it('trims older same-time snapshots without overwriting their newer replacements', async () => {
    const versions = [];
    for (let i = 0; i < 8; i++) versions.push(await saveVersion('Documents/A.docx', blob(`revision ${i}`), { now: T0, keep: 3 }));
    expect((await listVersions('Documents/A.docx')).map((v) => v.path)).toEqual(versions.slice(-3).map((v) => v.path).reverse());
    expect(await pf.files.get(versions.at(-1).path).text()).toBe('revision 7');
  });

  it('reports write failures without discarding an existing snapshot', async () => {
    const first = await saveVersion('Documents/A.docx', blob('keep'), { now: T0 });
    const write = vi.spyOn(pf.fs, 'write').mockRejectedValue(new Error('Permission denied'));
    await expect(saveVersion('Documents/A.docx', blob('new'), { now: T0 })).rejects.toThrow('Permission denied');
    expect(write).toHaveBeenCalledOnce();
    expect(await pf.files.get(first.path).text()).toBe('keep');
  });

  it('snapshots after a save only when due, reading the folder once', async () => {
    let last = await snapshotIfDue('Documents/A.docx', blob('v1'), undefined, { now: T0 });
    expect(last).toBe(T0);
    last = await snapshotIfDue('Documents/A.docx', blob('v2'), last, { now: T0 + 1000 });
    expect(last).toBe(T0);
    last = await snapshotIfDue('Documents/A.docx', blob('v3'), last, { now: T0 + VERSION_INTERVAL_MS });
    expect(last).toBe(T0 + VERSION_INTERVAL_MS);
    expect((await listVersions('Documents/A.docx')).map((v) => v.time)).toEqual([T0 + VERSION_INTERVAL_MS, T0]);
    // An existing history is picked up when the last time is unknown.
    expect(await snapshotIfDue('Documents/A.docx', blob('v4'), undefined, { now: T0 + VERSION_INTERVAL_MS + 5 })).toBe(T0 + VERSION_INTERVAL_MS);
    expect(await snapshotIfDue('Desktop/x.docx', blob('x'), undefined, { now: T0 })).toBeNull();
  });

  it('does not resolve the cloud folder on every autosave between snapshots', async () => {
    const stat = vi.spyOn(pf.fs, 'stat');
    expect(await snapshotIfDue('/demo/AppData/documents-app/Documents/A.docx', blob('edit'), T0, { now: T0 + 1000 })).toBe(T0);
    expect(stat).not.toHaveBeenCalled();
  });

  it('uses the app folder\'s known location instead of asking the cloud for a document opened by its absolute path', async () => {
    const stat = vi.spyOn(pf.fs, 'stat');
    rememberDocumentRoot('/demo/AppData/documents-app/Documents', pf);
    expect(await snapshotIfDue('/demo/AppData/documents-app/Documents/A.docx', blob('edit'), undefined, { now: T0 })).toBe(T0);
    expect(await snapshotIfDue('/elsewhere/x.docx', blob('edit'), null, { now: T0 })).toBeNull();
    expect(await snapshotIfDue('/elsewhere/x.docx', blob('edit'), null, { now: T0 + 1000 })).toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it('follows a rename and goes with a delete', async () => {
    await saveVersion('Documents/A.docx', blob('one'), { now: T0 });
    await renameVersions('Documents/A.docx', 'Documents/B.docx');
    expect(await listVersions('Documents/A.docx')).toEqual([]);
    expect((await listVersions('Documents/B.docx')).map((v) => v.time)).toEqual([T0]);
    await renameVersions('Documents/Nope.docx', 'Documents/C.docx');
    await deleteVersions('Documents/B.docx');
    expect(await listVersions('Documents/B.docx')).toEqual([]);
    expect([...pf.files.keys()].some((k) => k.startsWith('Documents/.versions/B/'))).toBe(false);
  });

  it('replaces a history left behind at the new name instead of adopting it', async () => {
    // B was deleted outside the app, leaving its snapshots; A is renamed to B.
    await saveVersion('Documents/B.docx', blob('stale'), { now: T0 - 1000 });
    await saveVersion('Documents/A.docx', blob('mine'), { now: T0 });
    await renameVersions('Documents/A.docx', 'Documents/B.docx');
    expect((await listVersions('Documents/B.docx')).map((v) => v.time)).toEqual([T0]);
    expect(await listVersions('Documents/A.docx')).toEqual([]);
  });

  it('replaces an empty folder left behind at the new name', async () => {
    // B's snapshots were removed one by one, leaving its empty folder; A is renamed to B.
    await saveVersion('Documents/B.docx', blob('stale'), { now: T0 - 1000 });
    for (const key of [...pf.files.keys()]) if (key.startsWith('Documents/.versions/B/')) pf.files.delete(key);
    await pf.fs.mkdir?.('Documents/.versions/B');
    await saveVersion('Documents/A.docx', blob('mine'), { now: T0 });
    await renameVersions('Documents/A.docx', 'Documents/B.docx');
    expect((await listVersions('Documents/B.docx')).map((v) => v.time)).toEqual([T0]);
    expect(await listVersions('Documents/A.docx')).toEqual([]);
  });

  it('keeps the same history after reopening an absolute path returned by Puter', async () => {
    const root = '/demo/AppData/documents-app';
    await P.writeFile('Documents/A.docx', blob('document'));
    await saveVersion('Documents/A.docx', blob('one'), { now: T0 });
    // The real SDK resolves relative requests but returns absolute FSItem paths.
    for (const method of ['stat', 'readdir', 'write', 'rename', 'delete']) {
      const original = pf.fs[method];
      pf.fs[method] = async (path, ...args) => {
        const result = await original(path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path, ...args);
        const absolute = (item) => ({ ...item, path: `${root}/${item.path}` });
        return Array.isArray(result) ? result.map(absolute) : result?.path ? absolute(result) : result;
      };
    }
    const [{ path }] = await P.listFiles();
    expect(path).toBe(`${root}/Documents/A.docx`);
    expect((await listVersions(path)).map((v) => v.time)).toEqual([T0]);
    expect(await snapshotIfDue(path, blob('two'), undefined, { now: T0 + VERSION_INTERVAL_MS })).toBe(T0 + VERSION_INTERVAL_MS);
    await saveVersion(path, blob('manual'), { now: T0 + VERSION_INTERVAL_MS + 1 });
    expect(await listVersions(path)).toHaveLength(3);
    await renameVersions(path, `${root}/Documents/B.docx`);
    expect(await listVersions('Documents/B.docx')).toHaveLength(3);
    await deleteVersions(`${root}/Documents/B.docx`);
    expect(await listVersions('Documents/B.docx')).toEqual([]);
  });

  it('never assigns an outside absolute document the history of an app document', async () => {
    await saveVersion('Documents/A.docx', blob('keep'), { now: T0 });
    pf.fs.stat = async () => ({ path: '/demo/AppData/this-app/Documents' });
    for (const path of ['/demo/Documents/A.docx', '/other/AppData/this-app/Documents/A.docx', '/demo/AppData/other-app/Documents/A.docx', '/demo/AppData/this-app/Documents/sub/A.docx', '/demo/AppData/this-app/Documents/../A.docx']) {
      expect(await listVersions(path)).toEqual([]);
      expect(await saveVersion(path, blob('outside'))).toBeNull();
      await renameVersions(path, 'Documents/B.docx');
      await deleteVersions(path);
    }
    expect(await listVersions('Documents/A.docx')).toHaveLength(1);
  });

  it('does not delete or move unrelated history for dot-only names or non-DOCX sources', async () => {
    await saveVersion('Documents/Report.docx', blob('saved work'), { now: T0 });
    const remove = vi.spyOn(pf.fs, 'delete');
    const rename = vi.spyOn(pf.fs, 'rename');
    for (const name of ['.docx', '..docx', '...docx', 'Report.hwp']) {
      await deleteVersions(`Documents/${name}`);
      await renameVersions(`Documents/${name}`, 'Documents/Other.docx');
      await renameVersions('Documents/Report.docx', `Documents/${name}`);
      expect(await saveVersion(`Documents/${name}`, blob('other work'))).toBeNull();
    }
    expect(remove).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect((await listVersions('Documents/Report.docx')).map((v) => v.time)).toEqual([T0]);
  });

  it('keeps the history of a document elsewhere on the drive by its id, through a rename, until it is deleted', async () => {
    // Inside the Puter desktop Save puts a new document where the user chooses, outside the app folder.
    const path = '/demo/Desktop/Plan.docx', uid = 'file-uid-1';
    expect(await snapshotIfDue(path, blob('first'), undefined, { now: T0, uid })).toBe(T0);
    await saveVersion(path, blob('named'), { now: T0 + 1, uid });
    const [folder] = new Set([...pf.files.keys()].map((k) => k.slice(0, k.lastIndexOf('/'))));
    expect(folder).toMatch(/^Documents\/\.versions-by-id\/[a-z0-9]+$/);
    expect((await listVersions(path, { uid })).map((v) => v.time)).toEqual([T0 + 1, T0]);
    // The id stays the same through a rename or a move: so does the history, and nothing has to move.
    const rename = vi.spyOn(pf.fs, 'rename');
    await renameVersions(path, '/demo/Desktop/Final.docx');
    expect(rename).not.toHaveBeenCalled();
    expect(await listVersions('/demo/Work/Final.docx', { uid })).toHaveLength(2);
    // Another file's id is another history; a file whose id is not known has none.
    expect(await listVersions(path, { uid: 'file-uid-2' })).toEqual([]);
    expect(await listVersions(path)).toEqual([]);
    expect(await saveVersion(path, blob('x'))).toBeNull();
    // Only a .docx has one, as in the app folder.
    expect(await saveVersion('/demo/Desktop/Plan.dotx', blob('x'), { uid })).toBeNull();
    await deleteVersions('/demo/Work/Final.docx', { uid });
    expect([...pf.files.keys()].filter((k) => k.startsWith('Documents/.versions-by-id/'))).toEqual([]);
  });

  it('a document in the app folder keeps its history by name, whatever its id', async () => {
    await saveVersion('Documents/A.docx', blob('one'), { now: T0 });
    expect(await listVersions('Documents/A.docx', { uid: 'file-uid-1' })).toHaveLength(1);
    await saveVersion('Documents/A.docx', blob('two'), { now: T0 + 1, uid: 'file-uid-1' });
    expect([...pf.files.keys()].every((k) => !k.includes('.versions-by-id'))).toBe(true);
  });
});
