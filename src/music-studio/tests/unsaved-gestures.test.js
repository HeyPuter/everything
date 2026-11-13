import { it, expect, vi, afterEach } from 'vitest';
import { App } from '../src/app.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { ProjectFiles } from '../src/storage/files.js';
import { install } from '../src/storage/index.js';
import { memoryDB } from '../src/storage/idb.js';
import { confirmDialog } from '../src/ui/dialog.js';

vi.mock('../src/ui/dialog.js', async (original) => ({ ...await original(), confirmDialog: vi.fn().mockResolvedValue(false) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const edit = (store) => {
  store.begin('Tempo');
  store.preview((p) => E.setProjectProps(p, { bpm: 99 }));
};

it('counts a changed gesture as unsaved and restores the saved state on cancel', () => {
  const store = new Store(newProject());
  store.begin('No change');
  expect(store.dirty).toBe(false);
  store.cancel();
  edit(store);
  expect(store.dirty).toBe(true);
  store.cancel();
  expect(store.dirty).toBe(false);
  edit(store);
  store.commit();
  expect(store.dirty).toBe(true);
  store.markSaved();
  expect(store.dirty).toBe(false);
});

it('keeps the committed dirty state when canceling and does not hide a preview when saving its start state', () => {
  const store = new Store(newProject());
  store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 110 }));
  edit(store);
  store.cancel();
  expect(store.dirty).toBe(true);
  edit(store);
  store.markSaved();
  expect(store.dirty).toBe(true);
  store.cancel();
  expect(store.dirty).toBe(false);
});

it.each(['new', 'open'])('asks before %s discards an active edit in an otherwise saved project', async (action) => {
  const app = { store: new Store(newProject()), engine: { stop: vi.fn() }, emit: vi.fn() };
  edit(app.store);
  const preview = app.store.project;
  const allowed = action === 'new' ? await App.prototype.newProject.call(app, newProject) : await new ProjectFiles(app, {}).confirmDiscard();
  expect(allowed).toBe(false);
  expect(confirmDialog).toHaveBeenCalledOnce();
  expect(app.store.project === preview).toBe(true);
});

it('warns on browser close when a persistent draft does not include an active gesture', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('puter', undefined);
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root, { storage: { getItem: () => null, setItem() {} } });
  const db = memoryDB();
  db.persistent = true;
  app.start([{ install: (a) => install(a, { db, tab: Promise.resolve({ key: 'gesture-test', liveKeys: () => new Set() }) }) }]);
  await app.restored;
  await app.autosave.flushDraft();
  expect(app.autosave.pending).toBe(false);
  edit(app.store);
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  const warned = closing.defaultPrevented;
  app.store.cancel();
  app.autosave.stop();
  root.remove();
  expect(warned).toBe(true);
});
