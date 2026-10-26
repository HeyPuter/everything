// @vitest-environment node
// Security review L9: anonymous callers can't drive the geo worker's KV spend.
import { describe, expect, it, vi } from 'vitest';
import { createGeoHandler, createKvLimiter } from '../../worker-geo/handler.js';
import { createGeoCache } from '../../worker-geo/cache.js';
import { sanitizeRemoteConfig } from '../../worker-geo/remote.js';

const base = 'https://trips-geo.puter.work';
function memoryKv() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async (key) => structuredClone(store.get(key) ?? null)),
    set: vi.fn(async (key, value) => { store.set(key, structuredClone(value)); return true; }),
    incr: vi.fn(async (key) => { const n = (store.get(key) ?? 0) + 1; store.set(key, n); return n; }),
    expire: vi.fn(async () => true),
  };
}

describe('geo worker abuse limits (L9)', () => {
  it('limits each caller address before any KV read', async () => {
    const kv = memoryKv();
    const handle = createGeoHandler({
      kv, fetch: async () => Response.json([]), limiter: async () => ({ ok: true }), remoteConfig: async () => sanitizeRemoteConfig({ regions: 1 }),
      enabled: ['nominatim'], maxRequestsPerSecond: 1000, now: () => 5_000,
    });
    const from = (address, q) => handle(new Request(`${base}/nominatim/search?q=${q}`, { headers: { 'cf-connecting-ip': address } }));
    for (let i = 0; i < 30; i++) expect((await from('203.0.113.9', `place${i}`)).status).toBe(200);
    const reads = kv.get.mock.calls.length;
    expect((await from('203.0.113.9', 'one-more')).status).toBe(429);
    expect(kv.get.mock.calls.length).toBe(reads);
    expect((await from('198.51.100.7', 'other')).status).toBe(200);
  });

  it('stops counting in a limiter window once it is full', async () => {
    const kv = memoryKv();
    const limit = createKvLimiter(kv, { now: () => 7_000, maxWait: 0 });
    expect((await limit('nominatim', { regions: 1, limit: 1 })).ok).toBe(true);
    expect((await limit('nominatim', { regions: 1, limit: 1 })).ok).toBe(false);
    const writes = kv.incr.mock.calls.length;
    for (let i = 0; i < 5; i++) expect((await limit('nominatim', { regions: 1, limit: 1 })).ok).toBe(false);
    expect(kv.incr.mock.calls.length).toBe(writes);
  });

  it('stores no answer over 64 KB', async () => {
    const kv = memoryKv();
    const cache = createGeoCache({ kv, now: () => 0 });
    expect(await cache.set('k', { data: 'x'.repeat(70_000) }, 60)).toBe(false);
    expect(kv.set).not.toHaveBeenCalled();
    expect(await cache.set('k', { data: 'x'.repeat(1000) }, 60)).toBe(true);
  });
});
