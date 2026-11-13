import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import { serializeProject } from '../src/model/serialize.js';
import * as E from '../src/model/edits.js';
import { install, RESTORE_WAIT_MS } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';

let app;
afterEach(() => {
  app?.autosave.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function delayedRestore() {
  vi.useFakeTimers();
  vi.stubGlobal('puter', undefined);
  const db = memoryDB();
  db.persistent = true;
  const original = { json: serializeProject(newProject('Previous session'), {}), dirty: true, at: Date.now() };
  await db.put('drafts', 'tab:own', original);
  const entries = await db.all('drafts');
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  vi.spyOn(db, 'all').mockImplementationOnce(() => waiting);
  const root = document.createElement('div');
  document.body.append(root);
  app = new App(root, { storage: { getItem: () => null, setItem() {} } });
  app.prefs.set('launched', true);
  install(app, { db, tab: { key: 'tab:own', liveKeys: async () => new Set(['tab:own']) } });
  app.emit('started');
  await vi.advanceTimersByTimeAsync(RESTORE_WAIT_MS + 1);
  expect(root.classList.contains('is-restoring')).toBe(false);
  return { db, finish: async () => { release(entries); await app.restored; } };
}

it('autosaves edits made after the workspace appears but before recovery finishes', async () => {
  const { db, finish } = await delayedRestore();
  app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
  await finish();
  expect(app.store.project.bpm).toBe(101);
  expect(app.autosave.pending).toBe(true);
  const close = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(close);
  expect(close.defaultPrevented).toBe(true);
  await app.autosave.flushAll();
  expect(JSON.parse((await db.get('drafts', 'tab:own')).json).bpm).toBe(101);
});
