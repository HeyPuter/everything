import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { newWindow } from '../src/features/workspace/window.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';

const edit = (doc, name) => doc.transact('Edit', () => doc.updateRoot({ name }));

it.each([
  { closeOriginal: false, hiding: false },
  { closeOriginal: true, hiding: false },
  { closeOriginal: true, hiding: true },
])('backs up the current Save As association after an earlier backup waits (closed: $closeOriginal, hiding: $hiding)', async ({ closeOriginal, hiding }) => {
  const app = await bootAppWithFeatures({ env: 'app' });
  const backend = memoryBackend(), store = new RecoveryStore(backend);
  const saver = app.files.autosaver;
  saver.fixedStore = store;
  const first = app.newDocument({ name: 'First' });
  edit(first.doc, 'First dirty');
  const original = app.newDocument({ name: 'Drawing' });
  original.file = { kind: 'puter', path: '/u/Old.vstudio', name: 'Old.vstudio' };
  edit(original.doc, 'Before Save As');
  const companion = newWindow(app, original);
  app.prefs.set('filesSaveDialog', 'puter');
  let saved;
  app.puter = { fs: {}, ui: { showSaveFilePicker: vi.fn(async (blob) => {
    saved = blob;
    return { path: '/u/New.vstudio', name: 'New.vstudio' };
  }) } };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => {
    await gate;
    return write(...args);
  });
  const pending = saver.flush({ hiding });
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    if (closeOriginal) await app.closeDocument(original, { force: true });
    expect(await app.files.service.saveAs(companion)).toBe(true);
    expect(companion.file.path).toBe('/u/New.vstudio');
    expect((await parseDocument(saved)).doc.root.name).toBe('Before Save As');
    edit(companion.doc, 'Unsaved work at new location');
    release();
    expect(await pending).toBe(2);
    const entry = (await store.list()).find((entry) => entry.id === companion.doc.recoveryId);
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Unsaved work at new location');
    expect(entry.file.path).toBe('/u/New.vstudio');
    expect(entry.file.name).toBe('New.vstudio');
    expect(entry.name).toBe((closeOriginal ? companion : original).name);
    expect(localStorage.getItem(`vs-recovery-unwritten:${entry.id}`)).toBeNull();
    expect(await saver.flush()).toBe(0);
    const recovered = await saver.recover(entry);
    expect(recovered.file.path).toBe('/u/New.vstudio');
    expect(recovered.doc.root.name).toBe('Unsaved work at new location');
  } finally {
    release();
    await pending;
    writing.mockRestore();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
    await store.queue;
  }
});
