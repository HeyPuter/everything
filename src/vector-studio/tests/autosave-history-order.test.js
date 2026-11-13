import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

function editTwice(doc) {
  doc.transact('First edit', () => doc.updateRoot({ name: 'Keep this' }));
  doc.transact('Second edit', () => doc.updateRoot({ name: 'Undo this' }));
}

it('recovers the latest Undo state even when its revision is lower and timestamps tie', async () => {
  const app = await bootAppWithFeatures();
  const backend = memoryBackend();
  let closing = false;
  const store = new RecoveryStore({ ...backend, writeBlob: (...args) => closing ? new Promise(() => {}) : backend.writeBlob(...args) });
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const ed = app.newDocument();
  const time = vi.spyOn(Date, 'now').mockReturnValue(5000);
  let key;
  try {
    editTwice(ed.doc);
    await saver.flush();
    const [older] = await store.list();
    ed.doc.undo();
    expect(ed.doc.revision).toBeLessThan(older.revision);
    expect(ed.doc.dirty).toBe(true);
    closing = true;
    saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    expect(localStorage.getItem(key)).toContain('Keep this');
    const nextApp = { prefs: app.prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: (doc, { file }) => ({ doc, file }) };
    const next = new Autosaver(nextApp, { store: new RecoveryStore(backend), session: 'after-undo' });
    next.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    const recovered = await next.offerRecovery();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].doc.root.name).toBe('Keep this');
    expect(localStorage.getItem(key)).toBeNull();
  } finally {
    dialogHooks.open = null;
    time.mockRestore();
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});

it('keeps an Undo stash when the recovery write from before Undo finishes', async () => {
  const app = await bootAppWithFeatures();
  const backend = memoryBackend();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const store = new RecoveryStore({ ...backend, writeBlob: async (...args) => {
    if (++writes === 1) await gate;
    return backend.writeBlob(...args);
  } });
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const ed = app.newDocument();
  let key;
  try {
    editTwice(ed.doc);
    const older = saver.flush();
    await vi.waitFor(() => expect(writes).toBe(1));
    ed.doc.undo();
    saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    expect(localStorage.getItem(key)).toContain('Keep this');
    release();
    await older;
    expect(localStorage.getItem(key)).toContain('Keep this');
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    const [entry] = await store.list();
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Keep this');
  } finally {
    release();
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});

it('does not restore an older stash over a later Undo backup with a lower revision', async () => {
  const app = await bootAppWithFeatures();
  const store = new RecoveryStore(memoryBackend());
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const ed = app.newDocument();
  const time = vi.spyOn(Date, 'now').mockReturnValue(5000);
  let key;
  try {
    editTwice(ed.doc);
    const writing = saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    const stale = localStorage.getItem(key);
    await writing;
    ed.doc.undo();
    await saver.flush();
    // Simulate a leftover stash after its cleanup failed.
    localStorage.setItem(key, stale);
    const nextApp = { prefs: app.prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: (doc, { file }) => ({ doc, file }) };
    const next = new Autosaver(nextApp, { store, session: 'after-later-backup' });
    next.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    const [recovered] = await next.offerRecovery();
    expect(recovered.doc.root.name).toBe('Keep this');
    expect(localStorage.getItem(key)).toBeNull();
  } finally {
    dialogHooks.open = null;
    time.mockRestore();
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});
