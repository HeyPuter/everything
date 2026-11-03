// In-memory Cache Storage for offline tests. Requests may be URLs, Request objects or `{url}` stand-ins.
const urlOf = (input) => new URL(typeof input === 'string' ? input : input.url).href;
const withoutSearch = (url) => { const value = new URL(url); value.search = ''; return value.href; };

function createCache(fetcher) {
  const items = new Map();
  const find = (input, options = {}) => {
    const url = urlOf(input);
    if (!options.ignoreSearch) return items.get(url);
    for (const [key, response] of items) if (withoutSearch(key) === withoutSearch(url)) return response;
    return undefined;
  };
  return {
    items,
    async match(input, options) { const hit = find(input, options); return hit ? hit.clone() : undefined; },
    async put(input, response) { items.set(urlOf(input), response.clone()); },
    async addAll(requests) {
      const loaded = [];
      for (const request of requests) {
        const response = await fetcher(request);
        if (!response.ok) throw new TypeError('addAll failed');
        loaded.push([urlOf(request), response]);
      }
      for (const [url, response] of loaded) items.set(url, response);
    },
    async delete(input) { return items.delete(urlOf(input)); },
    async keys() { return [...items.keys()].map((url) => ({ url })); },
  };
}

export function createCaches({ fetch: fetcher = async () => new Response('') } = {}) {
  const stores = new Map();
  return {
    stores,
    async open(name) { if (!stores.has(name)) stores.set(name, createCache(fetcher)); return stores.get(name); },
    async keys() { return [...stores.keys()]; },
    async has(name) { return stores.has(name); },
    async delete(name) { return stores.delete(name); },
    async match(input, options) {
      for (const cache of stores.values()) { const hit = await cache.match(input, options); if (hit) return hit; }
      return undefined;
    },
  };
}

/** A minimal account database with the `openDatabase` surface. */
export function createMemoryDb(account = '00000000-0000-4000-8000-000000000001') {
  const records = new Map();
  return {
    account, records,
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { records.set(key, structuredClone(value)); },
    async remove(key) { records.delete(key); },
    async update(key, change) {
      const value = change(structuredClone(records.get(key)));
      if (value === undefined) records.delete(key); else records.set(key, structuredClone(value));
      return value;
    },
    close() {},
  };
}
