import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Prefs } from '../src/prefs.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';

const edit = (doc, name) => doc.transact('Edit', () => doc.updateRoot({ name }));
let saver;
afterEach(() => {
  for (const editor of saver?.app.editors || []) localStorage.removeItem(`vs-recovery-unwritten:${editor.doc.recoveryId}`);
  vi.restoreAllMocks();
});

async function setup(direction = 'Undo') {
  const backend = memoryBackend(), store = new RecoveryStore(backend);
  const editors = ['First', 'Second'].map((name) => {
    const doc = VDocument.create({ name });
    edit(doc, `${name} backed up`);
    return { doc, file: { kind: 'puter', path: `/u/${name}.vstudio` }, get name() { return doc.root.name; } };
  });
  const second = editors[1];
  if (direction === 'Redo') edit(second.doc, 'Second backed up again');
  saver = new Autosaver({ editors, prefs: new Prefs(null) }, { store, session: 'current' });
  expect(await saver.flush()).toBe(2);
  const original = (await store.list()).find((entry) => entry.id === second.doc.recoveryId);
  edit(editors[0].doc, 'First new work');
  if (direction === 'Undo') edit(second.doc, 'Second new work');
  else second.doc.undo();
  const serialize = vi.spyOn(second.doc, 'toJSON');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = backend.writeBlob;
  const publishing = vi.spyOn(backend, 'writeJSON');
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => {
    await gate;
    return write(...args);
  });
  return { store, editors, second, original, serialize, writing, publishing, release };
}

it.each(['Undo', 'Redo'])('skips serialization and storage when %s restores a later document to its current backup', async (direction) => {
  const { store, second, original, serialize, writing, publishing, release } = await setup(direction);
  const pending = saver.flush();
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    second.doc[direction.toLowerCase()]();
    expect(second.doc.dirty).toBe(true);
    release();
    expect(await pending).toBe(1);
    expect(serialize).not.toHaveBeenCalled();
    expect(writing).toHaveBeenCalledOnce();
    expect(publishing).toHaveBeenCalledOnce();
    const current = (await store.list()).find((entry) => entry.id === second.doc.recoveryId);
    expect(current.snapshot).toBe(original.snapshot);
    expect((await parseDocument(await store.read(current))).doc.root.name).toBe(second.doc.root.name);
    expect(await saver.flush()).toBe(0);
  } finally { release(); }
});

it.each(['new work', 'new location', 'new comments', 'stashed newer work'])('still backs up the later document when it has %s', async (change) => {
  const { store, second, original, serialize, writing, release } = await setup();
  const pending = saver.flush({ hiding: change === 'stashed newer work' });
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    if (change !== 'new work') second.doc.undo();
    if (change === 'new location') second.file = { kind: 'puter', path: '/u/Renamed.vstudio' };
    if (change === 'new comments') second.doc.setComments({ threads: [{ id: 'new-comment', text: 'New comment' }] });
    serialize.mockClear();
    release();
    expect(await pending).toBe(2);
    expect(serialize).toHaveBeenCalledOnce();
    const current = (await store.list()).find((entry) => entry.id === second.doc.recoveryId);
    expect(current.snapshot).not.toBe(original.snapshot);
    expect(current.file.path).toBe(second.file.path);
    expect(current.commentsRevision).toBe(second.doc.commentsRevision);
    const restored = (await parseDocument(await store.read(current))).doc;
    expect(restored.root.name).toBe(second.doc.root.name);
    if (change === 'new comments') expect(JSON.stringify(restored.comments)).toContain('New comment');
    expect(localStorage.getItem(`vs-recovery-unwritten:${second.doc.recoveryId}`)).toBeNull();
    expect(await saver.flush()).toBe(0);
  } finally { release(); }
});
