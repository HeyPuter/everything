import { describe, expect, it } from 'vitest';
import { applyCharStyle, charStyleOfRange, defaultCharStyle, fromPlainText, plainText } from '../src/imaging/text/model';
import { findMatches, nextMatch, replaceAll } from '../src/imaging/text/find';

describe('find and replace text', () => {
  it('finds matches with case and whole-word options', () => {
    const t = 'Cat scatter cat CAT';
    expect(findMatches(t, 'cat')).toEqual([[0, 3], [5, 8], [12, 15], [16, 19]]);
    expect(findMatches(t, 'cat', { caseSensitive: true })).toEqual([[5, 8], [12, 15]]);
    expect(findMatches(t, 'cat', { wholeWord: true })).toEqual([[0, 3], [12, 15], [16, 19]]);
    expect(findMatches(t, '')).toEqual([]);
    expect(findMatches('aaaa', 'aa')).toEqual([[0, 2], [2, 4]]);
  });
  it('finds a whole-word match that overlaps a rejected one', () => {
    // "to be" inside "veto be" is not whole words; the one after it is.
    expect(findMatches('veto be be', 'o be', { wholeWord: true })).toEqual([]);
    expect(findMatches('to to be', 'to be', { wholeWord: true })).toEqual([[3, 8]]);
    expect(findMatches('aa a a', 'a a', { wholeWord: true })).toEqual([[3, 6]]);
    expect(findMatches('1.5.5', '.5', { wholeWord: true })).toEqual([]);
  });
  it('finds the next match and wraps around', () => {
    expect(nextMatch('one two one', 'one', 1)).toEqual([8, 11]);
    expect(nextMatch('one two one', 'one', 9)).toEqual([0, 3]);
    expect(nextMatch('one two one', 'one', 9, {}, false)).toBeUndefined();
  });
  it('replaces across paragraphs keeping the style of the replaced text', () => {
    let c = fromPlainText('red apple\nred pear', { ...defaultCharStyle(), size: 12 });
    c = applyCharStyle(c, 10, 13, { size: 30 });
    const r = replaceAll(c, 'red', 'green', { wholeWord: true });
    expect(r.count).toBe(2);
    expect(plainText(r.content)).toBe('green apple\ngreen pear');
    expect(charStyleOfRange(r.content, 12, 17).size).toBe(30);
    expect(charStyleOfRange(r.content, 0, 5).size).toBe(12);
  });
  it.each([
    ['kitten', [0, 6, 6, 7, 11, 12, 18, 18]],
    ['x', [0, 1, 1, 2, 6, 7, 8, 8]],
    ['', [0, 0, 0, 1, 5, 6, 6, 6]],
  ] as const)('maps positions through replacements with %j', (replacement, expected) => {
    const r = replaceAll(fromPlainText('dog tail dog'), 'dog', replacement);
    expect([0, 1, 3, 4, 8, 9, 10, 12].map(r.mapIndex)).toEqual(expected);
  });
  it('retains the boundary between adjacent replacements', () => {
    const r = replaceAll(fromPlainText('aaaa'), 'aa', 'b');
    expect([0, 1, 2, 3, 4].map(r.mapIndex)).toEqual([0, 1, 1, 2, 2]);
  });
  it('maps UTF-16 offsets using normalized paragraph breaks', () => {
    const r = replaceAll(fromPlainText('red\nred'), 'red', '😀\r\nx');
    expect(plainText(r.content)).toBe('😀\nx\n😀\nx');
    expect([0, 3, 4, 7].map(r.mapIndex)).toEqual([0, 4, 5, 9]);
  });
  it('leaves offsets untouched when no text matches', () => {
    const r = replaceAll(fromPlainText('hi'), 'dog', 'cat');
    expect([0, 1, 2].map(r.mapIndex)).toEqual([0, 1, 2]);
  });

});
