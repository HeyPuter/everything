/** Object URLs for downloaded blobs, least recently used first out, bounded by bytes. */
export function createUrlCache({ maxBytes, urls } = {}) {
  const api = () => urls ?? globalThis.URL;
  const entries = new Map();
  let bytes = 0;
  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.size;
    api().revokeObjectURL(entry.url);
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.url;
    },
    set(key, blob) {
      drop(key);
      const entry = { url: api().createObjectURL(blob), size: blob.size };
      entries.set(key, entry);
      bytes += entry.size;
      for (const oldest of entries.keys()) {
        if (bytes <= maxBytes || oldest === key) break;
        drop(oldest);
      }
      return entry.url;
    },
    /** Drops every entry whose key starts with `prefix` (all entries without one). */
    clear(prefix = '') { for (const key of [...entries.keys()]) if (key.startsWith(prefix)) drop(key); },
    get bytes() { return bytes; },
  };
}
