import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/local-store';
import { liveInstances, RecoveryStore, relativeTime, VersionStore, type RecoveryRecord } from '../src/persistence/versions';

const meta = (docId: string, name: string, kind: 'auto' | 'save' | 'named', time: number) => ({ docId, docName: 'Doc', name, kind, width: 10, height: 10, time });

describe('version store', () => {
  it('stores projects and lists a document’s versions newest first', async () => {
    const s = new VersionStore(new MemoryStore());
    const a = await s.add(meta('d1', 'First', 'save', 1000), new Blob(['one']));
    await s.add(meta('d2', 'Other', 'save', 1500), new Blob(['x']));
    const b = await s.add(meta('d1', 'Second', 'named', 2000), new Blob(['two!']));
    const list = await s.list('d1');
    expect(list.map((v) => v.name)).toEqual(['Second', 'First']);
    expect(b.size).toBe(4);
    expect(await (await s.project(a.id))!.text()).toBe('one');
    expect((await s.listAll()).length).toBe(3);
  });
  it('prunes the oldest automatic versions beyond the limit and keeps named ones', async () => {
    const s = new VersionStore(new MemoryStore());
    await s.add(meta('d', 'Named', 'named', 1), new Blob(['n']), 2);
    for (let i = 0; i < 4; i++) await s.add(meta('d', `Auto ${i}`, 'auto', 10 + i), new Blob([String(i)]), 2);
    const list = await s.list('d');
    expect(list.map((v) => v.name)).toEqual(['Auto 3', 'Auto 2', 'Named']);
  });
  it('leaves nothing behind when browser storage cannot take a version', async () => {
    // Storage that is full: single writes of version entries fail, and a
    // write of several records stores all of them or none.
    class Full extends MemoryStore {
      async put<T>(store: 'versions' | 'blobs' | 'recovery' | 'thumbs', key: string, value: T) {
        if (store === 'versions') throw new DOMException('Storage is full', 'QuotaExceededError');
        return super.put(store, key, value);
      }
      async putAll(writes: { store: 'versions' | 'blobs' | 'recovery' | 'thumbs'; key: string; value: unknown }[]) {
        if (writes.some((w) => w.store === 'versions')) throw new DOMException('Storage is full', 'QuotaExceededError');
        return super.putAll(writes);
      }
    }
    for (const store of [new Full(), Object.assign(new Full(), { putAll: undefined })]) {
      const s = new VersionStore(store);
      await expect(s.add(meta('d', 'Big', 'auto', 1), new Blob(['project bytes']))).rejects.toThrow('Storage is full');
      expect(await store.keys('blobs')).toEqual([]);
      expect(await s.list('d')).toEqual([]);
    }
  });
  it('renames (making a version named) and removes versions with their projects', async () => {
    const store = new MemoryStore();
    const s = new VersionStore(store);
    const v = await s.add(meta('d', 'Autosave', 'auto', 5), new Blob(['p']));
    await s.rename(v.id, 'Keeper');
    expect((await s.get(v.id))!.kind).toBe('named');
    await s.remove(v.id);
    expect(await s.list('d')).toEqual([]);
    expect(await store.get('blobs', v.id)).toBeUndefined();
  });
});

describe('recovery store', () => {
  const record = (sessionId: string, instance: string, time: number): RecoveryRecord => ({ sessionId, instance, docId: 'doc', name: sessionId, time, project: new Blob([sessionId]) });
  it('offers only records of instances that stopped running', async () => {
    const s = new RecoveryStore(new MemoryStore());
    await s.save(record('a', 'live', 1));
    await s.save(record('b', 'gone', 2));
    await s.save(record('c', 'stale', 3));
    const now = 100_000;
    const beats = { live: now - 1000, stale: now - 120_000 };
    expect((await s.orphaned(beats, now)).map((r) => r.sessionId)).toEqual(['c', 'b']);
  });
  it('replaces a session’s record and removes it after save or close', async () => {
    const s = new RecoveryStore(new MemoryStore());
    await s.save(record('a', 'x', 1));
    await s.save({ ...record('a', 'x', 2), name: 'newer' });
    expect((await s.list()).map((r) => r.name)).toEqual(['newer']);
    await s.remove('a');
    expect(await s.list()).toEqual([]);
  });
  it('keeps live heartbeats only', () => {
    expect(liveInstances({ a: 1000, b: 50_000, c: 'x' as unknown as number }, 60_000, 30_000)).toEqual({ b: 50_000 });
  });
});

describe('relative times', () => {
  it('reads naturally', () => {
    const now = 10_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 hr ago');
    expect(relativeTime(now - 86_400_000, now)).toBe('1 day ago');
  });
});
