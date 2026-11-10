import { describe, it, expect, vi, afterEach } from 'vitest';

/** A minimal IndexedDB whose connections can be closed by "the browser". */
function fakeIndexedDB({ failOpens = 0 } = {}) {
  const store = new Map();
  const dbs = [];
  let opens = 0;
  const idb = {
    get opens() {
      return opens;
    },
    dbs,
    open() {
      opens++;
      const req = {};
      const fail = opens <= failOpens;
      setTimeout(() => {
        if (fail) {
          req.error = new Error('open failed');
          return req.onerror();
        }
        const db = {
          closed: false,
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            if (db.closed) throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
            const t = {
              objectStore: () => ({
                put: (v) => (store.set(v.id, v), { result: v.id }),
                get: (k) => ({ result: store.get(k) }),
              }),
            };
            setTimeout(() => t.oncomplete?.(), 0);
            return t;
          },
        };
        dbs.push(db);
        req.result = db;
        req.onsuccess();
      }, 0);
      return req;
    },
  };
  return idb;
}

async function load(idb) {
  vi.resetModules();
  globalThis.indexedDB = idb;
  return (await import('../src/io/storage.js')).recovery;
}

afterEach(() => {
  delete globalThis.indexedDB;
});

describe('recovery storage', () => {
  it('opens the database again after the browser closes the connection', async () => {
    const idb = fakeIndexedDB();
    const recovery = await load(idb);
    expect(await recovery.put({ id: 1 })).toBe(true);
    idb.dbs[0].closed = true;
    expect(await recovery.put({ id: 2 })).toBe(true);
    expect(await recovery.put({ id: 3 })).toBe(true);
    expect((await recovery.get(2)).id).toBe(2);
    expect(idb.opens).toBe(2);
  });

  it('opens the database again after a failed open', async () => {
    const idb = fakeIndexedDB({ failOpens: 1 });
    const recovery = await load(idb);
    expect(await recovery.put({ id: 1 })).toBe(false);
    expect(await recovery.put({ id: 1 })).toBe(true);
    expect(idb.opens).toBe(2);
  });

  it('opens the database again when the connection reports it was closed', async () => {
    const idb = fakeIndexedDB();
    const recovery = await load(idb);
    expect(await recovery.put({ id: 1 })).toBe(true);
    idb.dbs[0].onclose();
    expect(await recovery.put({ id: 2 })).toBe(true);
    expect(idb.opens).toBe(2);
  });

  it('gives up on a database open that never answers', async () => {
    // Seen in browsers: the open request fires neither success nor error.
    vi.useFakeTimers();
    try {
      let late;
      const closed = [];
      const idb = { open: () => (late = {}) };
      const recovery = await load(idb);
      const answers = [];
      recovery.getSession().then((v) => answers.push(['session', v]));
      recovery.put({ id: 1 }).then((v) => answers.push(['put', v]));
      await vi.advanceTimersByTimeAsync(60000);
      expect(answers).toEqual([
        ['session', null],
        ['put', false],
      ]);
      // An answer that comes after all is not left open.
      late.result = { close: () => closed.push(1) };
      late.onsuccess();
      expect(closed).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
