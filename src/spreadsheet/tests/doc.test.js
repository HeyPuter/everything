import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Doc, UNTITLED } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { listVersions, versionsFolder } from '../src/lib/versions.js';

/** Minimal in-memory Puter for the document controller. */
function installMockPuter() {
  const fs = new Map();
  const kv = new Map();
  const notFound = (p) => Object.assign(new Error(`${p} does not exist`), { code: 'subject_does_not_exist' });
  const item = (path, f) => ({ path, name: path.split('/').pop(), is_dir: !f, size: f?.size ?? null, modified: f?.modified ?? 1 });
  globalThis.puter = {
    env: 'web',
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'demo' }), signIn: async () => true, signOut() {} },
    kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); return true; } },
    fs: {
      async mkdir(p) { return item(p); },
      async readdir(p) {
        const out = [...fs.entries()].filter(([k]) => k.startsWith(`${p}/`)).map(([k, f]) => item(k, f));
        if (!out.length) throw notFound(p);
        return out;
      },
      async read(p) { const f = fs.get(p); if (!f) throw notFound(p); return f.blob; },
      async write(p, blob, { overwrite = true, dedupeName = false } = {}) {
        if (fs.has(p) && !overwrite) {
          if (!dedupeName) throw new Error('A file with that name already exists');
          const stem = p.replace(/\.xlsx$/i, '');
          let n = 1;
          while (fs.has(p)) p = `${stem} (${n++}).xlsx`;
        }
        fs.set(p, { blob, size: blob.size, modified: Date.now() / 1000 });
        return item(p, fs.get(p));
      },
      async delete(p) { fs.delete(p); },
      async rename(p, name) { const f = fs.get(p); if (!f) throw notFound(p); fs.delete(p); const t = `${p.split('/').slice(0, -1).join('/')}/${name}`; fs.set(t, f); return item(t, f); },
      async stat(p) { if (fs.has(p)) return item(p, fs.get(p)); throw notFound(p); },
    },
    ui: {},
  };
  return { fs, kv };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Doc', () => {
  let mock;
  // SheetJS is loaded on first use with a real dynamic import, which fake
  // timers cannot advance; warm it up before any test starts a clock.
  beforeAll(async () => { await workbookToXlsx(new Workbook()); });
  beforeEach(() => {
    mock = installMockPuter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.puter;
  });

  it('starts untitled, saved, and without a path', () => {
    const doc = Doc.blank();
    expect(doc.name).toBe(UNTITLED);
    expect(doc.path).toBeNull();
    expect(doc.status).toBe('saved');
    doc.destroy();
  });

  it('autosaves an untitled document into the app folder on first change', async () => {
    const doc = Doc.blank();
    const statuses = [];
    doc.addEventListener('status', (e) => statuses.push(e.detail.status));
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, '42');
    expect(doc.status).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(doc.path).toBe(`Spreadsheets/${UNTITLED}.xlsx`);
    expect(doc.status).toBe('saved');
    expect(statuses).toEqual(['unsaved', 'saving', 'saved']);
    expect(mock.fs.has(`Spreadsheets/${UNTITLED}.xlsx`)).toBe(true);
    doc.destroy();
  });

  it('picks a unique name when the default is taken', async () => {
    mock.fs.set(`Spreadsheets/${UNTITLED}.xlsx`, { blob: new Blob(['x']), size: 1 });
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, '1');
    await doc.save();
    expect(doc.path).toBe(`Spreadsheets/${UNTITLED} 2.xlsx`);
    expect(doc.name).toBe(`${UNTITLED} 2`);
    doc.destroy();
  });

  it('preserves both workbooks when their first saves choose the same available name', async () => {
    const docs = [Doc.blank(), Doc.blank()];
    docs.forEach((doc, i) => doc.wb.setInput(doc.wb.activeSheetId, 0, 0, `book ${i}`));
    const ready = deferred();
    const write = globalThis.puter.fs.write;
    let writes = 0;
    globalThis.puter.fs.write = async (path, blob, options) => {
      if (!path.includes('/.versions/')) {
        if (++writes === 2) ready.resolve();
        await ready.promise;
      }
      return write(path, blob, options);
    };
    try {
      expect(await Promise.all(docs.map((doc) => doc.save()))).toEqual([true, true]);
      expect(docs[0].path).not.toBe(docs[1].path);
      for (const [i, doc] of docs.entries()) {
        const saved = await workbookFromFile(mock.fs.get(doc.path).blob, doc.fileName);
        expect(saved.getValue(saved.activeSheetId, 0, 0)).toBe(`book ${i}`);
        expect(doc.name).toBe(Doc.nameFor(doc.path));
        expect(doc.status).toBe('saved');
      }
    } finally { ready.resolve(); docs.forEach((doc) => doc.destroy()); }
  });

  it('keeps a failed first save unassigned and retries without overwriting a newly created file', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'local workbook');
    const write = globalThis.puter.fs.write;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.puter.fs.write = async () => { throw new Error('offline'); };
    try {
      expect(await doc.save({ auto: true })).toBe(false);
      expect(doc.path).toBeNull();
      expect(doc.wb.dirty).toBe(true);
      const target = `Spreadsheets/${UNTITLED}.xlsx`;
      const external = new Blob(['another workbook']);
      mock.fs.set(target, { blob: external, size: external.size });
      globalThis.puter.fs.write = write;
      expect(await doc.save()).toBe(true);
      expect(doc.path).not.toBe(target);
      expect(mock.fs.get(target).blob).toBe(external);
    } finally { globalThis.puter.fs.write = write; log.mockRestore(); doc.destroy(); }
  });

  it('writes a real xlsx that reads back with the same content', async () => {
    const doc = Doc.blank();
    const id = doc.wb.sheets[0].id;
    doc.wb.setInput(id, 0, 0, '10');
    doc.wb.setInput(id, 1, 0, '=A1*2');
    await doc.save();
    const blob = mock.fs.get(doc.path).blob;
    const back = await workbookFromFile(await blob.arrayBuffer(), 'x.xlsx');
    expect(back.getValue(back.sheets[0].id, 1, 0)).toBe(20);
    expect(back.getCell(back.sheets[0].id, 1, 0).f).toBe('A1*2');
    doc.destroy();
  });

  it('coalesces edits during a save and stays dirty until the newest state is written', async () => {
    const doc = Doc.blank();
    const id = doc.wb.sheets[0].id;
    doc.wb.setInput(id, 0, 0, '1');
    const write = puter.fs.write;
    puter.fs.write = (...args) => {
      puter.fs.write = write;
      doc.wb.setInput(id, 0, 0, '2'); // lands while the encoded book is being written
      return write.apply(puter.fs, args);
    };
    await doc.save();
    expect(doc.wb.dirty).toBe(true);
    expect(doc.status).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(doc.status).toBe('saved');
    const back = await workbookFromFile(await mock.fs.get(doc.path).blob.arrayBuffer(), 'x.xlsx');
    expect(back.getValue(back.sheets[0].id, 0, 0)).toBe(2);
    doc.destroy();
  });

  it('opens from a path and saves back to it', async () => {
    const original = Doc.blank();
    original.wb.setInput(original.wb.sheets[0].id, 0, 0, 'hello');
    await original.saveAs('Notes');
    original.destroy();

    const doc = await Doc.fromPath('Spreadsheets/Notes.xlsx');
    expect(doc.name).toBe('Notes');
    expect(doc.wb.getValue(doc.wb.sheets[0].id, 0, 0)).toBe('hello');
    expect(doc.status).toBe('saved');
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 1, 'world');
    await doc.save();
    expect(doc.path).toBe('Spreadsheets/Notes.xlsx');
    expect([...mock.fs.keys()].filter((k) => !k.includes('/.versions/')).length).toBe(1); // the save itself (a version snapshot may sit beside it)
    doc.destroy();
  });

  it('saves a CSV source as a new xlsx rather than overwriting it', async () => {
    const csv = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
    mock.fs.set('Desktop/data.csv', { blob: csv, size: csv.size });
    const doc = await Doc.fromPath('Desktop/data.csv');
    expect(doc.wb.getValue(doc.wb.sheets[0].id, 1, 1)).toBe(2);
    doc.wb.setInput(doc.wb.sheets[0].id, 2, 0, '3');
    await doc.save();
    expect(doc.path).toBe('Spreadsheets/data.xlsx');
    expect(mock.fs.has('Desktop/data.csv')).toBe(true);
    doc.destroy();
  });

  it('renames the file and refuses collisions', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, '1');
    await doc.save();
    mock.fs.set('Spreadsheets/Taken.xlsx', { blob: new Blob(['x']), size: 1 });
    expect(await doc.rename('Taken')).toMatch(/already exists/);
    expect(await doc.rename('')).toMatch(/Enter a name/);
    expect(await doc.rename('Budget 2026')).toBeNull();
    expect(doc.path).toBe('Spreadsheets/Budget 2026.xlsx');
    expect(mock.fs.has('Spreadsheets/Budget 2026.xlsx')).toBe(true);
    expect(mock.fs.has(`Spreadsheets/${UNTITLED}.xlsx`)).toBe(false);
    doc.destroy();
  });

  it('renames an unsaved document without touching the file system', async () => {
    const doc = Doc.blank();
    expect(await doc.rename('Plans')).toBeNull();
    expect(doc.name).toBe('Plans');
    expect(doc.path).toBeNull();
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, '1');
    await doc.save();
    expect(doc.path).toBe('Spreadsheets/Plans.xlsx');
    doc.destroy();
  });

  it('save as switches the document to the copy', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, '1');
    await doc.save();
    const first = doc.path;
    expect(await doc.saveAs('Copy')).toBeNull();
    expect(doc.path).toBe('Spreadsheets/Copy.xlsx');
    expect(doc.status).toBe('saved');
    expect(mock.fs.has(first)).toBe(true);
    expect(await doc.saveAs('Copy')).toMatch(/already exists/);
    doc.destroy();
  });

  it('does not attach a delayed snapshot of the original to a Save As copy', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'original');
    const entered = deferred();
    const release = deferred();
    const readdir = globalThis.puter.fs.readdir;
    const originalFolder = versionsFolder(`Spreadsheets/${UNTITLED}.xlsx`);
    globalThis.puter.fs.readdir = async (path) => {
      if (path === originalFolder) { entered.resolve(); await release.promise; }
      return readdir(path);
    };
    try {
      await doc.save();
      await entered.promise;
      expect(await doc.saveAs('Copy')).toBeNull();
      release.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(await listVersions(doc.path)).toEqual([]);
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'copy edit');
      await doc.save();
      await vi.advanceTimersByTimeAsync(10);
      const versions = await listVersions(doc.path);
      expect(versions).toHaveLength(1);
      const saved = await workbookFromFile(mock.fs.get(versions[0].path).blob, 'version.xlsx');
      expect(saved.getValue(saved.activeSheetId, 0, 0)).toBe('copy edit');
    } finally { release.resolve(); doc.destroy(); }
  });

  it('saves a manual version after a pending rename completes', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'content');
    await doc.save();
    await vi.advanceTimersByTimeAsync(10);
    const entered = deferred();
    const release = deferred();
    const rename = globalThis.puter.fs.rename;
    globalThis.puter.fs.rename = async (...args) => { entered.resolve(); await release.promise; return rename(...args); };
    try {
      const renaming = doc.rename('Renamed');
      await entered.promise;
      const snapshot = doc.saveVersion('Manual version');
      await vi.advanceTimersByTimeAsync(10);
      release.resolve();
      expect(await renaming).toBeNull();
      const saved = await snapshot;
      expect(saved.path.startsWith(versionsFolder(doc.path) + '/')).toBe(true);
      const restored = await workbookFromFile(mock.fs.get(saved.path).blob, 'version.xlsx');
      expect(restored.getValue(restored.activeSheetId, 0, 0)).toBe('content');
    } finally { release.resolve(); doc.destroy(); }
  });

  it('saves the first manual version of an unnamed document without blocking the write queue', async () => {
    const doc = Doc.blank();
    try {
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'first snapshot');
      const saved = await doc.saveVersion('Initial');
      expect(doc.path).toMatch(/\.xlsx$/);
      expect(saved.path.startsWith(versionsFolder(doc.path) + '/')).toBe(true);
      const wb = await workbookFromFile(mock.fs.get(saved.path).blob, 'version.xlsx');
      expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('first snapshot');
      expect(await doc.rename('After snapshot')).toBeNull();
    } finally { doc.destroy(); }
  });

  it('keeps edits made while the before-restore snapshot is uploading', async () => {
    const doc = Doc.blank();
    const id = doc.wb.activeSheetId;
    doc.wb.setInput(id, 0, 0, 'old version');
    await doc.save();
    const old = await doc.saveVersion('Old');
    doc.wb.setInput(id, 0, 0, 'before restore');
    const entered = deferred();
    const release = deferred();
    const write = globalThis.puter.fs.write;
    globalThis.puter.fs.write = async (path, ...args) => {
      if (path.includes('Before restore')) { entered.resolve(); await release.promise; }
      return write(path, ...args);
    };
    try {
      const restoring = doc.restoreVersion(old.path).catch((error) => error);
      await entered.promise;
      doc.wb.setInput(id, 0, 0, 'latest edit');
      release.resolve();
      const result = await restoring;
      expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('latest edit');
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toMatch(/changed.*restor/i);
      expect(doc.wb.undoLabels().length).toBeGreaterThan(0);
      globalThis.puter.fs.write = write;
      expect(await doc.restoreVersion(old.path)).toBe(true);
      expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('old version');
      const backups = (await listVersions(doc.path)).filter((v) => v.label === 'Before restore');
      const values = await Promise.all(backups.map(async (v) => {
        const wb = await workbookFromFile(mock.fs.get(v.path).blob, 'version.xlsx');
        return wb.getValue(wb.activeSheetId, 0, 0);
      }));
      expect(values).toContain('latest edit');
    } finally { release.resolve(); doc.destroy(); }
  });

  it('finishes a restore before a later Save As copies the workbook', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'old version');
    await doc.save();
    const old = await doc.saveVersion('Old');
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'before restore');
    const entered = deferred();
    const release = deferred();
    const read = globalThis.puter.fs.read;
    globalThis.puter.fs.read = async (path) => {
      if (path === old.path) { entered.resolve(); await release.promise; }
      return read(path);
    };
    try {
      const restoring = doc.restoreVersion(old.path);
      await entered.promise;
      const copying = doc.saveAs('Restored copy');
      await vi.advanceTimersByTimeAsync(10);
      release.resolve();
      expect(await restoring).toBe(true);
      expect(await copying).toBeNull();
      expect(doc.path).toBe('Spreadsheets/Restored copy.xlsx');
      const saved = await workbookFromFile(mock.fs.get(doc.path).blob, 'copy.xlsx');
      expect(saved.getValue(saved.activeSheetId, 0, 0)).toBe('old version');
    } finally { release.resolve(); doc.destroy(); }
  });

  it.each(['rename', 'saveAs'])('checks the new file history after %s', async (operation) => {
    const doc = Doc.blank();
    try {
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'original');
      await doc.save();
      await vi.advanceTimersByTimeAsync(10);
      expect(await listVersions(doc.path)).toHaveLength(1);
      expect(await doc[operation]('New name')).toBeNull();
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'new edit');
      await doc.save();
      await vi.advanceTimersByTimeAsync(10);
      expect(await listVersions(doc.path)).toHaveLength(1);
    } finally { doc.destroy(); }
  });

  it('refuses a Save As collision that arrives after the availability check', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'original');
    await doc.save();
    const originalPath = doc.path;
    const originalModified = doc.remoteModified;
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'unsaved edit');
    const target = 'Spreadsheets/Copy.xlsx';
    const external = new Blob(['another workbook']);
    const write = globalThis.puter.fs.write;
    globalThis.puter.fs.write = async (path, blob, options) => {
      if (path === target) mock.fs.set(target, { blob: external, size: external.size });
      return write(path, blob, options);
    };
    try {
      expect(await doc.saveAs('Copy')).toMatch(/already exists/);
      expect(mock.fs.get(target).blob).toBe(external);
      expect(doc.path).toBe(originalPath);
      expect(doc.remoteModified).toBe(originalModified);
      expect(doc.wb.dirty).toBe(true);
      expect(await doc.saveAs('Safe copy')).toBeNull();
      const saved = await workbookFromFile(mock.fs.get(doc.path).blob, doc.fileName);
      expect(saved.getValue(saved.activeSheetId, 0, 0)).toBe('unsaved edit');
    } finally { globalThis.puter.fs.write = write; doc.destroy(); }
  });

  it('uses the copied file timestamp for subsequent conflict checks', async () => {
    const doc = Doc.blank();
    const id = doc.wb.sheets[0].id;
    try {
      doc.wb.setInput(id, 0, 0, 'original');
      await doc.save();
      await vi.advanceTimersByTimeAsync(60000);
      expect(await doc.saveAs('Copy')).toBeNull();
      doc.wb.setInput(id, 0, 0, 'updated copy');
      expect(await doc.save()).toBe(true);
      expect(doc.status).toBe('saved');
      // A real external modification to the copy must still be detected: other bytes, at the same size.
      const theirs = new Uint8Array(await mock.fs.get(doc.path).blob.arrayBuffer());
      theirs[theirs.length - 1] ^= 0xff;
      Object.assign(mock.fs.get(doc.path), { blob: new Blob([theirs]), modified: mock.fs.get(doc.path).modified + 60 });
      doc.wb.setInput(id, 0, 0, 'local edit');
      expect(await doc.save()).toBe(false);
      expect(doc.status).toBe('conflict');
    } finally { doc.destroy(); }
  });

  it('keeps edits made during Save As dirty until they reach the new file', async () => {
    const doc = Doc.blank();
    const id = doc.wb.sheets[0].id;
    doc.wb.setInput(id, 0, 0, 'before');
    const entered = deferred();
    const release = deferred();
    const write = globalThis.puter.fs.write;
    globalThis.puter.fs.write = async (path, blob) => {
      if (path === 'Spreadsheets/Copy.xlsx') { entered.resolve(); await release.promise; }
      return write(path, blob);
    };
    try {
      const saving = doc.saveAs('Copy');
      await entered.promise;
      doc.wb.setInput(id, 0, 0, 'after');
      release.resolve();
      expect(await saving).toBeNull();
      expect(doc.wb.dirty).toBe(true);
      expect(doc.status).toBe('unsaved');
      await vi.advanceTimersByTimeAsync(2000);
      const back = await workbookFromFile(await mock.fs.get(doc.path).blob.arrayBuffer(), 'copy.xlsx');
      expect(back.getValue(back.sheets[0].id, 0, 0)).toBe('after');
      expect(doc.status).toBe('saved');
    } finally { release.resolve(); doc.destroy(); }
  });

  it('serializes queued saves so an older write cannot overwrite newer edits', async () => {
    const doc = Doc.blank();
    const id = doc.wb.sheets[0].id;
    doc.wb.setInput(id, 0, 0, 'first');
    const entered = deferred();
    const release = deferred();
    const write = globalThis.puter.fs.write;
    let active = 0;
    let maxActive = 0;
    let count = 0;
    globalThis.puter.fs.write = async (path, blob) => {
      if (path.includes('/.versions/')) return write(path, blob);
      maxActive = Math.max(maxActive, ++active);
      if (++count === 1) { entered.resolve(); await release.promise; }
      await Promise.resolve();
      const result = await write(path, blob);
      active--;
      return result;
    };
    try {
      const first = doc.save();
      await entered.promise;
      doc.wb.setInput(id, 0, 0, 'latest');
      const second = doc.save();
      const third = doc.save();
      release.resolve();
      await Promise.all([first, second, third]);
      expect(maxActive).toBe(1);
      expect(count).toBe(2);
      expect(doc.status).toBe('saved');
    } finally { release.resolve(); doc.destroy(); }
  });

  it('waits for an in-flight save before renaming its file', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, 'one');
    await doc.save();
    const originalPath = doc.path;
    const entered = deferred();
    const release = deferred();
    const write = globalThis.puter.fs.write;
    globalThis.puter.fs.write = async (path, blob) => {
      if (path === originalPath) { entered.resolve(); await release.promise; }
      return write(path, blob);
    };
    try {
      doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, 'two');
      const saving = doc.save();
      await entered.promise;
      const renaming = doc.rename('Renamed');
      await vi.advanceTimersByTimeAsync(0);
      release.resolve();
      await saving;
      expect(await renaming).toBeNull();
      expect(mock.fs.has(originalPath)).toBe(false);
      const back = await workbookFromFile(await mock.fs.get(doc.path).blob.arrayBuffer(), 'renamed.xlsx');
      expect(back.getValue(back.sheets[0].id, 0, 0)).toBe('two');
    } finally { release.resolve(); doc.destroy(); }
  });

  it('reports errors and retries later when a write fails', async () => {
    const doc = Doc.blank();
    const original = globalThis.puter.fs.write;
    globalThis.puter.fs.write = async () => { throw new Error('boom'); };
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, '1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(['error', 'offline']).toContain(doc.status);
    expect(doc.error).toBe('boom');
    globalThis.puter.fs.write = original;
    await vi.advanceTimersByTimeAsync(9000);
    expect(doc.status).toBe('saved');
    doc.destroy();
  });

  it('imports a browser File and marks it worth saving', async () => {
    const file = new File(['x,y\n1,2\n'], 'points.csv', { type: 'text/csv' });
    const doc = await Doc.fromBrowserFile(file);
    expect(doc.name).toBe('points');
    expect(doc.status).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(doc.path).toBe('Spreadsheets/points.xlsx');
    doc.destroy();
  });

  it('exports CSV of the active sheet', () => {
    const wb = new Workbook();
    wb.setInput(wb.sheets[0].id, 0, 0, 'a');
    wb.setInput(wb.sheets[0].id, 0, 1, '1');
    const doc = new Doc({ wb, name: 't' });
    expect(doc.toCsvBlob().type).toContain('text/csv');
    doc.destroy();
  });
});

describe('save conflicts', () => {
  it('requires a conflict decision when the opening timestamp could not be read', async () => {
    const wb = new Workbook();
    const original = await workbookToXlsx(wb);
    const path = 'Spreadsheets/Unknown.xlsx';
    mock.fs.set(path, { blob: original, size: original.size, modified: Date.now() / 1000 - 60 });
    const stat = globalThis.puter.fs.stat;
    globalThis.puter.fs.stat = async () => { throw new Error('Temporary metadata failure'); };
    const doc = await Doc.fromPath(path);
    globalThis.puter.fs.stat = stat;
    // The file is written elsewhere meanwhile: reading it back cannot confirm the bytes just opened
    // (an unchanged file would let the save through even with the baseline unknown).
    const elsewhere = new Blob([original, 'x']);
    mock.fs.set(path, { blob: elsewhere, size: elsewhere.size, modified: Date.now() / 1000 - 30 });
    try {
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Local edit');
      expect(await doc.save()).toBe(false);
      expect(doc.status).toBe('conflict');
      expect(mock.fs.get(path).blob).toBe(elsewhere);
      expect(await doc.forceSave()).toBe(true);
    } finally { doc.destroy(); }
  });

  it('detects a remote edit made while the file is opening', async () => {
    const wb = new Workbook();
    wb.setInput(wb.activeSheetId, 0, 0, 'Original');
    const original = await workbookToXlsx(wb);
    wb.setInput(wb.activeSheetId, 0, 0, 'Remote edit');
    const theirs = await workbookToXlsx(wb);
    const path = 'Spreadsheets/Opening.xlsx';
    const modified = Date.now() / 1000 - 60;
    mock.fs.set(path, { blob: original, size: original.size, modified });
    const read = globalThis.puter.fs.read;
    globalThis.puter.fs.read = async (p) => {
      const blob = await read(p);
      mock.fs.set(path, { blob: theirs, size: theirs.size, modified: modified + 30 });
      return blob;
    };
    const doc = await Doc.fromPath(path);
    try {
      expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('Original');
      doc.wb.setInput(doc.wb.activeSheetId, 0, 1, 'Local edit');
      expect(await doc.save()).toBe(false);
      expect(doc.status).toBe('conflict');
      expect(mock.fs.get(path).blob).toBe(theirs);
      expect(doc.wb.dirty).toBe(true);
      expect(await doc.forceSave()).toBe(true);
    } finally { doc.destroy(); }
  });

  it.each([false, true])('preserves remote content when the conflict check fails (auto: %s)', async (auto) => {
    const doc = Doc.blank();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Original');
      await doc.save();
      const theirs = new Blob(['remote version']);
      mock.fs.set(doc.path, { blob: theirs, size: theirs.size, modified: doc.remoteModified / 1000 + 60 });
      const stat = globalThis.puter.fs.stat;
      globalThis.puter.fs.stat = async () => { throw new Error('Temporary stat failure'); };
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Local edit');
      if (auto) expect(await doc.save({ auto })).toBe(false);
      else await expect(doc.save()).rejects.toThrow('Temporary stat failure');
      expect(doc.wb.dirty).toBe(true);
      expect(doc.error).toBe('Temporary stat failure');
      expect(mock.fs.get(doc.path).blob).toBe(theirs);
      globalThis.puter.fs.stat = stat;
      expect(await doc.save()).toBe(false);
      expect(doc.status).toBe('conflict');
      expect(await doc.forceSave()).toBe(true);
      expect(doc.wb.dirty).toBe(false);
    } finally { doc.destroy(); log.mockRestore(); }
  });

  it('preserves a remote edit made less than 1.5 seconds after the last save', async () => {
    const { fs } = mock;
    const doc = Doc.blank();
    try {
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Original');
      await doc.save();
      const theirs = new Blob(['remote version']);
      fs.set(doc.path, { blob: theirs, size: theirs.size, modified: (doc.remoteModified + 1000) / 1000 });
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Local edit');
      expect(await doc.save()).toBe(false);
      expect(doc.status).toBe('conflict');
      expect(doc.wb.dirty).toBe(true);
      expect(fs.get(doc.path).blob).toBe(theirs);
    } finally { doc.destroy(); }
  });

  let mock;
  beforeAll(async () => { await workbookToXlsx(new Workbook()); });
  beforeEach(() => { mock = installMockPuter(); });
  afterEach(() => { delete globalThis.puter; });

  it('refuses to overwrite a file written elsewhere until told to', async () => {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 0, 'mine');
    expect(await doc.save()).toBe(true);
    const path = doc.path;
    const before = mock.fs.get(path).blob;
    // Someone else writes the file later.
    mock.fs.set(path, { blob: new Blob(['theirs']), size: 6, modified: Date.now() / 1000 + 60 });
    const conflicts = [];
    doc.addEventListener('conflict', (e) => conflicts.push(e.detail));
    doc.wb.setInput(doc.wb.sheets[0].id, 0, 1, 'more');
    expect(await doc.save()).toBe(false);
    expect(conflicts).toHaveLength(1);
    expect(doc.status).toBe('conflict');
    expect(mock.fs.get(path).size).toBe(6); // untouched
    expect(await doc.forceSave()).toBe(true);
    expect(mock.fs.get(path).size).not.toBe(6);
    expect(doc.status).toBe('saved');
    expect(before).toBeTruthy();
    doc.destroy();
  });
});
