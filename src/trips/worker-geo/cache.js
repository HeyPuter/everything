import { stable } from '../src/services/core.js';

// Larger answers are served but not stored: each stored byte is a KV write billed to the app operator.
export const MAX_ENTRY_BYTES = 64_000;
export async function cacheKey(provider, identity) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(identity))));
  return `geo:${provider}:${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export function createLru(limit = 128) {
  const items = new Map();
  return {
    get(key) { if (!items.has(key)) return undefined; const value = items.get(key); items.delete(key); items.set(key, value); return value; },
    set(key, value) { items.delete(key); items.set(key, value); while (items.size > limit) items.delete(items.keys().next().value); },
    delete(key) { items.delete(key); },
    get size() { return items.size; },
  };
}
/** Isolate LRU in front of KV; only successful responses are stored, each capped at 64 KB. */
export function createGeoCache({ kv, now = Date.now, memoryEntries = 128, maxBytes = MAX_ENTRY_BYTES }) {
  const memory = createLru(memoryEntries);
  const peek = key => {
    const warm = memory.get(key);
    if (warm) { if (warm.expires > now()) return { data: warm.data, layer: 'memory' }; memory.delete(key); }
    return null;
  };
  return {
    memory, peek,
    async get(key) {
      const warm = peek(key); if (warm) return warm;
      let saved;
      try { saved = await kv.get(key); } catch { return null; }
      if (!saved || typeof saved !== 'object' || saved.data === undefined || !(saved.expires > now())) return null;
      memory.set(key, saved);
      return { data: saved.data, layer: 'kv' };
    },
    async set(key, data, ttlSeconds) {
      const entry = { data, expires: now() + ttlSeconds * 1000 };
      if (new TextEncoder().encode(JSON.stringify(entry)).length > maxBytes) return false;
      memory.set(key, entry);
      try { await kv.set(key, entry, Math.floor(entry.expires / 1000)); return true; } catch { return false; }
    },
  };
}
