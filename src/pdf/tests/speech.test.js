import { expect, it } from 'vitest';
import { pageSpeechText, speechChunks } from '../src/core/speech.js';

it('keeps short text whole and empty text silent', () => {
  expect(speechChunks('  One line.\nAnd another.  ')).toEqual(['One line. And another.']);
  expect(speechChunks(' \n\t ')).toEqual([]);
});

it('cuts a long page into short pieces of whole sentences, keeping every word', () => {
  const sentence = (i) => `Sentence ${i} has a few words, and 3.14 is not its end.`;
  const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join('\n');
  const chunks = speechChunks(text, { max: 200, lang: 'en' });
  expect(chunks.length).toBeGreaterThan(5);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunk).toMatch(/^Sentence \d+ .*end\.$/);
  }
  expect(chunks.join(' ')).toBe(text.replace(/\n/g, ' '));
});

it('breaks a sentence longer than a piece between words, or anywhere without spaces', () => {
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  const chunks = speechChunks(words, { max: 100 });
  expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  expect(chunks.every((chunk) => /^word\d+( word\d+)*$/.test(chunk))).toBe(true);
  expect(chunks.join(' ')).toBe(words);
  const unbroken = '字'.repeat(250);
  expect(speechChunks(unbroken, { max: 100 }).map((chunk) => chunk.length)).toEqual([100, 100, 50]);
});

it('speaks a word hyphenated at the end of a line whole', () => {
  expect(
    pageSpeechText([
      { str: 'an exam-', hasEOL: true },
      { str: 'ple of a well-' },
      { str: '', hasEOL: true },
      { str: 'Known word' },
    ]),
  ).toBe('an example of a well-\nKnown word');
});

it('breaks a long run without spaces between whole characters', () => {
  // Emoji and letters outside the basic plane take two code units; a mark joins its letter.
  for (const unit of ['😀', 'กิ', 'e\u0301']) {
    const chunks = speechChunks('a' + unit.repeat(150), { max: 101 });
    expect(chunks.join(''), unit).toBe('a' + unit.repeat(150));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(101);
      expect(chunk.replace(/^a/, '').replaceAll(unit, ''), unit).toBe('');
    }
  }
});

it('reads a Chinese or Japanese phrase that wraps onto the next line as one phrase', () => {
  expect(
    pageSpeechText([
      { str: '東京大學中', hasEOL: true },
      { str: '文化研究所です', hasEOL: true },
      { str: 'Next line' },
    ]),
  ).toBe('東京大學中文化研究所です\nNext line');
});
