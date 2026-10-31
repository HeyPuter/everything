/** Insertion-ordered map that evicts the oldest entry past `max` entries or `maxBytes`. Values are settled data, never promises. */
export function createCache({ max = 1000, maxBytes = Infinity, size = () => 0 } = {}) {
  const map = new Map();
  let bytes = 0;
  const drop = (key) => {
    if (!map.has(key)) return;
    bytes -= size(map.get(key));
    map.delete(key);
  };
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      drop(key);
      const weight = size(value);
      if (weight > maxBytes) return value;
      map.set(key, value);
      bytes += weight;
      while (map.size > max || bytes > maxBytes) drop(map.keys().next().value);
      return value;
    },
    delete: drop,
    clear() { map.clear(); bytes = 0; },
    get size() { return map.size; },
    keys: () => map.keys(),
  };
}

/** Fixed-window counters held in isolate memory. Cheap, approximate across isolates. */
export function createLimiter({ now, max = 10_000 }) {
  const windows = createCache({ max });
  return {
    take(key, limit, windowMs, weight = 1) {
      const window = Math.floor(now() / windowMs);
      const id = `${key}|${window}`;
      const count = (windows.get(id) ?? 0) + weight;
      windows.set(id, count);
      return count <= limit;
    },
    /** True while `key` is still under `limit`, without counting this call. */
    check(key, limit, windowMs) {
      return (windows.get(`${key}|${Math.floor(now() / windowMs)}`) ?? 0) < limit;
    },
  };
}
