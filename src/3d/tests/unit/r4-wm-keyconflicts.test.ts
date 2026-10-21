import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/app/app', () => ({ app: {} }));
vi.mock('../../src/ui/menu', () => ({ menuKey: () => false, pieOpen: () => false, openMenu: () => {} }));
vi.mock('../../src/app/prefs', () => ({ prefs: {} }));

describe('key conflicts', () => {
  it('reports bindings that one key press would trigger together', async () => {
    const { keyConflicts } = await import('../../src/prefs/keyconflicts');
    const when = () => true;
    const r = keyConflicts({
      A: [
        { key: 'G', op: 'transform.translate' },
        { key: 'G', op: 'object.something' },
        { key: 'G', shift: true, op: 'x.y' },
        { key: 'H', op: 'a.b', when },
        { key: 'H', op: 'a.c' },
        { key: 'J', op: 'a.d', inactive: true },
        { key: 'J', op: 'a.e' },
      ],
    });
    expect(r).toEqual([{ keymap: 'A', key: 'G', items: ['transform.translate', 'object.something'] }]);
  });
});
