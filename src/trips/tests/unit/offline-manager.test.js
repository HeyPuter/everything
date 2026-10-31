// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createOfflineManager } from '../../src/lib/offline/manager.js';
import { replicaKey } from '../../src/lib/offline/warm.js';
import { fileCacheName } from '../../src/lib/offline/files.js';
import { createTiles } from '../../src/services/tiles.js';
import { DEFAULT_CONFIG } from '../../src/services/core.js';
import { createCaches, createMemoryDb } from './helpers/fake-caches.js';

const TEMPLATE = 'https://tiles.openfreemap.org/planet/20261020_001001_pt/{z}/{x}/{y}.pbf';
const kept = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
const old = { w: 'trips-abcdefghij', s: '0000000000000002', k: 'trip' };
const sha = 'a'.repeat(64);

function tileProvider() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const { pathname } = new URL(url);
    if (pathname.startsWith('/styles/')) {
      return new Response(JSON.stringify({ version: 8, sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } }, layers: [] }));
    }
    if (pathname === '/planet') return new Response(JSON.stringify({ tiles: [TEMPLATE], maxzoom: 14 }));
    return new Response(new Uint8Array(10));
  };
  return { fetch, calls };
}

async function setup({ online = true } = {}) {
  const db = createMemoryDb();
  const caches = createCaches();
  await db.put(replicaKey(kept), { rev: 3, pending: [], conflicts: [], batch: null, confirmed: {
    'meta:meta': { id: 'meta', title: 'Lyon', start: '2099-05-01', end: '2099-05-04' },
    'place:p': { id: 'p', name: 'Museum', lat: 45.76, lng: 4.83 },
    'file:f': { id: '0000000000000003', name: 'ticket.pdf', mime: 'application/pdf', size: 10, sha256: sha, kind: 'user' },
    'file:g': { id: '0000000000000004', name: 'photo.jpg', mime: 'image/jpeg', size: 10, sha256: sha, kind: 'user' },
  } });
  await db.put(replicaKey(old), { rev: 5, pending: [], conflicts: [], batch: null, confirmed: { 'meta:meta': { id: 'meta', title: 'Rome', start: '2020-01-01', end: '2020-01-05' } } });
  await db.put('offline:index', { v: 1, tiles: true, modes: {}, map: null, trips: { [`${old.w}:${old.s}`]: { files: { count: 1, bytes: 5 }, warmAt: 1 } } });
  const personal = {
    spaces: { list: async () => [{ ref: kept, role: 'owner', title: 'Lyon' }, { ref: old, role: 'editor', title: 'Rome' }] },
    flush: vi.fn(async () => ({ sent: true })), failedWrites: async () => [], subscribe: () => () => {},
  };
  const api = { call: vi.fn(async (_ref, op) => (op === 'sync' ? { rev: 3, changes: [] } : {})), commit: vi.fn(), snapshot: vi.fn() };
  const download = vi.fn(async (_ref, file) => new Blob([new Uint8Array(file.size)]));
  const provider = tileProvider();
  const target = new EventTarget();
  target.navigator = { onLine: online };
  target.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  target.Event = Event;
  const manager = createOfflineManager({ db, personal, api, account: '00000000-0000-4000-8000-000000000001', download, caches, fetch: provider.fetch,
    services: { tiles: async () => createTiles(DEFAULT_CONFIG) }, window: target });
  return { db, caches, manager, api, download, provider };
}

describe('offline downloads', () => {
  it('keeps upcoming trips with their data, documents and map, and evicts long-ended trips', async () => {
    const { db, caches, manager, api, download, provider } = await setup();
    const map = await caches.open('trips-map-v1');
    const stray = 'https://tiles.openfreemap.org/planet/20261020_001001_pt/14/0/0.pbf';
    await map.put(stray, new Response('x'));
    await manager.run();
    expect(api.call).toHaveBeenCalledWith(kept, 'sync', { since: 3 });
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1].name).toBe('ticket.pdf');
    const files = await caches.open(fileCacheName('00000000-0000-4000-8000-000000000001'));
    expect(await files.keys()).toHaveLength(1);
    const index = await db.get('offline:index');
    const trip = index.trips[`${kept.w}:${kept.s}`];
    expect(trip.files).toEqual({ count: 1, bytes: 10, failed: 0 });
    expect(trip.tiles.count).toBeGreaterThan(15);
    expect(trip.tiles.template).toBe(TEMPLATE);
    expect(index.map.template).toBe(TEMPLATE);
    expect(provider.calls.some((url) => url.includes('openstreetmap.org/') && !url.includes('openfreemap'))).toBe(false);
    expect(await map.match('https://tiles.openfreemap.org/planet')).toBeTruthy();
    expect(await map.match(stray)).toBeUndefined();
    expect(await db.get(replicaKey(old))).toBeUndefined();
    expect(index.trips[`${old.w}:${old.s}`]).toBeUndefined();
    expect(manager.snapshot().results[`${old.w}:${old.s}`]).toEqual({ state: 'evicted' });
  });

  it('pins an ended trip, skips downloads offline and lists trips with their state', async () => {
    const { db, manager, api } = await setup({ online: false });
    await manager.setMode(old, 'on');
    expect(await manager.run()).toEqual({ skipped: 'offline' });
    expect(api.call).not.toHaveBeenCalled();
    const trips = await manager.listTrips();
    expect(trips.map((trip) => [trip.title, trip.keep, trip.mode, trip.auto])).toEqual([['Lyon', true, 'auto', true], ['Rome', true, 'on', false]]);
    expect(await db.get(replicaKey(old))).toBeTruthy();
  });

  it('merges requests made during a run and clears caches without touching trip data', async () => {
    const { db, caches, manager } = await setup();
    const first = manager.run();
    const second = manager.download(kept);
    expect(manager.snapshot().running).toBe(true);
    await Promise.all([first, second]);
    await manager.clearCache();
    expect(await caches.has('trips-map-v1')).toBe(false);
    expect((await db.get('offline:index')).trips[`${kept.w}:${kept.s}`].tiles).toBeUndefined();
    expect(await db.get(replicaKey(kept))).toBeTruthy();
  });
});
