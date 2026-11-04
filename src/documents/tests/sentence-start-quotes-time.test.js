import { it, expect } from 'vitest';
import { sentenceCapital } from '../src/lib/autocorrect.js';
import { TextDocument } from '../src/engine/model.js';
import { changeCase } from '../src/engine/home-editing.js';

/**
 * Whether a letter starts a sentence was read past the opening quotes and brackets before it with regular
 * expressions anchored only at the end (/["'“‘(\[]+$/), which try every start position: a paragraph holding a
 * run of tens of thousands of quotation marks (a document anyone can send) made each lowercase letter typed
 * after it, and each change of case, take seconds.
 */
const QUOTES = '"'.repeat(200000);

it('capitalizes as you type in linear time after a long run of quotation marks', () => {
  const start = performance.now();
  expect(sentenceCapital(`${QUOTES}x a`, 'a')).toBeNull();
  expect(performance.now() - start).toBeLessThan(1000);
  // As before: opening quotes and brackets before a sentence's first letter are passed over.
  expect(sentenceCapital('Done. “(a', 'a')).toEqual({ back: 1, text: 'A' });
  expect(sentenceCapital('"\'a', 'a')).toEqual({ back: 1, text: 'A' });
  expect(sentenceCapital('word "a', 'a')).toBeNull();
  expect(sentenceCapital('a', 'a')).toEqual({ back: 1, text: 'A' });
});

it('changes to sentence case in linear time after a long run of quotation marks', () => {
  const doc = new TextDocument([{ runs: [{ text: `${QUOTES}x word` }] }]);
  doc.select(QUOTES.length + 2, QUOTES.length + 6);
  const start = performance.now();
  changeCase(doc, 'sentence');
  expect(performance.now() - start).toBeLessThan(1000);
  const opened = new TextDocument([{ runs: [{ text: 'End. ("word here' }] }]);
  opened.select(7, 11);
  changeCase(opened, 'sentence');
  expect(opened.text).toBe('End. ("Word here');
});
