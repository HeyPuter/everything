import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import { serializeProject } from '../src/model/serialize.js';
import * as E from '../src/model/edits.js';
import { install, RESTORE_WAIT_MS } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';
import { pickDraft } from '../src/storage/tabs.js';

let app;
const listeners = [];
afterEach(() => {
  app?.autosave.stop();
  for (const [target, args] of listeners.splice(0)) target.removeEventListener(...args);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function delayedRestore(stage = 'local', { abandoned = false } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('puter', stage === 'cloud' ? { env: 'web', auth: { isSignedIn: () => true } } : undefined);
  const db = memoryDB();
  db.persistent = true;
  const original = { json: serializeProject(newProject('Previous session'), {}), dirty: true, at: Date.now() };
  if (stage === 'cloud') Object.assign(original, { dirty: false, file: { path: '/cloud/song.msproj' } });
  await db.put('drafts', abandoned ? 'tab:closed' : 'tab:own', original);
  const entries = await db.all('drafts');
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  if (stage === 'local') vi.spyOn(db, 'all').mockImplementationOnce(() => waiting);
  const root = document.createElement('div');
  document.body.append(root);
  app = new App(root, { storage: { getItem: () => null, setItem() {} } });
  app.prefs.set('launched', true);
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((...args) => { listeners.push([target, args]); add(...args); });
  }
  install(app, { db, tab: { key: 'tab:own', liveKeys: async () => new Set(['tab:own']) } });
  if (stage === 'cloud') vi.spyOn(app.library, 'loadCloud').mockImplementationOnce(() => waiting);
  app.emit('started');
  await vi.advanceTimersByTimeAsync(RESTORE_WAIT_MS + 1);
  expect(root.classList.contains('is-restoring')).toBe(false);
  return { db, finish: async () => { release(stage === 'local' ? entries : newProject('Updated cloud session')); await app.restored; } };
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

it.each([
  ['local', 'undo'], ['local', 'gesture'], ['cloud', 'undo'], ['cloud', 'gesture'],
])('preserves an intervening %s recovery %s interaction', async (stage, interaction) => {
  const { finish } = await delayedRestore(stage);
  const initial = app.store.project;
  if (interaction === 'undo') {
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
    app.store.undo();
  } else {
    app.store.begin('Tempo');
    app.store.preview((p) => E.setProjectProps(p, { bpm: 101 }));
  }
  const current = app.store.project;
  await finish();
  expect(app.store.project).toBe(current);
  if (interaction === 'undo') {
    expect(app.store.canRedo).toBe(true);
    app.store.redo();
    expect(app.store.project.bpm).toBe(101);
  } else {
    expect(app.store.gesture).not.toBe(null);
    app.store.commit();
    expect(app.store.project.bpm).toBe(101);
    app.store.undo();
    expect(app.store.project).toBe(initial);
  }
});

it.each(['local', 'cloud'])('still restores a delayed %s session when there was no project interaction', async (stage) => {
  const { finish } = await delayedRestore(stage);
  await finish();
  expect(app.store.project.name).toBe(stage === 'local' ? 'Previous session' : 'Updated cloud session');
});

it.each([
  ['local', false], ['local', true], ['cloud', false],
])('keeps the skipped %s session recoverable after autosaving new work (abandoned: %s)', async (stage, abandoned) => {
  const { db, finish } = await delayedRestore(stage, { abandoned });
  app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
  await finish();
  await app.autosave.flushAll();
  expect(JSON.parse((await db.get('drafts', 'tab:own')).json).bpm).toBe(101);
  const next = pickDraft(await db.all('drafts'), { own: 'tab:new', live: new Set(['tab:own', 'tab:new']) });
  expect(next.draft).not.toBe(null);
  expect(JSON.parse(next.draft.json).name).toBe('Previous session');
});

it.each([false, true])('preserves the previous session when recovery storage is full (early draft: %s)', async (earlyDraft) => {
  const { db, finish } = await delayedRestore();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const notify = vi.spyOn(app, 'notify');
  const put = db.put.bind(db);
  let full = true;
  const quota = new DOMException('No room for another draft', 'QuotaExceededError');
  vi.spyOn(db, 'put').mockImplementation((store, key, value) => {
    if (full && store === 'drafts' && key !== 'tab:own') return Promise.reject(quota);
    return put(store, key, value);
  });
  app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 101 }));
  if (earlyDraft) {
    app.files.setFile({ local: 'current', name: 'Current work' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(JSON.parse((await db.get('drafts', 'tab:own')).json).name).toBe('Previous session');
  }
  await finish();
  await app.autosave.flushAll();
  expect(JSON.parse((await db.get('drafts', 'tab:own')).json).name).toBe('Previous session');
  expect(app.store.project.bpm).toBe(101);
  expect(app.autosave.lastError).toBe(quota);
  const warning = notify.mock.calls.find(([, options]) => options?.error && options?.action);
  expect(warning).toBeDefined();
  const download = vi.spyOn(app.files, 'download').mockResolvedValue();
  await warning[1].action.run();
  expect(download).toHaveBeenCalledOnce();
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  expect(closing.defaultPrevented).toBe(true);
  await app.autosave.flushAll();
  full = false;
  await app.autosave.flushAll();
  expect(app.autosave.lastError).toBe(null);
  expect(JSON.parse((await db.get('drafts', 'tab:own')).json).bpm).toBe(101);
  const previous = pickDraft(await db.all('drafts'), { own: 'tab:new', live: new Set(['tab:own', 'tab:new']) });
  expect(JSON.parse(previous.draft.json).name).toBe('Previous session');
  const savedClose = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(savedClose);
  expect(savedClose.defaultPrevented).toBe(false);
});
