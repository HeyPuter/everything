// Small IndexedDB key-value store for preference assets that do not fit localStorage
// (MatCap images, HDRI pixels). Failures degrade to "nothing stored".
const DB = 'p3d-prefs';
const STORE = 'assets';
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise<T | null>((resolve) => {
        if (!d) return resolve(null);
        try {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const assetGet = <T>(key: string) => run<T>('readonly', (s) => s.get(key));
export const assetPut = (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key));
export const assetDelete = (key: string) => run('readwrite', (s) => s.delete(key));
export const assetKeys = () => run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
