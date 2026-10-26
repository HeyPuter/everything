import { describe, it, expect } from 'vitest';
import { countWords, countCharacters, countParagraphs, readingMinutes, textStats, formatCount, formatSelectionCount } from '../src/core/text.js';

describe('text statistics', () => {
  it('counts words the way a word processor does', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('  spaced   out  ')).toBe(2);
    expect(countWords("Don't split contractions or well-known hyphens")).toBe(6);
    expect(countWords('Numbers 3.14 and 1,000 count')).toBe(5);
    expect(countWords('Unicode: café naïve 日本語')).toBe(4);
    // Combining marks and zero-width joiners stay inside their word.
    expect(countWords('नमस्ते दुनिया')).toBe(2);
    expect(countWords('cafe\u0301 nai\u0308ve')).toBe(2);
    expect(countWords('مَرْحَبًا بِكُمْ')).toBe(2);
    expect(countWords('שָׁלוֹם עוֹלָם')).toBe(2);
    expect(countWords('می\u200cخواهم بروم')).toBe(2);
    expect(countWords('line one\nline two')).toBe(4);
    // Whitespace-delimited, as the document engine counts: a lone dash is a word, an address one word.
    expect(countWords('--- ... !!!')).toBe(3);
    expect(countWords('snake_case_name user@example.com a/b hello—world www.example.com/path?q=1 😀 😀')).toBe(7);
    expect(countWords('x - y')).toBe(3);
    // Thai, Lao, Khmer and Myanmar write no spaces between words.
    expect(countWords('ฉันไปโรงเรียนทุกวันเพราะอยากเรียนรู้')).toBe(9);
    expect(countWords('ฉันไปโรงเรียน')).toBe(3);
    expect(countWords('ฉัน ไป โรงเรียน ทุก วัน')).toBe(5);
    expect(countWords('hello ฉันไป world')).toBe(4);
    expect(countWords('ฉัน\u200Bไป')).toBe(2);
  });

  it('counts characters with and without spaces, ignoring line breaks', () => {
    expect(countCharacters('ab cd\nef')).toBe(7);
    expect(countCharacters('ab cd\nef', { spaces: false })).toBe(6);
    expect(countCharacters('')).toBe(0);
    expect(countCharacters('日本')).toBe(2);
  });

  it.each([
    ['😀𝄞', 2, 2],
    ['e\u0301', 2, 2],
    ['a\r\nb\nc\rd', 5, 4],
    ['a\t\u00a0\u2003\u2028\u2029\uFEFFb', 8, 2],
    ['\ud800x\udc00', 3, 3],
    ['\u200b', 1, 1],
  ])('preserves Unicode and whitespace counts for %j', (text, withSpaces, withoutSpaces) => {
    expect(countCharacters(text)).toBe(withSpaces);
    expect(countCharacters(text, { spaces: false })).toBe(withoutSpaces);
  });

  it('counts non-empty paragraphs and estimates reading time', () => {
    expect(countParagraphs('a\n\nb\n   \nc')).toBe(3);
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(460)).toBe(2);
  });

  it('bundles everything into one stats object', () => {
    expect(textStats('One two three.\nFour')).toEqual({
      words: 4, characters: 18, charactersNoSpaces: 16, paragraphs: 2, readingMinutes: 1,
    });
  });

  it('pluralizes counts', () => {
    expect(formatCount(1, 'word')).toBe('1 word');
    expect(formatCount(2, 'word')).toBe('2 words');
    expect(formatCount(1200, 'page')).toBe(`${(1200).toLocaleString()} pages`);
    expect(formatSelectionCount(12, 340, 'word')).toBe('12 of 340 words');
    expect(formatSelectionCount(1, 1, 'word')).toBe('1 of 1 word');
  });
});

describe('engine counts', () => {
  it('takes the engine word and paragraph counts over the joined-text ones', async () => {
    const { textStats, mergeEngineCounts } = await import('../src/core/text.js');
    const stats = textStats('First paragraph.Second paragraph here');
    expect(stats.words).toBe(4);
    expect(stats.paragraphs).toBe(1);
    const merged = mergeEngineCounts(stats, { words: 5, paragraphs: 2 });
    expect(merged.words).toBe(5);
    expect(merged.paragraphs).toBe(2);
    expect(merged.characters).toBe(stats.characters);
    expect(merged.readingMinutes).toBe(1);
    expect(mergeEngineCounts(stats, null)).toBe(stats);
    expect(mergeEngineCounts(stats, { words: -1, paragraphs: 'x' })).toEqual(stats);
  });
});

it('counts both character kinds in one pass and takes the engine\'s word and paragraph counts when given', () => {
  const text = 'Hello there,\nworld 👋 and\r\nmore.';
  const characters = countCharacters(text), charactersNoSpaces = countCharacters(text, { spaces: false });
  expect(textStats('ab cd')).toMatchObject({ characters: 5, charactersNoSpaces: 4 });
  // The waving hand is a word of its own, as the engine counts it.
  expect(textStats(text)).toMatchObject({ words: 6, characters, charactersNoSpaces, paragraphs: 3 });
  expect(textStats(text, { words: 40, paragraphs: 9 })).toMatchObject({ words: 40, paragraphs: 9, characters, charactersNoSpaces, readingMinutes: 1 });
  expect(textStats(text, { words: -1, paragraphs: 'x' })).toMatchObject({ words: 6, paragraphs: 3 });
});
