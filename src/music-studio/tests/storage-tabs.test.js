import { describe, it, expect } from 'vitest';
import { claimTab, pickDraft, LEGACY_KEY, STALE_MS, KEEP_UNOWNED } from '../src/storage/tabs.js';

/** A fake Web Locks API: locks are held until released by the test. */
function fakeLocks(held = []) {
  const names = new Set(held);
  return {
    names,
    async request(name, opts, cb) {
      if (names.has(name)) return cb(null);
      names.add(name);
      return cb({ name });
    },
    async query() {
      return { held: [...names].map((name) => ({ name })) };
    },
  };
}

const fakeSession = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m };
};

describe('tab slots', () => {
  it('keeps the slot across a reload and holds its lock', async () => {
    const locks = fakeLocks();
    const session = fakeSession({ 'music-studio:tab': 'abc' });
    const tab = await claimTab({ locks, session });
    expect(tab.key).toBe('tab:abc');
    expect([...(await tab.liveKeys())]).toEqual(['tab:abc']);
  });

  it('gives a duplicated tab (same sessionStorage, lock taken) a new slot', async () => {
    const locks = fakeLocks(['music-studio-tab-abc']);
    const session = fakeSession({ 'music-studio:tab': 'abc' });
    const tab = await claimTab({ locks, session });
    expect(tab.key).not.toBe('tab:abc');
    expect(session.m.get('music-studio:tab')).toBe(tab.key.slice(4));
  });

  it('shares the legacy key without the Web Locks API', async () => {
    const tab = await claimTab({ locks: undefined, session: fakeSession() });
    expect(tab.key).toBe(LEGACY_KEY);
  });
});

describe('pickDraft', () => {
  const now = 1_000_000_000_000;
  const d = (at) => ({ json: '{}', at });

  it('prefers the tab\'s own draft (a reload)', () => {
    const r = pickDraft([['tab:a', d(now - 10)], ['tab:b', d(now)]], { own: 'tab:a', live: new Set(['tab:a']), now });
    expect(r.key).toBe('tab:a');
  });

  it('restores the newest draft that no open tab owns', () => {
    const r = pickDraft([['tab:x', d(now - 50)], ['tab:y', d(now - 5)], ['tab:live', d(now)]], { own: 'tab:new', live: new Set(['tab:new', 'tab:live']), now });
    expect(r.key).toBe('tab:y');
    expect(r.busy).toBe(false);
  });

  it('reports busy when every draft belongs to another open tab', () => {
    const r = pickDraft([['tab:live', d(now)]], { own: 'tab:new', live: new Set(['tab:new', 'tab:live']), now });
    expect(r.draft).toBe(null);
    expect(r.busy).toBe(true);
  });

  it('adopts the legacy shared draft and prunes stale or excess unowned drafts', () => {
    const entries = [[LEGACY_KEY, d(now - 1)], ['tab:old', d(now - STALE_MS - 1)], ...Array.from({ length: KEEP_UNOWNED + 2 }, (_, i) => [`tab:u${i}`, d(now - 100 - i)])];
    const r = pickDraft(entries, { own: 'tab:me', live: new Set(['tab:me']), now });
    expect(r.key).toBe(LEGACY_KEY);
    expect(r.remove).toContain('tab:old');
    expect(r.remove.length).toBeGreaterThanOrEqual(3);
    expect(r.remove).not.toContain(LEGACY_KEY);
  });
});
