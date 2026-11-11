// @vitest-environment happy-dom
// File operations: modified state, save targets and hostile/odd input files.
import { describe, it, expect, beforeEach, vi } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { fileEvents, openFile, registerFormat } from '../../src/io/files';
import { encodeDocument } from '../../src/io/native';

registerFormat({
  id: 'zz_test',
  label: 'Test Format',
  extensions: ['.zztest'],
  import: async () => {
    const ob = Object.values(app.doc.objects)[0];
    ob.location = [5, 5, 5];
  },
});

beforeEach(() => {
  setApp(new App(startupDocument()));
  fileEvents.saveTarget = null;
});

describe('openFile', () => {
  it('keeps the file modified after importing into it', async () => {
    app.dirty = false;
    await openFile(new File([new Uint8Array([1, 2, 3])], 'model.zztest'), 'import');
    expect(app.reports.at(-1)?.type).toBe('INFO');
    expect(app.dirty).toBe(true);
  });

  it('keeps the save target when a file fails to open', async () => {
    const target = { name: 'project.p3d', write: async () => {} };
    fileEvents.saveTarget = target;
    const bad = encodeDocument(startupDocument()).slice(0, 40);
    await openFile(new File([bad], 'broken.p3d'), 'open');
    expect(app.reports.at(-1)?.type).toBe('ERROR');
    expect(fileEvents.saveTarget).toBe(target);
    // a file that opens replaces it
    await openFile(new File([encodeDocument(startupDocument())], 'other.p3d'), 'open');
    expect(app.filename).toBe('other.p3d');
    expect(fileEvents.saveTarget).toBeNull();
    expect(app.dirty).toBe(false);
  });
});

describe('auto save storage', () => {
  it('reports a full disk instead of waiting forever', async () => {
    const { installFakeIndexedDb } = await import('./support/fakeidb');
    const idb = installFakeIndexedDb();
    const { saveRecovery, loadRecovery, clearRecovery } = await import('../../src/io/native');
    await saveRecovery(new Uint8Array([1, 2]), 'a.p3d');
    expect((await loadRecovery())?.name).toBe('a.p3d');
    idb.fail.put = true;
    const settled = await Promise.race([saveRecovery(new Uint8Array([3]), 'b.p3d').then(() => 'saved', (e: Error) => e.name), new Promise((r) => setTimeout(() => r('hung'), 500))]);
    expect(settled).toBe('QuotaExceededError');
    expect(await Promise.race([clearRecovery().then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 500))])).toBe('done');
    expect(idb.open).toBe(0);
    // the previous auto save is still there
    idb.fail.put = false;
    expect((await loadRecovery())?.name).toBe('a.p3d');
  });
});

describe('recent files', () => {
  it('forgets the stored copy when a file becomes too large to keep', async () => {
    const { installFakeIndexedDb } = await import('./support/fakeidb');
    installFakeIndexedDb();
    const session = await import('../../src/io/session');
    await session.sessionReady;
    await session.recordRecent('big.p3d', new Uint8Array([1, 2, 3]));
    expect(await session.recentBytes('big.p3d')).toEqual(new Uint8Array([1, 2, 3]));
    let huge: Uint8Array | null = new Uint8Array(96 * 1024 * 1024 + 1);
    await session.recordRecent('big.p3d', huge);
    huge = null;
    // Revert / Open Recent would otherwise load the old, smaller save
    expect(await session.recentBytes('big.p3d')).toBeNull();
    expect(session.recentFiles().some((e) => e.name === 'big.p3d')).toBe(false);
  });
});

describe('project files with missing parts', () => {
  const p3d = (obj: unknown) => {
    const enc = new TextEncoder().encode(JSON.stringify(obj));
    const off = (12 + enc.length + 7) & ~7;
    const b = new Uint8Array(off + 8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x00443350, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, enc.length, true);
    b.set(enc, 12);
    return b;
  };

  it('fills in missing tables, scene settings and object fields', async () => {
    const { decodeDocument } = await import('../../src/io/native');
    const { Depsgraph } = await import('../../src/eval/depsgraph');
    const { doc } = decodeDocument(p3d({ doc: { scene: { name: 'S' }, objects: { ob_a: { name: 'Empty', type: 'EMPTY', data: null } } } }));
    expect(doc.scene.name).toBe('S');
    expect(doc.scene.render.resolution_x).toBeGreaterThan(0);
    expect(doc.collections[doc.scene.collection]).toBeTruthy();
    expect(doc.object_order).toEqual(['ob_a']);
    expect(doc.objects.ob_a.location).toEqual([0, 0, 0]);
    expect(doc.objects.ob_a.id).toBe('ob_a');
    expect(() => new Depsgraph(doc).evaluate(doc)).not.toThrow();
    // a file whose objects are not a table is rejected
    expect(() => decodeDocument(p3d({ doc: { scene: {}, objects: [] } }))).toThrow('does not contain a scene');
  });

  it('keeps everything a complete file has', async () => {
    const { decodeDocument, encodeDocument } = await import('../../src/io/native');
    const src = startupDocument();
    src.scene.frame_end = 77;
    const { doc } = decodeDocument(encodeDocument(src));
    expect(doc.scene.frame_end).toBe(77);
    expect(doc.scene.collection).toBe(src.scene.collection);
    expect(doc.scene.world).toBe(src.scene.world);
    expect(doc.object_order).toEqual(src.object_order);
    expect(Object.keys(doc.collections).sort()).toEqual(Object.keys(src.collections).sort());
  });
});

describe('startup file', () => {
  it('does not report a startup file as saved when storage fails', async () => {
    const { installFakeIndexedDb } = await import('./support/fakeidb');
    const idb = installFakeIndexedDb();
    const session = await import('../../src/io/session');
    await session.sessionReady;
    idb.fail.put = true;
    await expect(session.saveStartupFile()).rejects.toBeTruthy();
    expect(session.hasStartupFile()).toBe(false);
    idb.fail.put = false;
    await session.saveStartupFile();
    expect(session.hasStartupFile()).toBe(true);
  });
});

describe('saving into a folder', () => {
  it('keeps edits made while the file was being written', async () => {
    const { saveFile } = await import('../../src/io/files');
    let finish: () => void = () => {};
    app.filename = 'project.p3d';
    fileEvents.saveTarget = { name: 'project.p3d', write: () => new Promise<void>((r) => (finish = r)) };
    app.dirty = true;
    saveFile();
    // an edit lands before the write completes
    app.doc.objects[app.doc.object_order[0]].location = [1, 2, 3];
    app.changed('doc');
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.reports.at(-1)?.message).toBe('Saved "project.p3d"');
    expect(app.dirty).toBe(true);
    // a save with nothing happening meanwhile clears it
    saveFile();
    app.doc.scene.frame_current = 7;
    app.changed('frame');
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.dirty).toBe(false);
    // a failed write leaves it modified
    fileEvents.saveTarget = { name: 'project.p3d', write: async () => Promise.reject(new Error('denied')) };
    saveFile();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.reports.at(-1)?.type).toBe('ERROR');
    expect(app.dirty).toBe(true);
  });
});

describe('auto save snapshots', () => {
  it('lists only snapshots whose copy was stored', async () => {
    const { installFakeIndexedDb } = await import('./support/fakeidb');
    const idb = installFakeIndexedDb();
    const session = await import('../../src/io/session');
    await session.sessionReady;
    await session.takeSnapshot('first');
    const before = await session.listSnapshots();
    expect(before.length).toBeGreaterThan(0);
    idb.fail.put = true;
    await expect(session.takeSnapshot('second')).rejects.toBeTruthy();
    idb.fail.put = false;
    const after = await session.listSnapshots();
    expect(after.map((s) => s.key)).toEqual(before.map((s) => s.key));
    // every listed snapshot opens
    expect(await session.openSnapshot(after[0])).toBe(true);
  });
});

describe('save names', () => {
  it('adds .p3d without cutting names that contain dots', async () => {
    const { saveFile } = await import('../../src/io/files');
    const name = (n: string) => (saveFile(n), app.filename);
    expect(name('scene v1.2')).toBe('scene v1.2.p3d');
    expect(name('Robot.final')).toBe('Robot.final.p3d');
    expect(name('model.zztest')).toBe('model.p3d');
    expect(name('old.blend')).toBe('old.p3d');
    expect(name('legacy.3d.json')).toBe('legacy.p3d');
    expect(name('done.P3D')).toBe('done.P3D');
  });
});

describe('user asset libraries', () => {
  it('reports a library that could not be stored', async () => {
    const { installFakeIndexedDb } = await import('./support/fakeidb');
    const idb = installFakeIndexedDb();
    const lib = await import('../../src/assets/library');
    lib.resetLibrariesForTests();
    const id = await lib.createLibrary('Shelf');
    idb.fail.put = true;
    await lib.saveLibrary(id, true);
    expect(app.reports.at(-1)?.type).toBe('ERROR');
    expect(app.reports.at(-1)?.message).toContain('"Shelf" could not be stored');
    // saving the library opened as a file fails visibly too
    await expect(lib.writeLibraryBytes(id, encodeDocument(startupDocument()))).rejects.toBeTruthy();
    idb.fail.put = false;
    const n = app.reports.length;
    await lib.saveLibrary(id, true);
    expect(app.reports.length).toBe(n);
  });
});

describe('per-tab recovery slots', () => {
  it('takes over the newest slot of a closed tab, keeps a few others and leaves live tabs alone', async () => {
    const { installFakeIndexedDb } = await import('./support/fakeidb');
    const idb = installFakeIndexedDb();
    // Web Locks: "held" are the locks of other open tabs
    const held = new Set<string>(['p3d-recovery:autosave:live']);
    const locks = {
      request: async (name: string, _o: unknown, cb: (l: unknown) => unknown) => {
        if (held.has(name)) return cb(null);
        held.add(name);
        return cb({ name });
      },
      query: async () => ({ held: [...held].map((name) => ({ name })) }),
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    const store = (idb.stores.get('p3d-recovery') ?? new Map()).get('files') as Map<string, unknown> | undefined;
    const files = store ?? new Map<string, unknown>();
    if (!store) idb.stores.set('p3d-recovery', new Map([['files', files]]));
    files.clear();
    files.set('autosave:live', { bytes: new Uint8Array([9]), name: 'live.p3d', time: 100 });
    for (let i = 0; i < 7; i++) files.set(`autosave:old${i}`, { bytes: new Uint8Array([i]), name: `old${i}.p3d`, time: i });
    vi.resetModules();
    const native = await import('../../src/io/native');
    // the tab was edited before the stored session arrived: nothing is taken over
    expect(await native.claimRecovery(true, () => false)).toBeNull();
    vi.resetModules();
    const fresh = await import('../../src/io/native');
    const got = await fresh.claimRecovery(true);
    expect(got?.name).toBe('old6.p3d');
    // the live tab's slot is untouched and not offered; at most four stale ones were kept, older ones went
    const others = await fresh.otherRecoveries();
    expect(others.map((e) => e.name).sort()).toEqual(['old3.p3d', 'old4.p3d', 'old5.p3d']);
    expect(files.has('autosave:live')).toBe(true);
    // this tab writes into the slot it took over
    await fresh.saveRecovery(new Uint8Array([42]), 'mine.p3d');
    expect((files.get('autosave:old6') as { name: string }).name).toBe('mine.p3d');
    expect((files.get('autosave:live') as { name: string }).name).toBe('live.p3d');
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  });
});

describe('damaged project files', () => {
  it('say the file is damaged instead of showing parser errors', async () => {
    const { decodeDocument, encodeDocument } = await import('../../src/io/native');
    const good = encodeDocument(startupDocument());
    // corrupt JSON
    const badJson = good.slice();
    badJson[12] = 0x5d; // "]" where the JSON object starts
    expect(() => decodeDocument(badJson)).toThrow('The file is damaged.');
    // garbage after the magic number
    expect(() => decodeDocument(new TextEncoder().encode('P3D\0garbagegarbage'))).toThrow('The file is damaged.');
    // a genuinely newer file still says so
    const newer = good.slice();
    new DataView(newer.buffer).setUint32(4, 2, true);
    expect(() => decodeDocument(newer)).toThrow('newer version');
  });
});
