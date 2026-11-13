import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';

it.each(['undo', 'redo'])('captures %s back to the last backup while a different state is being written', async (action) => {
  const app = await bootAppWithFeatures();
  const backend = memoryBackend();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const store = new RecoveryStore({ ...backend, writeBlob: async (...args) => {
    if (++writes === 2) await gate;
    return backend.writeBlob(...args);
  } });
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const ed = app.newDocument();
  let key;
  try {
    ed.doc.transact('First', () => ed.doc.updateRoot({ name: 'First state' }));
    if (action === 'redo') ed.doc.transact('Second', () => ed.doc.updateRoot({ name: 'Second state' }));
    await saver.flush();
    const latestName = ed.doc.root.name;
    if (action === 'redo') ed.doc.undo();
    else ed.doc.transact('Second', () => ed.doc.updateRoot({ name: 'Second state' }));
    const pending = saver.flush();
    await vi.waitFor(() => expect(writes).toBe(2));
    ed.doc[action]();
    expect(ed.doc.root.name).toBe(latestName);
    saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    expect(localStorage.getItem(key)).toContain(latestName);
    release();
    await pending;
    expect(localStorage.getItem(key)).toContain(latestName);
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    const [entry] = await store.list();
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe(latestName);
    expect(await saver.flush()).toBe(0);
  } finally {
    release();
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});

it('replaces an intermediate stash after Undo even when disk already contains the final state', async () => {
  const app = await bootAppWithFeatures();
  const backend = memoryBackend();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const store = new RecoveryStore({ ...backend, writeBlob: async (...args) => {
    if (++writes === 2) await gate;
    return backend.writeBlob(...args);
  } });
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const ed = app.newDocument();
  let key;
  try {
    ed.doc.transact('First', () => ed.doc.updateRoot({ name: 'Keep this state' }));
    await saver.flush();
    const other = app.newDocument();
    other.doc.transact('Other', () => other.doc.updateRoot({ name: 'Other document' }));
    const pending = saver.flush();
    await vi.waitFor(() => expect(writes).toBe(2));
    ed.doc.transact('Second', () => ed.doc.updateRoot({ name: 'Intermediate state' }));
    saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    expect(localStorage.getItem(key)).toContain('Intermediate state');
    ed.doc.undo();
    saver.flush({ hiding: true });
    expect(localStorage.getItem(key)).toContain('Keep this state');
    release();
    await pending;
    expect(await saver.flush()).toBe(0); // The disk copy already matches; no redundant write.
    const entry = (await store.list()).find((e) => e.id === ed.recoveryId);
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Keep this state');
  } finally {
    release();
    if (key) localStorage.removeItem(key);
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});
