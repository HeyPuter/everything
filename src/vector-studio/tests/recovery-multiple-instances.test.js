import { afterEach, expect, it, vi } from 'vitest';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';

afterEach(() => vi.restoreAllMocks());

const copy = (name, sequence = 1) => ({ name, data: name, session: 'old', sequence, saved: sequence });
async function contents(backend) {
  const store = new RecoveryStore(backend);
  return (await Promise.all((await store.list()).map(async (entry) => [entry.id, await (await store.read(entry)).text()]))).sort(([a], [b]) => a.localeCompare(b));
}

// Distinct clients share persisted files, as separate tabs/devices do. Neither
// store's in-memory operation queue can serialize the other client's writes.
function concurrentClients(backend, count = 2) {
  let arrivals = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  return Array.from({ length: count }, () => new RecoveryStore({ ...backend, writeJSON: async (...args) => {
    if (++arrivals === count) release();
    await gate;
    return backend.writeJSON(...args);
  } }));
}

it.each([
  ['add', 'add', [], [['a', 'New A'], ['b', 'New B']]],
  ['replace', 'add', ['a'], [['a', 'New A'], ['b', 'New B']]],
  ['remove', 'add', ['a'], [['b', 'New B']]],
  ['remove', 'replace', ['a', 'b'], [['b', 'New B']]],
  ['remove', 'remove', ['a', 'b'], []],
])('preserves both results when separate instances %s and %s different documents', async (leftAction, rightAction, initial, expected) => {
  const backend = memoryBackend();
  const initialStore = new RecoveryStore(backend);
  for (const id of initial) await initialStore.put(id, copy(`Old ${id}`));
  const [left, right] = concurrentClients(backend);
  const act = (store, action, id, name) => action === 'remove' ? store.remove(id) : store.put(id, copy(name, 2));
  await Promise.all([act(left, leftAction, 'a', 'New A'), act(right, rightAction, 'b', 'New B')]);
  expect(await contents(backend)).toEqual(expected);
});

it('migrates different legacy documents concurrently without losing either update', async () => {
  const backend = memoryBackend();
  for (const id of ['a', 'b']) await backend.writeBlob(`recovery/${id}.vstudio`, new Blob([`Old ${id}`]));
  await backend.writeJSON('recovery/index.json', ['a', 'b'].map((id) => ({ id, name: `Old ${id}`, saved: 1 })));
  const [left, right] = concurrentClients(backend);
  await Promise.all([left.put('a', copy('New A', 2)), right.put('b', copy('New B', 2))]);
  expect(await contents(backend)).toEqual([['a', 'New A'], ['b', 'New B']]);
  await new RecoveryStore(backend).remove('a');
  expect(await contents(backend)).toEqual([['b', 'New B']]);
});

it('retains every backup from many independent instances after restart', async () => {
  const backend = memoryBackend();
  const clients = concurrentClients(backend, 12);
  await Promise.all(clients.map((store, i) => store.put(`doc-${i}`, copy(`Work ${i}`))));
  const restored = await contents(backend);
  expect(restored).toHaveLength(12);
  for (let i = 0; i < clients.length; i++) expect(restored).toContainEqual([`doc-${i}`, `Work ${i}`]);
});

it.each(['array', 'alternating generations'])('keeps unmigrated legacy documents and masks deleted ones after migrating %s', async (format) => {
  const backend = memoryBackend();
  const entries = ['a', 'b'].map((id) => ({ id, name: `Old ${id}`, saved: 1, ...(format === 'array' ? {} : { snapshot: 'old' }) }));
  for (const entry of entries) await backend.writeBlob(entry.snapshot ? `recovery/${entry.id}/old.vstudio` : `recovery/${entry.id}.vstudio`, new Blob([entry.name]));
  await backend.writeJSON('recovery/index.json', format === 'array' ? entries : { version: 1, generation: 3, entries });
  if (format !== 'array') await backend.writeJSON('recovery/index.next.json', { version: 1, generation: 4, entries });
  const original = backend.files.get('recovery/index.json');
  let store = new RecoveryStore(backend);
  await store.put('a', copy('New A', 2));
  expect(await contents(backend)).toEqual([['a', 'New A'], ['b', 'Old b']]);
  await store.remove('a');
  expect(await contents(backend)).toEqual([['b', 'Old b']]);
  store = new RecoveryStore(backend);
  await store.put('a', copy('Reopened A', 3));
  await store.remove('b');
  expect(await contents(backend)).toEqual([['a', 'Reopened A']]);
  expect(backend.files.get('recovery/index.json')).toBe(original);
  await store.remove('a');
  expect(await contents(backend)).toEqual([]);
  expect([...backend.files.keys()].filter((path) => path.endsWith('.vstudio'))).toEqual([]);
});

it('limits concurrent metadata reads while listing many documents', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  for (let i = 0; i < 12; i++) await store.put(`doc-${i}`, copy(`Work ${i}`));
  const read = backend.readJSON;
  let active = 0, peak = 0;
  vi.spyOn(backend, 'readJSON').mockImplementation(async (path) => {
    peak = Math.max(peak, ++active);
    try { await Promise.resolve(); return await read(path); }
    finally { active--; }
  });
  expect(await store.list()).toHaveLength(12);
  expect(peak).toBeGreaterThan(2);
  expect(peak).toBeLessThanOrEqual(8);
});

it('reads only the selected document metadata when checking or updating one of many backups', async () => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  for (let i = 0; i < 12; i++) await store.put(`doc-${i}`, copy(`Work ${i}`));
  const entry = (await store.list()).find((e) => e.id === 'doc-5');
  const reads = vi.spyOn(backend, 'readJSON');
  const lists = vi.spyOn(backend, 'list');
  expect(await store.isCurrent(entry)).toBe(true);
  expect(reads).toHaveBeenCalledTimes(2);
  reads.mockClear();
  await store.put('doc-5', copy('Updated work', 2));
  expect(reads).toHaveBeenCalledTimes(2);
  expect(reads.mock.calls.every(([path]) => path.endsWith('.doc-5.json'))).toBe(true);
  expect(lists).not.toHaveBeenCalled();
});

it.each(['save cleanup', 'confirmed discard'])('does not accumulate metadata for removed non-legacy documents after %s', async (mode) => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  for (let i = 0; i < 12; i++) {
    const id = `doc-${i}`;
    await store.put(id, copy(`Work ${i}`));
    await store.put(id, copy(`Latest ${i}`, 2));
    const [entry] = await store.list();
    expect(await store.remove(id, mode === 'confirmed discard' ? { expected: entry } : {})).toBe(true);
  }
  expect(await new RecoveryStore(backend).list()).toEqual([]);
  expect(backend.files.size).toBe(0);
});

it.each([0, 1])('keeps deletions effective when metadata cleanup fails on slot %s and completes cleanup on retry', async (failedSlot) => {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  await store.put('drawing', copy('Original'));
  const remove = backend.remove;
  let fail = true;
  vi.spyOn(backend, 'remove').mockImplementation(async (path) => {
    if (fail && path === `recovery/index.${failedSlot}.drawing.json`) { fail = false; throw new Error('Offline'); }
    return remove(path);
  });
  expect(await store.remove('drawing')).toBe(false);
  expect(await contents(backend)).toEqual([]);
  expect(await new RecoveryStore(backend).remove('drawing')).toBe(true);
  expect(backend.files.size).toBe(0);
});
