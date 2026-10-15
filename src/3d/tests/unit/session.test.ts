import { describe, it, expect } from 'vitest';
import { bumpRecent, MAX_RECENT, type RecentEntry } from '../../src/io/recentlist';

const e = (name: string, time = 0): RecentEntry => ({ name, time, size: 1 });

describe('recent files list', () => {
  it('puts the latest file first without duplicates', () => {
    const { list } = bumpRecent([e('a'), e('b'), e('c')], e('b', 5));
    expect(list.map((x) => x.name)).toEqual(['b', 'a', 'c']);
    expect(list[0].time).toBe(5);
  });
  it('drops the oldest beyond the limit', () => {
    const many = Array.from({ length: MAX_RECENT }, (_, i) => e(`f${i}`));
    const { list, dropped } = bumpRecent(many, e('new'));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].name).toBe('new');
    expect(dropped).toEqual([`f${MAX_RECENT - 1}`]);
  });
});
