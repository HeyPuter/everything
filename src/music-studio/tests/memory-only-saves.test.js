import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { install } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';

const apps = [];
const listeners = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.autosave.stop();
  for (const args of listeners.splice(0)) window.removeEventListener(...args);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function setup({ persistent = false, desktop = false } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  let close;
  const exit = vi.fn();
  vi.stubGlobal('puter', { env: desktop ? 'app' : 'web', auth: { isSignedIn: () => false }, ui: { onWindowClose: (fn) => { close = fn; } }, exit });
  const db = memoryDB();
  db.persistent = persistent;
  const app = new App(document.createElement('div'), { project: newProject(), storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((...args) => { listeners.push(args); add(...args); });
  install(app, { db, tab: Promise.resolve({ key: 'memory-save-test', liveKeys: async () => new Set(['memory-save-test']) }) });
  apps.push(app);
  app.emit('started');
  await app.restored;
  app.store.load(newProject());
  app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
  vi.spyOn(app.files, 'localSaveNotice').mockResolvedValue();
  return { app, db, close, exit };
}

it.each([false, true])('marks a local save durable only when its database is persistent (%s)', async (persistent) => {
  const { app } = await setup({ persistent });
  expect(await app.files.saveLocalProject('song', 'Song')).toBe(true);
  expect((await app.library.loadLocal('song')).bpm).toBe(99);
  expect(app.file.local).toBe('song');
  expect(app.store.dirty).toBe(!persistent);
});

it('warns before browser close after a memory-only save and completed draft', async () => {
  const { app } = await setup();
  await app.files.saveLocalProject('song', 'Song');
  await app.autosave.flushAll();
  expect(app.autosave.pending).toBe(false);
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  expect(closing.defaultPrevented).toBe(true);
});

it('keeps the desktop window open after Save writes only to memory', async () => {
  const { app, close, exit } = await setup({ desktop: true });
  await app.files.saveLocalProject('song', 'Song');
  const saving = close();
  const dialog = document.querySelector('.dialog-backdrop');
  expect(dialog).not.toBeNull();
  dialog.querySelector('[data-value="save"]').click();
  await saving;
  expect(exit).not.toHaveBeenCalled();
  const discarding = close();
  document.querySelector('.dialog-backdrop [data-value="discard"]').click();
  await discarding;
  expect(exit).toHaveBeenCalledOnce();
});

it.each([false, true])('keeps the right durability state when reopening a local project (%s)', async (persistent) => {
  const { app } = await setup({ persistent });
  await app.library.saveLocal(app.store.project, {}, { key: 'song' });
  app.store.load(newProject());
  expect(await app.files.openLocalKey('song')).toBe(true);
  expect(app.store.project.bpm).toBe(99);
  expect(app.store.dirty).toBe(!persistent);
});

it('clears the unsaved state after recovering a memory-only project to cloud', async () => {
  const { app } = await setup();
  await app.files.saveLocalProject('song', 'Song');
  app.library.puter = { requireSignedIn() {}, writeFile: vi.fn(async (path) => ({ path })) };
  expect(await app.files.saveCloudTo('/Song.msproj')).toBe(true);
  expect(app.file.path).toBe('/Song.msproj');
  expect(app.store.dirty).toBe(false);
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  expect(closing.defaultPrevented).toBe(false);
});
