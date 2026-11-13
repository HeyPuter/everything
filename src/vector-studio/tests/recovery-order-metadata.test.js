import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); });
const invalidNumber = { valueOf: null, toString: null };
async function put(backend, id, name, metadata = {}, patch = {}) {
  const store = new RecoveryStore(backend);
  await store.put(id, { name, session: 'previous', saved: 0,
    data: await serializeDocument(VDocument.create({ name }), { compress: false }), ...metadata });
  const path = `recovery/index.0.${id}.json`;
  const index = await backend.readJSON(path);
  const entry = { ...index.entries[0], ...patch };
  await backend.writeJSON(path, { ...index, entries: [entry] });
  return { entry, path: `recovery/${id}/${entry.snapshot}.vstudio` };
}
function recovery(store) {
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument(doc, { file }) {
    const editor = { doc, file };
    this.editors.push(editor);
    return editor;
  } };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  return { app, saver };
}

it.each([false, true])('offers a sequenced backup with malformed saved metadata (valid neighbor: %s)', async (neighbor) => {
  const backend = memoryBackend();
  await put(backend, 'drawing', 'Drawing', { sequence: 1 }, { saved: invalidNumber });
  if (neighbor) await put(backend, 'neighbor', 'Neighbor', { saved: 1000, sequence: 1 });
  const store = new RecoveryStore(backend);
  const { saver } = recovery(store);
  dialogHooks.open = async (opts) => {
    expect(opts.body.textContent).toContain('Unknown time');
    expect(opts.body.textContent).not.toContain('Invalid Date');
    return 'recover';
  };
  const opened = await saver.offerRecovery();
  expect(opened.map((editor) => editor.doc.root.name).sort()).toEqual(neighbor ? ['Drawing', 'Neighbor'] : ['Drawing']);
});

it.each([[{}], [['invalid']], ['not-a-time'], [1e30]])('shows an unknown recovery time for invalid stored timestamp %j', async (saved) => {
  const backend = memoryBackend();
  await put(backend, 'drawing', 'Drawing', { sequence: 1 }, { saved });
  const { saver } = recovery(new RecoveryStore(backend));
  dialogHooks.open = async (opts) => {
    expect(opts.body.querySelector('.files-recover-list .muted').textContent).toBe(' Not saved yet · Unknown time');
    return 'recover';
  };
  expect((await saver.offerRecovery()).map((editor) => editor.doc.root.name)).toEqual(['Drawing']);
});

it.each(['saved', 'revision', 'commentsRevision'])('does not let invalid %s metadata break fallback selection or discard uncertain bytes', async (field) => {
  const damaged = memoryBackend(), valid = memoryBackend();
  const retained = await put(damaged, 'drawing', 'Uncertain copy', {}, { [field]: invalidNumber });
  await put(valid, 'drawing', 'Good copy', { [field]: 2 });
  await put(valid, 'neighbor', 'Neighbor', { saved: 3, sequence: 1 });
  const store = new RecoveryStore([damaged, valid]);
  const { saver } = recovery(store);
  const opened = await saver.offerRecovery();
  expect(opened.map((editor) => editor.doc.root.name).sort()).toEqual(['Good copy', 'Neighbor']);
  const bytes = await damaged.readBlob(retained.path);
  expect(bytes).not.toBeNull();
  expect((await parseDocument(bytes)).doc.root.name).toBe('Uncertain copy');
});

it('keeps unsequenced uncertain metadata distinct while allowing neighboring work to recover', async () => {
  const backend = memoryBackend();
  const retained = await put(backend, 'drawing', 'Uncertain copy', {}, { saved: invalidNumber });
  await put(backend, 'neighbor', 'Neighbor', { saved: 1, sequence: 1 });
  const store = new RecoveryStore(backend);
  const { app, saver } = recovery(store);
  const opened = await saver.offerRecovery();
  expect(opened.map((editor) => editor.doc.root.name)).toEqual(['Neighbor']);
  expect((await store.list()).find((entry) => entry.id === 'drawing').saved).toEqual(invalidNumber);
  expect(await backend.readBlob(retained.path)).not.toBeNull();
  expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('kept for the next recovery attempt'), expect.any(Object));
});

it('keeps capture sequence authoritative when the newest capture has an invalid clock value', async () => {
  const first = memoryBackend(), second = memoryBackend();
  await put(first, 'drawing', 'Latest capture', { sequence: 2 }, { saved: invalidNumber });
  await put(second, 'drawing', 'Older capture', { sequence: 1, saved: 1000000 });
  const { saver } = recovery(new RecoveryStore([first, second]));
  expect((await saver.offerRecovery()).map((editor) => editor.doc.root.name)).toEqual(['Latest capture']);
});

it('preserves ordinary date ordering and labels without modifying stored identity metadata', async () => {
  const now = 1700000000000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const backend = memoryBackend();
  await put(backend, 'older', 'Older', { saved: now - 5 * 60 * 1000, sequence: 1 });
  await put(backend, 'newer', 'Newer', { saved: now - 60 * 1000, sequence: 2 });
  const before = await backend.readJSON('recovery/index.0.newer.json');
  const { saver } = recovery(new RecoveryStore(backend));
  dialogHooks.open = async (opts) => {
    expect([...opts.body.querySelectorAll('.files-recover-name')].map((node) => node.textContent)).toEqual(['Newer', 'Older']);
    expect([...opts.body.querySelectorAll('.files-recover-list .muted')].map((node) => node.textContent)).toEqual([
      ' Not saved yet · 1 min ago', ' Not saved yet · 5 min ago',
    ]);
    return null;
  };
  expect(await saver.offerRecovery()).toEqual([]);
  expect(await backend.readJSON('recovery/index.0.newer.json')).toEqual(before);
});
