import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { handleStore } from '../src/features/files/handles.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); });

async function snapshot(name, sequence) {
  return { name, session: 'previous', sequence, saved: sequence, revision: sequence,
    data: await serializeDocument(VDocument.create({ name }), { compress: false }) };
}

async function setup({ local = false, fallback = false } = {}) {
  const backend = memoryBackend(), other = memoryBackend();
  const store = new RecoveryStore(fallback ? [backend, other] : backend);
  await store.put('drawing', { ...await snapshot('Shown work', 1), ...(local ? { file: { kind: 'local', name: 'Drawing.vstudio', handleId: 'handle' } } : {}) });
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  return { backend, other, store, app, saver };
}

it.each(['parsing', 'local handle lookup', 'fallback publication', 'same capture metadata'])('rejects a snapshot replaced during %s and recovers the new work on retry', async (phase) => {
  const { backend, other, store, app, saver } = await setup({ local: phase === 'local handle lookup', fallback: phase === 'fallback publication' });
  const next = await snapshot('Newer work', phase === 'same capture metadata' ? 1 : 2);
  const publish = () => (phase === 'fallback publication' ? new RecoveryStore(other) : store).put('drawing', next);
  if (phase === 'local handle lookup') {
    vi.spyOn(handleStore, 'get').mockImplementationOnce(async () => { await publish(); return { name: 'Drawing.vstudio' }; });
  } else {
    const read = backend.readBlob;
    vi.spyOn(backend, 'readBlob').mockImplementationOnce(async (path) => {
      const blob = await read(path);
      return { arrayBuffer: async () => {
        const bytes = await blob.arrayBuffer();
        await publish();
        return bytes;
      } };
    });
  }
  expect((await saver.offerRecovery()).length).toBe(0);
  expect(app.addDocument).not.toHaveBeenCalled();
  expect(app.notify.mock.calls.some(([message]) => message.includes('kept'))).toBe(true);
  const [latest] = await store.list();
  expect((await parseDocument(await store.read(latest))).doc.root.name).toBe('Newer work');
  expect((await saver.offerRecovery()).map((ed) => ed.doc.root.name)).toEqual(['Newer work']);
});

it('still opens the selected copy when an unrelated document is backed up during parsing', async () => {
  const { backend, store, saver } = await setup();
  const read = backend.readBlob;
  vi.spyOn(backend, 'readBlob').mockImplementationOnce(async (path) => {
    const blob = await read(path);
    return { arrayBuffer: async () => {
      await store.put('unrelated', await snapshot('Other work', 1));
      return blob.arrayBuffer();
    } };
  });
  expect((await saver.offerRecovery()).map((ed) => ed.doc.root.name)).toEqual(['Shown work']);
  expect(await store.list()).toHaveLength(2);
});

it('waits for an already queued publication before checking whether the selected copy is current', async () => {
  const { backend, store } = await setup();
  const [entry] = await store.list();
  const next = await snapshot('Newer work', 2);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = backend.writeJSON;
  const writing = vi.spyOn(backend, 'writeJSON').mockImplementationOnce(async (...args) => { await gate; return write(...args); });
  try {
    const saving = store.put('drawing', next);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    const checking = store.isCurrent(entry);
    release();
    await saving;
    expect(await checking).toBe(false);
  } finally { release(); }
});

it('allows an identical fallback copy when the selected storage becomes unavailable after listing', async () => {
  const { backend, other, store, saver } = await setup({ fallback: true });
  await new RecoveryStore(other).put('drawing', await snapshot('Shown work', 1));
  dialogHooks.open = async () => {
    vi.spyOn(backend, 'readJSON').mockRejectedValue(new Error('Offline'));
    return 'recover';
  };
  expect((await saver.offerRecovery()).map((ed) => ed.doc.root.name)).toEqual(['Shown work']);
  expect((await store.list())[0].backend).toBe(other);
});
