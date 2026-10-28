import { it, expect, beforeEach, afterEach } from 'vitest';

/** Just enough of IndexedDB for the outbox: one store, put/getAll/delete, completing after the calls. */
function memoryIndexedDB() {
  const rows = new Map();
  const store = {
    put: item => { rows.set(item.key, structuredClone(item)); return {}; },
    delete: key => { rows.delete(key); return {}; },
    getAll: () => ({ result: [...rows.values()].map(r => structuredClone(r)) }),
  };
  const db = { transaction: () => { const tx = { objectStore: () => store }; setTimeout(() => tx.oncomplete?.(), 0); return tx; } };
  return { rows, open: () => { const request = { result: db }; setTimeout(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }, 0); request.result.createObjectStore = () => store; return request; } };
}

let idb;
beforeEach(() => { idb = memoryIndexedDB(); globalThis.indexedDB = idb; });
afterEach(() => { delete globalThis.indexedDB; });

const { Outbox, CollabClient } = await import('../src/collab/client.js');

it('gives back only the changes this account left undelivered in a room, keeping the others\' for them', async () => {
  const ann = new Outbox('room1', 's1', 'ann-uuid');
  await ann.add(new Uint8Array([1, 2, 3]));
  await new Outbox('room2', 's2', 'ann-uuid').add(new Uint8Array([9]));
  // Someone else signs in on this computer and opens the same shared document.
  const bob = new Outbox('room1', 's3', 'bob-uuid');
  expect(await bob.restore()).toEqual([]);
  // Ann's change waits for her, in its room only.
  const again = await new Outbox('room1', 's4', 'ann-uuid').restore();
  expect(again.map(item => [...item.update])).toEqual([[1, 2, 3]]);
  expect(idb.rows.size).toBe(2);
});

it('leaves changes kept before they named their account alone, rather than sending them as whoever opens the room', async () => {
  idb.rows.set('legacy', { key: 'legacy', room: 'room1', at: 1, seq: 0, update: new Uint8Array([7]) });
  expect(await new Outbox('room1', 's1', 'bob-uuid').restore()).toEqual([]);
  expect(idb.rows.has('legacy')).toBe(true);
});

it('names the person\'s account on what a client keeps', () => {
  const client = new CollabClient({ transport: {}, user: { id: 'ann-uuid', name: 'Ann' }, room: 'room1' });
  expect(client.outbox.account).toBe('ann-uuid');
});
