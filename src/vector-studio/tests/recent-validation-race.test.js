import { expect, it, vi } from 'vitest';
import { Prefs } from '../src/prefs.js';
import { RecentFiles, entryKey } from '../src/features/files/recent.js';
import { memoryBackend } from '../src/features/files/backends.js';

const drawing = { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' };
const missing = () => Object.assign(new Error('Missing'), { code: 'not_found' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
  const prefs = new Prefs(storage);
  const recent = new RecentFiles(prefs, { cache: memoryBackend(), now: () => 1000, ...options });
  return { recent, storage };
}

it.each(['reopen', 'rename', 'clear and reopen'])('ignores an old missing result after %s, even with tied timestamps', async (action) => {
  const { recent, storage } = setup();
  const original = await recent.add(drawing);
  const result = deferred();
  const checking = recent.validate(() => result.promise, { force: true });
  if (action === 'rename') recent.rename(original, { name: 'Renamed.vstudio' });
  else {
    if (action === 'clear and reopen') recent.clear();
    await recent.add({ ...drawing, thumb: 'data:image/png;base64,NEW' });
  }
  const current = recent.list()[0];
  result.reject(missing());
  expect(await checking).toEqual([]);
  expect(recent.list()[0] === current).toBe(true);
  expect(new Prefs(storage).get('recentFiles')[0].name).toBe(current.name);
  if (action !== 'rename') expect(await recent.thumb(current)).toBe('data:image/png;base64,NEW');
});

it('rechecks a missing entry after waiting for other file checks', async () => {
  const { recent } = setup();
  await recent.add(drawing);
  await recent.add({ kind: 'puter', path: '/u/Other.vstudio', name: 'Other' });
  const other = deferred();
  const checking = recent.validate(async (path) => {
    if (path === drawing.path) throw missing();
    return other.promise;
  }, { force: true });
  // The missing result is ready, but validation is still waiting on Other.
  await Promise.resolve();
  await recent.add(drawing);
  other.resolve({});
  expect(await checking).toEqual([]);
  expect(recent.list().map((e) => e.path)).toContain(drawing.path);
});

it('rechecks later removals after waiting for another entry thumbnail cleanup', async () => {
  const cache = memoryBackend();
  const { recent } = setup({ cache });
  await recent.add(drawing);
  const other = await recent.add({ kind: 'puter', path: '/u/Other.vstudio', name: 'Other' });
  const cleanup = deferred();
  const remove = cache.remove;
  const deleting = vi.spyOn(cache, 'remove').mockImplementationOnce(async (path) => { await cleanup.promise; return remove(path); });
  try {
    const checking = recent.validate(async () => { throw missing(); }, { force: true });
    await vi.waitFor(() => expect(deleting).toHaveBeenCalledOnce());
    await recent.add({ ...drawing, thumb: 'data:image/png;base64,NEW' });
    cleanup.resolve();
    expect((await checking).map((e) => e.path)).toEqual([other.path]);
    expect(recent.list().map((e) => e.path)).toEqual([drawing.path]);
    expect(await recent.thumb(drawing)).toBe('data:image/png;base64,NEW');
  } finally { cleanup.resolve(); vi.restoreAllMocks(); }
});

it.each(['missing', 'offline', 'success'])('ignores an older overlapping %s result after a newer successful check', async (outcome) => {
  let time = 1000;
  const { recent } = setup({ now: () => time, staleAfter: 100 });
  const entry = await recent.add(drawing);
  const old = deferred();
  const first = recent.validate(() => old.promise, { force: true });
  time = 2000;
  await recent.validate(async () => ({}), { force: true });
  if (outcome === 'success') old.resolve({});
  else old.reject(outcome === 'missing' ? missing() : new Error('Offline'));
  expect(await first).toEqual([]);
  expect(recent.list()).toHaveLength(1);
  expect(recent.checked.get(entryKey(entry))).toBe(2000);
  const stat = vi.fn(async () => ({}));
  await recent.validate(stat);
  expect(stat).not.toHaveBeenCalled();
});

it('dates a successful check at completion so a slow check is not immediately repeated', async () => {
  let time = 1000;
  const { recent } = setup({ now: () => time, staleAfter: 100 });
  await recent.add(drawing);
  const result = deferred();
  const checking = recent.validate(() => result.promise, { force: true });
  time = 2000;
  result.resolve({});
  await checking;
  const stat = vi.fn(async () => ({}));
  await recent.validate(stat);
  expect(stat).not.toHaveBeenCalled();
});

it('still removes unchanged missing files and directories while retaining offline and local entries', async () => {
  const { recent } = setup();
  for (const name of ['missing', 'directory', 'offline']) await recent.add({ kind: 'puter', path: `/u/${name}`, name });
  await recent.add({ kind: 'local', handleId: 'local-handle', name: 'Local' });
  const stat = vi.fn(async (path) => {
    if (path.endsWith('missing')) throw missing();
    if (path.endsWith('offline')) throw new Error('Offline');
    return { is_dir: true };
  });
  expect((await recent.validate(stat, { force: true })).map((e) => e.name).sort()).toEqual(['directory', 'missing']);
  expect(recent.list().map((e) => e.name).sort()).toEqual(['Local', 'offline']);
  expect(stat).toHaveBeenCalledTimes(3);
});
