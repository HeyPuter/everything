// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, memoryDB } from '../src/storage/idb.js';
import { Library } from '../src/storage/library.js';
import { newProject } from '../src/model/demo.js';

const connections = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const db = await openDB('local-project-transactions');
  connections.push(db);
  expect(db.persistent).toBe(true);
  return { db, lib: new Library({ db, now: () => 100 }) };
}
function abortMetadata(method) {
  const original = IDBObjectStore.prototype[method];
  return vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (...args) {
    const request = original.apply(this, args);
    if (this.name === 'projects') request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
}

it.each(['new', 'overwrite'])('rolls back project contents when a %s save’s metadata transaction aborts', async (mode) => {
  const { db, lib } = await setup();
  if (mode === 'overwrite') await lib.saveLocal({ ...newProject(), bpm: 90 }, {}, { key: 'song', name: 'Original' });
  const before = { content: await db.get('projectData', 'song'), meta: await db.get('projects', 'song') };
  const fault = abortMetadata('put');
  await expect(lib.saveLocal({ ...newProject(), bpm: 150 }, {}, { key: 'song', name: 'Replacement' })).rejects.toThrow();
  fault.mockRestore();
  expect(await db.get('projectData', 'song') === before.content).toBe(true);
  expect(await db.get('projects', 'song')).toEqual(before.meta);
  await lib.saveLocal({ ...newProject(), bpm: 150 }, {}, { key: 'song', name: 'Replacement' });
  expect((await lib.loadLocal('song')).bpm).toBe(150);
  expect((await lib.listLocal())[0].name).toBe('Replacement');
});

it('preserves an openable project when deleting its list entry aborts', async () => {
  const { db, lib } = await setup();
  await lib.saveLocal({ ...newProject(), bpm: 90 }, {}, { key: 'song', name: 'Original' });
  const before = { content: await db.get('projectData', 'song'), meta: await db.get('projects', 'song') };
  const fault = abortMetadata('delete');
  await expect(lib.deleteLocal('song')).rejects.toThrow();
  fault.mockRestore();
  expect(await db.get('projectData', 'song') === before.content).toBe(true);
  expect(await db.get('projects', 'song')).toEqual(before.meta);
  expect((await lib.loadLocal('song')).bpm).toBe(90);
  await lib.deleteLocal('song');
  expect(await lib.listLocal()).toEqual([]);
  await expect(lib.loadLocal('song')).rejects.toThrow(/no longer saved/);
});

it.each(['indexeddb', 'memory'])('clones a mixed batch and commits all changes before resolving (%s)', async (backend) => {
  const db = backend === 'indexeddb' ? (await setup()).db : memoryDB();
  await db.put('projectData', 'old', 'old content');
  const value = { name: 'Saved', nested: { bpm: 99 } };
  const saving = db.batch([
    { type: 'delete', store: 'projectData', key: 'old' },
    { type: 'put', store: 'projectData', key: 'new', value: 'new content' },
    { type: 'put', store: 'projects', key: 'new', value },
  ]);
  value.nested.bpm = 150;
  await saving;
  expect(await db.get('projectData', 'old')).toBeNull();
  expect(await db.get('projectData', 'new')).toBe('new content');
  expect(await db.get('projects', 'new')).toEqual({ name: 'Saved', nested: { bpm: 99 } });
});

it.each([
  ['indexeddb', 'clone'], ['indexeddb', 'operation'],
  ['memory', 'clone'], ['memory', 'operation'],
])('rolls back earlier queued changes after a synchronous %s/%s failure', async (backend, fault) => {
  const db = backend === 'indexeddb' ? (await setup()).db : memoryDB();
  await db.put('projectData', 'song', 'original');
  const bad = fault === 'clone'
    ? { type: 'put', store: 'projects', key: 'song', value: { uncloneable() {} } }
    : { type: 'unsupported', store: 'projects', key: 'song' };
  await expect(db.batch([
    { type: 'delete', store: 'projectData', key: 'song' },
    { type: 'put', store: 'projectData', key: 'other', value: 'new' },
    bad,
  ])).rejects.toThrow();
  expect(await db.get('projectData', 'song')).toBe('original');
  expect(await db.get('projectData', 'other')).toBeNull();
  expect(await db.get('projects', 'song')).toBeNull();
  await db.batch([{ type: 'put', store: 'projects', key: 'song', value: { name: 'Retry' } }]);
  expect(await db.get('projects', 'song')).toEqual({ name: 'Retry' });
});

it('keeps concurrent saves of one project consistent across both stores', async () => {
  const { db, lib } = await setup();
  await Promise.all([
    lib.saveLocal({ ...newProject(), name: 'First', bpm: 90 }, {}, { key: 'song' }),
    lib.saveLocal({ ...newProject(), name: 'Second', bpm: 150 }, {}, { key: 'song' }),
  ]);
  const project = await lib.loadLocal('song');
  const meta = (await lib.listLocal())[0];
  expect(project.name).toBe('Second');
  expect(project.bpm).toBe(150);
  expect(meta.name).toBe(project.name);
  expect(meta.size).toBe((await db.get('projectData', 'song')).length);
});
