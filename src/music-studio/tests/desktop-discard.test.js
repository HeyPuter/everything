import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { install } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { serializeProject } from '../src/model/serialize.js';

const apps = [];
const listeners = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.autosave.stop();
  for (const [target, args] of listeners.splice(0)) target.removeEventListener(...args);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function setup({ key = 'tab:own', shared = false, restored = null } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  let close;
  const exit = vi.fn();
  const write = vi.fn(async (path) => ({ path }));
  vi.stubGlobal('puter', { env: 'app', auth: { isSignedIn: () => true }, ui: { onWindowClose: (fn) => { close = fn; } }, fs: { write }, exit });
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((...args) => { listeners.push([target, args]); add(...args); });
  }
  const db = memoryDB();
  db.persistent = true;
  if (restored) await db.put('drafts', key, restored);
  const app = new App(document.createElement('div'), { storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  app.reportError = vi.fn();
  app.prefs.set('launched', true);
  install(app, { db, tab: { key, shared, liveKeys: async () => new Set([key]) } });
  apps.push(app);
  app.emit('started');
  await app.restored;
  if (!restored) {
    app.store.load(newProject('Song'));
    await app.files.saveCloudTo('/Song.msproj');
    await app.autosave.flushAll();
  }
  write.mockClear();
  if (!restored) app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
  return { app, db, close, exit, write };
}

it('does not flush pending cloud edits after Don’t Save', async () => {
  const { app, close, exit, write } = await setup();
  expect(app.autosave.cloudTimer).not.toBe(null);
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await closing;
  expect(write).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledOnce();
});

it('does not autosave cloud changes while the close choice is still open', async () => {
  const { close, write } = await setup();
  const closing = close();
  await vi.advanceTimersByTimeAsync(61000);
  expect(write).not.toHaveBeenCalled();
  document.querySelector('[data-value="discard"]').click();
  await closing;
});

it('resumes cloud autosave after Cancel even if its timer elapsed in the dialog', async () => {
  const { app, close, exit, write } = await setup();
  const closing = close();
  await vi.advanceTimersByTimeAsync(61000);
  document.querySelector('.dialog-head button').click();
  await closing;
  expect(exit).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(61000);
  expect(write).toHaveBeenCalledOnce();
  expect(app.store.dirty).toBe(false);
});

it('still writes an explicit Save before exiting', async () => {
  const { app, close, exit, write } = await setup();
  const closing = close();
  document.querySelector('[data-value="save"]').click();
  await closing;
  expect(write).toHaveBeenCalledOnce();
  expect(app.store.dirty).toBe(false);
  expect(exit).toHaveBeenCalledOnce();
});

it('blocks a queued autosave that has not started writing when close opens', async () => {
  const { app, close, write } = await setup();
  const saving = app.autosave.flushCloud();
  const closing = close();
  await saving;
  expect(write).not.toHaveBeenCalled();
  document.querySelector('[data-value="discard"]').click();
  await closing;
});

it('does not restart cloud autosave from pagehide after discard', async () => {
  const { app, close, write } = await setup();
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await closing;
  app.store.apply('Late input', (p) => E.setProjectProps(p, { bpm: 102 }));
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(61000);
  expect(write).not.toHaveBeenCalled();
});

it.each(['auto', 'manual'])('waits for an already-started %s save without saving later discarded edits', async (mode) => {
  const { app, close, exit, write } = await setup();
  let finish;
  write.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const saving = mode === 'auto' ? app.autosave.flushCloud() : app.files.saveCloudTo('/Song.msproj');
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  app.store.apply('Later tempo', (p) => E.setProjectProps(p, { bpm: 102 }));
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await Promise.resolve();
  expect(exit).not.toHaveBeenCalled();
  finish({ path: '/Song.msproj' });
  await Promise.all([saving, closing]);
  expect(write).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledOnce();
  await close();
  expect(document.querySelector('.dialog-backdrop')).toBe(null);
  expect(exit).toHaveBeenCalledOnce();
});

it('keeps the window open and resumes autosave after an explicit Save fails', async () => {
  const { app, close, exit, write } = await setup();
  write.mockRejectedValueOnce(new Error('Offline'));
  const closing = close();
  document.querySelector('[data-value="save"]').click();
  await closing;
  expect(exit).not.toHaveBeenCalled();
  expect(app.store.dirty).toBe(true);
  await vi.advanceTimersByTimeAsync(61000);
  expect(write).toHaveBeenCalledTimes(2);
  expect(app.store.dirty).toBe(false);
});

it('does not restore explicitly discarded edits from the session draft', async () => {
  const { app, db, close } = await setup();
  await app.autosave.flushDraft();
  expect(JSON.parse((await db.get('drafts', 'tab:own')).json).bpm).toBe(101);
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await closing;
  expect(await db.get('drafts', 'tab:own')).toBe(null);
});


it('preserves a newer draft from another tab in the shared recovery slot', async () => {
  const { app, db, close } = await setup({ key: 'session', shared: true });
  await app.autosave.flushDraft();
  const other = { json: '{"name":"Another tab"}', dirty: true, at: Date.now() + 1 };
  await db.put('drafts', 'session', other);
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await closing;
  expect(await db.get('drafts', 'session')).toEqual(other);
});

it('waits for a draft write already in progress, then removes it without recreating it', async () => {
  const { app, db, close, exit } = await setup();
  const put = db.put.bind(db);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const pending = vi.spyOn(db, 'put').mockImplementationOnce(async (...args) => { await held; return put(...args); });
  const writing = app.autosave.flushDraft();
  await vi.waitFor(() => expect(pending).toHaveBeenCalled());
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await Promise.resolve();
  expect(exit).not.toHaveBeenCalled();
  release();
  await Promise.all([writing, closing]);
  app.emit('file');
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(await db.get('drafts', 'tab:own')).toBe(null);
  expect(exit).toHaveBeenCalledOnce();
});

it('reports cleanup failure, keeps the window open, and allows retry', async () => {
  const { app, db, close, exit } = await setup();
  await app.autosave.flushDraft();
  const failure = new Error('Draft deletion failed');
  vi.spyOn(db, 'deleteIf').mockRejectedValueOnce(failure);
  const first = close();
  document.querySelector('[data-value="discard"]').click();
  await first;
  expect(app.reportError).toHaveBeenCalledWith(failure);
  expect(exit).not.toHaveBeenCalled();
  expect(app.autosave.pending).toBe(true);
  const second = close();
  document.querySelector('[data-value="discard"]').click();
  await second;
  expect(await db.get('drafts', 'tab:own')).toBe(null);
  expect(exit).toHaveBeenCalledOnce();
});

it('discards a restored legacy draft before its first rewrite while preserving other slots', async () => {
  const restored = { json: serializeProject(newProject('Recovered'), {}), dirty: true, at: Date.now() };
  const { app, db, close, exit } = await setup({ key: 'session', shared: true, restored });
  expect(app.store.project.name).toBe('Recovered');
  const other = { json: 'other', dirty: true, at: Date.now() };
  await db.put('drafts', 'tab:other', other);
  const closing = close();
  document.querySelector('[data-value="discard"]').click();
  await closing;
  expect(await db.get('drafts', 'session')).toBe(null);
  expect(await db.get('drafts', 'tab:other')).toEqual(other);
  expect(exit).toHaveBeenCalledOnce();
});
