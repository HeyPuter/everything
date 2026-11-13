import { expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';

async function snapshot(name, sequence) {
  return { name, file: { kind: 'puter', path: `/u/${name}.vstudio`, name: `${name}.vstudio` },
    data: await serializeDocument(VDocument.create({ name }), { compress: false }),
    session: 'session', sequence, saved: sequence, revision: sequence };
}
async function setup() {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  const before = await snapshot('Original', 1);
  const after = await snapshot('Changed', 2);
  await store.put('drawing', before);
  return { backend, store, before, after, entry: (await store.list())[0] };
}

it.each(['index read', 'index write', 'partial blob write'])('keeps the previous recovery contents and location paired after a failed %s', async (stage) => {
  const { backend, store, after } = await setup();
  if (stage === 'index read') vi.spyOn(backend, 'readJSON').mockRejectedValueOnce(new Error('Index unavailable'));
  if (stage === 'index write') vi.spyOn(backend, 'writeJSON').mockRejectedValueOnce(new Error('Index unavailable'));
  if (stage === 'partial blob write') vi.spyOn(backend, 'writeBlob').mockImplementationOnce(async (path) => {
    backend.files.set(path, new Blob(['partial bytes']));
    throw new Error('Write interrupted');
  });
  try {
    await expect(store.put('drawing', after)).rejects.toThrow();
    const [entry] = await new RecoveryStore(backend).list();
    expect(entry.file.path).toBe('/u/Original.vstudio');
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Original');
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(1);
    // A retry publishes the new contents and location together.
    await store.put('drawing', after);
    const [latest] = await store.list();
    expect(latest.file.path).toBe('/u/Changed.vstudio');
    expect((await parseDocument(await store.read(latest))).doc.root.name).toBe('Changed');
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(1);
  } finally { vi.restoreAllMocks(); }
});

it('reads the previously selected snapshot while a new index write is pending', async () => {
  const { backend, store, after, entry } = await setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const write = backend.writeJSON;
  const writing = vi.spyOn(backend, 'writeJSON').mockImplementationOnce(async (...args) => {
    await gate;
    return write(...args);
  });
  let saving;
  try {
    saving = store.put('drawing', after);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Original');
    release();
    await saving;
    const [latest] = await store.list();
    expect((await parseDocument(await store.read(latest))).doc.root.name).toBe('Changed');
  } finally { release(); await saving; vi.restoreAllMocks(); }
});

it('rejects an obsolete selection instead of pairing current contents with its old file location', async () => {
  const { store, after, entry } = await setup();
  await store.put('drawing', after);
  await expect(store.read(entry)).rejects.toThrow();
  const [latest] = await store.list();
  expect(latest.file.path).toBe('/u/Changed.vstudio');
  expect((await parseDocument(await store.read(latest))).doc.root.name).toBe('Changed');
});

it('can read, replace, and remove a legacy recovery file', async () => {
  const backend = memoryBackend();
  const before = await snapshot('Legacy', 1);
  const { data, ...meta } = before;
  await backend.writeBlob('recovery/drawing.vstudio', new Blob([data]));
  await backend.writeJSON('recovery/index.json', [{ id: 'drawing', ...meta }]);
  const store = new RecoveryStore(backend);
  expect((await parseDocument(await store.read((await store.list())[0]))).doc.root.name).toBe('Legacy');
  await store.put('drawing', await snapshot('Current', 2));
  expect((await parseDocument(await store.read((await store.list())[0]))).doc.root.name).toBe('Current');
  expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(1);
  await store.remove('drawing');
  expect(await store.list()).toEqual([]);
  expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(0);
});

it('distinguishes separate publications even when legacy metadata ties', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  const before = await snapshot('Original', 1);
  const after = await snapshot('Changed', 2);
  const meta = { name: 'Drawing', session: 'same', saved: 100, revision: 0 };
  await store.put('drawing', { ...meta, data: before.data });
  const [entry] = await store.list();
  await store.put('drawing', { ...meta, data: after.data });
  await expect(store.read(entry)).rejects.toThrow();
  expect((await parseDocument(await store.read((await store.list())[0]))).doc.root.name).toBe('Changed');
});

it('does not mistake a concurrently replaced snapshot for missing recovery data', async () => {
  const { backend, store, after, entry } = await setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = backend.readBlob;
  const reading = vi.spyOn(backend, 'readBlob').mockImplementationOnce(async (path) => {
    await gate;
    return read(path);
  });
  let pending;
  try {
    pending = store.read(entry);
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    await store.put('drawing', after);
    const rejected = expect(pending).rejects.toThrow();
    release();
    await rejected;
    expect((await parseDocument(await store.read((await store.list())[0]))).doc.root.name).toBe('Changed');
  } finally { release(); await pending?.catch(() => {}); vi.restoreAllMocks(); }
});

it('keeps published bytes when an index write succeeds but its acknowledgement fails', async () => {
  const { backend, store, after } = await setup();
  const write = backend.writeJSON;
  vi.spyOn(backend, 'writeJSON').mockImplementationOnce(async (...args) => {
    await write(...args);
    throw new Error('Response lost');
  });
  try {
    await expect(store.put('drawing', after)).rejects.toThrow('Response lost');
    const [entry] = await new RecoveryStore(backend).list();
    expect(entry.file.path).toBe('/u/Changed.vstudio');
    expect((await parseDocument(await store.read(entry))).doc.root.name).toBe('Changed');
    // Removing the recovery document also clears leftover unpublished/old files.
    await store.remove('drawing');
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(0);
  } finally { vi.restoreAllMocks(); }
});

it('keeps the failed backend consistent when a newer snapshot succeeds in fallback storage', async () => {
  const { backend, before, after } = await setup();
  const local = memoryBackend();
  local.kind = 'local';
  const store = new RecoveryStore([backend, local]);
  vi.spyOn(backend, 'writeJSON').mockRejectedValue(new Error('Index offline'));
  try {
    expect(await store.put('drawing', after)).toBe('local');
    const oldStore = new RecoveryStore(backend);
    const [old] = await oldStore.list();
    expect(old.file.path).toBe(before.file.path);
    expect((await parseDocument(await oldStore.read(old))).doc.root.name).toBe('Original');
    const [latest] = await store.list();
    expect(latest.file.path).toBe(after.file.path);
    expect((await parseDocument(await store.read(latest))).doc.root.name).toBe('Changed');
  } finally { vi.restoreAllMocks(); }
});

it('can retry payload cleanup after removing the index entry succeeds but deleting files fails', async () => {
  const { backend, store } = await setup();
  vi.spyOn(backend, 'remove').mockRejectedValueOnce(new Error('Delete interrupted'));
  try {
    await store.remove('drawing');
    expect(await store.list()).toEqual([]);
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(1);
    await new RecoveryStore(backend).remove('drawing');
    expect([...backend.files.keys()].filter((p) => p.endsWith('.vstudio'))).toHaveLength(0);
  } finally { vi.restoreAllMocks(); }
});
