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
