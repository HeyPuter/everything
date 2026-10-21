import { expect, it } from 'vitest';
import { indexPageText, searchQuery } from '../src/core/search.js';

it('keeps words continuous across text styles while retaining item offsets', () => {
  expect(
    indexPageText([{ str: 'paper' }, { type: 'beginMarkedContent' }, { str: 'work' }]),
  ).toMatchObject({
    text: 'paperwork',
    ranges: [
      { start: 0, end: 5 },
      { start: 5, end: 9 },
    ],
  });
});

it('normalizes PDF spaces and line breaks without merging separate words', () => {
  const index = indexPageText([
    { str: 'One', hasEOL: true },
    { str: '', hasEOL: true },
    { str: '  two\t ' },
    { str: ' three' },
  ]);
  expect(index.text).toBe('one two three');
  expect(index.ranges).toEqual([
    { start: 0, end: 3 },
    { start: 4, end: 4 },
    { start: 4, end: 8 },
    { start: 8, end: 13 },
  ]);
  expect(index.text.includes(searchQuery(' ONE   two\nthree '))).toBe(true);
  expect(index.text.includes(searchQuery('onetwo'))).toBe(false);
});

it('keeps offsets aligned when folding changes character lengths', () => {
  // The Devanagari letter qa decomposes into ka and a nukta, which stays: two units from one.
  expect(indexPageText([{ str: '\u0958' }, { str: 'TEST' }])).toMatchObject({
    text: '\u0915\u093ctest',
    ranges: [
      { start: 0, end: 2 },
      { start: 2, end: 6 },
    ],
  });
});

it('preserves contextual Greek case conversion across text items', () => {
  expect(indexPageText([{ str: 'Ο' }, { str: 'Σ' }]).text).toBe(searchQuery('ΟΣ'));
});

it('matches Greek prefixes regardless of final-sigma casing', () => {
  const index = indexPageText([{ str: 'ΟΔΥΣΣΕΥΣ και ' }, { str: 'οδυσσευς' }]);
  expect(index.text.includes(searchQuery('ΟΔΥΣ'))).toBe(true);
  expect(index.text.includes(searchQuery('ΟΔΥΣΣΕΥΣ'))).toBe(true);
  expect(index.text.includes(searchQuery('οδυσσευς'))).toBe(true);
  expect(index.ranges).toEqual([
    { start: 0, end: 13 },
    { start: 13, end: 21 },
  ]);
});

it('maps folded offsets back to the characters of each text item', () => {
  const index = indexPageText([{ str: 'One', hasEOL: true }, { str: '  two\t ' }, { str: 'İx' }]);
  expect(index.text).toBe('one two ix');
  expect(index.ranges).toEqual([
    { start: 0, end: 3 },
    { start: 4, end: 8 },
    { start: 8, end: 10 },
  ]);
  expect(index.origins).toEqual([
    [0, 1, 2],
    [2, 3, 4, 5],
    [0, 1],
  ]);
});

it('folds supplementary-plane letters and maps their full UTF-16 spans', () => {
  const upper = '\u{10400}\u{10401}';
  const lower = upper.toLowerCase();
  const index = indexPageText([{ str: `${upper} İ` }, { str: `${lower} end` }]);
  expect(index.text).toBe(`${lower} i${lower} end`);
  expect(index.text.includes(searchQuery(upper))).toBe(true);
  expect(index.text.includes(searchQuery(lower))).toBe(true);
  expect(index.ranges).toEqual([
    { start: 0, end: 6 },
    { start: 6, end: 14 },
  ]);
  expect(index.origins).toEqual([
    [0, 1, 2, 3, 4, 5],
    [0, 1, 2, 3, 4, 5, 6, 7],
  ]);
});

it('finds a word hyphenated across a line break whole, and keeps real dashes', () => {
  const index = indexPageText([
    { str: 'An exam-', hasEOL: true },
    { str: 'ple of hy' },
    { str: '-', hasEOL: true },
    { str: 'phenation, pages 1-', hasEOL: true },
    { str: '2 and A-', hasEOL: true },
    { str: 'Z.' },
  ]);
  expect(index.text).toBe('an example of hyphenation, pages 1- 2 and a- z.');
  expect(index.ranges).toEqual([
    { start: 0, end: 7 },
    { start: 7, end: 16 },
    { start: 16, end: 16 },
    { start: 16, end: 35 },
    { start: 36, end: 44 },
    { start: 45, end: 47 },
  ]);
  // The match maps back onto the characters on each line, without the hyphen.
  expect(index.origins[0].slice(3)).toEqual([3, 4, 5, 6]);
});

it('ignores accents, as PDF readers do by default, and keeps highlights on the accented letters', () => {
  const index = indexPageText([
    { str: 'Le CAFÉ ' },
    { str: 'İstanbul, cafe\u0301 ' },
    { str: 'Ἀθῆναι' },
  ]);
  expect(index.text).toBe('le cafe istanbul, cafe αθηναι');
  for (const query of ['café', 'cafe', 'CAFE\u0301', 'istanbul', 'Αθήναι'])
    expect(index.text.includes(searchQuery(query))).toBe(true);
  // "é" maps back to the one character on the page; a separate accent is left beside its letter.
  expect(index.origins[0].slice(3)).toEqual([3, 4, 5, 6, 7]);
  expect(index.origins[1].slice(-5)).toEqual([10, 11, 12, 13, 15]);
  // Marks that make another letter are not accents: ka and ga stay apart.
  expect(searchQuery('が')).not.toBe(searchQuery('か'));
});

it('matches straight quotes typed in a query to typographic quotes on the page', () => {
  const index = indexPageText([{ str: 'Don\u2019t say \u201cnever\u201d' }]);
  expect(index.text.indexOf(searchQuery("don't"))).toBe(0);
  expect(index.text.indexOf(searchQuery('"never"'))).toBe(10);
  expect(index.origins[0].length).toBe(index.text.length);
});

it('folds each distinct character of a huge page once, not every time it appears', () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({
    str: 'Lorem ipsum dolor sit amet, café',
    hasEOL: i % 3 === 0,
  }));
  const normalize = String.prototype.normalize;
  let calls = 0;
  String.prototype.normalize = function (...args) {
    calls++;
    return normalize.apply(this, args);
  };
  try {
    const index = indexPageText(items);
    expect(index.text.length).toBeGreaterThan(60000);
    expect(index.text.slice(0, 33)).toBe('lorem ipsum dolor sit amet, cafe ');
  } finally {
    String.prototype.normalize = normalize;
  }
  // Two normalizations for each of the page's few distinct characters, at most.
  expect(calls).toBeLessThan(100);
});
