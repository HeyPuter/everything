import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { serializeDocument } from '../src/features/files/format.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function setup({ stored = false, persistent = true } = {}) {
  const app = await bootAppWithFeatures();
  const service = app.files.service;
  const bytes = await serializeDocument(VDocument.create({ name: 'Drawing' }), { compress: false });
  const read = deferred();
  const file = { name: 'Drawing.vstudio', arrayBuffer: vi.fn(() => read.promise) };
  const handle = (key = 'drawing') => ({
    kind: 'file', name: file.name, key,
    isSameEntry: async (other) => other.key === key,
    getFile: vi.fn(async () => file),
    queryPermission: vi.fn(async () => 'granted'),
  });
  const first = handle();
  const entries = new Map(stored ? [['saved-handle', first]] : []);
  service.handles = {
    find: vi.fn(async (h) => [...entries].find(([, other]) => other.key === h.key)?.[0] || null),
    put: vi.fn(async (id, h) => { if (persistent) entries.set(id, h); return persistent; }),
    get: vi.fn(async (id) => entries.get(id) || null),
  };
  app.dialogs.alert = vi.fn(async () => true);
  return { app, service, file, first, handle, entries, read, bytes, release: () => read.resolve(bytes.buffer) };
}
async function cleanup(ctx) {
  ctx.release();
  for (const ed of [...ctx.app.editors]) await ctx.app.closeDocument(ed, { force: true });
}

it.each([false, true].flatMap((stored) => [false, true].map((sameObject) => [stored, sameObject])))('opens one native document for concurrent local picks (stored: %s, same handle object: %s)', async (stored, sameObject) => {
  const c = await setup({ stored });
  try {
    const count = c.app.editors.length;
    const first = c.service.openFileBlob(c.file, { handle: c.first });
    const second = c.service.openFileBlob(c.file, { handle: sameObject ? c.first : c.handle() });
    await vi.waitFor(() => expect(c.file.arrayBuffer).toHaveBeenCalled());
    c.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeTruthy();
    expect(a === b).toBe(true);
    expect(c.app.editors.length).toBe(count + 1);
    expect(c.file.arrayBuffer).toHaveBeenCalledOnce();
    expect(c.entries.size).toBe(1);
    a.doc.transact('Edit', () => a.doc.updateRoot({ name: 'Changed' }));
    expect(b.doc.root.name).toBe('Changed');
  } finally { await cleanup(c); }
});

it.each(['picker', 'recent'])('coalesces overlapping Recent and picker opens when %s starts first', async (start) => {
  const c = await setup({ stored: true });
  const recent = { kind: 'local', handleId: 'saved-handle', name: c.file.name };
  const pick = () => c.service.openFileBlob(c.file, { handle: c.handle() });
  const reopen = () => c.service.openRecent(recent);
  try {
    const count = c.app.editors.length;
    const first = start === 'picker' ? pick() : reopen();
    await vi.waitFor(() => expect(c.file.arrayBuffer).toHaveBeenCalledOnce());
    const second = start === 'picker' ? reopen() : pick();
    c.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a === b).toBe(true);
    expect(c.app.editors.length).toBe(count + 1);
    expect(c.file.arrayBuffer).toHaveBeenCalledOnce();
  } finally { await cleanup(c); }
});

it('recognizes an already open local handle even when IndexedDB persistence is unavailable', async () => {
  const c = await setup({ persistent: false });
  try {
    c.release();
    const first = await c.service.openFileBlob(c.file, { handle: c.first });
    first.doc.transact('Unsaved edit', () => first.doc.updateRoot({ name: 'Unsaved work' }));
    const second = await c.service.openFileBlob(c.file, { handle: c.handle() });
    expect(first === second).toBe(true);
    expect(second.doc.root.name).toBe('Unsaved work');
    expect(c.file.arrayBuffer).toHaveBeenCalledOnce();
  } finally { await cleanup(c); }
});

it('loads different files with the same name concurrently', async () => {
  const c = await setup();
  const otherRead = deferred();
  const otherFile = { name: c.file.name, arrayBuffer: vi.fn(() => otherRead.promise) };
  try {
    const first = c.service.openFileBlob(c.file, { handle: c.first });
    const second = c.service.openFileBlob(otherFile, { handle: c.handle('other-folder/drawing') });
    await vi.waitFor(() => {
      expect(c.file.arrayBuffer).toHaveBeenCalledOnce();
      expect(otherFile.arrayBuffer).toHaveBeenCalledOnce();
    });
    otherRead.resolve(c.bytes.buffer);
    const b = await second;
    expect(b).toBeTruthy();
    c.release();
    const a = await first;
    expect(a === b).toBe(false);
    expect(a.file.handleId).not.toBe(b.file.handleId);
  } finally { otherRead.resolve(c.bytes.buffer); await cleanup(c); }
});

it('shares a Recent read error with a joining picker request and allows a fresh retry', async () => {
  const c = await setup({ stored: true });
  const failing = deferred();
  c.first.getFile.mockImplementationOnce(() => failing.promise);
  try {
    const first = c.service.openRecent({ kind: 'local', handleId: 'saved-handle', name: c.file.name });
    await vi.waitFor(() => expect(c.first.getFile).toHaveBeenCalledOnce());
    const handle = c.handle();
    const sameEntry = vi.fn(handle.isSameEntry);
    handle.isSameEntry = sameEntry;
    const second = c.service.openFileBlob(c.file, { handle });
    await vi.waitFor(() => expect(sameEntry).toHaveBeenCalled());
    const results = Promise.allSettled([first, second]);
    failing.reject(new Error('Disk unavailable'));
    expect(await results).toEqual([{ status: 'fulfilled', value: null }, { status: 'fulfilled', value: null }]);
    expect(c.app.dialogs.alert).toHaveBeenCalledOnce();
    c.release();
    expect(await c.service.openFileBlob(c.file, { handle })).toBeTruthy();
    expect(c.file.arrayBuffer).toHaveBeenCalledOnce();
  } finally { failing.resolve(c.file); await cleanup(c); }
});

it('releases a denied Recent request so granting permission can open it later', async () => {
  const c = await setup({ stored: true });
  const recent = { kind: 'local', handleId: 'saved-handle', name: c.file.name };
  c.first.queryPermission.mockResolvedValueOnce('denied');
  c.first.requestPermission = vi.fn(async () => 'denied');
  try {
    expect(await c.service.openRecent(recent)).toBeNull();
    expect(c.first.getFile).not.toHaveBeenCalled();
    c.release();
    expect(await c.service.openRecent(recent)).toBeTruthy();
    expect(c.first.getFile).toHaveBeenCalledOnce();
  } finally { await cleanup(c); }
});

it('opens independent imported copies when no file handle is supplied', async () => {
  const c = await setup();
  try {
    c.release();
    const [a, b] = await Promise.all([c.service.openFileBlob(c.file), c.service.openFileBlob(c.file)]);
    expect(a === b).toBe(false);
    expect(a.file.kind).toBe('import');
    expect(b.file.kind).toBe('import');
    expect(c.file.arrayBuffer).toHaveBeenCalledTimes(2);
  } finally { await cleanup(c); }
});

it('uses stored identity when the browser cannot compare handles', async () => {
  const c = await setup({ stored: true });
  const other = c.handle();
  other.isSameEntry = async () => { throw new Error('Cannot compare'); };
  try {
    const first = c.service.openFileBlob(c.file, { handle: c.first });
    const second = c.service.openFileBlob(c.file, { handle: other });
    c.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a === b).toBe(true);
    expect(c.file.arrayBuffer).toHaveBeenCalledOnce();
  } finally { await cleanup(c); }
});

it.each(['closed', 'saved elsewhere'])('rechecks a pending match if its window is %s while handle comparison waits', async (change) => {
  const c = await setup({ stored: true });
  const comparison = deferred();
  const other = c.handle();
  other.isSameEntry = vi.fn(() => comparison.promise);
  try {
    const first = c.service.openFileBlob(c.file, { handle: c.first });
    await vi.waitFor(() => expect(c.file.arrayBuffer).toHaveBeenCalledOnce());
    const second = c.service.openFileBlob(c.file, { handle: other });
    await vi.waitFor(() => expect(other.isSameEntry).toHaveBeenCalledOnce());
    c.release();
    const a = await first;
    if (change === 'closed') await c.app.closeDocument(a, { force: true });
    else {
      a.doc.transact('Rename', () => a.doc.updateRoot({ name: 'Saved copy' }));
      c.app.user = { username: 'test' };
      c.app.prefs.set('filesSaveDialog', 'puter');
      c.app.puter = { fs: {}, ui: { showSaveFilePicker: async () => ({ path: '/u/Copy.vstudio', name: 'Copy.vstudio' }) } };
      expect(await c.service.saveAs(a)).toBe(true);
    }
    comparison.resolve(true);
    const b = await second;
    expect(a === b).toBe(false);
    expect(c.app.editors.includes(b)).toBe(true);
    expect(b.file.kind).toBe('local');
    expect(b.doc.root.name).toBe('Drawing');
    expect(c.file.arrayBuffer).toHaveBeenCalledTimes(2);
  } finally { comparison.resolve(true); await cleanup(c); }
});
