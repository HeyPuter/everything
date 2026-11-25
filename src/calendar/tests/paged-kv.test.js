import { describe, it, expect, vi } from 'vitest';
import { createPagedKv, isCompleteListing } from '../src/js/paged-kv.js';
import { createStore, listAllEntries } from '../src/js/store.js';

/** A puter.kv stand-in that pages like the real one: `limit` rows and a
 *  `cursor` while more remain, capped at `maxPage` whatever is asked for. */
function makePagingKv(entries, { maxPage = 1000 } = {}) {
  const sorted = () => [...entries.keys()].sort();
  const list = vi.fn(async (opts) => {
    if (opts === null || typeof opts !== 'object') throw new Error('expected the options form');
    const prefix = String(opts.pattern).replace(/\*$/, '');
    const keys = sorted().filter((k) => k.startsWith(prefix));
    const from = opts.cursor ? keys.indexOf(opts.cursor) + 1 : 0;
    const size = Math.min(opts.limit ?? maxPage, maxPage);
    const page = keys.slice(from, from + size);
    const items = opts.returnValues ? page.map((key) => ({ key, value: entries.get(key) })) : page;
    const more = from + size < keys.length;
    return { items, ...(more ? { cursor: page[page.length - 1] } : {}) };
  });
  return {
    list,
    get: vi.fn(async (k) => (entries.has(k) ? entries.get(k) : null)),
    set: vi.fn(async (k, v) => (entries.set(k, v), true)),
    del: vi.fn(async (k) => entries.delete(k)),
    incr: vi.fn(async () => 1),
  };
}

const seedEvents = (n) => {
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const id = `${(i % 16).toString(16)}${String(i).padStart(5, '0')}`;
    entries.set(`cal:evt:${id}`, { id, title: `E${i}`, start: 1_800_000_000_000 + i, end: 1_800_000_003_600 + i });
  }
  return entries;
};

describe('createPagedKv', () => {
  it('follows cursors to the last page and returns every entry', async () => {
    const raw = makePagingKv(seedEvents(2139));
    const kv = createPagedKv(raw);
    const all = await kv.list('cal:evt:*', true);
    expect(all).toHaveLength(2139);
    expect(new Set(all.map((e) => e.key)).size).toBe(2139);
    expect(all[0]).toHaveProperty('value.title');
    expect(raw.list).toHaveBeenCalledTimes(3); // 1000 + 1000 + 139
    expect(raw.list.mock.calls[0][0]).toEqual({ pattern: 'cal:evt:*', returnValues: true, limit: 1000 });
    expect(raw.list.mock.calls[1][0].cursor).toBeTruthy();
    expect(isCompleteListing(all)).toBe(true);
  });

  it('lists keys without values, and an empty namespace as one empty page', async () => {
    const raw = makePagingKv(seedEvents(3));
    const kv = createPagedKv(raw);
    expect(await kv.list('cal:evt:*')).toEqual([...seedEvents(3).keys()].sort());
    expect(raw.list.mock.calls[0][0].returnValues).toBe(false);
    const none = await kv.list('cal:task:*', true);
    expect(none).toEqual([]);
    expect(isCompleteListing(none)).toBe(true);
  });

  it('keeps going through pages shorter than the limit', async () => {
    // The server may return fewer rows than asked for; only a missing cursor ends it.
    const raw = makePagingKv(seedEvents(250), { maxPage: 40 });
    const kv = createPagedKv(raw);
    expect(await kv.list('cal:evt:*', true)).toHaveLength(250);
    expect(raw.list).toHaveBeenCalledTimes(7);
  });

  it('does not vouch for a server that answers with a bare array', async () => {
    const flat = [{ key: 'cal:evt:a', value: { id: 'a' } }];
    const raw = { list: vi.fn(async () => flat) };
    const kv = createPagedKv(raw);
    expect(await kv.list('cal:evt:*', true)).toBe(flat);
    expect(isCompleteListing(flat)).toBe(false);
  });

  it('stops on a cursor that never ends, without vouching for the result', async () => {
    const raw = { list: vi.fn(async () => ({ items: ['k'], cursor: 'again' })) };
    const kv = createPagedKv(raw);
    const got = await kv.list('cal:evt:*');
    expect(got.length).toBe(raw.list.mock.calls.length);
    expect(raw.list.mock.calls.length).toBeLessThanOrEqual(500);
    expect(isCompleteListing(got)).toBe(false);
  });

  it('lets a failed page reject the whole listing', async () => {
    const raw = makePagingKv(seedEvents(1500));
    const real = raw.list.getMockImplementation();
    raw.list.mockImplementation(async (opts) => {
      if (opts.cursor) throw Object.assign(new Error('Too many requests.'), { code: 'too_many_requests' });
      return real(opts);
    });
    await expect(createPagedKv(raw).list('cal:evt:*', true)).rejects.toMatchObject({ code: 'too_many_requests' });
  });

  it('passes every other call straight through', async () => {
    const raw = makePagingKv(new Map());
    const kv = createPagedKv(raw);
    await kv.set('k', 1);
    expect(await kv.get('k')).toBe(1);
    expect(await kv.incr('n')).toBe(1);
    await kv.del('k');
    expect(raw.set).toHaveBeenCalledWith('k', 1);
    expect(raw.del).toHaveBeenCalledWith('k');
    expect(kv.expire).toBeUndefined(); // not on the backend, so not invented
  });
});

describe('a store on the paged backend', () => {
  it('loads a big calendar in pages, with no shard fan-out', async () => {
    const raw = makePagingKv(seedEvents(2139));
    const s = createStore(createPagedKv(raw));
    await s.load();
    expect(s.getAllEvents()).toHaveLength(2139);
    // Three pages of events and one (empty) page of tasks.
    expect(raw.list).toHaveBeenCalledTimes(4);
    expect(raw.list.mock.calls.every(([o]) => o.pattern === 'cal:evt:*' || o.pattern === 'cal:task:*')).toBe(true);
  });

  it('listAllEntries still shards a big result the backend does not vouch for', async () => {
    const entries = seedEvents(600);
    const flatOnly = {
      list: vi.fn(async (pattern, rv) => {
        const prefix = String(pattern).replace(/\*$/, '');
        const keys = [...entries.keys()].filter((k) => k.startsWith(prefix));
        return rv ? keys.map((key) => ({ key, value: entries.get(key) })) : keys;
      }),
    };
    expect(await listAllEntries(flatOnly, 'cal:evt:')).toHaveLength(600);
    expect(flatOnly.list.mock.calls.length).toBe(17); // the flat list and 16 shards
  });
});
