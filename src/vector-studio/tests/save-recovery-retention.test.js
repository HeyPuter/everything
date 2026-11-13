import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';

it.each(['artwork', 'comment'])('keeps recovery data containing a newer %s after an older save completes', async (change) => {
  const app = await bootAppWithFeatures();
  const store = new RecoveryStore(memoryBackend());
  app.files.autosaver.fixedStore = store;
  const ed = app.newDocument({ name: 'Original' });
  ed.file = { kind: 'puter', path: '/u/Artwork.vstudio', name: 'Artwork.vstudio' };
  ed.doc.transact('Earlier edit', () => ed.doc.updateRoot({ name: 'Earlier' }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  app.puter = { fs: { write: vi.fn(async (path) => {
    if (++writes === 1) await gate;
    return { path, name: 'Artwork.vstudio' };
  }) } };
  try {
    const saving = app.files.service.save(ed);
    await vi.waitFor(() => expect(writes).toBe(1));
    if (change === 'artwork') ed.doc.transact('Newer edit', () => ed.doc.updateRoot({ name: 'Newer' }));
    else app.comments.addThread('Newer comment', { x: 10, y: 10 });
    expect(await app.files.autosaver.flush()).toBe(1);
    expect(await store.list()).toHaveLength(1);
    release();
    expect(await saving).toBe(true);
    await store.queue;
    expect(ed.doc.dirty).toBe(true);
    const copies = await store.list();
    expect(copies).toHaveLength(1);
    const recovered = (await parseDocument(await store.read(copies[0]))).doc;
    if (change === 'artwork') expect(recovered.root.name).toBe('Newer');
    else expect(JSON.stringify(recovered.comments)).toContain('Newer comment');
    // Saving the actual latest content still removes the now-unneeded recovery copy.
    expect(await app.files.service.save(ed)).toBe(true);
    await store.queue;
    expect(ed.doc.dirty).toBe(false);
    expect(await store.list()).toHaveLength(0);
  } finally {
    release();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
