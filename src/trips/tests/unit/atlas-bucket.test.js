// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BUCKET_INDEX, BUCKET_LIMITS, bucketEntries, createBucketStore, sortBucket, validateBucketItem } from '../../src/lib/atlas/bucket.js';
import { aggregateAtlas } from '../../src/lib/atlas/aggregate.js';
import { newId } from '../../src/shared/ids.js';

const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };

describe('bucket-list items', () => {
  it('normalizes a place or a country', () => {
    expect(validateBucketItem({ name: '  Machu\nPicchu ', lat: -13.16314159, lng: -72.545, cc: 'pe', notes: ' Go early.\r\nBook ahead. ', target: '2027-05-01' }))
      .toEqual({ name: 'Machu Picchu', cc: 'PE', lat: -13.163142, lng: -72.545, notes: 'Go early.\nBook ahead.', target: '2027-05-01' });
    expect(validateBucketItem({ cc: 'JP', visitedAt: '2026-04-02' })).toEqual({ name: '', cc: 'JP', visitedAt: '2026-04-02' });
    expect(validateBucketItem({ name: 'Réunion', cc: 'RE' }).cc).toBe('FR');
    expect(validateBucketItem({ name: 'x'.repeat(500), notes: 'y'.repeat(5000) })).toMatchObject({ name: 'x'.repeat(BUCKET_LIMITS.name), notes: 'y'.repeat(BUCKET_LIMITS.notes) });
  });

  it('rejects incomplete or invalid items', () => {
    expect(code(() => validateBucketItem({ name: '   ' }))).toBe('bucket_name_required');
    expect(code(() => validateBucketItem({ name: 'x', cc: 'ZZ' }))).toBe('invalid_bucket');
    expect(code(() => validateBucketItem({ name: 'x', lat: 10 }))).toBe('invalid_bucket');
    expect(code(() => validateBucketItem({ name: 'x', lat: 91, lng: 0 }))).toBe('invalid_bucket');
    expect(code(() => validateBucketItem({ name: 'x', lat: '1', lng: '2' }))).toBe('invalid_bucket');
    expect(code(() => validateBucketItem({ name: 'x', target: '2027-13-01' }))).toBe('invalid_bucket');
    expect(code(() => validateBucketItem({ name: 'x', visitedAt: 'yesterday' }))).toBe('invalid_bucket');
    expect(code(() => validateBucketItem(null))).toBe('invalid_bucket');
  });

  it('reads index entries and sorts wishes before visited items', () => {
    const [a, b, c, d] = [newId(), newId(), newId(), newId()];
    const entries = bucketEntries({ [a]: { name: 'Zanzibar', upd: 1 }, [b]: { name: 'Alps', target: '2027-01-01', upd: 2 }, [c]: { name: 'Oslo', visitedAt: '2025-01-01' }, [d]: { name: 'Lima', visitedAt: '2026-01-01' }, nope: { name: 'x' }, [newId()]: { name: '' } });
    expect(entries).toHaveLength(4);
    expect(sortBucket(entries).map((entry) => entry.name)).toEqual(['Alps', 'Zanzibar', 'Lima', 'Oslo']);
    expect(bucketEntries(null)).toEqual([]);
  });
});

function fakeStore() {
  const kv = new Map();
  const puter = {
    authToken: 'token',
    kv: {
      update: vi.fn(async (key, patch) => { const value = { ...(kv.get(key) ?? {}) }; Object.assign(value, patch); kv.set(key, value); return value; }),
      remove: vi.fn(async (key, ...paths) => { const value = { ...(kv.get(key) ?? {}) }; for (const path of paths) delete value[path]; kv.set(key, value); return value; }),
      del: vi.fn(async (key) => { kv.delete(key); return true; }),
    },
  };
  const listeners = new Map();
  const personal = {
    get: vi.fn(async (key) => kv.get(key) ?? null),
    set: vi.fn(async (key, value) => { kv.set(key, value); return value; }),
    refresh: vi.fn(async (key) => { const value = kv.get(key) ?? null; for (const fn of listeners.get(key) ?? []) fn(value); return value; }),
    subscribe: (key, fn) => { listeners.set(key, new Set([...(listeners.get(key) ?? []), fn])); return () => listeners.get(key).delete(fn); },
  };
  return { kv, puter, personal };
}

describe('bucket store', () => {
  it('writes the item before its index entry and removes it first', async () => {
    const { kv, puter, personal } = fakeStore();
    const store = createBucketStore({ personal, puter, now: () => 1000 });
    const seen = [];
    store.subscribe((entries) => seen.push(entries.length));
    const id = await store.create({ name: 'Kyoto', cc: 'JP', notes: 'Temples' });
    expect(kv.get(`me:bucket:${id}`)).toEqual({ name: 'Kyoto', cc: 'JP', notes: 'Temples', upd: 1000 });
    expect(kv.get(BUCKET_INDEX)[id]).toEqual({ name: 'Kyoto', cc: 'JP', upd: 1000 });
    expect(personal.set.mock.invocationCallOrder[0]).toBeLessThan(puter.kv.update.mock.invocationCallOrder[0]);
    expect(await store.get(id)).toEqual({ id, name: 'Kyoto', cc: 'JP', notes: 'Temples', upd: 1000 });

    await store.setVisited(id, '2026-04-01');
    expect(kv.get(BUCKET_INDEX)[id]).toMatchObject({ visitedAt: '2026-04-01' });
    expect(kv.get(`me:bucket:${id}`)).toMatchObject({ notes: 'Temples', visitedAt: '2026-04-01' });
    await store.setVisited(id, null);
    expect(kv.get(BUCKET_INDEX)[id].visitedAt).toBeUndefined();

    await store.remove(id);
    expect(kv.has(`me:bucket:${id}`)).toBe(false);
    expect(kv.get(BUCKET_INDEX)).toEqual({});
    expect(puter.kv.del.mock.invocationCallOrder[0]).toBeLessThan(puter.kv.remove.mock.invocationCallOrder[0]);
    expect(seen.at(-1)).toBe(0);
  });

  it('deletes the item again when its index write fails, and refuses another account', async () => {
    const { kv, puter, personal } = fakeStore();
    const store = createBucketStore({ personal, puter });
    puter.kv.update.mockRejectedValueOnce(Object.assign(new Error('credit'), { status: 402 }));
    await expect(store.create({ name: 'Petra' })).rejects.toMatchObject({ status: 402 });
    expect([...kv.keys()].filter((key) => key.startsWith('me:bucket:'))).toEqual([]);
    puter.authToken = 'other';
    await expect(store.remove(newId())).rejects.toMatchObject({ code: 'account_changed' });
  });

  it('caps the list size', async () => {
    const { kv, puter, personal } = fakeStore();
    kv.set(BUCKET_INDEX, Object.fromEntries(Array.from({ length: BUCKET_LIMITS.items }, () => [newId(), { name: 'x' }])));
    await expect(createBucketStore({ personal, puter }).create({ name: 'One more' })).rejects.toMatchObject({ code: 'bucket_full' });
  });
});

describe('bucket list in the atlas', () => {
  it('counts visited items as visited countries and open ones as the wishlist', () => {
    const atlas = aggregateAtlas({
      today: '2026-10-24',
      trips: [{ key: 't', start: '2024-01-01', end: '2024-01-02', cached: true, places: [{ id: 'p', name: 'Oslo', cc: 'NO' }], res: [] }],
      marks: { hidden: { IS: true } },
      bucket: [
        { id: 'a', name: 'Kyoto', cc: 'JP', visitedAt: '2026-04-01', lat: 35.0, lng: 135.7 },
        { id: 'b', name: 'Geysir', cc: 'IS', visitedAt: '2025-06-01' },
        { id: 'c', name: 'Patagonia', cc: 'AR' },
        { id: 'd', name: 'Fjords', cc: 'NO' },
        { id: 'e', name: 'Somewhere', lat: 1, lng: 1 },
      ],
      locate: () => 'GH',
    });
    expect(atlas.visited).toEqual(['JP', 'IS', 'NO']);
    expect(atlas.countries.get('JP')).toMatchObject({ status: 'visited', bucket: true, manual: false, last: '2026-04-01' });
    expect(atlas.countries.get('JP').items[0]).toMatchObject({ kind: 'bucket', id: 'a', lat: 35.0, lng: 135.7 });
    expect(atlas.countries.get('IS').status).toBe('visited');
    expect(atlas.wishlist).toEqual(['AR', 'GH']);
  });
});
