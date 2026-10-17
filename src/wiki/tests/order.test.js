import { describe, it, expect } from 'vitest';
import { between, keyBetween, keysAfter, compareOrder } from '../src/lib/order.js';

describe('order keys', () => {
  it('makes a key between any two keys', () => {
    const cases = [['', ''], ['i', ''], ['', 'i'], ['i', 'j'], ['', '1'], ['', '01'], ['ab', 'ac'], ['az', 'b'], ['zz', '']];
    for (const [a, b] of cases) {
      const k = between(a, b);
      if (a) expect(k > a).toBe(true);
      if (b) expect(k < b).toBe(true);
      expect(k.endsWith('0')).toBe(false);
    }
  });

  it('keeps working after many inserts at the same spot', () => {
    let lo = 'a';
    const hi = 'b';
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo && k < hi).toBe(true);
      lo = k;
    }
    let up = 'b';
    for (let i = 0; i < 200; i++) {
      const k = keyBetween('a', up);
      expect(k > 'a' && k < up).toBe(true);
      up = k;
    }
  });

  it('keeps keys short when appending, prepending or typing a list in the middle', () => {
    let last = '';
    for (let i = 0; i < 10000; i++) last = keyBetween(last, '');
    expect(last.length).toBeLessThan(12);
    let first = '';
    for (let i = 0; i < 10000; i++) first = keyBetween('', first);
    expect(first.length).toBeLessThan(12);
    // Each new item goes right after the previous one, before a fixed key.
    let prev = 'i';
    for (let i = 0; i < 2000; i++) prev = keyBetween(prev, 'j');
    expect(prev.length).toBeLessThan(14);
    let next = 'j';
    for (let i = 0; i < 2000; i++) next = keyBetween('i', next);
    expect(next.length).toBeLessThan(20);
  });

  it('stays ordered under random inserts, including keys made by the old scheme', () => {
    const keys = ['i', 'qab', 'z5', 'zz', '01', '0z'];
    keys.sort();
    for (let n = 0; n < 3000; n++) {
      const at = Math.floor(Math.random() * (keys.length + 1));
      const k = keyBetween(keys[at - 1] || '', keys[at] || '');
      if (at > 0) expect(k > keys[at - 1]).toBe(true);
      if (at < keys.length) expect(k < keys[at]).toBe(true);
      expect(k.endsWith('0')).toBe(false);
      keys.splice(at, 0, k);
    }
  });

  it('gives two clients inserting at the same place different keys', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(keyBetween('a', 'b'));
    expect(seen.size).toBeGreaterThan(40);
  });

  it('rejects keys out of order', () => {
    expect(() => between('b', 'a')).toThrow();
  });

  it('spreads keys after a point in order', () => {
    const keys = keysAfter('', 20);
    expect([...keys].sort()).toEqual(keys);
  });

  it('breaks ties by id', () => {
    const list = [{ id: 'b', order: 'i' }, { id: 'a', order: 'i' }, { id: 'c', order: 'h' }];
    expect(list.sort(compareOrder).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});
