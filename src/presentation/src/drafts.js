const DB = "presentation-drafts-v1";
function metadata(draft) {
  const { bytes, ...summary } = draft;
  return summary;
}
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      const drafts = db.objectStoreNames.contains("drafts")
        ? r.transaction.objectStore("drafts")
        : db.createObjectStore("drafts", { keyPath: "id" });
      const summaries = db.createObjectStore("summaries", { keyPath: "id" });
      summaries.createIndex("owner", "owner");
      const cursor = drafts.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        summaries.put(metadata(entry.value));
        entry.continue();
      };
    };
    let blocked = false;
    r.onblocked = () => {
      // An older tab keeps the previous schema open, so the upgrade waits
      // indefinitely. Report it instead of leaving the library loading.
      blocked = true;
      reject(
        Object.assign(
          new Error(
            "Local drafts are unavailable while an older Presentation tab is open. Close your other Presentation tabs, then try again.",
          ),
          { code: "blocked" },
        ),
      );
    };
    r.onsuccess = () => {
      if (blocked) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
}
async function transact(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["drafts", "summaries"], mode);
      let request;
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      try {
        request = fn(tx.objectStore("drafts"), tx.objectStore("summaries"));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}
export const saveDraft = (draft) =>
  transact("readwrite", (s, summaries) => {
    const record = { ...draft, updated: Date.now() };
    summaries.put(metadata(record));
    return s.put(record);
  });
export const deleteDraft = (id) =>
  transact("readwrite", (s, summaries) => {
    summaries.delete(id);
    return s.delete(id);
  });
export const getDraft = (id) => transact("readonly", (s) => s.get(id));
export const linkCloudFile = (id, owner, path, name, baseline = {}) =>
  transact("readwrite", (s, summaries) => {
    const request = s.get(id);
    request.onsuccess = () => {
      const record = request.result;
      if (!record || record.owner !== owner || record.path) return;
      Object.assign(record, baseline, { path, name });
      s.put(record);
      summaries.put(metadata(record));
    };
  });
const updateCloudDrafts = (owner, path, changes) =>
  transact("readwrite", (s, summaries) => {
    const cursor = summaries.index("owner").openCursor(owner);
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if (entry.value.path === path) {
        const request = s.get(entry.primaryKey);
        request.onsuccess = () => {
          const record = request.result;
          if (record) {
            Object.assign(record, changes);
            s.put(record);
            summaries.put(metadata(record));
          }
        };
      }
      entry.continue();
    };
  });
export const detachCloudFile = (owner, path) =>
  updateCloudDrafts(owner, path, { path: null });
export const renameCloudFile = (owner, path, renamed, name) =>
  updateCloudDrafts(owner, path, { path: renamed, name });
// A draft written when its revision was the one saved in Puter has nothing
// left to recover. Those are removed, all but `keep`, the open presentation's.
export const pruneSavedDrafts = (owner, keep = null) =>
  transact("readwrite", (s, summaries) => {
    const cursor = summaries.index("owner").openCursor(owner);
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const { id, cloudSaved, path } = entry.value;
      if (cloudSaved && path && id !== keep) {
        summaries.delete(id);
        s.delete(id);
      }
      entry.continue();
    };
  });
export async function listDrafts(owner) {
  return (
    await transact("readonly", (s, summaries) =>
      summaries.index("owner").getAll(owner),
    )
  )
    .filter((d) => !d.cloudSaved)
    .sort((a, b) => b.updated - a.updated);
}
