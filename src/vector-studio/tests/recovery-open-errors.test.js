import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { documentData, FORMAT_VERSION, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(data) {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', { name: 'Drawing', data, session: 'previous', saved: 1 });
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  return { backend, store, app, saver };
}

const json = () => documentData(VDocument.create({ name: 'Keep this artwork' }));

it('keeps a recovery file from a newer app version and explains how to open it', async () => {
  const data = JSON.stringify({ ...json(), version: FORMAT_VERSION + 1 });
  const { store, app, saver } = await setup(data);
  expect(await saver.offerRecovery()).toEqual([]);
  expect(app.addDocument).not.toHaveBeenCalled();
  const entries = await store.list();
  expect(entries).toHaveLength(1);
  expect(await (await store.read(entries[0])).text()).toBe(data);
  expect(app.notify.mock.calls.some(([message]) => /newer version.*Reload/.test(message))).toBe(true);
  expect(app.notify.mock.calls.some(([message]) => message.includes('copy is damaged'))).toBe(false);
});

it('keeps compressed recovery data when the browser lacks decompression and recovers on retry', async () => {
  const { store, app, saver } = await setup(gzipSync(JSON.stringify(json())));
  vi.stubGlobal('DecompressionStream', undefined);
  expect(await saver.offerRecovery()).toEqual([]);
  expect(await store.list()).toHaveLength(1);
  expect(app.notify.mock.calls.some(([message]) => message.includes('cannot decompress'))).toBe(true);
  vi.unstubAllGlobals();
  const opened = await saver.offerRecovery();
  expect(opened.map((ed) => ed.doc.root.name)).toEqual(['Keep this artwork']);
});

it('keeps intact bytes if reading the returned blob fails during parsing', async () => {
  const { backend, store, saver } = await setup(JSON.stringify(json()));
  const read = backend.readBlob;
  vi.spyOn(backend, 'readBlob').mockImplementationOnce(async (path) => {
    const blob = await read(path);
    return { arrayBuffer: async () => { throw new DOMException('File could not be read', 'NotReadableError'); }, size: blob.size };
  });
  expect(await saver.offerRecovery()).toEqual([]);
  const entries = await store.list();
  expect(entries).toHaveLength(1);
  expect((await parseDocument(await store.read(entries[0]))).doc.root.name).toBe('Keep this artwork');
  expect((await saver.offerRecovery()).length).toBe(1);
});

it('keeps valid backup bytes if creating an editor fails and permits retry', async () => {
  const { store, app, saver } = await setup(JSON.stringify(json()));
  app.addDocument.mockImplementationOnce(() => { throw new Error('Editor setup failed'); });
  expect(await saver.offerRecovery()).toEqual([]);
  expect(await store.list()).toHaveLength(1);
  expect(app.notify.mock.calls.some(([message]) => message.includes('copy is damaged'))).toBe(false);
  expect((await saver.offerRecovery()).map((ed) => ed.doc.root.name)).toEqual(['Keep this artwork']);
});

it('still identifies genuinely damaged document data', async () => {
  const { store, app, saver } = await setup('not a document');
  expect(await saver.offerRecovery()).toEqual([]);
  expect(await store.list()).toEqual([]);
  expect(app.notify.mock.calls.some(([message]) => message.includes('copy is damaged'))).toBe(true);
});
