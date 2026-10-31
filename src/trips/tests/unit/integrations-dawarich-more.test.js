import { afterEach, describe, expect, it, vi } from 'vitest';
import { bucketMatches, journeyEntries, metersBetween } from '../../src/lib/integrations/dawarich-match.js';
import { bucketSection, journeyButton } from '../../src/views/integrations/stays/index.js';
import { validateEntity } from '../../src/shared/schema/index.js';

const stay = (fields) => ({ name: 'Cafe', date: '2026-06-01', time: '10:30', lat: 38.7139, lng: -9.1394, start: Date.parse('2026-06-01T09:30:00Z'), ...fields });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => document.body.replaceChildren());

describe('stays as journey check-ins', () => {
  it('makes valid entries in order, named or not', () => {
    const entries = journeyEntries([stay({}), stay({ name: '', time: '25:00', cc: 'PT' }), stay({ date: null })], { fallbackTitle: 'A stay' });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'checkin', date: '2026-06-01', time: '10:30', title: 'Cafe', loc: { name: 'Cafe', lat: 38.7139, lng: -9.1394 } });
    expect(entries[1].title).toBe('A stay');
    expect(entries[1].time).toBeUndefined();
    expect(entries[1].loc).toEqual({ lat: 38.7139, lng: -9.1394, cc: 'PT' });
    expect(entries[0].order < entries[1].order).toBe(true);
    for (const entry of entries) expect(() => validateEntity('journey', 'entry', entry)).not.toThrow();
  });
});

describe('bucket-list matches', () => {
  const locate = (lat) => (lat > 40 ? 'ES' : 'PT');
  it('matches places within 2 km and countries by the atlas lookup, earliest stay first', () => {
    const near = { id: 'a', name: 'Praça do Comércio', lat: 38.7075, lng: -9.1364 };
    const far = { id: 'b', name: 'Sintra', lat: 38.7972, lng: -9.3906 };
    const spain = { id: 'c', name: '', cc: 'ES' };
    const done = { id: 'd', name: 'Done', lat: 38.7139, lng: -9.1394, visitedAt: '2020-01-01' };
    const stays = [stay({ start: 2, date: '2026-06-02' }), stay({ start: 1 }), stay({ lat: 41.38, lng: 2.17, start: 3, date: '2026-06-05', name: 'Barcelona' })];
    const matches = bucketMatches(stays, [near, far, spain, done], { locate });
    expect(matches.map((match) => [match.item.id, match.date])).toEqual([['a', '2026-06-01'], ['c', '2026-06-05']]);
    expect(metersBetween(near, stays[0])).toBeLessThan(2000);
  });
});

describe('Dawarich extras in the dialogs', () => {
  it('adds the chosen stays to the only journey', async () => {
    const commit = vi.fn(async (_ref, text) => ({ done: Object.fromEntries(JSON.parse(text).ops.map((op) => [op.opId, 4])) }));
    const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'journey' };
    const personal = { spaces: { list: async () => [{ ref, role: 'editor', title: 'Portugal' }, { ref: { ...ref, s: '0000000000000002' }, role: 'viewer', title: 'Not mine' }] } };
    const onAdded = vi.fn();
    const node = journeyButton({ context: { session: { api: { commit }, personal } }, selected: () => [stay({})], onAdded, onError: (error) => { throw error; } });
    await flush();
    expect(node.hidden).toBe(false);
    node.click();
    await flush(); await flush();
    const [target, text] = commit.mock.calls[0];
    expect(target).toEqual(ref);
    expect(JSON.parse(text).ops[0]).toMatchObject({ t: 'entry', put: { type: 'checkin', title: 'Cafe' } });
    expect(onAdded).toHaveBeenCalledWith([expect.objectContaining({ name: 'Cafe' })], ref.s);
  });

  it('stays hidden without a journey to write in', async () => {
    const node = journeyButton({ context: { session: { api: {}, personal: { spaces: { list: async () => [] } } } }, selected: () => [], onAdded: () => {}, onError: () => {} });
    await flush();
    expect(node.hidden).toBe(true);
  });

  it('marks matched bucket-list items visited', async () => {
    const index = { aaaaaaaaaaaaaaaa: { name: 'Praça do Comércio', lat: 38.7075, lng: -9.1364, upd: 1 } };
    const items = { 'me:bucket:aaaaaaaaaaaaaaaa': { name: 'Praça do Comércio', lat: 38.7075, lng: -9.1364, upd: 1 } };
    const personal = {
      get: async (key) => (key === 'me:buckets' ? index : items[key] ?? null),
      set: async (key, value) => { items[key] = value; },
      refresh: async () => {},
      subscribe: () => () => {},
    };
    const puter = { authToken: 't', kv: { update: vi.fn(async (_key, patch) => Object.assign(index, patch)) } };
    const { element } = await bucketSection({ puter, personal, stays: [stay({})], locate: () => 'PT', onError: (error) => { throw error; } });
    document.body.append(element);
    [...element.querySelectorAll('button')].find((node) => node.textContent === 'Mark 1 visited').click();
    await flush(); await flush();
    expect(items['me:bucket:aaaaaaaaaaaaaaaa'].visitedAt).toBe('2026-06-01');
    expect(element.textContent).toContain('Visited');
  });
});
