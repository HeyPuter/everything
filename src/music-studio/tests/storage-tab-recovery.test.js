import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import { serializeProject } from '../src/model/serialize.js';
import { install } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';
import { claimTab, STALE_MS } from '../src/storage/tabs.js';

let app;
const apps = [];
afterEach(() => {
  app?.autosave.stop();
  for (const instance of apps.splice(0)) instance.autosave.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([
  { hasOwn: false, failure: 'query' }, { hasOwn: true, failure: 'query' },
  { hasOwn: false, failure: 'recovery lock' }, { hasOwn: true, failure: 'recovery lock' },
])('preserves other tabs’ drafts after $failure failure (own draft: $hasOwn)', async ({ hasOwn, failure }) => {
  vi.useFakeTimers();
  vi.stubGlobal('puter', undefined);
  const db = memoryDB();
  const draft = (name, at = Date.now()) => ({ json: serializeProject(newProject(name), {}), dirty: true, at });
  const other = draft('Other open session');
  const old = draft('Long-running open session', Date.now() - STALE_MS - 1);
  await db.put('drafts', 'tab:other', other);
  await db.put('drafts', 'tab:old', old);
  if (hasOwn) await db.put('drafts', 'tab:own', draft('My session'));
  let claimed = false;
  const tab = await claimTab({
    session: { getItem: () => 'own', setItem() {} },
    locks: {
      request: (name, _options, callback) => {
        if (claimed && failure === 'recovery lock' && name === 'music-studio-recovery') return Promise.reject(new DOMException('Denied', 'SecurityError'));
        return callback({});
      },
      query: async () => {
        if (failure === 'query') throw new DOMException('Lock inspection unavailable', 'SecurityError');
        return { held: ['own', 'other', 'old'].map((id) => ({ name: `music-studio-tab-${id}` })) };
      },
    },
  });
  claimed = true;
  const root = document.createElement('div');
  document.body.append(root);
  app = new App(root, { storage: { getItem: () => null, setItem() {} } });
  app.prefs.set('launched', true);
  const initial = app.store.project;
  install(app, { db, tab });
  app.emit('started');
  await app.restored;
  expect(await db.get('drafts', 'tab:other')).toEqual(other);
  expect(await db.get('drafts', 'tab:old')).toEqual(old);
  expect(app.store.project.name).toBe(hasOwn ? 'My session' : initial.name);
  expect(app.autosave.offs.length).toBeGreaterThan(0);
  app.store.apply('Tempo', (p) => ({ ...p, bpm: 101 }));
  await app.autosave.flushDraft();
  expect(JSON.parse((await db.get('drafts', 'tab:own')).json).bpm).toBe(101);
});

// Models the Web Locks queue, including the lifetime locks held by claimTab.
function queuedLocks() {
  const held = new Set();
  const queues = new Map();
  return {
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
      const previous = queues.get(name) || Promise.resolve();
      const run = previous.then(async () => {
        held.add(name);
        try { return await callback({ name }); }
        finally { held.delete(name); }
      });
      queues.set(name, run.catch(() => {}));
      return run;
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
  };
}

it.each([1, 2])('recovers each abandoned session once when two tabs start together (%s drafts)', async (count) => {
  vi.useFakeTimers();
  vi.stubGlobal('puter', undefined);
  const db = memoryDB();
  for (let i = 0; i < count; i++) {
    await db.put('drafts', `tab:closed${i}`, { json: serializeProject(newProject(`Recovered ${i}`), {}), dirty: true, at: Date.now() - i });
  }
  const locks = queuedLocks();
  const tabs = await Promise.all(['a', 'b'].map((id) => claimTab({ locks, session: { getItem: () => id, setItem() {} } })));
  for (const tab of tabs) {
    const root = document.createElement('div');
    document.body.append(root);
    const instance = new App(root, { storage: { getItem: () => null, setItem() {} } });
    instance.prefs.set('launched', true);
    instance.notify = vi.fn();
    install(instance, { db, tab });
    apps.push(instance);
  }
  for (const instance of apps) instance.emit('started');
  await Promise.all(apps.map((instance) => instance.restored));
  const names = apps.map((instance) => instance.store.project.name).filter((name) => name.startsWith('Recovered'));
  expect(names.sort()).toEqual(Array.from({ length: count }, (_, i) => `Recovered ${i}`));
  for (let i = 0; i < count; i++) expect(await db.get('drafts', `tab:closed${i}`)).toBe(null);
  const recoveredCopies = (await db.all('drafts')).filter(([, draft]) => JSON.parse(draft.json).name.startsWith('Recovered'));
  expect(recoveredCopies).toHaveLength(count);
});

it('releases the recovery lock after a failed transfer without retrying the action', async () => {
  const locks = queuedLocks();
  const tab = await claimTab({ locks, session: { getItem: () => 'own', setItem() {} } });
  const failed = vi.fn(async () => { throw new Error('Write failed'); });
  await expect(tab.withRecovery(failed)).rejects.toThrow('Write failed');
  expect(failed).toHaveBeenCalledTimes(1);
  await expect(tab.withRecovery(async () => 'next recovery')).resolves.toBe('next recovery');
});

it('waits to claim a reload slot until an active recovery releases it', async () => {
  const locks = queuedLocks();
  const tab = await claimTab({ locks, session: { getItem: () => 'a', setItem() {} } });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const recovery = tab.withRecovery(async () => { started(); await held; });
  await entered;
  const reload = claimTab({ locks, session: { getItem: () => 'closed', setItem() {} } });
  await Promise.resolve();
  expect((await locks.query()).held.map((lock) => lock.name)).not.toContain('music-studio-tab-closed');
  release();
  await recovery;
  expect((await reload).key).toBe('tab:closed');
  expect((await locks.query()).held.map((lock) => lock.name)).toContain('music-studio-tab-closed');
});
