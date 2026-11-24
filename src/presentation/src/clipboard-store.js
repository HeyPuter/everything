// The object clipboard shared between this app's tabs: the last copy made
// in any tab, kept in IndexedDB as a small presentation of its own, so a
// paste in another tab (another presentation) brings the objects rather
// than only their text. A paste recognises it by the token the system
// clipboard carries, or by its text. Storage that fails (a private window,
// a full disk) leaves pasting to text, as before.
const DB = "presentation-clipboard-v1";
const STORE = "clipboard";
const KEY = "last";

let opening = null;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("clipboard storage blocked"));
  }).catch((error) => {
    opening = null;
    throw error;
  });
  return opening;
}
function run(mode, act) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = act(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      }),
  );
}
// Keeps `entry` ({ token, bytes, ... }) as the shared copy.
export function shareClipboard(entry) {
  return run("readwrite", (store) => store.put(entry, KEY));
}
// The last copy made in any tab, or null.
export async function sharedClipboard() {
  return (await run("readonly", (store) => store.get(KEY))) ?? null;
}
