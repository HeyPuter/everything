import { invariant } from '../shared/errors.js';
import { isUuid } from '../shared/ids.js';

const STORE = 'records';
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error('storage_aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('storage_failed'));
  });
}

export async function openDatabase(account, { indexedDB = globalThis.indexedDB, name = `trips-v1:${account}` } = {}) {
  invariant(isUuid(account), 'invalid_account');
  invariant(indexedDB, 'storage_unavailable');
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('storage_blocked'));
  });
  database.onversionchange = () => database.close();
  return {
    account,
    async get(key) {
      const tx = database.transaction(STORE, 'readonly');
      const done = completed(tx);
      const request = tx.objectStore(STORE).get(key);
      const [value] = await Promise.all([result(request), done]);
      return value;
    },
    async put(key, value) {
      const tx = database.transaction(STORE, 'readwrite');
      const done = completed(tx);
      tx.objectStore(STORE).put(value, key);
      await done;
    },
    async remove(key) {
      const tx = database.transaction(STORE, 'readwrite');
      const done = completed(tx);
      tx.objectStore(STORE).delete(key);
      await done;
    },
    async update(key, change) {
      const tx = database.transaction(STORE, 'readwrite');
      const done = completed(tx);
      let value;
      let failure;
      const get = tx.objectStore(STORE).get(key);
      get.onsuccess = () => {
        try {
          value = change(get.result);
          invariant(!value?.then, 'async_storage_change');
          // Returning the value it was given means unchanged: nothing is written.
          if (value === undefined) tx.objectStore(STORE).delete(key);
          else if (value !== get.result) tx.objectStore(STORE).put(value, key);
        } catch (error) { failure = error; tx.abort(); }
      };
      try { await done; } catch (error) { throw failure ?? error; }
      return value;
    },
    close() { database.close(); },
  };
}
