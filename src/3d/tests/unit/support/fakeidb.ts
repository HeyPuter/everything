// Minimal in-memory IndexedDB for unit tests (open / object stores / get / put / delete).
// `fail.put` makes writes abort their transaction the way a full disk (QuotaExceededError) does.
type Handler = ((this: unknown, ev?: unknown) => void) | null;

export interface FakeIdb {
  stores: Map<string, Map<string, Map<string, unknown>>>;
  fail: { put: boolean; open: boolean };
  /** database connections that were opened and not closed */
  open: number;
}

/** Installs the fake once per test file (modules keep their database connections) and returns its state. */
export function installFakeIndexedDb(): FakeIdb {
  const g = globalThis as unknown as { __fakeIdb?: FakeIdb };
  if (g.__fakeIdb) return g.__fakeIdb;
  const state: FakeIdb = { stores: new Map(), fail: { put: false, open: false }, open: 0 };
  const later = (f: () => void) => setTimeout(f, 0);
  const request = () => ({ result: undefined as unknown, error: null as unknown, onsuccess: null as Handler, onerror: null as Handler, onupgradeneeded: null as Handler, onblocked: null as Handler });
  const indexedDB = {
    open(name: string) {
      const r = request();
      later(() => {
        if (state.fail.open) {
          r.error = new DOMException('denied', 'UnknownError');
          return r.onerror?.call(r);
        }
        const fresh = !state.stores.has(name);
        const db = state.stores.get(name) ?? new Map<string, Map<string, unknown>>();
        state.stores.set(name, db);
        let closed = false;
        state.open++;
        r.result = {
          createObjectStore: (s: string) => db.set(s, new Map()),
          close: () => {
            if (!closed) state.open--;
            closed = true;
          },
          transaction(store: string) {
            const tx = { error: null as unknown, oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler };
            let failed = false;
            const os = db.get(store)!;
            const op = (fn: () => unknown, write: boolean) => {
              const req = request();
              if (write && state.fail.put) failed = true;
              else req.result = fn();
              later(() => req.onsuccess?.call(req));
              return req;
            };
            later(() =>
              later(() => {
                if (!failed) return tx.oncomplete?.call(tx);
                // QuotaExceededError aborts the transaction without a request error
                tx.error = new DOMException('quota', 'QuotaExceededError');
                tx.onabort?.call(tx);
              }),
            );
            return {
              ...tx,
              set oncomplete(f: Handler) {
                tx.oncomplete = f;
              },
              set onerror(f: Handler) {
                tx.onerror = f;
              },
              set onabort(f: Handler) {
                tx.onabort = f;
              },
              get error() {
                return tx.error;
              },
              objectStore: () => ({
                put: (v: unknown, k: string) => op(() => void os.set(k, v), true),
                get: (k: string) => op(() => os.get(k), false),
                delete: (k: string) => op(() => void os.delete(k), true),
                getAll: () => op(() => [...os.values()], false),
                getAllKeys: () => op(() => [...os.keys()], false),
              }),
            };
          },
        };
        if (fresh) r.onupgradeneeded?.call(r);
        r.onsuccess?.call(r);
      });
      return r;
    },
  };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = indexedDB;
  g.__fakeIdb = state;
  return state;
}
