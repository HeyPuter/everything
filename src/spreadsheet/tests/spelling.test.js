import { beforeAll, describe, expect, it } from 'vitest';
import { loadWordList, createSpeller, decodeWords, wordsIn, textCellsInOrder, replaceWord } from '../src/core/spelling.js';
import { Workbook } from '../src/core/workbook.js';

let us, gb;
beforeAll(async () => {
  us = createSpeller(await loadWordList('en-US'));
  gb = createSpeller(await loadWordList('en-GB'));
});

describe('the word lists', () => {
  it('decode the front coding', () => {
    expect(decodeWords('0apple\n5s\n2t\n')).toEqual(['apple', 'apples', 'apt']);
  });

  it('know common words and their forms, names with their capital, and possessives', () => {
    for (const w of ['receive', 'received', 'happiness', 'unhappily', "don't", 'Paris', 'NASA', 'Hello', "students'", "teacher's", 'The']) expect(us.check(w), w).toBe(true);
    for (const w of ['recieve', 'teh', 'paris', 'accomodation']) expect(us.check(w), w).toBe(false);
  });

  it('spell British and American English apart', () => {
    expect(us.check('color')).toBe(true);
    expect(us.check('colour')).toBe(false);
    expect(gb.check('colour')).toBe(true);
    expect(gb.check('color')).toBe(false);
  });

  it('suggest the nearest words first, cased as typed', () => {
    expect(us.suggest('recieve')[0]).toBe('receive');
    expect(us.suggest('Teh')[0]).toBe('The');
    expect(us.suggest('accomodation')[0]).toBe('accommodation');
    expect(us.suggest('tommorow')[0]).toBe('tomorrow');
    expect(us.suggest('paris')[0]).toBe('Paris');
    expect(us.suggest('xyzzyq')).toEqual([]);
  });

  it('take the person’s own words', () => {
    const own = createSpeller({ words: new Set(['cat']), noSuggest: new Set() }, { custom: ['Puter', 'xlsx'] });
    expect(own.check('Puter')).toBe(true);
    expect(own.check('XLSX')).toBe(true);
    expect(own.check('dog')).toBe(false);
  });
});

describe('finding words in text', () => {
  it('splits on spaces, hyphens and punctuation and keeps apostrophes inside words', () => {
    expect(wordsIn("It's a well-known fact.").map((w) => w.word)).toEqual(["It's", 'a', 'well', 'known', 'fact']);
  });

  it('leaves out words in capitals, next to digits, and inside addresses, as the options say', () => {
    const text = 'See NASA at www.teh.com or me@x.org, the 3rd file C:\\teh\\data and A4b';
    expect(wordsIn(text).map((w) => w.word)).toEqual(['See', 'at', 'or', 'the', 'file', 'and']);
    expect(wordsIn(text, { ignoreUppercase: false, ignoreNumbers: true, ignoreAddresses: true }).map((w) => w.word)).toContain('NASA');
    expect(wordsIn('3rd', { ignoreNumbers: false }).map((w) => w.word)).toEqual(['rd']);
  });

  it('replaces a word by its place', () => {
    expect(replaceWord('a teh b', 2, 5, 'the')).toBe('a the b');
  });
});

describe('the cells a check reads', () => {
  it('are the text constants in reading order, from the active cell round to it', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'top');
    wb.setInput(id, 0, 1, '=1+1');
    wb.setInput(id, 1, 0, '42');
    wb.setInput(id, 2, 1, 'later');
    wb.setInput(id, 1, 1, 'middle');
    expect(textCellsInOrder(wb, id)).toEqual([[0, 0], [1, 1], [2, 1]]);
    expect(textCellsInOrder(wb, id, { from: { r: 1, c: 0 } })).toEqual([[1, 1], [2, 1], [0, 0]]);
    expect(textCellsInOrder(wb, id, { ranges: [{ r1: 1, c1: 0, r2: 2, c2: 1 }] })).toEqual([[1, 1], [2, 1]]);
  });
});
