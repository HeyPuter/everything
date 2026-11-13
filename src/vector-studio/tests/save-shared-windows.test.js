import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow } from '../src/features/workspace/window.js';
import { parseDocument, serializeDocument } from '../src/features/files/format.js';

it.each([false, true])('serializes saves from shared windows (first window closes: %s)', async (closeFirst) => {
  const app = await bootAppWithFeatures();
  const first = app.newDocument({ name: 'Older' });
  first.file = { kind: 'puter', path: '/u/Artwork.vstudio', name: 'Artwork.vstudio' };
  const second = newWindow(app, first);
  const service = app.files.service;
  const snapshots = new Map([['Older', await serializeDocument(first.doc, { compress: false })]]);
  // Control encoding completion so the test controls write ordering, not thumbnail timing.
  const encode = vi.spyOn(service, 'encode').mockImplementation(async (ed) => ({
    bytes: snapshots.get(ed.doc.root.name), thumb: null, rev: ed.doc.revision,
  }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let disk, writes = 0;
  app.puter = { fs: { write: vi.fn(async (path, blob) => {
    const index = writes++;
    if (index === 0) await gate;
    disk = new Uint8Array(await blob.arrayBuffer());
    return { path, name: 'Artwork.vstudio' };
  }) } };
  try {
    const olderSave = service.save(first);
    await vi.waitFor(() => expect(writes).toBe(1));
    if (closeFirst) await app.closeDocument(first, { force: true });
    second.doc.transact('Newer edit', () => second.doc.updateRoot({ name: 'Latest' }));
    snapshots.set('Latest', await serializeDocument(second.doc, { compress: false }));
    const latestSave = service.save(second);
    // Encoding resolves in one microtask. If a second write starts concurrently,
    // let it finish before releasing the older write, reproducing out-of-order I/O.
    await Promise.resolve();
    if (writes > 1) await latestSave;
    release();
    expect(await olderSave).toBe(true);
    expect(await latestSave).toBe(true);
    expect(writes).toBe(2);
    expect(second.doc.dirty).toBe(false);
    expect((await parseDocument(disk)).doc.root.name).toBe('Latest');
  } finally {
    release();
    encode.mockRestore();
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
  }
});
