import { expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

async function value(name, sequence) {
  return { name, session: 'session', sequence, saved: sequence, revision: sequence,
    file: { kind: 'puter', path: `/u/${name}.vstudio`, name: `${name}.vstudio` },
    data: await serializeDocument(VDocument.create({ name }), { compress: false }) };
}
async function names(store) {
  const result = [];
  for (const entry of await store.list()) result.push([entry.name, (await parseDocument(await store.read(entry))).doc.root.name, entry.file?.path]);
  return result;
}

it.each(['replace', 'add', 'remove'])('retains the complete published index after an interrupted %s', async (action) => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('first', await value('Original', 1));
  await store.put('second', await value('Other', 2));
  const expected = await names(store);
  vi.spyOn(backend, 'writeJSON').mockImplementationOnce(async (path) => {
    backend.files.set(path, '{"generation":');
    throw new Error('Index write interrupted');
  });
  try {
    if (action === 'remove') await store.remove('first');
    else await expect(store.put(action === 'replace' ? 'first' : 'third', await value('Changed', 3))).rejects.toThrow();
    const restarted = new RecoveryStore(backend);
    expect(await names(restarted)).toEqual(expected);
    if (action === 'remove') {
      await restarted.remove('first');
      expect((await restarted.list()).map((e) => e.id)).toEqual(['second']);
    } else {
      await restarted.put(action === 'replace' ? 'first' : 'third', await value('Changed', 3));
      expect((await names(restarted))[0]).toEqual(['Changed', 'Changed', '/u/Changed.vstudio']);
      expect((await restarted.list()).some((e) => e.id === 'second')).toBe(true);
    }
  } finally { vi.restoreAllMocks(); }
});

it('preserves legacy entries when migration is interrupted', async () => {
  const backend = memoryBackend();
  const original = await value('Legacy', 1);
  const { data, ...meta } = original;
  await backend.writeBlob('recovery/first.vstudio', new Blob([data]));
  await backend.writeJSON('recovery/index.json', [{ id: 'first', ...meta }]);
  const store = new RecoveryStore(backend);
  vi.spyOn(backend, 'writeJSON').mockImplementationOnce(async (path) => {
    backend.files.set(path, '[');
    throw new Error('Interrupted');
  });
  try {
    await expect(store.put('first', await value('Changed', 2))).rejects.toThrow();
    expect(await names(new RecoveryStore(backend))).toEqual([['Legacy', 'Legacy', '/u/Legacy.vstudio']]);
  } finally { vi.restoreAllMocks(); }
});

it('does not resurrect deleted entries after alternating updates and restart', async () => {
  const backend = memoryBackend();
  let store = new RecoveryStore(backend);
  await store.put('first', await value('First', 1));
  await store.put('second', await value('Second', 2));
  await store.remove('first');
  store = new RecoveryStore(backend);
  expect((await store.list()).map((e) => e.id)).toEqual(['second']);
  await store.put('second', await value('Newest', 3));
  await store.put('third', await value('Third', 4));
  expect((await names(new RecoveryStore(backend))).map(([name]) => name)).toEqual(['Third', 'Newest']);
  await store.clear();
  expect(await new RecoveryStore(backend).list()).toEqual([]);
  expect(backend.files.size).toBe(0);
});

it('reads the index slots concurrently and writes only one payload and one index per backup', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  const data = await value('Drawing', 1);
  for (let i = 1; i <= 6; i++) {
    const before = backend.writes;
    await store.put('drawing', { ...data, sequence: i, saved: i });
    expect(backend.writes - before).toBe(2);
  }
  expect([...backend.files.keys()].filter((p) => p.endsWith('.json'))).toHaveLength(2);
  expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(1);
  const [entry] = await store.list();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = backend.readJSON;
  const reads = vi.spyOn(backend, 'readJSON').mockImplementation(async (path) => { await gate; return read(path); });
  try {
    const reading = new RecoveryStore(backend).read(entry);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(reads.mock.calls.map(([path]) => path).sort()).toEqual(['recovery/index.0.drawing.json', 'recovery/index.1.drawing.json']);
    release();
    expect((await parseDocument(await reading)).doc.root.name).toBe('Drawing');
  } finally { release(); vi.restoreAllMocks(); }
});

it('does not trust an older index when the newer slot cannot be read', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', await value('Old', 1));
  await store.put('drawing', await value('Newest', 2));
  const [entry] = await store.list();
  const read = backend.readJSON;
  vi.spyOn(backend, 'readJSON').mockImplementation(async (path) => {
    if (path === 'recovery/index.1.drawing.json') throw new Error('Offline');
    return read(path);
  });
  try {
    expect(await new RecoveryStore(backend).list()).toEqual([]);
    await expect(store.read(entry)).rejects.toThrow('Offline');
    await expect(store.put('drawing', await value('Changed', 3))).rejects.toThrow('Offline');
    await store.put('other', await value('Other', 3));
    expect((await store.list()).map((e) => e.id)).toEqual(['other']);
  } finally { vi.restoreAllMocks(); }
  expect(await names(new RecoveryStore(backend))).toEqual([['Other', 'Other', '/u/Other.vstudio'], ['Newest', 'Newest', '/u/Newest.vstudio']]);
});

it.each([false, true])('does not restore or discard an older snapshot when a damaged index leaves newer bytes unindexed (old cleanup failed: %s)', async (cleanupFailed) => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', await value('Old', 1));
  if (cleanupFailed) vi.spyOn(backend, 'remove').mockRejectedValueOnce(new Error('Cleanup interrupted'));
  await store.put('drawing', await value('Newest', 2));
  backend.files.set('recovery/index.1.drawing.json', '{');
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store: new RecoveryStore(backend), session: 'new' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  try {
    expect((await saver.offerRecovery()).map((ed) => ed.doc.root.name)).toEqual([]);
    expect(app.addDocument).not.toHaveBeenCalled();
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(cleanupFailed ? 2 : 1);
    expect(app.notify.mock.calls.some(([message]) => message.includes('could not be recovered right now'))).toBe(true);
  } finally { dialogHooks.open = null; vi.restoreAllMocks(); }
});
