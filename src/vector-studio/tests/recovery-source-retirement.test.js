import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Prefs } from '../src/prefs.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { parseDocument, serializeDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); });
async function setup(mode) {
  const selected = memoryBackend(), fallback = memoryBackend();
  const common = { saved: 100, revision: 1, commentsRevision: 0, session: 'previous' };
  const selectedData = await serializeDocument(VDocument.create({ name: 'Selected work' }), { compress: false });
  const duplicate = mode === 'identical' || mode === 'mirror';
  await new RecoveryStore(selected).put('original', { ...common, sequence: mode === 'older legacy' ? undefined : mode === 'mirror' ? 'unknown' : 1,
    name: 'Selected work', data: selectedData });
  await new RecoveryStore(fallback).put('original', { ...common, sequence: 2,
    ...(mode === 'invalid clock' || mode === 'tied sessions' ? { session: 'later-session', saved: 200 } : {}),
    ...(mode === 'older sequence' ? { sequence: 0, saved: 200 } : {}),
    ...(mode === 'older legacy' ? { sequence: undefined, saved: 50, revision: 0 } : {}),
    ...(mode === 'older session' ? { sequence: 10, session: 'older-session', saved: 50 } : {}),
    ...(duplicate ? { sequence: 1 } : {}),
    name: duplicate ? 'Selected work' : 'Newer uncertain work',
    data: duplicate ? selectedData : await serializeDocument(VDocument.create({ name: 'Newer uncertain work' }), { compress: false }) });
  const indexPath = 'recovery/index.0.original.json';
  const index = await fallback.readJSON(indexPath);
  const patch = mode === 'invalid sequence' ? { sequence: 'unknown' }
    : mode === 'invalid clock' ? { saved: { valueOf: null, toString: null } }
      : mode === 'tied sessions' ? { saved: 100 } : {};
  await fallback.writeJSON(indexPath, { ...index, entries: [{ ...index.entries[0], ...patch }] });
  if (mode === 'mirror') {
    fallback.files.clear();
    for (const [path, data] of selected.files) fallback.files.set(path, data);
  }
  const path = `recovery/original/${index.entries[0].snapshot}.vstudio`;
  const store = new RecoveryStore([selected, fallback]);
  const app = { editors: [], prefs: new Prefs(null), renderTabs: vi.fn(), notify: vi.fn(), addDocument(doc, { file }) {
    const editor = { doc, file, get name() { return doc.root.name; } };
    this.editors.push(editor);
    return editor;
  } };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  return { selected, fallback, path, store, app, saver };
}

it.each(['invalid sequence', 'invalid clock', 'tied sessions'])('retains an unproven fallback after recovering, backing up, and saving another copy (%s)', async (mode) => {
  const { selected, fallback, path, store, saver } = await setup(mode);
  const [entry] = await store.list();
  expect(entry.backend).toBe(selected);
  const editor = await saver.recover(entry);
  expect(editor.doc.root.name).toBe('Selected work');
  const original = await fallback.readBlob(path);
  expect(original).not.toBeNull();
  expect((await parseDocument(original)).doc.root.name).toBe('Newer uncertain work');
  editor.doc.transact('Edit recovered work', () => editor.doc.updateRoot({ name: 'Edited selected work' }));
  expect(await saver.flush()).toBe(1);
  expect(await fallback.readBlob(path)).not.toBeNull();
  editor.doc.markSaved();
  await saver.discard(editor);
  expect(await fallback.readBlob(path)).not.toBeNull();
  const [remaining] = await store.list();
  expect(remaining.id).toBe('original');
  expect((await parseDocument(await store.read(remaining))).doc.root.name).toBe('Newer uncertain work');
  const recovered = await saver.recover(remaining);
  expect(recovered.doc.root.name).toBe('Newer uncertain work');
});

it.each(['invalid sequence', 'invalid clock', 'tied sessions'])('still honors explicit confirmed Discard for exact observed copies (%s)', async (mode) => {
  const { selected, fallback, store, saver } = await setup(mode);
  dialogHooks.open = async () => 'discard';
  expect(await saver.offerRecovery()).toEqual([]);
  expect(await store.list()).toEqual([]);
  for (const backend of [selected, fallback]) expect([...backend.files.keys()].filter((path) => path.endsWith('.vstudio'))).toEqual([]);
});

it.each(['older sequence', 'older legacy', 'older session', 'identical', 'mirror'])('retires a fallback whose capture is verifiably covered: %s', async (mode) => {
  const { selected, fallback, store, saver } = await setup(mode);
  const [entry] = await store.list();
  expect(entry.backend).toBe(selected);
  const editor = await saver.recover(entry);
  expect(editor.doc.root.name).toBe('Selected work');
  expect((await store.list()).map((entry) => entry.id)).toEqual([editor.recoveryId]);
  for (const backend of [selected, fallback]) expect([...backend.files.keys()].filter((path) => path.startsWith('recovery/original/'))).toEqual([]);
  expect(await saver.flush()).toBe(0);
});

it('stops retrying source cleanup once an uncertain copy is removed independently', async () => {
  const { selected, fallback, store, saver } = await setup('invalid sequence');
  const [entry] = await store.list();
  const editor = await saver.recover(entry);
  await new RecoveryStore([selected, fallback]).remove('original');
  const removing = vi.spyOn(store, 'remove');
  editor.doc.transact('Edit', () => editor.doc.updateRoot({ name: 'First new edit' }));
  expect(await saver.flush()).toBe(1);
  expect(removing).toHaveBeenCalledOnce();
  editor.doc.transact('Edit', () => editor.doc.updateRoot({ name: 'Second new edit' }));
  expect(await saver.flush()).toBe(1);
  expect(removing).toHaveBeenCalledOnce();
});

it.each([false, true])('retains uncertain unindexed bytes during later cleanup (different remaining payload: %s)', async (otherPayload) => {
  const { fallback, path, store, saver } = await setup('invalid sequence');
  const [entry] = await store.list();
  const editor = await saver.recover(entry);
  await fallback.remove('recovery/index.0.original.json');
  await fallback.remove('recovery/index.1.original.json');
  let retained = path;
  if (otherPayload) {
    retained = 'recovery/original/unindexed.vstudio';
    await fallback.writeBlob(retained, await fallback.readBlob(path));
    await fallback.remove(path);
  }
  editor.doc.transact('Edit', () => editor.doc.updateRoot({ name: 'New edit' }));
  expect(await saver.flush()).toBe(1);
  expect((await parseDocument(await fallback.readBlob(retained))).doc.root.name).toBe('Newer uncertain work');
  await saver.discard(editor);
  expect(await fallback.readBlob(retained)).not.toBeNull();
});

it('does not permit automatic source retirement without an observed snapshot', async () => {
  const { selected, fallback, store } = await setup('invalid sequence');
  expect(await store.remove('original', { superseded: true })).toBe(false);
  for (const backend of [selected, fallback]) expect([...backend.files.keys()].filter((path) => path.endsWith('.vstudio'))).toHaveLength(1);
});
