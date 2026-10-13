// Browser-local storage for document versions, crash recovery, thumbnails
// and recently opened local files. Records live in IndexedDB; tests use the
// in-memory backend with the same interface.

export type StoreName = 'versions' | 'blobs' | 'recovery' | 'thumbs';
export const STORE_NAMES: StoreName[] = ['versions', 'blobs', 'recovery', 'thumbs'];

export interface LocalStore<S extends string = StoreName> {
  get<T>(store: S, key: string): Promise<T | undefined>;
  put<T>(store: S, key: string, value: T): Promise<void>;
  delete(store: S, key: string): Promise<void>;
  /** Every value of a store (small record stores only). */
  all<T>(store: S): Promise<T[]>;
  /** Write records of several stores together: all of them or none. */
  putAll?(writes: { store: S; key: string; value: unknown }[]): Promise<void>;
  /** The keys of a store. */
  keys?(store: S): Promise<string[]>;
}

/** In-memory backend (tests, and browsers without IndexedDB). */
export class MemoryStore<S extends string = StoreName> implements LocalStore<S> {
  private data = new Map<S, Map<string, unknown>>();
  private map(store: S) {
    let m = this.data.get(store);
    if (!m) this.data.set(store, (m = new Map()));
    return m;
  }
  async get<T>(store: S, key: string) {
    return this.map(store).get(key) as T | undefined;
  }
  async put<T>(store: S, key: string, value: T) {
    this.map(store).set(key, value);
  }
  async delete(store: S, key: string) {
    this.map(store).delete(key);
  }
  async all<T>(store: S) {
    return [...this.map(store).values()] as T[];
  }
  async putAll(writes: { store: S; key: string; value: unknown }[]) {
    for (const w of writes) this.map(w.store).set(w.key, w.value);
  }
  async keys(store: S) {
    return [...this.map(store).keys()];
  }
}

const DB_NAME = 'photo-studio-local';
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('Browser storage failed.'));
  });

/** IndexedDB backend: one object store per StoreName, keyed out of line.
 * Features with their own records can open a separate database. */
export class IndexedDbStore<S extends string = StoreName> implements LocalStore<S> {
  private db?: Promise<IDBDatabase>;
  constructor(
    private name = DB_NAME,
    private stores: readonly S[] = STORE_NAMES as unknown as S[],
  ) {}
  private open() {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        for (const name of this.stores) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('Browser storage is unavailable.'));
      r.onblocked = () => reject(new Error('Browser storage is busy in another tab.'));
    });
    return this.db;
  }
  private async tx(store: S, mode: IDBTransactionMode) {
    return (await this.open()).transaction(store, mode).objectStore(store);
  }
  async get<T>(store: S, key: string) {
    return (await request((await this.tx(store, 'readonly')).get(key))) as T | undefined;
  }
  async put<T>(store: S, key: string, value: T) {
    await request((await this.tx(store, 'readwrite')).put(value, key));
  }
  async delete(store: S, key: string) {
    await request((await this.tx(store, 'readwrite')).delete(key));
  }
  async all<T>(store: S) {
    return (await request((await this.tx(store, 'readonly')).getAll())) as T[];
  }
  async putAll(writes: { store: S; key: string; value: unknown }[]) {
    const tx = (await this.open()).transaction([...new Set(writes.map((w) => w.store))], 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Browser storage failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Browser storage failed.'));
    });
    for (const w of writes) tx.objectStore(w.store).put(w.value, w.key);
    await done;
  }
  async keys(store: S) {
    return (await request((await this.tx(store, 'readonly')).getAllKeys())).map(String);
  }
}

let shared: LocalStore | undefined;
/** The app's store: IndexedDB where available, otherwise memory. */
export function localStore(): LocalStore {
  shared ??= typeof indexedDB !== 'undefined' ? new IndexedDbStore() : new MemoryStore();
  return shared;
}
/** Replace the store (tests). */
export function setLocalStore(s: LocalStore) {
  shared = s;
}
