import { afterEach, describe, expect, it } from 'vitest';
import { setPuterForTests } from '../src/platform/puter';
import { sharedWithMe } from '../src/app/share';

afterEach(() => setPuterForTests(null));

describe('sharedWithMe', () => {
  it('follows the cursor through short pages and keeps only part files', async () => {
    const pages: Record<string, { items: unknown[]; cursor: string | null }> = {
      start: { items: [{ name: 'Bracket.parametric', path: '/alice/Parts/Bracket.parametric', modified: 1700000000, owner: { username: 'alice' }, mode: 'write' }], cursor: 'p2' },
      p2: { items: [], cursor: 'p3' },
      p3: { items: [{ name: 'notes.txt', path: '/bob/notes.txt' }, { name: 'Parts', path: '/bob/Parts', is_dir: true }, { name: 'Flange.parametric', path: '/bob/Flange.parametric', owner: 'bob' }], cursor: null },
    };
    const calls: (string | null | undefined)[] = [];
    setPuterForTests({
      env: 'app',
      fs: { listShared: async ({ cursor }: { cursor?: string | null }) => { calls.push(cursor); return pages[cursor ?? 'start']; } },
    } as never);
    const items = await sharedWithMe();
    expect(calls).toEqual([null, 'p2', 'p3']);
    expect(items.map((i) => [i.name, i.owner, i.mode])).toEqual([['Bracket', 'alice', 'write'], ['Flange', 'bob', 'read']]);
    expect(items[0].modified).toBe(1700000000000);
  });

  it('reports a failure to list rather than an empty list, but keeps pages already read', async () => {
    setPuterForTests({ env: 'app', fs: { listShared: async () => { throw new TypeError('Failed to fetch'); } } } as never);
    await expect(sharedWithMe()).rejects.toThrow('Failed to fetch');
    let n = 0;
    setPuterForTests({
      env: 'app',
      fs: { listShared: async () => { if (n++) throw new TypeError('Failed to fetch'); return { items: [{ name: 'A.parametric', path: '/a/A.parametric' }], cursor: 'p2' }; } },
    } as never);
    expect((await sharedWithMe()).map((i) => i.name)).toEqual(['A']);
  });

  it('returns nothing without cloud storage', async () => {
    expect(await sharedWithMe()).toEqual([]);
  });
});
