import { describe, it, expect } from 'vitest';
import { moveInList } from '../../src/editors/filebrowser_logic';

describe('bookmark list moves', () => {
  it('moves up, down, to the top and bottom', () => {
    const l = ['a', 'b', 'c', 'd'];
    expect(moveInList(l, 2, 'UP')).toBe(1);
    expect(l).toEqual(['a', 'c', 'b', 'd']);
    expect(moveInList(l, 1, 'BOTTOM')).toBe(3);
    expect(l).toEqual(['a', 'b', 'd', 'c']);
    expect(moveInList(l, 3, 'TOP')).toBe(0);
    expect(l).toEqual(['c', 'a', 'b', 'd']);
    expect(moveInList(l, 3, 'DOWN')).toBe(3);
    expect(moveInList(l, 9, 'UP')).toBe(9);
  });
});
