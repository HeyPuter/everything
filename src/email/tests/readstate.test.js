import { describe, it, expect, vi } from 'vitest';
import {
  createReadState, createStarState, createOriginState, createImageState, mergeFlags, flagId,
  memoryStorage,
} from '../src/lib/readstate.js';

// The stored shape is { id: seconds }, negative when the flag was turned off.
const stored = (storage, key) => JSON.parse(storage.getItem(key));

// A change is written to storage in a microtask, so a burst of them costs one
// write; a test that reads the storage waits for that.
const written = () => Promise.resolve();

describe('remote image consent', () => {
  it('requires explicit consent even for sender names inherited from Object', () => {
    const storage = memoryStorage();
    const state = createImageState('user', storage);
    for (const sender of ['constructor', '__proto__', 'newsletter@example.com']) {
      expect(state.allows(sender)).toBe(false);
      state.allow(sender);
      expect(state.allows(sender)).toBe(true);
      expect(createImageState('user', storage).allows(sender)).toBe(true);
      expect(createImageState('other', storage).allows(sender)).toBe(false);
    }
  });

  it('keeps consent case insensitive and ignores an empty sender', () => {
    const state = createImageState('user', memoryStorage());
    state.allow(' Newsletter@Example.com ');
    expect(state.allows('newsletter@example.com')).toBe(true);
    state.allow('');
    expect(state.allows('')).toBe(false);
  });

  it('still requires consent after trimming the store or recovering corrupt storage', () => {
    const storage = memoryStorage();
    storage.setItem('puter-mail:images:user', '{invalid');
    const state = createImageState('user', storage);
    expect(state.allows('constructor')).toBe(false);
    for (let i = 0; i < 501; i++) state.allow(`sender${i}@example.com`);
    expect(state.allows('constructor')).toBe(false);
    expect(state.allows('__proto__')).toBe(false);
    expect(state.allows('sender0@example.com')).toBe(false);
    expect(state.allows('sender500@example.com')).toBe(true);
  });
});

describe('createReadState', () => {
  it('marks and reports messages as read', () => {
    const state = createReadState('user', memoryStorage());
    expect(state.isRead('m1')).toBe(false);
    state.markRead('m1');
    expect(state.isRead('m1')).toBe(true);
  });

  it('persists through the storage it was given', async () => {
    const storage = memoryStorage();
    createReadState('user', storage).markRead('m1');
    await written();
    expect(createReadState('user', storage).isRead('m1')).toBe(true);
  });

  it('writes a burst of changes to storage once', async () => {
    let writes = 0;
    const storage = memoryStorage();
    const counted = { ...storage, setItem: (k, v) => { writes++; storage.setItem(k, v); } };
    const state = createReadState('user', counted);
    for (let i = 0; i < 300; i++) state.markRead(`m${i}`);
    expect(state.isRead('m299')).toBe(true);
    expect(writes).toBe(0);
    await written();
    expect(writes).toBe(1);
    expect(Object.keys(stored(storage, 'puter-mail:read:user'))).toHaveLength(300);
  });

  it('scopes state per account', () => {
    const storage = memoryStorage();
    createReadState('alice', storage).markRead('m1');
    expect(createReadState('bob', storage).isRead('m1')).toBe(false);
  });

  it('counts unread ids', () => {
    const state = createReadState('user', memoryStorage());
    state.markRead('m2');
    expect(state.unreadCount(['m1', 'm2', 'm3'])).toBe(2);
  });

  it('keeps one entry per id and ignores an empty one', async () => {
    const storage = memoryStorage();
    const state = createReadState('user', storage);
    state.markRead('m1');
    state.markRead('m1');
    state.markRead('');
    await written();
    expect(Object.keys(stored(storage, 'puter-mail:read:user'))).toEqual(['m1']);
  });

  it('keys flags by the uuid part of the filename, not the whole name', async () => {
    const storage = memoryStorage();
    const state = createReadState('user', storage);
    state.markRead('0198d3cb-b700-777c-abf5-8204667dff5b--SGVsbG8');
    await written();
    expect(Object.keys(stored(storage, 'puter-mail:read:user')))
      .toEqual(['0198d3cb-b700-777c-abf5-8204667dff5b']);
    expect(state.isRead('0198d3cb-b700-777c-abf5-8204667dff5b--SGVsbG8')).toBe(true);
  });

  it('reads the id-list format an earlier version stored', () => {
    const storage = memoryStorage();
    storage.setItem('puter-mail:read:user', JSON.stringify(['m1--x', 'm2--y']));
    const state = createReadState('user', storage);
    expect(state.isRead('m1--x')).toBe(true);
    expect(state.isRead('m3--z')).toBe(false);
  });

  it('drops the oldest changes past the cap', async () => {
    const storage = memoryStorage();
    const state = createReadState('user', storage);
    for (let i = 0; i < 5001; i++) state.markRead(`m${i}`);
    await written();
    expect(state.isRead('m0')).toBe(false);
    expect(state.isRead('m1')).toBe(true);
    expect(state.isRead('m5000')).toBe(true);
    expect(Object.keys(stored(storage, 'puter-mail:read:user'))).toHaveLength(5000);
    // A store reopened over a full set stamps its next change after every
    // stamp it holds, so what it drops is still the oldest change -- not the
    // one just made.
    const again = createReadState('user', storage);
    again.markRead('m5001');
    await written();
    expect(again.isRead('m1')).toBe(false);
    expect(again.isRead('m5001')).toBe(true);
    expect(Object.keys(stored(storage, 'puter-mail:read:user'))).toHaveLength(5000);
  });

  it('marks a message unread again, and remembers that', () => {
    const storage = memoryStorage();
    const state = createReadState('user', storage);
    state.markRead('m1');
    state.markUnread('m1');
    expect(state.isRead('m1')).toBe(false);
    expect(createReadState('user', storage).isRead('m1')).toBe(false);
    expect(state.unreadCount(['m1'])).toBe(1);
  });

  it('tolerates corrupt stored state', () => {
    const storage = memoryStorage();
    storage.setItem('puter-mail:read:user', '{not json');
    const state = createReadState('user', storage);
    expect(state.isRead('m1')).toBe(false);
    state.markRead('m1');
    expect(state.isRead('m1')).toBe(true);
  });

  it('tolerates a storage that throws (private mode, quota)', () => {
    const broken = {
      getItem: () => { throw new Error('nope'); },
      setItem: () => { throw new Error('nope'); },
    };
    expect(() => {
      const state = createReadState('user', broken);
      state.markRead('m1');
      expect(state.isRead('m1')).toBe(true);
    }).not.toThrow();
  });
});

describe('createStarState', () => {
  it('toggles a star on and off, reporting the new state', () => {
    const stars = createStarState('user', memoryStorage());
    expect(stars.isStarred('m1')).toBe(false);
    expect(stars.toggle('m1')).toBe(true);
    expect(stars.isStarred('m1')).toBe(true);
    expect(stars.toggle('m1')).toBe(false);
    expect(stars.isStarred('m1')).toBe(false);
  });

  it('persists stars through the storage it was given', async () => {
    const storage = memoryStorage();
    createStarState('user', storage).toggle('m1');
    await written();
    expect(createStarState('user', storage).isStarred('m1')).toBe(true);
  });

  it('unstarring persists too', async () => {
    const storage = memoryStorage();
    const stars = createStarState('user', storage);
    stars.toggle('m1');
    stars.toggle('m1');
    await written();
    expect(createStarState('user', storage).isStarred('m1')).toBe(false);
  });

  it('keeps stars separate from read state in the same storage', () => {
    const storage = memoryStorage();
    const stars = createStarState('user', storage);
    const reads = createReadState('user', storage);
    stars.toggle('m1');
    expect(reads.isRead('m1')).toBe(false);
    reads.markRead('m2');
    expect(stars.isStarred('m2')).toBe(false);
  });
});


describe('createOriginState', () => {
  it('answers inbox for a message it has never seen', () => {
    expect(createOriginState('me', memoryStorage()).get('a--x')).toBe('inbox');
  });

  it('remembers where a message came from, so restore puts it back there', () => {
    const state = createOriginState('me', memoryStorage());
    state.set('a--x', 'sent');
    expect(state.get('a--x')).toBe('sent');
  });

  it('forgets an entry once the message has been restored', () => {
    const state = createOriginState('me', memoryStorage());
    state.set('a--x', 'sent');
    state.clear('a--x');
    expect(state.get('a--x')).toBe('inbox');
  });

  it('survives a reload through the same storage', () => {
    const storage = memoryStorage();
    createOriginState('me', storage).set('a--x', 'archive');
    expect(createOriginState('me', storage).get('a--x')).toBe('archive');
  });

  it('is scoped per account', () => {
    const storage = memoryStorage();
    createOriginState('me', storage).set('a--x', 'sent');
    expect(createOriginState('you', storage).get('a--x')).toBe('inbox');
  });

  it('ignores stored junk rather than throwing', () => {
    const storage = memoryStorage();
    storage.setItem('puter-mail:origin:me', '["not", "an", "object"]');
    expect(createOriginState('me', storage).get('a--x')).toBe('inbox');
    storage.setItem('puter-mail:origin:me', 'not json at all');
    expect(createOriginState('me', storage).get('a--x')).toBe('inbox');
  });
});


describe('flagId', () => {
  it('is the uuid part of a mailbox filename', () => {
    expect(flagId('0198d3cb-b700-777c-abf5-8204667dff5b--SGVsbG8'))
      .toBe('0198d3cb-b700-777c-abf5-8204667dff5b');
  });

  it('leaves a name with no separator alone', () => {
    expect(flagId('plain-name')).toBe('plain-name');
    expect(flagId('')).toBe('');
  });
});

describe('mergeFlags', () => {
  it('unions two devices that read different messages', () => {
    expect(mergeFlags({ a: 100 }, { b: 200 })).toEqual({ a: 100, b: 200 });
  });

  it('lets the more recent change win, in either direction', () => {
    // One device marked it read, the other marked it unread afterwards.
    expect(mergeFlags({ a: 100 }, { a: -200 })).toEqual({ a: -200 });
    // And the other way round: read after unread stays read.
    expect(mergeFlags({ a: -100 }, { a: 200 })).toEqual({ a: 200 });
  });

  it('keeps an older local change when the account store is behind', () => {
    expect(mergeFlags({ a: 300 }, { a: 100 })).toEqual({ a: 300 });
  });

  it('keeps the flag on when both changed in the same second', () => {
    expect(mergeFlags({ a: 100 }, { a: -100 })).toEqual({ a: 100 });
    expect(mergeFlags({ a: -100 }, { a: 100 })).toEqual({ a: 100 });
  });

  it('is order independent for different ids', () => {
    const a = { x: 10, y: -20 };
    const b = { y: 30, z: 40 };
    expect(mergeFlags(a, b)).toEqual(mergeFlags(b, a));
  });

  it('does not mutate either side', () => {
    const mine = { a: 100 };
    const theirs = { a: 200, b: 300 };
    mergeFlags(mine, theirs);
    expect(mine).toEqual({ a: 100 });
    expect(theirs).toEqual({ a: 200, b: 300 });
  });

  it('reads the old id-list format from either side', () => {
    expect(mergeFlags(['a--x'], { b: 200 })).toEqual({ a: 1, b: 200 });
    expect(mergeFlags({ a: 500 }, ['a--x'])).toEqual({ a: 500 });
  });

  it('ignores junk values rather than storing them', () => {
    expect(mergeFlags({ a: 'yesterday', b: null, c: 0, d: 100 }, {})).toEqual({ d: 100 });
    expect(mergeFlags(null, undefined)).toEqual({});
  });

  it('caps the merged set at the most recently changed ids', () => {
    const mine = Object.fromEntries(Array.from({ length: 4000 }, (unused, i) => [`m${i}`, i + 1]));
    const theirs = Object.fromEntries(Array.from({ length: 4000 }, (unused, i) => [`t${i}`, i + 1]));
    const merged = mergeFlags(mine, theirs);
    expect(Object.keys(merged)).toHaveLength(5000);
    // The oldest stamps are the ones dropped.
    expect(merged.m1).toBeUndefined();
    expect(merged.m3999).toBe(4000);
    expect(merged.t3999).toBe(4000);
  });
});

describe('flags against an account store', () => {
  // A fake puter.kv: one string per key, with the calls it received.
  const fakeKv = (initial = {}) => {
    const values = { ...initial };
    const calls = { get: [], set: [] };
    return {
      values,
      calls,
      get: async (key) => { calls.get.push(key); return values[key] ?? null; },
      set: async (key, value) => { calls.set.push(key); values[key] = value; },
    };
  };

  it('lets a later change on another device win over an earlier bulk mark', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.UTC(2026, 9, 20, 12, 0, 0);
      vi.setSystemTime(start);
      const remote = fakeKv();
      const a = createReadState('user', memoryStorage(), { remote });
      const b = createReadState('user', memoryStorage(), { remote });
      // Device A marks 3,000 messages read in one go, and pushes.
      const ids = Array.from({ length: 3000 }, (unused, i) => `0199${String(i).padStart(8, '0')}--x`);
      for (const id of ids) a.markRead(id);
      await vi.advanceTimersByTimeAsync(2000);
      // Ten minutes later device B, which has not pulled since, reads the
      // newest of them and then marks it unread.
      const target = ids.at(-1);
      vi.setSystemTime(start + 10 * 60_000);
      b.markRead(target);
      vi.setSystemTime(start + 10 * 60_000 + 5000);
      b.markUnread(target);
      await vi.advanceTimersByTimeAsync(2000);
      await a.pull();
      expect(b.isRead(target)).toBe(false);
      expect(a.isRead(target)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pulls the account state into the local cache and reports the change', async () => {
    const remote = fakeKv({ 'puter-mail:read:user': JSON.stringify({ m1: 500 }) });
    let notified = 0;
    const state = createReadState('user', memoryStorage(), { remote, onChange: () => { notified++; } });
    expect(state.isRead('m1')).toBe(false);
    expect(await state.pull()).toBe(true);
    expect(state.isRead('m1')).toBe(true);
    expect(notified).toBe(1);
  });

  it('pushes local flags the account did not have', async () => {
    const remote = fakeKv();
    const state = createStarState('user', memoryStorage(), { remote });
    state.toggle('m1--x');
    await state.pull();
    expect(JSON.parse(remote.values['puter-mail:star:user']).m1).toBeGreaterThan(0);
  });

  it('says nothing changed when both sides already agree', async () => {
    const storage = memoryStorage();
    const first = createReadState('user', storage, { remote: fakeKv() });
    first.markRead('m1');
    await written();
    const remote = fakeKv({ 'puter-mail:read:user': storage.getItem('puter-mail:read:user') });
    const state = createReadState('user', storage, { remote });
    expect(await state.pull()).toBe(false);
    expect(remote.calls.set).toEqual([]);
  });

  it('keeps working when the account store is unreachable', async () => {
    const remote = {
      get: async () => { throw new Error('offline'); },
      set: async () => { throw new Error('offline'); },
    };
    const state = createReadState('user', memoryStorage(), { remote });
    state.markRead('m1');
    expect(await state.pull()).toBe(false);
    expect(state.isRead('m1')).toBe(true);
  });

  it('never touches an account store it was not given', async () => {
    const state = createReadState('sample', memoryStorage());
    state.markRead('m1');
    expect(await state.pull()).toBe(false);
    expect(state.isRead('m1')).toBe(true);
  });

  it('an unread on this device survives a merge with a device that read it', async () => {
    const storage = memoryStorage();
    const remote = fakeKv();
    const state = createReadState('user', storage, { remote });
    state.markRead('m1');
    await state.pull();
    // The other device is still holding the older "read" stamp.
    const stale = JSON.parse(remote.values['puter-mail:read:user']);
    state.markUnread('m1');
    remote.values['puter-mail:read:user'] = JSON.stringify(stale);
    await state.pull();
    expect(state.isRead('m1')).toBe(false);
    expect(JSON.parse(remote.values['puter-mail:read:user']).m1).toBeLessThan(0);
  });
});
