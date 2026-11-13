import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Prefs } from '../src/prefs.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const edit = (doc, name) => doc.transact('Edit', () => doc.updateRoot({ name }));
function setup() {
  const backend = memoryBackend(), store = new RecoveryStore(backend);
  const doc = VDocument.create({ name: 'Untitled' });
  edit(doc, 'Capture before Save');
  const editor = { doc, get name() { return doc.root.name; } };
  const app = { editors: [editor], prefs: new Prefs(null) };
  const saver = new Autosaver(app, { store, session: 'current' });
  return { app, backend, store, doc, editor, saver };
}
async function names(store) {
  return Promise.all((await store.list()).map(async (entry) => (await parseDocument(await store.read(entry))).doc.root.name));
}

it.each(['encoding', 'storage'])('keeps later dirty work eligible after Save invalidates a copy pending in %s', async (phase) => {
  const { backend, store, doc, editor, saver } = setup();
  const gate = deferred(), write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  // A resolved serialization still yields before publishing, without relying
  // on compression speed or timing to let Save/Undo run in that gap.
  vi.stubGlobal('CompressionStream', undefined);
  const pending = saver.flush();
  try {
    if (phase === 'storage') await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    edit(doc, 'Saved contents');
    doc.markSaved();
    const discarding = saver.discard(editor);
    doc.undo();
    if (phase === 'encoding') {
      editor.file = { kind: 'puter', path: '/u/Saved-as.vstudio', name: 'Saved-as.vstudio' };
      edit(doc, 'New work after Save');
    }
    const currentName = doc.root.name;
    expect(doc.dirty).toBe(true);
    gate.resolve();
    await Promise.all([pending, discarding]);
    expect(await names(store)).toEqual([]);
    if (phase === 'encoding') expect(writing).not.toHaveBeenCalled();
    expect(await saver.flush()).toBe(1);
    expect(await names(store)).toEqual([currentName]);
    if (phase === 'encoding') expect((await store.list())[0].file.path).toBe('/u/Saved-as.vstudio');
    expect(await saver.flush()).toBe(0);
  } finally { gate.resolve(); }
});

it('invalidates pending bookkeeping when Save comes from another window of the same document', async () => {
  const { app, backend, store, doc, editor, saver } = setup();
  const shared = { ...editor, doc };
  app.editors.push(shared);
  const gate = deferred(), write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const pending = saver.flush();
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    edit(doc, 'Saved through companion');
    doc.markSaved();
    const discarding = saver.discard(shared);
    doc.undo();
    gate.resolve();
    await Promise.all([pending, discarding]);
    expect(await names(store)).toEqual([]);
    expect(await saver.flush()).toBe(1);
    expect(await names(store)).toEqual(['Capture before Save']);
  } finally { gate.resolve(); }
});

it('retains a newer page-close stash until Undo contents have a new persistent backup', async () => {
  const { backend, store, doc, editor, saver } = setup();
  const gate = deferred(), write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const pending = saver.flush();
  let key;
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    edit(doc, 'Saved contents');
    doc.markSaved();
    const discarding = saver.discard(editor);
    doc.undo();
    saver.flush({ hiding: true });
    key = `vs-recovery-unwritten:${editor.recoveryId}`;
    expect(localStorage.getItem(key)).toContain('Capture before Save');
    gate.resolve();
    await Promise.all([pending, discarding]);
    expect(localStorage.getItem(key)).toContain('Capture before Save');
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    expect(await names(store)).toEqual(['Capture before Save']);
  } finally { gate.resolve(); if (key) localStorage.removeItem(key); }
});

it('does not cancel another document backup when one document is saved', async () => {
  const { app, backend, store, doc, saver } = setup();
  const other = VDocument.create({ name: 'Other' });
  edit(other, 'Other saved work');
  const companion = { doc: other, name: 'Other' };
  app.editors.push(companion);
  const gate = deferred(), write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const pending = saver.flush();
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    other.markSaved();
    await saver.discard(companion);
    gate.resolve();
    expect(await pending).toBe(1);
    expect(await names(store)).toEqual([doc.root.name]);
    expect(await saver.flush()).toBe(0);
  } finally { gate.resolve(); }
});
