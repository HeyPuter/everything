import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

it('updates recovery data after a comment changes without an artwork edit', async () => {
  const app = await bootAppWithFeatures();
  const store = new RecoveryStore(memoryBackend());
  app.files.autosaver.fixedStore = store;
  const ed = app.newDocument();
  try {
    app.comments.addThread('Before', { x: 10, y: 10 });
    expect(await app.files.autosaver.flush()).toBe(1);
    const revision = ed.doc.revision;
    app.comments.addThread('After', { x: 20, y: 20 });
    expect(ed.doc.revision).toBe(revision);
    expect(await app.files.autosaver.flush()).toBe(1);
    const [entry] = await store.list();
    const recovered = (await parseDocument(await store.read(entry))).doc;
    expect(JSON.stringify(recovered.comments)).toContain('After');
    expect(await app.files.autosaver.flush()).toBe(0);
  } finally {
    await app.closeDocument(ed, { force: true });
  }
});

it('recovers a newer comment from the page-close stash when artwork revision and timestamps tie', async () => {
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
    app.comments.addThread('Before', { x: 10, y: 10 });
    await saver.flush();
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    app.comments.addThread('After', { x: 20, y: 20 });
    closing = true;
    saver.flush({ hiding: true });
    expect(localStorage.getItem(key)).toContain('After');
    const nextStore = new RecoveryStore(backend);
    const nextApp = { prefs: app.prefs, editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: (doc, { file }) => ({ doc, file }) };
    const next = new Autosaver(nextApp, { store: nextStore, session: 'next-session' });
    next.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    const recovered = await next.offerRecovery();
    expect(recovered).toHaveLength(1);
    expect(JSON.stringify(recovered[0].doc.comments)).toContain('After');
    expect(localStorage.getItem(key)).toBeNull();
  } finally {
    dialogHooks.open = null;
    time.mockRestore();
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});

it('keeps a newer comment stash when an older recovery write finishes', async () => {
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
    app.comments.addThread('Before', { x: 10, y: 10 });
    const older = saver.flush();
    await vi.waitFor(() => expect(writes).toBe(1));
    app.comments.addThread('After', { x: 20, y: 20 });
    saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${ed.recoveryId}`;
    expect(localStorage.getItem(key)).toContain('After');
    release();
    await older;
    expect(localStorage.getItem(key)).toContain('After');
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    const [entry] = await store.list();
    const recovered = (await parseDocument(await store.read(entry))).doc;
    expect(JSON.stringify(recovered.comments)).toContain('After');
  } finally {
    release();
    if (key) localStorage.removeItem(key);
    await app.closeDocument(ed, { force: true });
  }
});
