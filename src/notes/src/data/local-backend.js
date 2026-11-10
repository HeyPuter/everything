/**
 * Browser-only backend on IndexedDB, used by the development sandbox
 * (?local) so the app can be tried without a Puter account.
 */
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('notes-local', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function localBackend() {
  const db = await open();
  const tx = (mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction('files', mode);
    const store = t.objectStore('files');
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    // A transaction that is aborted (storage is full) reports no error: it
    // must still settle, or the save waits forever.
    t.onabort = () => reject(t.error || new Error('The write was aborted.'));
  });
  return {
    kind: 'local',
    async readJSON(path) {
      const v = await tx('readonly', (s) => s.get(path));
      return v === undefined ? null : JSON.parse(v);
    },
    async writeJSON(path, value) {
      await tx('readwrite', (s) => s.put(JSON.stringify(value), path));
    },
    async readBlob(path) {
      return (await tx('readonly', (s) => s.get(path))) ?? null;
    },
    async writeBlob(path, blob) {
      await tx('readwrite', (s) => s.put(blob, path));
    },
    async remove(path) {
      await tx('readwrite', (s) => s.delete(path));
    },
    async list(dir) {
      const keys = await tx('readonly', (s) => s.getAllKeys());
      const prefix = `${dir}/`;
      return keys.filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => ({ name: k.slice(prefix.length), isDir: false }));
    },
    async readURL(path) {
      const v = await this.readBlob(path);
      return URL.createObjectURL(v instanceof Blob ? v : new Blob([v], { type: 'application/json' }));
    },
  };
}
