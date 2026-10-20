import { expect, it } from 'vitest';
import { speechChunks } from '../src/core/speech.js';

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
