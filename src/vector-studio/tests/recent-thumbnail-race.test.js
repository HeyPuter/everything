import { afterEach, expect, it, vi } from 'vitest';
import { Prefs } from '../src/prefs.js';
import { RecentFiles } from '../src/features/files/recent.js';
import { memoryBackend } from '../src/features/files/backends.js';

afterEach(() => vi.restoreAllMocks());
const drawing = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing' };
const oldThumb = 'data:image/png;base64,OLD', newThumb = 'data:image/png;base64,NEW';
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
function setup(options = {}) {
  const prefs = new Prefs(null), cache = memoryBackend();
  const recent = new RecentFiles(prefs, { cache, ...options });
  const persisted = (entry = drawing) => new RecentFiles(prefs, { cache }).thumb(entry);
  return { cache, recent, persisted };
}

it.each(['remove', 'clear'])('keeps a reopened file thumbnail when an earlier %s finishes late', async (action) => {
  const { cache, recent, persisted } = setup();
  const entry = await recent.add({ ...drawing, thumb: oldThumb });
  const gate = deferred(), remove = cache.remove;
  const deleting = vi.spyOn(cache, 'remove').mockImplementationOnce(async (path) => { await gate.promise; return remove(path); });
  const removed = action === 'clear' ? recent.clear() : recent.remove(entry);
  await vi.waitFor(() => expect(deleting).toHaveBeenCalledOnce());
  const reopened = recent.add({ ...drawing, thumb: newThumb });
  gate.resolve();
  await Promise.all([removed, reopened]);
  expect(await persisted()).toBe(newThumb);
  expect(await recent.thumb(entry)).toBe(newThumb);
});

it('keeps the latest thumbnail when two writes complete out of order', async () => {
  const { cache, recent, persisted } = setup();
  const gate = deferred(), write = cache.writeJSON;
  const writing = vi.spyOn(cache, 'writeJSON').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const first = recent.setThumb(drawing, oldThumb);
  await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
  const second = recent.setThumb(drawing, newThumb);
  gate.resolve();
  await Promise.all([first, second]);
  expect(await persisted()).toBe(newThumb);
});

it.each(['replace', 'clear'])('does not restore an old cache read after %s', async (action) => {
  const { cache, recent } = setup();
  await recent.add({ ...drawing, thumb: oldThumb });
  recent.thumbs.clear();
  const gate = deferred(), read = cache.readJSON;
  const reading = vi.spyOn(cache, 'readJSON').mockImplementationOnce(async (path) => { const old = await read(path); await gate.promise; return old; });
  const loading = recent.thumb(drawing);
  await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
  const changing = action === 'clear' ? recent.clear() : recent.setThumb(drawing, newThumb);
  gate.resolve();
  expect(await loading).toBe(action === 'clear' ? null : newThumb);
  await changing;
  expect(await recent.thumb(drawing)).toBe(action === 'clear' ? null : newThumb);
});

it('does not evict a reopened file thumbnail after another entry finishes writing', async () => {
  const { cache, recent, persisted } = setup({ max: 1 });
  await recent.add({ ...drawing, thumb: oldThumb });
  const other = { kind: 'puter', path: '/u/Other.vstudio', name: 'Other' };
  const gate = deferred(), write = cache.writeJSON;
  const writing = vi.spyOn(cache, 'writeJSON').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const addingOther = recent.add({ ...other, thumb: oldThumb });
  await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
  const reopening = recent.add({ ...drawing, thumb: newThumb });
  gate.resolve();
  await Promise.all([addingOther, reopening]);
  expect(recent.list().map((e) => e.path)).toEqual([drawing.path]);
  expect(await recent.thumb(drawing)).toBe(newThumb);
  expect(await persisted()).toBe(newThumb);
  expect(await recent.thumb(other)).toBeNull();
});

it('allows unrelated thumbnail writes to proceed while one file is blocked', async () => {
  const { cache, recent, persisted } = setup();
  const gate = deferred(), write = cache.writeJSON;
  const writing = vi.spyOn(cache, 'writeJSON').mockImplementationOnce(async (...args) => { await gate.promise; return write(...args); });
  const first = recent.setThumb(drawing, oldThumb);
  await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
  const other = { kind: 'puter', path: '/u/Other.vstudio', name: 'Other' };
  try {
    await recent.setThumb(other, newThumb);
    expect(await persisted(other)).toBe(newThumb);
  } finally { gate.resolve(); await first; }
});

it('does not let a stalled old cache read block saving a new thumbnail', async () => {
  const { cache, recent, persisted } = setup();
  await recent.add({ ...drawing, thumb: oldThumb });
  recent.thumbs.clear();
  const gate = deferred(), read = cache.readJSON;
  const reading = vi.spyOn(cache, 'readJSON').mockImplementationOnce(async (path) => { const old = await read(path); await gate.promise; return old; });
  const loading = recent.thumb(drawing);
  await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
  let saved = false;
  const updating = recent.setThumb(drawing, newThumb).then(() => { saved = true; });
  try {
    await vi.waitFor(() => expect(saved).toBe(true), { timeout: 200 });
    expect(await persisted()).toBe(newThumb);
  } finally { gate.resolve(); await Promise.all([loading, updating]); }
});

it('coalesces concurrent cache reads and recovers from cache failures', async () => {
  const { cache, recent, persisted } = setup();
  cache.failNext = 1;
  await recent.setThumb(drawing, oldThumb);
  await recent.setThumb(drawing, newThumb);
  expect(await persisted()).toBe(newThumb);
  recent.thumbs.clear();
  cache.failNext = 1;
  expect(await recent.thumb(drawing)).toBeNull();
  const read = vi.spyOn(cache, 'readJSON');
  expect(await Promise.all([recent.thumb(drawing), recent.thumb(drawing)])).toEqual([newThumb, newThumb]);
  expect(read).toHaveBeenCalledOnce();
});
