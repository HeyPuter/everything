import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOffline, OfflineWriteError, isOfflineError, isBlocked } from '../src/js/offline.js';
import { createOfflineKv, clearSnapshot } from '../src/js/offline-store.js';
import { createPagedKv } from '../src/js/paged-kv.js';
import { createStore } from '../src/js/store.js';

const DATA_MUTATORS = [
  'saveEvent',
  'deleteEvent',
  'importEvents',
  'updateOccurrence',
  'deleteOccurrence',
  'updateSeries',
  'updateFuture',
  'deleteFuture',
  'applyOutOfOffice',
  'setDeclined',
  'rsvpEvent',
  'applyRsvpResponses',
  'saveTask',
  'toggleTask',
  'deleteTask',
];

const READS = [
  'getAllEvents',
  'getEvent',
  'getEventsInRange',
  'getAllTasks',
  'getTask',
  'getTasksInRange',
  'getSettings',
  'revision',
];

function makeStore() {
  const store = { subscribe: vi.fn(() => () => {}) };
  for (const m of READS) store[m] = vi.fn(() => `read:${m}`);
  for (const m of DATA_MUTATORS) store[m] = vi.fn(async () => `wrote:${m}`);
  store.load = vi.fn(async () => ({}));
  store.saveSettings = vi.fn(async () => ({ ok: true }));
  return store;
}

describe('write-gate (offline.js)', () => {
  let offline;
  let toast;

  beforeEach(() => {
    toast = vi.fn();
    offline = createOffline({ toast, onReconnectRefresh: vi.fn(async () => true) });
  });

  afterEach(() => {
    offline.start({ online: true }); // reset shared module state
    offline.stop();
  });

  it('blocks every data mutator when offline without ever calling the store', async () => {
    const store = makeStore();
    const gated = offline.gate(store);
    offline.start({ online: false });
    expect(isBlocked()).toBe(true);

    for (const m of DATA_MUTATORS) {
      await expect(gated[m]({ any: 'arg' })).rejects.toBeInstanceOf(OfflineWriteError);
      expect(store[m]).not.toHaveBeenCalled(); // no in-memory mutation, no KV write
    }
    expect(toast).toHaveBeenCalled(); // the user was told (throttled to >=1)
  });

  it('classifies every method of the REAL store, so a new mutator cannot slip past the gate', () => {
    // Regression: rsvpEvent was added to the store but not to the gate's
    // mutator set, so an offline RSVP mutated memory before the KV write
    // failed. This enumerates the actual store surface — adding a method
    // without deciding whether the gate must block it fails here first.
    const kvStub = { get: async () => null, set: async () => {}, del: async () => {}, list: async () => [] };
    const real = createStore(kvStub);
    const known = new Set([...DATA_MUTATORS, ...READS, 'load', 'subscribe', 'saveSettings']);
    for (const key of Object.keys(real)) {
      expect(known.has(key), `store.${key} is neither a known read nor a gated mutator`).toBe(true);
    }
  });

  it('passes reads and subscribe straight through, offline or online', () => {
    const store = makeStore();
    const gated = offline.gate(store);
    offline.start({ online: false });

    for (const m of READS) {
      expect(gated[m]()).toBe(`read:${m}`);
      expect(store[m]).toHaveBeenCalled();
    }
    gated.subscribe(() => {});
    expect(store.subscribe).toHaveBeenCalled();
  });

  it('delegates data mutators to the store when online', async () => {
    const store = makeStore();
    const gated = offline.gate(store);
    offline.start({ online: true });

    await expect(gated.saveEvent({})).resolves.toBe('wrote:saveEvent');
    expect(store.saveEvent).toHaveBeenCalledOnce();
  });

  it('always applies saveSettings locally and never rejects, even offline', async () => {
    const store = makeStore();
    store.saveSettings = vi.fn(async () => {
      throw new Error('network'); // simulate offline persist failure
    });
    const gated = offline.gate(store);
    offline.start({ online: false });

    await expect(gated.saveSettings({ theme: 'dark' })).resolves.toBeUndefined();
    expect(store.saveSettings).toHaveBeenCalledOnce(); // preference applied in memory
  });

  it('defers the reconnect refresh while a context menu is open', async () => {
    // Regression: isBusy() only knew about modal/dialog scrims, so a background
    // reconnect re-rendered (render() closes the context menu unconditionally)
    // and yanked an open menu out from under the user's pointer.
    const refresh = vi.fn(async () => true);
    const off = createOffline({ toast: vi.fn(), onReconnectRefresh: refresh });
    off.start({ online: false });

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    document.body.append(menu);
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled(); // busy: menu open

    menu.remove();
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1); // idle again: refresh proceeds

    off.start({ online: true });
    off.stop();
  });

  it('isOfflineError only matches OfflineWriteError', () => {
    expect(isOfflineError(new OfflineWriteError())).toBe(true);
    expect(isOfflineError(new Error('other'))).toBe(false);
    expect(isOfflineError(null)).toBe(false);
  });
});

describe('snapshot KV (offline-store.js)', () => {
  function makeKv() {
    const backing = new Map();
    const kv = {
      offline: false,
      list: vi.fn(async (pattern) => {
        if (kv.offline) throw new Error('net');
        const prefix = String(pattern).replace(/\*$/, '');
        return [...backing.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
      }),
      get: vi.fn(async (key) => {
        if (kv.offline) throw new Error('net');
        return backing.has(key) ? backing.get(key) : null;
      }),
      set: vi.fn(async (key, value) => {
        if (kv.offline) throw new Error('net');
        // Mirrors puter.kv.set's two forms: (key, value) or a batch array.
        const items = Array.isArray(key) ? key : [{ key, value }];
        for (const it of items) backing.set(it.key, it.value);
        return true;
      }),
      del: vi.fn(async (key) => {
        if (kv.offline) throw new Error('net');
        backing.delete(key);
        return true;
      }),
    };
    return { kv, backing };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('caches a successful list and serves it back when offline', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    backing.set('cal:evt:b', { id: 'b' });
    const okv = createOfflineKv(kv);

    const online = await okv.list('cal:evt:*', true);
    expect(online).toHaveLength(2);
    expect(okv.wasOffline()).toBe(false);
    expect(okv.hasSnapshot()).toBe(true);

    kv.offline = true;
    const offline = await okv.list('cal:evt:*', true);
    expect(offline.map((e) => e.key).sort()).toEqual(['cal:evt:a', 'cal:evt:b']);
    expect(okv.wasOffline()).toBe(true);
  });

  it('replaces (not merges) a prefix namespace so deletions do not resurrect', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    backing.set('cal:evt:b', { id: 'b' });
    const okv = createOfflineKv(kv);
    await okv.list('cal:evt:*', true); // cache both

    backing.delete('cal:evt:b'); // deleted elsewhere
    await okv.list('cal:evt:*', true); // fresh list has only 'a'

    kv.offline = true;
    const offline = await okv.list('cal:evt:*', true);
    expect(offline.map((e) => e.key)).toEqual(['cal:evt:a']); // 'b' is gone, not cached
  });

  it('a possibly-truncated list merges into the snapshot instead of replacing it', async () => {
    // puter.kv silently truncates big flat lists; store.js shards them, but
    // the FLAT (cut) result reaches this wrapper first. Replacing the
    // namespace with it would poison the last good snapshot with a partial
    // calendar — permanently, if the shard fan-out then fails or the tab
    // closes. 600 entries trips the same suspicion heuristic store.js uses.
    const { kv, backing } = makeKv();
    for (let i = 0; i < 600; i++) backing.set(`cal:evt:${i}`, { id: String(i) });
    const okv = createOfflineKv(kv);
    await okv.list('cal:evt:*', true); // full snapshot of all 600

    // The next flat list comes back cut in half (still >= the suspect count).
    const real = kv.list.getMockImplementation();
    kv.list.mockImplementation(async (pattern) => (await real(pattern)).slice(0, 500));
    await okv.list('cal:evt:*', true);

    kv.offline = true;
    const offline = await okv.list('cal:evt:*', true);
    expect(offline).toHaveLength(600); // the snapshot kept its complete copy
  });

  it('a big list the backend read to the end replaces, so deletions do not linger', async () => {
    const { kv, backing } = makeKv();
    for (let i = 0; i < 600; i++) backing.set(`cal:evt:${i}`, { id: String(i) });
    // The app's wiring: a backend that pages, read to its last page.
    const paged = createPagedKv({
      list: async ({ pattern, returnValues }) => ({ items: await kv.list(pattern, returnValues) }),
    });
    const okv = createOfflineKv({ ...kv, list: paged.list });
    await okv.list('cal:evt:*', true);

    backing.delete('cal:evt:7'); // deleted on another device
    await okv.list('cal:evt:*', true);

    kv.offline = true;
    const offline = await okv.list('cal:evt:*', true);
    expect(offline).toHaveLength(599);
    expect(offline.some((e) => e.key === 'cal:evt:7')).toBe(false);
  });

  it('a small (trusted) list still replaces, so deletions do not linger', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    backing.set('cal:evt:b', { id: 'b' });
    const okv = createOfflineKv(kv);
    await okv.list('cal:evt:*', true);

    backing.delete('cal:evt:b');
    await okv.list('cal:evt:*', true); // trusted-size result → replace

    kv.offline = true;
    const offline = await okv.list('cal:evt:*', true);
    expect(offline.map((e) => e.key)).toEqual(['cal:evt:a']);
  });

  it('caches get on success and serves it offline', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:settings', { theme: 'dark' });
    const okv = createOfflineKv(kv);

    expect(await okv.get('cal:settings')).toEqual({ theme: 'dark' });
    kv.offline = true;
    expect(await okv.get('cal:settings')).toEqual({ theme: 'dark' });
  });

  it('never lets a snapshot-write failure reject a successful cloud set', async () => {
    const { kv } = makeKv();
    const okv = createOfflineKv(kv);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    await expect(okv.set('cal:evt:x', { id: 'x' })).resolves.toBe(true);
    expect(kv.set).toHaveBeenCalledOnce(); // the cloud write went through
  });

  it('keeps the snapshot in step with a batch set (array form)', async () => {
    const { kv, backing } = makeKv();
    const okv = createOfflineKv(kv);
    await okv.set([
      { key: 'cal:evt:a', value: { id: 'a' } },
      { key: 'cal:evt:b', value: { id: 'b' } },
    ]);
    expect(kv.set).toHaveBeenCalledOnce(); // forwarded as ONE cloud request
    expect(backing.get('cal:evt:b')).toEqual({ id: 'b' });

    kv.offline = true;
    const offline = await okv.list('cal:evt:*', true);
    expect(offline.map((e) => e.key).sort()).toEqual(['cal:evt:a', 'cal:evt:b']);
  });

  it('keeps the snapshot in step with set and del', async () => {
    const { kv } = makeKv();
    const okv = createOfflineKv(kv);
    await okv.set('cal:evt:x', { id: 'x' });

    kv.offline = true;
    expect((await okv.list('cal:evt:*', true)).map((e) => e.key)).toEqual(['cal:evt:x']);

    kv.offline = false;
    await okv.del('cal:evt:x');
    kv.offline = true;
    expect(await okv.list('cal:evt:*', true)).toEqual([]);
  });

  it('drops a snapshot belonging to a different user (account switch)', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    const okv = createOfflineKv(kv);
    okv.ensureUser('user-1');
    await okv.list('cal:evt:*', true);
    expect(okv.hasSnapshot()).toBe(true);

    okv.ensureUser('user-2'); // different account
    expect(okv.hasSnapshot()).toBe(false);
  });

  it('reports no snapshot before any sync and clears on demand', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    const okv = createOfflineKv(kv);
    expect(okv.hasSnapshot()).toBe(false);

    await okv.list('cal:evt:*', true);
    expect(okv.hasSnapshot()).toBe(true);

    clearSnapshot();
    expect(okv.hasSnapshot()).toBe(false);
  });

  it('throws (rather than faking data) when offline with no snapshot', async () => {
    const { kv } = makeKv();
    kv.offline = true;
    const okv = createOfflineKv(kv);
    await expect(okv.list('cal:evt:*', true)).rejects.toThrow();
  });

  it('wasOffline() is sticky: any fallback read wins even if a later read succeeds', async () => {
    // Guards against the concurrent-boot-reads bug where the last-resolving read
    // (a success) would mask an earlier read that fell back to the snapshot.
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    const okv = createOfflineKv(kv);
    await okv.list('cal:evt:*', true); // seed snapshot online
    okv.resetReachable();
    kv.offline = true;
    await okv.list('cal:evt:*', true); // one read falls back → sticky offline
    kv.offline = false;
    await okv.get('cal:settings'); // a later read succeeds — must NOT clear it
    expect(okv.wasOffline()).toBe(true);
  });

  it('resetReachable() clears prior offline state when the next load fully succeeds', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    const okv = createOfflineKv(kv);
    await okv.list('cal:evt:*', true);
    kv.offline = true;
    await okv.list('cal:evt:*', true);
    expect(okv.wasOffline()).toBe(true);
    kv.offline = false;
    okv.resetReachable();
    await okv.list('cal:evt:*', true);
    expect(okv.wasOffline()).toBe(false);
  });

  it('never overwrites a known snapshot userId with null', async () => {
    const { kv, backing } = makeKv();
    backing.set('cal:evt:a', { id: 'a' });
    const okv = createOfflineKv(kv);
    okv.ensureUser('user-1');
    await okv.list('cal:evt:*', true); // stamps userId 'user-1'
    okv.ensureUser(null); // unknown user (e.g. getUser returned no id); no clear
    await okv.set('cal:evt:b', { id: 'b' }); // must keep the known userId
    expect(JSON.parse(localStorage.getItem('cal:snapshot')).userId).toBe('user-1');
  });
});
