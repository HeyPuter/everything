import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { memoryBackend, opfsBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// A minimal File System Access directory implementation. Path splitting and
// recursive removal are exercised through the production OPFS backend.
function directory() {
  const children = new Map();
  const missing = () => new DOMException('Missing', 'NotFoundError');
  return {
    kind: 'directory',
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!children.has(name) && create) children.set(name, directory());
      if (!children.has(name)) throw missing();
      if (children.get(name).kind !== 'directory') throw new DOMException('Not a directory', 'TypeMismatchError');
      return children.get(name);
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!children.has(name) && create) {
        let blob = new Blob();
        children.set(name, { kind: 'file', getFile: async () => blob,
          createWritable: async () => ({ write: async (value) => { blob = value; }, close: async () => {} }) });
      }
      if (!children.has(name)) throw missing();
      if (children.get(name).kind !== 'file') throw new DOMException('Not a file', 'TypeMismatchError');
      return children.get(name);
    },
    async removeEntry(name) { if (!children.delete(name)) throw missing(); },
    async *entries() { yield* children; },
  };
}

it.each(['/', '//'])('does not let closing a malformed recovered document %j erase other backups', async (id) => {
  const top = directory();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => top } });
  const backend = opfsBackend();
  const store = new RecoveryStore(backend);
  const data = await serializeDocument(VDocument.create({ name: 'Keep this artwork' }), { compress: false });
  await store.put('valid', { name: 'Valid drawing', data, session: 'old', saved: 1 });
  await backend.writeBlob('recovery/bad.vstudio', new Blob([data]));
  await backend.writeJSON('recovery/index.json', [{ id, snapshot: 'bad', name: 'Broken record', session: 'old', saved: 2 }]);
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  const opened = await saver.offerRecovery();
  const malformed = opened.find((ed) => ed.recoveryId === id);
  if (malformed) await saver.discard(malformed);
  const entries = await store.list();
  expect(entries.map((entry) => entry.id)).toEqual(opened.map((ed) => ed.recoveryId));
  expect((await parseDocument(await store.read(entries[0]))).doc.root.name).toBe('Keep this artwork');
  expect(opened.map((ed) => ed.doc.root.name)).toEqual(['Keep this artwork']);
});

it.each(['', '/', '..', '../other', 'nested/id', 'nested\\id', 'bad\u0000id'])('rejects invalid recovery id %j before writing or deleting storage', async (id) => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  const write = vi.spyOn(backend, 'writeBlob'), remove = vi.spyOn(backend, 'remove');
  await expect(store.put(id, { name: 'Invalid', data: 'bytes' })).rejects.toThrow();
  expect(await store.remove(id)).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

it('does not follow a snapshot path outside its document when reading a legacy index', async () => {
  const backend = memoryBackend();
  await backend.writeJSON('recovery/index.json', [{ id: 'drawing', snapshot: '../other/secret', name: 'Unsafe', saved: 1 }]);
  const store = new RecoveryStore(backend);
  const read = vi.spyOn(backend, 'readBlob');
  expect(await store.list()).toEqual([]);
  await expect(store.read({ id: 'drawing', snapshot: '../other/secret' })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it.each([{ id: '..' }, { snapshot: '../sibling' }, { id: 'other' }])('rejects unsafe metadata filenames and malformed observed copies %j during discard', async (invalid) => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', { name: 'Safe', data: 'safe bytes', saved: 1 });
  await backend.writeJSON('recovery/index.0.%2F.json', { version: 1, generation: 1, entries: [{ id: '/', name: 'Unsafe' }] });
  const entries = await store.list();
  expect(entries.map((e) => e.id)).toEqual(['drawing']);
  const [entry] = entries;
  const remove = vi.spyOn(backend, 'remove');
  expect(await store.remove('drawing', { expected: { ...entry, copies: [{ backend, entry: { ...entry, ...invalid } }] } })).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  expect(await (await store.read(entry)).text()).toBe('safe bytes');
});

it('keeps valid legacy entries usable when mixed with unsafe ids and snapshot names', async () => {
  const backend = memoryBackend();
  const entries = [
    { id: 'Legacy-id_2', name: 'Flat', saved: 2 },
    { id: 'legacy-id_3', snapshot: 'old-Snapshot_1', name: 'Versioned', saved: 1 },
    { id: 'invalid', snapshot: '../other', name: 'Unsafe snapshot', saved: 3 },
    { id: '', name: 'Unsafe id', saved: 4 },
  ];
  await backend.writeJSON('recovery/index.json', entries);
  await backend.writeBlob('recovery/Legacy-id_2.vstudio', new Blob(['flat bytes']));
  await backend.writeBlob('recovery/legacy-id_3/old-Snapshot_1.vstudio', new Blob(['versioned bytes']));
  const store = new RecoveryStore(backend);
  const valid = await store.list();
  expect(valid.map((e) => e.id)).toEqual(['Legacy-id_2', 'legacy-id_3']);
  expect(await Promise.all(valid.map(async (e) => (await store.read(e)).text()))).toEqual(['flat bytes', 'versioned bytes']);
  expect(await store.remove('Legacy-id_2', { expected: valid[0] })).toBe(true);
  expect(await (await store.read(valid[1])).text()).toBe('versioned bytes');
  await store.put('Legacy-id_2', { name: 'New', data: 'new bytes', saved: 5 });
  expect(await (await store.read((await store.list())[0])).text()).toBe('new bytes');
});
