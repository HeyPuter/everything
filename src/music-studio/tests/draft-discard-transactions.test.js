// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, memoryDB } from '../src/storage/idb.js';
import { Library } from '../src/storage/library.js';

const connections = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(kind) {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const db = kind === 'memory' ? memoryDB() : await openDB('draft-discard');
  connections.push(db);
  return { db, lib: new Library({ db, now: () => 100 }) };
}

it.each(['memory', 'indexeddb'])('removes only the expected draft revision in %s', async (kind) => {
  const { db, lib } = await setup(kind);
  const old = await lib.saveDraft({ json: 'old', dirty: true }, 'session');
  const newer = await lib.saveDraft({ json: 'new', dirty: true }, 'session');
  expect(newer.revision).not.toBe(old.revision);
  expect(await lib.discardDraft('session', old)).toBe(false);
  expect(await db.get('drafts', 'session')).toEqual(newer);
  expect(await lib.discardDraft('session', newer)).toBe(true);
  expect(await lib.discardDraft('session', newer)).toBe(false);
});

it.each(['memory', 'indexeddb'])('preserves a replacement racing discard in %s', async (kind) => {
  const { db, lib } = await setup(kind);
  const old = await lib.saveDraft({ json: 'old' }, 'session');
  const removing = lib.discardDraft('session', old);
  const replacing = lib.saveDraft({ json: 'replacement' }, 'session');
  const [, newer] = await Promise.all([removing, replacing]);
  expect(await db.get('drafts', 'session')).toEqual(newer);
});

it.each(['memory', 'indexeddb'])('supports legacy drafts without deleting a changed copy in %s', async (kind) => {
  const { db, lib } = await setup(kind);
  const legacy = { json: 'old', dirty: true, at: 10 };
  await db.put('drafts', 'session', legacy);
  expect(await lib.discardDraft('session', { ...legacy, json: 'different' })).toBe(false);
  expect(await lib.discardDraft('session', legacy)).toBe(true);
});

it.each(['memory', 'indexeddb'])('keeps the record intact if a conditional-delete predicate throws in %s', async (kind) => {
  const { db } = await setup(kind);
  await db.put('drafts', 'session', { json: 'old' });
  await expect(db.deleteIf('drafts', 'session', (record) => { record.json = 'changed'; throw new Error('Predicate failed'); })).rejects.toThrow('Predicate failed');
  expect(await db.get('drafts', 'session')).toEqual({ json: 'old' });
});

it('rolls back an aborted conditional deletion and permits retry', async () => {
  const { db, lib } = await setup('indexeddb');
  const original = await lib.saveDraft({ json: 'old' }, 'session');
  const nativeDelete = IDBObjectStore.prototype.delete;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (...args) {
    const request = nativeDelete.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  await expect(lib.discardDraft('session', original)).rejects.toThrow();
  expect(await db.get('drafts', 'session')).toEqual(original);
  fault.mockRestore();
  expect(await lib.discardDraft('session', original)).toBe(true);
});
