export const DB_NAME = 'cloud-studio-v1';
const DB_VERSION = 1;

let openConnection = null;

/** Clear all stores (tests). Avoids deleteDatabase blocked/hang races. */
export async function resetDb() {
  const db = await openDb();
  const names = [...db.objectStoreNames];
  if (!names.length) return;
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  await txDone(tx);
}

/**
 * Open the IndexedDB backing store. In Node tests, fake-indexeddb provides
 * indexedDB on globalThis.
 */
export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('buckets')) {
        db.createObjectStore('buckets', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('objects')) {
        const objects = db.createObjectStore('objects', { keyPath: ['bucket', 'key'] });
        objects.createIndex('byBucket', 'bucket', { unique: false });
      }
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys', { keyPath: 'accessKeyId' });
      }
      if (!db.objectStoreNames.contains('functions')) {
        db.createObjectStore('functions', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('logs')) {
        const logs = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        logs.createIndex('byFn', 'functionName', { unique: false });
      }
    };
    req.onsuccess = () => {
      openConnection = req.result;
      openConnection.onversionchange = () => {
        openConnection.close();
        openConnection = null;
      };
      resolve(openConnection);
    };
  });
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export function reqOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('request failed'));
  });
}
