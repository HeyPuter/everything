// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { autoKeep, decide, ended, localToday } from '../../src/lib/offline/policy.js';
import { evictReplica, readReplica, replicaKey } from '../../src/lib/offline/warm.js';
import { createMemoryDb } from './helpers/fake-caches.js';

const today = '2026-10-24';
const NOW = Date.UTC(2026, 9, 24, 12);

describe('which trips stay on the device', () => {
  it.each([
    [{ start: '2026-11-01', end: '2026-11-10' }, true, false],
    [{ start: '2026-10-20', end: '2026-10-28' }, true, false],
    [{ start: '2026-10-10', end: '2026-10-17' }, true, false],
    [{ start: '2026-10-01', end: '2026-10-16' }, false, true],
    [{ start: '2026-10-16' }, false, true],
    [{ start: '2026-10-17' }, true, false],
    [{ end: '2026-12-01' }, true, false],
    [{}, false, false],
    [{ start: null, end: 'not-a-date' }, false, false],
  ])('%j → kept %s, ended %s', (dates, kept, old) => {
    expect(autoKeep(dates, today)).toBe(kept);
    expect(ended(dates, today)).toBe(old);
  });

  it('pins and opt-outs override the dates; only long-ended trips lose their replica', () => {
    const old = { start: '2026-09-01', end: '2026-09-05' };
    const soon = { start: '2026-11-01', end: '2026-11-03' };
    expect(decide({ dates: old, mode: 'auto' }, { today, now: NOW })).toEqual({ keep: false, evictFiles: true, evictReplica: true });
    expect(decide({ dates: old, mode: 'on' }, { today, now: NOW })).toEqual({ keep: true, evictFiles: false, evictReplica: false });
    expect(decide({ dates: soon, mode: 'off' }, { today, now: NOW })).toEqual({ keep: false, evictFiles: true, evictReplica: false });
    expect(decide({ dates: {}, mode: 'auto' }, { today, now: NOW })).toEqual({ keep: false, evictFiles: true, evictReplica: false });
    expect(decide({ dates: old, mode: 'auto', opened: NOW - 60_000 }, { today, now: NOW }).evictReplica).toBe(false);
  });

  it('reads today in the device time zone', () => {
    expect(localToday(new Date(2026, 0, 2, 23, 30).getTime())).toBe('2026-01-02');
  });
});

describe('replica eviction', () => {
  const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
  it('keeps replicas with unsent writes, a frozen batch or conflicts', async () => {
    const db = createMemoryDb();
    for (const state of [{ pending: [{}] }, { batch: { id: 'b' } }, { conflicts: [{}] }]) {
      await db.put(replicaKey(ref), { rev: 3, confirmed: {}, pending: [], conflicts: [], batch: null, ...state });
      expect(await evictReplica({ ref, db })).toBe(false);
      expect(await db.get(replicaKey(ref))).toBeTruthy();
    }
  });
  it('removes an idle replica and its feed', async () => {
    const db = createMemoryDb();
    await db.put(replicaKey(ref), { rev: 3, confirmed: {}, pending: [], conflicts: [], batch: null });
    await db.put(`feed:${ref.w}:${ref.s}`, [{ rev: 1 }]);
    expect(await evictReplica({ ref, db })).toBe(true);
    expect(db.records.size).toBe(0);
  });
  it('summarizes a replica without building the store', async () => {
    const db = createMemoryDb();
    await db.put(replicaKey(ref), { rev: 9, pending: [{}, {}], conflicts: [{ op: { opId: 'x' } }], batch: null, confirmed: {
      'meta:meta': { id: 'meta', title: 'Lyon', start: '2026-11-01' },
      'place:a': { id: 'a', name: 'A', lat: 45.76, lng: 4.83 },
      'place:b': { id: 'b', name: 'B', deleted: true },
      'res:c': { id: 'c', status: 'confirmed', location: { lat: 45.7, lng: 4.8 }, legs: [{ from: { lat: 48.8, lng: 2.3 }, to: { lat: 45.7, lng: 5.1 } }] },
      'file:d': { id: 'd', name: 'ticket.pdf' },
    } });
    const summary = await readReplica({ ref, db, size: true });
    expect(summary).toMatchObject({ loaded: true, rev: 9, pending: 2, meta: { title: 'Lyon' } });
    expect(summary.conflicts).toHaveLength(1);
    expect(summary.files.map((file) => file.id)).toEqual(['d']);
    expect(summary.points.overview).toEqual([[4.83, 45.76], [4.8, 45.7]]);
    expect(summary.points.detail).toHaveLength(4);
    expect(summary.bytes).toBeGreaterThan(100);
    expect(await readReplica({ ref: { ...ref, s: '0000000000000002' }, db })).toMatchObject({ loaded: false, rev: 0, pending: 0 });
  });
});
