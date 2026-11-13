import { afterEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';
import { VDocument } from '../src/model/document.js';
import { Prefs } from '../src/prefs.js';
import { Autosaver } from '../src/features/files/autosave.js';

afterEach(() => { vi.restoreAllMocks(); });

const edit = (doc, name) => doc.transact('Edit', () => doc.updateRoot({ name }));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

it.each([
  { phase: 'completed', target: 'New', writes: 1 },
  { phase: 'writing', target: 'New', writes: 1 },
  { phase: 'completed', target: 'Old', writes: 0 },
])('refreshes the backup location after Save As ($phase backup, $target location)', async ({ phase, target, writes }) => {
  const app = await bootAppWithFeatures({ env: 'app' });
  const backend = memoryBackend(), store = new RecoveryStore(backend);
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const editor = app.newDocument({ name: 'Drawing' });
  editor.file = { kind: 'puter', path: '/u/Old.vstudio', name: 'Old.vstudio' };
  edit(editor.doc, 'Saved artwork');
  app.prefs.set('filesSaveDialog', 'puter');
  const savingGate = deferred(), backupGate = deferred();
  let saved;
  app.puter = { fs: {}, ui: { showSaveFilePicker: vi.fn(async (blob) => {
    saved = blob;
    await savingGate.promise;
    return { path: `/u/${target}.vstudio`, name: `${target}.vstudio` };
  }) } };
  const write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => {
    if (phase === 'writing') await backupGate.promise;
    return write(...args);
  });
  const saving = app.files.service.saveAs(editor);
  let backup;
  try {
    await vi.waitFor(() => expect(app.puter.ui.showSaveFilePicker).toHaveBeenCalledOnce());
    edit(editor.doc, 'Newer unsaved artwork');
    backup = saver.flush();
    if (phase === 'completed') await backup;
    else await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    savingGate.resolve();
    expect(await saving).toBe(true);
    expect(editor.doc.dirty).toBe(true);
    expect((await parseDocument(saved)).doc.root.name).toBe('Saved artwork');
    backupGate.resolve();
    await backup;
    const [before] = await store.list();
    expect((await parseDocument(await store.read(before))).doc.root.name).toBe('Newer unsaved artwork');
    expect(await saver.flush()).toBe(writes);
    const [after] = await store.list();
    expect(after.file.path).toBe(`/u/${target}.vstudio`);
    expect((await parseDocument(await store.read(after))).doc.root.name).toBe('Newer unsaved artwork');
    expect(await saver.flush()).toBe(0);
  } finally {
    savingGate.resolve(); backupGate.resolve();
    await Promise.all([saving, backup]);
    writing.mockRestore();
    for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
    await store.queue;
  }
});

function setup() {
  const backend = memoryBackend(), store = new RecoveryStore(backend);
  const doc = VDocument.create({ name: 'Drawing' });
  edit(doc, 'Unsaved artwork');
  const editor = { doc, file: { kind: 'puter', path: '/u/New.vstudio', name: 'New.vstudio' }, get name() { return this.file?.name || doc.root.name; } };
  const app = { editors: [editor], prefs: new Prefs(null) };
  const saver = new Autosaver(app, { store, session: 'current' });
  return { backend, store, doc, editor, app, saver };
}

it.each([
  ['path', { kind: 'puter', path: '/u/New.vstudio', name: 'New.vstudio' }, '/u/Moved.vstudio'],
  ['name', { kind: 'puter', path: '/u/New.vstudio', name: 'New.vstudio' }, 'Renamed.vstudio'],
  ['handleId', { kind: 'local', name: 'Local.vstudio', handleId: 'old-handle' }, 'new-handle'],
  ['kind', { kind: 'import', name: 'Drawing.vstudio' }, 'download'],
])('tracks a changed %s without rewriting equivalent file objects', async (field, file, value) => {
  const { store, editor, saver } = setup();
  editor.file = file;
  expect(await saver.flush()).toBe(1);
  // File metadata can be assigned after asynchronous handle storage completes.
  editor.file[field] = value;
  expect(await saver.flush()).toBe(1);
  const [entry] = await store.list();
  expect(entry.file[field]).toBe(value);
  expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Unsaved artwork');
  editor.file = { ...editor.file };
  expect(await saver.flush()).toBe(0);
});

it('stashes a returned file location while a different association is about to replace its backup', async () => {
  const { backend, store, editor, saver } = setup();
  await saver.flush();
  const currentFile = editor.file;
  editor.file = { kind: 'puter', path: '/u/Other.vstudio', name: 'Other.vstudio' };
  const gate = deferred(), write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => {
    await gate.promise;
    return write(...args);
  });
  const pending = saver.flush();
  const key = `vs-recovery-unwritten:${editor.doc.recoveryId}`;
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    editor.file = currentFile;
    saver.flush({ hiding: true });
    const stash = JSON.parse(localStorage.getItem(key).split('\n')[0]);
    expect(stash.file.path).toBe('/u/New.vstudio');
    gate.resolve();
    await pending;
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    expect((await store.list())[0].file.path).toBe('/u/New.vstudio');
    expect(await saver.flush()).toBe(0);
  } finally { gate.resolve(); await pending; localStorage.removeItem(key); }
});

it('supersedes a different stashed location even after returning to the existing disk association', async () => {
  const { backend, store, editor, saver } = setup();
  await saver.flush();
  const currentFile = editor.file;
  editor.file = { kind: 'puter', path: '/u/Other.vstudio', name: 'Other.vstudio' };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(backend, 'writeBlob').mockRejectedValueOnce(new Error('Storage unavailable'));
  const key = `vs-recovery-unwritten:${editor.doc.recoveryId}`;
  try {
    expect(await saver.flush({ hiding: true })).toBe(0);
    expect(JSON.parse(localStorage.getItem(key).split('\n')[0]).file.path).toBe('/u/Other.vstudio');
    editor.file = currentFile;
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    expect((await store.list())[0].file.path).toBe('/u/New.vstudio');
    expect(await saver.flush()).toBe(0);
  } finally { localStorage.removeItem(key); }
});

it('keeps an unchanged recovered import baseline without rewriting its original metadata', async () => {
  const { store, editor, saver, app } = setup();
  editor.file = null;
  await saver.flush();
  const [entry] = await store.list();
  const nextApp = { prefs: app.prefs, editors: [], renderTabs: vi.fn(), addDocument(doc, { file }) {
    const ed = { doc, file, get name() { return file.name; } };
    this.editors.push(ed);
    return ed;
  } };
  const next = new Autosaver(nextApp, { store, session: 'next' });
  const recovered = await next.recover(entry);
  expect(recovered.file.kind).toBe('import');
  expect(await next.flush()).toBe(0);
  expect((await store.list())[0].file).toBeNull();
  expect(recovered.doc.root.name).toBe('Unsaved artwork');
});
