import { afterEach, expect, it, vi } from 'vitest';

/** A small IndexedDB stand-in: one object store kept in memory, and every connection opened, to count. */
function fakeIndexedDB() {
  const rows = new Map();
  const connections = [];
  const request = (fn) => {
    const req = {};
    queueMicrotask(() => { req.result = fn(); req.onsuccess?.(); });
    return req;
  };
  const store = {
    put: (value, key) => request(() => { rows.set(key, structuredClone(value)); return key; }),
    get: (key) => request(() => structuredClone(rows.get(key))),
    delete: (key) => request(() => { rows.delete(key); }),
    getAll: () => request(() => [...rows.values()].map((v) => structuredClone(v))),
  };
  return {
    connections,
    open() {
      const req = {};
      queueMicrotask(() => {
        const db = { closed: false, transaction: () => ({ objectStore: () => store }), close() { this.closed = true; } };
        connections.push(db);
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

// Each shared workbook opened made its own outbox, and with it a connection to the browser's database that nothing
// ever closed: a tab that opened many shared workbooks one after another kept every one of them open.
it('keeps one database connection however many shared workbooks a tab opens', async () => {
  const idb = fakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  const { browserOutbox } = await import('../src/collab/outbox.js');
  for (let n = 0; n < 5; n++) {
    const store = browserOutbox();
    await store.put(`u:${n}`, { room: String(n), user: 'u', rev: 0, pending: [] });
    expect(await store.get(`u:${n}`)).toMatchObject({ room: String(n) });
    expect(store.durable).toBe(true);
  }
  expect(idb.connections).toHaveLength(1);
  expect((await browserOutbox().all()).map((r) => r.room)).toEqual(['0', '1', '2', '3', '4']);
  expect(idb.connections).toHaveLength(1);
});

// The browser can close the connection itself (site data cleared while the page is open): the next shared workbook
// opens a new one, as each did when every outbox had its own, rather than keep using the closed one.
it('opens a new connection once the browser closed the one the page had', async () => {
  const idb = fakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  const { browserOutbox } = await import('../src/collab/outbox.js');
  await browserOutbox().put('u:1', { room: '1', user: 'u', rev: 0, pending: [] });
  const [first] = idb.connections;
  first.closed = true;
  first.transaction = () => { throw new DOMException('The database connection is closing.', 'InvalidStateError'); };
  first.onclose?.();
  const store = browserOutbox();
  await store.put('u:2', { room: '2', user: 'u', rev: 0, pending: [] });
  expect(idb.connections).toHaveLength(2);
  expect(store.durable).toBe(true);
});
