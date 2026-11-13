import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { Library } from '../src/storage/library.js';
import { ProjectFiles } from '../src/storage/files.js';
import { openDB, memoryDB } from '../src/storage/idb.js';
import { createProject } from '../src/model/project.js';
import { Store } from '../src/model/store.js';
import { Emitter } from '../src/lib/emitter.js';
import { promptDialog } from '../src/ui/dialog.js';

vi.mock('../src/ui/dialog.js', () => ({ promptDialog: vi.fn(), confirmDialog: vi.fn(), openDialog: vi.fn() }));
const connections = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function database(kind) {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const db = kind === 'memory' ? memoryDB() : await openDB('project-id-collisions');
  connections.push(db); return db;
}
function collide() {
  const random = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.length === 8 && calls++ < 2 ? bytes.fill(0) : random(bytes));
}
function appFor(lib, project) {
  const values = { dismissedNotices: ['localSave'], recent: [] };
  const app = new Emitter();
  Object.assign(app, { store: new Store(project), file: null, notify: vi.fn(), prefs: { get: (k) => values[k], set: (k, v) => { values[k] = v; } } });
  const files = new ProjectFiles(app, lib);
  vi.spyOn(files, 'localSaveNotice').mockResolvedValue();
  vi.stubGlobal('puter', { auth: { isSignedIn: () => false } });
  return { app, files };
}

it.each(['memory', 'indexed'])('keeps an earlier project intact when a generated save key collides (%s)', async (kind) => {
  const db = await database(kind), lib = new Library({ db });
  const original = { ...createProject({ name: 'Original' }), bpm: 90 }, incoming = { ...createProject({ name: 'Incoming' }), bpm: 150 };
  await lib.saveLocal(original, {}, { key: '00000000' });
  const before = await db.get('projectData', '00000000'), meta = await db.get('projects', '00000000');
  collide();
  const saved = await lib.saveLocal(incoming, {});
  expect(await db.get('projectData', '00000000')).toBe(before);
  expect(await db.get('projects', '00000000')).toEqual(meta);
  expect(saved.key).not.toBe('00000000');
  expect((await lib.loadLocal(saved.key)).bpm).toBe(150);
  expect((await lib.listLocal()).map((p) => p.key).sort()).toEqual(['00000000', saved.key].sort());
});

it.each(['first save', 'save as'])('uses the reserved project key for the %s file and recent entry', async (action) => {
  const db = await database('memory'), lib = new Library({ db });
  const original = { ...createProject({ name: 'Original' }), bpm: 90 };
  const incoming = { ...createProject({ name: 'Incoming' }), bpm: 150 };
  await lib.saveLocal(original, {}, { key: '00000000' });
  const { app, files } = appFor(lib, incoming);
  if (action === 'save as') app.file = { local: '00000000', name: 'Original' };
  promptDialog.mockResolvedValue('Copy');
  collide();
  expect(await (action === 'save as' ? files.saveAs() : files.save())).toBe(true);
  expect((await lib.loadLocal('00000000')).bpm).toBe(90);
  expect(app.file.local).not.toBe('00000000');
  expect((await lib.loadLocal(app.file.local)).bpm).toBe(150);
  expect(app.prefs.get('recent')[0].local).toBe(app.file.local);
  expect(app.saving).toBe(false);
  expect(app.store.dirty).toBe(true); // memory saves keep their warning
  app.store.apply('Tempo', (p) => ({ ...p, bpm: 155 }));
  expect(await files.save()).toBe(true);
  expect((await lib.loadLocal(app.file.local)).bpm).toBe(155);
  expect((await lib.loadLocal('00000000')).bpm).toBe(90);
  expect(await lib.listLocal()).toHaveLength(2);
});

it.each(['memory', 'indexed'])('allocates separate keys for concurrent new projects (%s)', async (kind) => {
  const db = await database(kind);
  const other = kind === 'indexed' ? await openDB('project-id-collisions') : db;
  if (other !== db) connections.push(other);
  const a = new Library({ db }), b = new Library({ db: other });
  const first = { ...createProject({ name: 'First' }), bpm: 90 }, second = { ...createProject({ name: 'Second' }), bpm: 150 };
  collide();
  const [left, right] = await Promise.all([a.saveLocal(first, {}), b.saveLocal(second, {})]);
  expect(left.key).not.toBe(right.key);
  expect((await a.loadLocal(left.key)).bpm).toBe(90);
  expect((await b.loadLocal(right.key)).bpm).toBe(150);
  expect(await a.listLocal()).toHaveLength(2);
});

for (const kind of ['memory', 'indexed']) it.each(['projects', 'projectData'])('reserves a key present only in %s without leaving a partial save (' + kind + ')', async (store) => {
  const db = await database(kind), lib = new Library({ db });
  const project = createProject({ name: 'New' });
  const before = store === 'projects' ? { key: '00000000', name: 'Orphan metadata', modified: 1, size: 12 } : 'original orphaned content';
  await db.put(store, '00000000', before);
  collide();
  const saved = await lib.saveLocal(project, {});
  expect(await db.get(store, '00000000')).toEqual(before);
  expect(await db.get(store === 'projects' ? 'projectData' : 'projects', '00000000')).toBeNull();
  expect(saved.key).not.toBe('00000000');
  expect((await lib.loadLocal(saved.key)).name).toBe('New');
});

it.each(['memory', 'indexed'])('still overwrites an explicitly identified existing project (%s)', async (kind) => {
  const db = await database(kind), lib = new Library({ db });
  const p = createProject({ name: 'Original' });
  await lib.saveLocal(p, {}, { key: 'same' });
  const saved = await lib.saveLocal({ ...p, name: 'Edited', bpm: 140 }, {}, { key: 'same' });
  expect(saved.key).toBe('same');
  expect(await lib.listLocal()).toHaveLength(1);
  expect((await lib.loadLocal('same')).bpm).toBe(140);
});

it.each(['library', 'file action'])('rolls back a new save when metadata aborts and allows retry through %s', async (mode) => {
  const db = await database('indexed'), lib = new Library({ db });
  const project = createProject({ name: 'Unsaved' }), { app, files } = appFor(lib, project);
  app.store.dirty = true;
  const add = IDBObjectStore.prototype.add;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (...args) {
    const request = add.apply(this, args);
    if (this.name === 'projects') request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
  if (mode === 'library') await expect(lib.saveLocal(project, {})).rejects.toThrow();
  else expect(await files.save()).toBe(false);
  expect(fault).toHaveBeenCalledTimes(2);
  expect(await db.all('projects')).toEqual([]);
  expect(await db.all('projectData')).toEqual([]);
  expect(app.file).toBeNull();
  expect(app.store.dirty).toBe(true);
  expect(app.prefs.get('recent')).toEqual([]);
  expect(app.saving || false).toBe(false);
  fault.mockRestore();
  expect(await files.save()).toBe(true);
  expect((await lib.loadLocal(app.file.local)).name).toBe('Unsaved');
  expect(app.store.dirty).toBe(false);
});
