import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Prefs } from '../src/prefs.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument, serializeDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); });
function client(backend, session) {
  const app = { editors: [], prefs: new Prefs(null), renderTabs: vi.fn(), notify: vi.fn(),
    addDocument(doc, { file }) {
      const editor = { doc, file, get name() { return doc.root.name; } };
      app.editors.push(editor);
      return editor;
    },
  };
  const store = new RecoveryStore({ ...backend });
  const saver = new Autosaver(app, { store, session });
  return { app, store, saver };
}
async function seed() {
  const backend = memoryBackend(), original = new RecoveryStore(backend);
  await original.put('original', { name: 'Original work', session: 'previous', sequence: 1,
    data: await serializeDocument(VDocument.create({ name: 'Original work' }), { compress: false }) });
  return backend;
}
async function setup() {
  const backend = await seed();
  const a = client(backend, 'session-a'), b = client(backend, 'session-b');
  const [entryA] = await a.store.list(), [entryB] = await b.store.list();
  const [editorA, editorB] = await Promise.all([a.saver.recover(entryA), b.saver.recover(entryB)]);
  return { backend, a, b, editorA, editorB };
}
const edit = (editor, name) => editor.doc.transact('Edit independently', () => editor.doc.updateRoot({ name }));
async function restored(backend) {
  const restarted = new RecoveryStore(backend);
  return (await Promise.all((await restarted.list()).map(async (entry) =>
    (await parseDocument(await restarted.read(entry))).doc.root.name))).sort();
}

it('preserves both independently edited documents recovered from the same original backup', async () => {
  const { backend, a, b, editorA, editorB } = await setup();
  edit(editorA, 'Work from A');
  edit(editorB, 'Work from B');
  expect(await a.saver.flush()).toBe(1);
  expect(await b.saver.flush()).toBe(1);
  expect(await restored(backend)).toEqual(['Work from A', 'Work from B']);
});

it('does not discard another instance backup when a recovered document is saved or closed before its first autosave', async () => {
  const { backend, a, b, editorA, editorB } = await setup();
  edit(editorB, 'Work from B');
  expect(await b.saver.flush()).toBe(1);
  await a.saver.discard(editorA);
  expect(await restored(backend)).toEqual(['Work from B']);
});

it('does not discard another instance backup after both recovered documents have autosaved', async () => {
  const { backend, a, b, editorA, editorB } = await setup();
  edit(editorA, 'Work from A');
  edit(editorB, 'Work from B');
  await Promise.all([a.saver.flush(), b.saver.flush()]);
  await a.saver.discard(editorA);
  expect(await restored(backend)).toEqual(['Work from B']);
});

it('keeps the other recovered document backed up even before it is edited or autosaved', async () => {
  const { backend, a, editorA } = await setup();
  await a.saver.discard(editorA);
  expect(await restored(backend)).toEqual(['Original work']);
});


it('recovers from readable storage when writes fail and retires the source only after a successful later backup', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list();
  const write = vi.spyOn(a.store.backends[0], 'writeBlob').mockRejectedValue(new Error('Read only'));
  const editor = await a.saver.recover(source);
  expect(editor.doc.root.name).toBe('Original work');
  expect((await a.store.list()).map((entry) => entry.id)).toEqual(['original']);
  write.mockRestore();
  edit(editor, 'Recovered edits');
  expect(await a.saver.flush()).toBe(1);
  expect(await restored(backend)).toEqual(['Recovered edits']);
  expect((await a.store.list()).map((entry) => entry.id)).toEqual([editor.recoveryId]);
});

it('retries failed source cleanup after a later successful autosave', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list();
  vi.spyOn(a.store, 'remove').mockRejectedValueOnce(new Error('Offline during cleanup'));
  const editor = await a.saver.recover(source);
  expect(await restored(backend)).toEqual(['Original work', 'Original work']);
  edit(editor, 'Later work');
  expect(await a.saver.flush()).toBe(1);
  expect(await restored(backend)).toEqual(['Later work']);
  await a.saver.discard(editor);
  expect(await restored(backend)).toEqual([]);
});

it('keeps the source when editor creation fails without writing a replacement', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list();
  a.app.addDocument = () => { throw new Error('Editor unavailable'); };
  const write = vi.spyOn(a.store.backends[0], 'writeBlob');
  await expect(a.saver.recover(source)).rejects.toThrow('Editor unavailable');
  expect(write).not.toHaveBeenCalled();
  expect(await restored(backend)).toEqual(['Original work']);
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

it('backs up edits made while the independent recovery copy is being written', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list(), gate = deferred();
  const write = a.store.backends[0].writeBlob;
  const writing = vi.spyOn(a.store.backends[0], 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const opening = a.saver.recover(source);
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    edit(a.app.editors[0], 'Edited during recovery');
    const saving = a.saver.flush();
    gate.resolve();
    await opening;
    expect(await saving).toBe(1);
    expect(await restored(backend)).toEqual(['Edited during recovery']);
    expect(await a.saver.flush()).toBe(0);
  } finally { gate.resolve(); }
});

it('preserves a source replaced by another writer while recovery creates its independent copy', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list(), gate = deferred();
  const write = a.store.backends[0].writeBlob;
  const writing = vi.spyOn(a.store.backends[0], 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const opening = a.saver.recover(source);
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    // Even identical capture metadata has a distinct immutable snapshot token.
    await new RecoveryStore(backend).put('original', { ...source, data: await serializeDocument(VDocument.create({ name: 'New source work' }), { compress: false }) });
    gate.resolve();
    const editor = await opening;
    expect(await restored(backend)).toEqual(['New source work', 'Original work']);
    await a.saver.discard(editor);
    expect(await restored(backend)).toEqual(['New source work']);
  } finally { gate.resolve(); }
});

it('keeps both page-close stashes independent and restores their edited contents after restart', async () => {
  const { backend, a, b, editorA, editorB } = await setup();
  const keys = [editorA, editorB].map((editor) => `vs-recovery-unwritten:${editor.recoveryId}`);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const instance of [a, b]) vi.spyOn(instance.store.backends[0], 'writeBlob').mockRejectedValue(new Error('Page closing'));
  try {
    edit(editorA, 'Stashed from A');
    edit(editorB, 'Stashed from B');
    await Promise.all([a.saver.flush({ hiding: true }), b.saver.flush({ hiding: true })]);
    expect(new Set(keys).size).toBe(2);
    expect(localStorage.getItem(keys[0])).toContain('Stashed from A');
    expect(localStorage.getItem(keys[1])).toContain('Stashed from B');
    const next = client(backend, 'after-restart');
    next.saver.liveSessions = async () => new Set();
    dialogHooks.open = async () => 'recover';
    const opened = await next.saver.offerRecovery();
    expect(opened.map((editor) => editor.doc.root.name).sort()).toEqual(['Stashed from A', 'Stashed from B']);
    expect(await restored(backend)).toEqual(['Stashed from A', 'Stashed from B']);
    expect(keys.map((key) => localStorage.getItem(key))).toEqual([null, null]);
  } finally { for (const key of keys) localStorage.removeItem(key); }
});

it('does not mark edits made by editor-opening hooks as included in the original backup bytes', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list(), add = a.app.addDocument;
  a.app.addDocument = (...args) => {
    const editor = add(...args);
    edit(editor, 'Opening hook edit');
    return editor;
  };
  await a.saver.recover(source);
  expect(await a.saver.flush()).toBe(1);
  expect(await restored(backend)).toEqual(['Opening hook edit']);
});

it('does not mark a discarded in-flight recovery copy as still backed up after Save and Undo', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list(), gate = deferred();
  const write = a.store.backends[0].writeBlob;
  const writing = vi.spyOn(a.store.backends[0], 'writeBlob').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const opening = a.saver.recover(source);
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    const editor = a.app.editors[0];
    edit(editor, 'Saved later work');
    editor.doc.markSaved();
    const discarding = a.saver.discard(editor);
    editor.doc.undo();
    expect(editor.doc.dirty).toBe(true);
    gate.resolve();
    await Promise.all([opening, discarding]);
    expect(await restored(backend)).toEqual([]);
    expect(await a.saver.flush()).toBe(1);
    expect(await restored(backend)).toEqual(['Original work']);
  } finally { gate.resolve(); }
});

it('copies the exact bytes from compatible file readers without reading them twice', async () => {
  const backend = await seed(), a = client(backend, 'session-a');
  const [source] = await a.store.list();
  const bytes = await (await a.store.read(source)).arrayBuffer();
  const arrayBuffer = vi.fn(async () => bytes);
  vi.spyOn(a.store.backends[0], 'readBlob').mockResolvedValueOnce({ arrayBuffer });
  await a.saver.recover(source);
  expect(arrayBuffer).toHaveBeenCalledOnce();
  expect(await restored(backend)).toEqual(['Original work']);
});
