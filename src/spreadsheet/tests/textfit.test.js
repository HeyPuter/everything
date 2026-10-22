import { describe, it, expect, vi } from 'vitest';
import { wrapLines, heightForLines, rowPad, maxLineWidth, cellHorizontalPadding } from '../src/core/textfit.js';

const measure = (t) => t.length * 10; // 10px per character

it('measures explicit line endings and large multiline values by their longest line', () => {
  expect(maxLineWidth('aa\r\nlongest\rbbb\nc', measure)).toBe(70);
  expect(maxLineWidth(`${'a\n'.repeat(150000)}last`, measure)).toBe(40);
  expect(maxLineWidth(null, measure)).toBe(0);
});

describe('wrapLines', () => {
  it('fills lines greedily on word boundaries', () => {
    expect(wrapLines('the quick brown fox', 100, measure)).toEqual(['the quick', 'brown fox']);
    expect(wrapLines('short', 100, measure)).toEqual(['short']);
    expect(wrapLines('', 100, measure)).toEqual(['']);
  });

  it('keeps explicit line breaks', () => {
    expect(wrapLines('a\nb c', 100, measure)).toEqual(['a', 'b c']);
  });

  it('does not open a blank line when a word fits but the space after it does not', () => {
    expect(wrapLines('hello world again', 50, measure)).toEqual(['hello', 'world', 'again']);
    expect(wrapLines('ab cd ef', 20, measure)).toEqual(['ab', 'cd', 'ef']);
    expect(wrapLines('ab  cd', 20, measure)).toEqual(['ab', 'cd']);
    expect(wrapLines('abcde fgh', 50, measure)).toEqual(['abcde', 'fgh']);
  });

  it('breaks words longer than the cell', () => {
    expect(wrapLines('abcdefghijklmnop', 50, measure)).toEqual(['abcde', 'fghij', 'klmno', 'p']);
    expect(wrapLines('ok abcdefghijkl', 50, measure)).toEqual(['ok', 'abcde', 'fghij', 'kl']);
  });

  it('wraps long unbroken input without repeatedly measuring large prefixes', () => {
    const input = 'abcdefghij'.repeat(1000);
    let calls = 0;
    let measuredCharacters = 0;
    const lines = wrapLines(input, 100, (text) => {
      calls++;
      measuredCharacters += text.length;
      if (calls > 20000 || measuredCharacters > 1000000) throw new Error('Excessive text measurement');
      return text.length * 10;
    });
    expect(lines).toEqual(Array(1000).fill('abcdefghij'));
    expect(calls).toBeLessThan(15000);
    expect(measuredCharacters).toBeLessThan(300000);
  });

  it.each(['😀', 'e\u0301', '🇨🇦', '👩‍👩‍👧‍👦'])('keeps the grapheme %s intact when it is wider than the column', (grapheme) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const measure = (text) => Array.from(segmenter.segment(text)).length * 30;
    expect(wrapLines(grapheme.repeat(2), 20, measure)).toEqual([grapheme, grapheme]);
  });

  it('keeps surrogate pairs intact when grapheme segmentation is unavailable', () => {
    vi.stubGlobal('Intl', {});
    try {
      expect(wrapLines('😀😀', 20, (text) => Array.from(text).length * 30)).toEqual(['😀', '😀']);
    } finally { vi.unstubAllGlobals(); }
  });

  it('packs several graphemes on each line when they fit', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const measure = (text) => Array.from(segmenter.segment(text)).length * 10;
    expect(wrapLines('e\u0301😀🇨🇦👩‍👩‍👧‍👦', 20, measure)).toEqual(['e\u0301😀', '🇨🇦👩‍👩‍👧‍👦']);
  });

  it('computes heights with a floor at the default row height', () => {
    // A line takes 1.3 times its size, rounded up: 11 point (14.67px) is Excel's 20px row, 28 point its 49px row.
    expect(heightForLines(1)).toBe(17);
    expect(heightForLines(1, 44 / 3)).toBe(20);
    expect(heightForLines(1, 112 / 3)).toBe(49);
    expect(heightForLines(2, 44 / 3)).toBe(40);
    // The caller's default row is the floor: a fitted row never gets shorter than a fresh one.
    expect(heightForLines(1, 13, 26)).toBe(26);
    expect(heightForLines(1, 8, 19.5)).toBe(19.5);
    expect(heightForLines(3, 13, 19.5)).toBe(3 * 17);
    expect(heightForLines(3)).toBe(3 * 17);
    expect(heightForLines(2, 20)).toBe(2 * 26);
    // A default row a little roomier than its Normal font's line passes that room on (the app's 19.5px rows for
    // 13px text); one set well apart from the font passes nothing.
    expect(rowPad(19.5, 13)).toBe(2.5);
    expect(rowPad(20, 44 / 3)).toBe(0);
    expect(rowPad(48, 13)).toBe(0);
    expect(heightForLines(1, 13, 0, rowPad(19.5, 13))).toBe(19.5);
  });
});

// Indentation keeps identical origin increments from levels
// 0→1, 1→2 and 2→3, across cell fonts/sizes. The text margin stays present.
it.each([0.5, 1, 1.25, 2])('adds indentation without consuming ordinary margins at zoom %s', zoom => {
  for (const step of [3.25, 9, 12, 21]) {
    const padding = [0, 1, 2, 3].map(level => cellHorizontalPadding(level * step, zoom));
    for (let i = 1; i < padding.length; i++) expect(padding[i] - padding[i - 1]).toBeCloseTo(step * zoom);
  }
});
