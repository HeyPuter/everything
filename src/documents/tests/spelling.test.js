import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import nspell from 'nspell';
import { wordsToCheck, rankSuggestions } from '../src/lib/spelling.js';

describe('words to check', () => {
  const words = text => wordsToCheck(text).map(w => w.word);
  it('skips words in uppercase, with numbers, and addresses by default', () => {
    expect(words('Visit www.example.com or mail me@example.com about NASA and R2D2 today.')).toEqual(['Visit', 'or', 'mail', 'about', 'and', 'today']);
    expect(words('Open C:\\temp\\file.txt and /usr/bin now')).toEqual(['Open', 'and', 'now']);
  });
  it('checks the first word of a paragraph that follows an address', () => {
    expect(words('Visit www.example.com\nTeh end')).toEqual(['Visit', 'Teh', 'end']);
    expect(words('mail me@example.com\tTeh end')).toEqual(['mail', 'Teh', 'end']);
  });
  it('keeps contractions whole, normalizes curly apostrophes and drops possessive s', () => {
    expect(words('Sam’s book, don’t ask, isn\'t it')).toEqual(['Sam', 'book', "don't", 'ask', "isn't", 'it']);
  });
  it('checks the parts of a hyphenated compound and reports their positions', () => {
    const list = wordsToCheck('a well-knwn fact');
    expect(list.map(w => [w.word, w.start, w.end])).toEqual([['a', 0, 1], ['well', 2, 6], ['knwn', 7, 11], ['fact', 12, 16]]);
  });
  it('checks only words with Latin letters, since the dictionary is English', () => {
    expect(words('ฉันไปโรงเรียนทุกวัน hello wrold now')).toEqual(['hello', 'wrold', 'now']);
    expect(words('Привет мир, γεια σου, 你好 and café')).toEqual(['and', 'café']);
  });
});

describe('suggestions', () => {
  it('ranks a swapped pair of letters first and keeps the word\'s capitalization', () => {
    expect(rankSuggestions('teh', ['ten', 'eh', 'tea', 'the', 'Th'])[0]).toBe('the');
    expect(rankSuggestions('Teh', ['ten', 'the'])[0]).toBe('The');
    expect(rankSuggestions('RECIEVE', ['receive', 'relieve'])).toEqual(['RECEIVE', 'RELIEVE']);
  });
  it('prefers a left-out vowel and common words over proper nouns for a lowercase word', () => {
    expect(rankSuggestions('jumpd', ['jumps', 'jump', 'jumped'])[0]).toBe('jumped');
    expect(rankSuggestions('bok', ['Bob', 'bog', 'book'])[0]).toBe('book');
  });
  it('flags misspellings and accepts correct words with the vendored dictionary', () => {
    const speller = nspell(readFileSync('public/dictionaries/en-US.aff', 'utf8'), readFileSync('public/dictionaries/en-US.dic', 'utf8'));
    const wrong = wordsToCheck('Teh quick brown fox jumpd over the lazy dog. It’s well-known.').filter(w => !speller.correct(w.word)).map(w => w.word);
    expect(wrong).toEqual(['Teh', 'jumpd']);
    expect(rankSuggestions('jumpd', speller.suggest('jumpd'))[0]).toBe('jumped');
  });
});
