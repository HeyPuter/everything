import { it, expect, beforeEach, afterEach, vi } from 'vitest';

let clock = 1;
const fs = new Map();
vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeFile: vi.fn(async (path, blob) => { fs.set(path, { blob, modified: ++clock, uid: fs.get(path)?.uid || `uid-${clock}` }); return { path, modified: clock, uid: fs.get(path).uid }; }),
    statFile: vi.fn(async path => (fs.has(path) ? { path, modified: fs.get(path).modified, size: fs.get(path).blob.size } : null)),
    statByUid: vi.fn(async uid => { const found = [...fs].find(([, f]) => f.uid === uid); return found ? { path: found[0], uid, modified: found[1].modified, size: found[1].blob.size } : null; }),
    readFile: vi.fn(async path => fs.get(path).blob),
  };
});

const { Doc, versioning, publishing } = await import('../src/lib/doc.js');
const { isStarred, toggleStar } = await import('../src/lib/starred.js');
const { rememberRoom, rememberedRoom } = await import('../src/collab/room-memory.js');

/** Renaming or moving elsewhere (the Puter desktop) gives the file a new path and a new time stamp, and keeps its id. */
const renameElsewhere = (from, to, { edit = null } = {}) => {
  const f = fs.get(from); fs.delete(from);
  fs.set(to, { ...f, modified: ++clock, ...(edit ? { blob: new Blob([edit]) } : {}) });
};

let kv;
beforeEach(() => {
  vi.useFakeTimers();
  versioning.enabled = false; publishing.enabled = false;
  fs.clear(); clock = 1;
  kv = new Map();
  const storage = new Map();
  vi.stubGlobal('localStorage', { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) });
  vi.stubGlobal('puter', { kv: { get: async k => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); return true; }, del: async k => kv.delete(k) } });
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function opened(path, text) {
  fs.set(path, { blob: new Blob([text]), modified: 1, uid: 'file-1' });
  const doc = new Doc({ name: 'Plan', path, uid: 'file-1', blob: fs.get(path).blob, modified: 1 });
  let content = text;
  doc.attach(async () => new Blob([content]));
  return { doc, edit: next => { content = next; doc.changed(); } };
}

it('follows a file renamed elsewhere and goes on saving there, with what keys on its path', async () => {
  const { doc, edit } = await opened('Documents/Plan.docx', 'opened');
  toggleStar('Documents/Plan.docx');
  await rememberRoom('Documents/Plan.docx', { server: 'https://documents-abc.puter.work', room: 'room1' });
  const paths = [], conflicts = [];
  doc.addEventListener('path', e => paths.push(e.detail.path));
  doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
  renameElsewhere('Documents/Plan.docx', 'Documents/Budget.docx');
  edit('edited after the rename');
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(200);
  expect(conflicts).toEqual([]);
  expect(doc.status).toBe('saved');
  expect([doc.path, doc.name]).toEqual(['Documents/Budget.docx', 'Budget']);
  expect(paths).toEqual(['Documents/Budget.docx']);
  expect(fs.has('Documents/Plan.docx')).toBe(false);
  expect(await fs.get('Documents/Budget.docx').blob.text()).toBe('edited after the rename');
  expect([isStarred('Documents/Budget.docx'), isStarred('Documents/Plan.docx')]).toEqual([true, false]);
  expect((await rememberedRoom('Documents/Budget.docx'))?.room).toBe('room1');
  // And again, after its own write there.
  renameElsewhere('Documents/Budget.docx', 'Archive/Budget 2025.docx');
  edit('edited after the move');
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(200);
  expect(doc.path).toBe('Archive/Budget 2025.docx');
  expect(await fs.get('Archive/Budget 2025.docx').blob.text()).toBe('edited after the move');
});

it('still reports a file renamed and changed elsewhere as changed in another window', async () => {
  const { doc, edit } = await opened('Documents/Plan.docx', 'opened');
  const conflicts = [];
  doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
  renameElsewhere('Documents/Plan.docx', 'Documents/Budget.docx', { edit: 'their version' });
  edit('mine');
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(200);
  expect(conflicts).toHaveLength(1);
  expect(doc.path).toBe('Documents/Plan.docx');
  expect(await fs.get('Documents/Budget.docx').blob.text()).toBe('their version');
  expect(fs.has('Documents/Plan.docx')).toBe(false);
});

it('still reports a deleted file, or one in the trash, as before', async () => {
  for (const to of [null, '/ada/Trash/Plan.docx']) {
    fs.clear();
    const { doc, edit } = await opened('Documents/Plan.docx', 'opened');
    const conflicts = [];
    doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
    if (to) renameElsewhere('Documents/Plan.docx', to); else fs.delete('Documents/Plan.docx');
    edit('mine');
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(200);
    expect(conflicts[0]).toMatch(/moved or deleted/);
    expect(doc.path).toBe('Documents/Plan.docx');
    doc.destroy();
  }
});
