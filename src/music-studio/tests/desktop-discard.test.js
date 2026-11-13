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
  for (const [target, args] of listeners.splice(0)) target.removeEventListener(...args);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function setup() {
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
  const app = new App(document.createElement('div'), { storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  app.reportError = vi.fn();
  app.prefs.set('launched', true);
  install(app, { db, tab: { key: 'tab:own', liveKeys: async () => new Set(['tab:own']) } });
  apps.push(app);
  app.emit('started');
  await app.restored;
  app.store.load(newProject('Song'));
  await app.files.saveCloudTo('/Song.msproj');
  await app.autosave.flushAll();
  write.mockClear();
  app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
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

it('waits for an already-started autosave without saving later discarded edits', async () => {
  const { app, close, exit, write } = await setup();
  let finish;
  write.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const saving = app.autosave.flushCloud();
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
