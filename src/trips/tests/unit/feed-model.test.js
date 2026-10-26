import { describe, expect, it, vi } from 'vitest';
import { areaOf, authorsOf, filterFeed, groupBursts, tabOf } from '../../src/views/trip/collab/feed/model.js';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const MIN = 60_000;
const item = (t, id, op = 'change', fields = []) => ({ t, id, name: id, op, fields });
const entry = (rev, by, at, items) => ({ rev, by, at, items });

describe('feed model', () => {
  it('maps types to areas and tabs', () => {
    expect(['place', 'visit', 'res', 'exp', 'todo', 'file', 'msg', 'meta', 'unknownType'].map(areaOf)).toEqual(['plan', 'plan', 'bookings', 'costs', 'lists', 'files', 'collab', 'trip', 'trip']);
    expect(tabOf(item('res', 'r1'))).toBe('bookings');
    expect(tabOf(item('member', 'm1'))).toBe('members');
    expect(tabOf(item('meta', 'meta'))).toBeNull();
    expect(tabOf(item('place', 'p1', 'remove'))).toBeNull();
  });

  it('filters by area and person, dropping emptied entries', () => {
    const feed = [entry(1, A, 0, [item('place', 'p1'), item('exp', 'e1')]), entry(2, B, MIN, [item('exp', 'e2')]), entry(3, B, 2 * MIN, [item('todo', 't1')])];
    expect(filterFeed(feed, { area: 'costs' }).map((e) => [e.rev, e.items.map((i) => i.id)])).toEqual([[1, ['e1']], [2, ['e2']]]);
    expect(filterFeed(feed, { person: 'me', uid: A }).map((e) => e.rev)).toEqual([1]);
    expect(filterFeed(feed, { person: 'others', uid: A }).map((e) => e.rev)).toEqual([2, 3]);
    expect(filterFeed(feed, { person: B, area: 'lists' }).map((e) => e.rev)).toEqual([3]);
    expect(filterFeed(feed, {})).toEqual(feed);
    expect(authorsOf(feed)).toEqual([A, B]);
  });

  it('merges quick successive entries by one person, newest first', () => {
    const newestFirst = [
      entry(5, A, 30 * MIN, [item('place', 'p1', 'change', ['notes'])]),
      entry(4, A, 20 * MIN, [item('place', 'p1', 'change', ['name']), item('visit', 'v1', 'add')]),
      entry(3, A, 6 * MIN, [item('place', 'p1', 'add')]),
      entry(2, B, 5 * MIN, [item('exp', 'e1', 'add')]),
      entry(1, A, 0, [item('day', 'd1')]),
    ];
    const grouped = groupBursts(newestFirst);
    expect(grouped.map((e) => [e.by === A ? 'A' : 'B', e.revs])).toEqual([['A', [5, 4, 3]], ['B', [2]], ['A', [1]]]);
    expect(grouped[0]).toMatchObject({ at: 30 * MIN, oldest: 6 * MIN, rev: 5 });
    expect(grouped[0].items.map((i) => [i.id, i.op, i.fields])).toEqual([['p1', 'add', ['notes', 'name']], ['v1', 'add', []]]);
    expect(groupBursts(newestFirst, { gap: 5 * MIN }).map((e) => e.revs)).toEqual([[5], [4], [3], [2], [1]]);
  });
});

describe('activity view', () => {
  it('links items to their tab, marks unread entries and filters', async () => {
    const { createCollabContext } = await import('../../src/views/trip/collab/common.js');
    const { mountFeed } = await import('../../src/views/trip/collab/feed/index.js');
    localStorage.clear();
    const now = Date.now();
    const feed = [
      entry(1, A, now - 3 * 3_600_000, [item('place', 'Museum', 'add')]),
      entry(2, B, now - 2 * 3_600_000, [item('res', 'Flight', 'change', ['legs', 'code'])]),
      entry(3, B, now - 3_600_000, [item('exp', 'Dinner', 'remove')]),
    ];
    const space = { ref: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' }, role: 'editor', feed: async () => feed, subscribe: () => () => {},
      members: () => [{ uid: A, name: 'Alice' }, { uid: B, name: 'Bob' }], can: () => true };
    const ctx = createCollabContext({ space, uid: A, route: { name: 'space', ref: space.ref, tab: 'collab' } });
    const container = document.createElement('div');
    document.body.append(container);
    mountFeed(container, ctx, { unreadAtOpen: Promise.resolve(1) });
    await vi.waitFor(() => expect(container.querySelectorAll('.feed-entry')).toHaveLength(3));
    const entries = [...container.querySelectorAll('.feed-entry')];
    expect(entries.map((node) => node.dataset.rev)).toEqual(['3', '2', '1']);
    expect(entries[0].classList.contains('is-new')).toBe(true);
    expect(container.querySelector('.feed-divider')).not.toBeNull();
    const links = [...container.querySelectorAll('a.feed-item-link')].map((node) => node.getAttribute('href'));
    expect(links).toEqual(['#/t/trips-abcdefghij/0000000000000001/bookings', '#/t/trips-abcdefghij/0000000000000001/plan']);
    expect(container.textContent).toContain('confirmation code');
    const area = container.querySelector('select.feed-filter');
    area.value = 'costs';
    area.dispatchEvent(new Event('change'));
    expect([...container.querySelectorAll('.feed-entry')].map((node) => node.dataset.rev)).toEqual(['3']);
    expect(container.querySelector('.feed-count').textContent).toBe('Showing 1 of 3 changes');
  });
});
