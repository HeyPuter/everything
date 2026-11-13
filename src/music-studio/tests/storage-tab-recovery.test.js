import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import { serializeProject } from '../src/model/serialize.js';
import { install } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';
import { claimTab, STALE_MS } from '../src/storage/tabs.js';

let app;
afterEach(() => {
  app?.autosave.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([false, true])('preserves other tabs’ drafts when lock inspection fails (own draft: %s)', async (hasOwn) => {
  vi.useFakeTimers();
  vi.stubGlobal('puter', undefined);
  const db = memoryDB();
  const draft = (name, at = Date.now()) => ({ json: serializeProject(newProject(name), {}), dirty: true, at });
  const other = draft('Other open session');
  const old = draft('Long-running open session', Date.now() - STALE_MS - 1);
  await db.put('drafts', 'tab:other', other);
  await db.put('drafts', 'tab:old', old);
  if (hasOwn) await db.put('drafts', 'tab:own', draft('My session'));
  const tab = await claimTab({
    session: { getItem: () => 'own', setItem() {} },
    locks: {
      request: (_name, _options, callback) => callback({}),
      query: async () => { throw new DOMException('Lock inspection unavailable', 'SecurityError'); },
    },
  });
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
