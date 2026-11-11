// @vitest-environment happy-dom
// File operations: modified state, save targets and hostile/odd input files.
import { describe, it, expect, beforeEach } from 'vitest';

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
