import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Prefs } from '../src/prefs.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument } from '../src/features/files/format.js';

afterEach(() => { vi.restoreAllMocks(); });
const edit = (doc, name) => doc.transact('Edit', () => doc.updateRoot({ name }));
function setup() {
  const backend = memoryBackend(), store = new RecoveryStore(backend);
  const editors = ['First', 'Second', 'Third'].map((name) => {
    const doc = VDocument.create({ name });
    edit(doc, `${name} committed`);
    return { doc, get name() { return doc.root.name; } };
  });
  const app = { editors, prefs: new Prefs(null) };
  const saver = new Autosaver(app, { store, session: 'current' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = backend.writeBlob;
  const writing = vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (...args) => {
    await gate;
    return write(...args);
  });
  return { app, store, saver, editors, release, writing };
}
async function names(store) {
  return (await Promise.all((await store.list()).map(async (entry) =>
    (await parseDocument(await store.read(entry))).doc.root.name))).sort();
}

it.each(['cancel', 'commit then Undo'])('never restores an unfinished later gesture after %s', async (ending) => {
  const { store, saver, editors, release, writing } = setup();
  const second = editors[1].doc;
  const pending = saver.flush();
  let tx;
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    tx = second.begin('Gesture');
    second.updateRoot({ name: 'Unfinished gesture' });
    release();
    await pending;
    if (ending === 'cancel') tx.cancel();
    else { tx.commit(); second.undo(); }
    expect(second.root.name).toBe('Second committed');
    await saver.flush();
    expect(await names(store)).toEqual(['First committed', 'Second committed', 'Third committed']);
    expect(await saver.flush()).toBe(0);
  } finally { release(); tx?.cancel(); }
});

it.each(['saved', 'closed'])('does not serialize a later document that became %s while another backup was pending', async (change) => {
  const { app, store, saver, editors, release, writing } = setup();
  const second = editors[1];
  const serialize = vi.spyOn(second.doc, 'toJSON');
  const pending = saver.flush();
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    if (change === 'saved') second.doc.markSaved();
    else app.editors = app.editors.filter((editor) => editor !== second);
    release();
    expect(await pending).toBe(2);
    expect(await names(store)).toEqual(['First committed', 'Third committed']);
    expect(serialize).not.toHaveBeenCalled();
  } finally { release(); }
});

it.each(['commit', 'cancel'])('backs up the current stable document when a later gesture finishes with %s before its turn', async (ending) => {
  const { store, saver, editors, release, writing } = setup();
  const pending = saver.flush();
  let tx;
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    tx = editors[1].doc.begin('Gesture');
    editors[1].doc.updateRoot({ name: 'Second newer work' });
    tx[ending]();
    release();
    expect(await pending).toBe(3);
    expect(await names(store)).toEqual(['First committed', ending === 'commit' ? 'Second newer work' : 'Second committed', 'Third committed']);
    expect(await saver.flush()).toBe(0);
  } finally { release(); tx?.cancel(); }
});

it('still backs up a later document when another window keeps it open', async () => {
  const { app, store, saver, editors, release, writing } = setup();
  const second = editors[1];
  const pending = saver.flush();
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    app.editors = [editors[0], { doc: second.doc, name: second.name }, editors[2]];
    release();
    expect(await pending).toBe(3);
    expect(await names(store)).toEqual(['First committed', 'Second committed', 'Third committed']);
    expect(await saver.flush()).toBe(0);
  } finally { release(); }
});

it('retains the stable page-close stash while skipping an active gesture in a later document', async () => {
  const { store, saver, editors, release, writing } = setup();
  const pending = saver.flush({ hiding: true });
  const key = `vs-recovery-unwritten:${editors[1].doc.recoveryId}`;
  let tx;
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    tx = editors[1].doc.begin('Gesture');
    editors[1].doc.updateRoot({ name: 'Unfinished gesture' });
    release();
    expect(await pending).toBe(2);
    expect(localStorage.getItem(key)).toContain('Second committed');
    expect(localStorage.getItem(key)).not.toContain('Unfinished gesture');
    tx.cancel();
    expect(await saver.flush()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
    expect(await names(store)).toEqual(['First committed', 'Second committed', 'Third committed']);
  } finally {
    release(); tx?.cancel();
    for (const { doc } of editors) localStorage.removeItem(`vs-recovery-unwritten:${doc.recoveryId}`);
  }
});

it('keeps a stable snapshot captured before a gesture started during its own storage write', async () => {
  const { store, saver, editors, release, writing } = setup();
  const pending = saver.flush();
  let tx;
  try {
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    tx = editors[0].doc.begin('Gesture');
    editors[0].doc.updateRoot({ name: 'Unfinished gesture' });
    release();
    expect(await pending).toBe(3);
    expect(await names(store)).toEqual(['First committed', 'Second committed', 'Third committed']);
    tx.cancel();
    expect(await saver.flush()).toBe(0);
  } finally { release(); tx?.cancel(); }
});
