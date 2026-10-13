import { describe, expect, it } from 'vitest';
import { correctBeforeCaret, correctTail, correctWord, normalizeAutoCorrect, DEFAULT_AUTOCORRECT } from '../src/core/autocorrect.js';

const typed = (text, settings = DEFAULT_AUTOCORRECT) => correctBeforeCaret(text, text.length, settings)?.text ?? text;

describe('AutoCorrect rules', () => {
  it('replaces listed text once the word ends, keeping the punctuation that ended it', () => {
    expect(typed('teh ')).toBe('the ');
    expect(typed('I think teh,')).toBe('I think the,');
    expect(typed('(c) ')).toBe('© ');
    expect(typed('Brand(tm) ')).toBe('Brand(tm) '); // only a whole word or its letters
    expect(typed('a -- b ')).toBe('a -- b '); // the word before the caret is "b"
    expect(typed('a -- ')).toBe('a – ');
    expect(typed('go -> ')).toBe('go → ');
  });

  it('keeps the case the word was typed in', () => {
    expect(typed('Teh ')).toBe('The ');
    expect(typed('TEH ')).toBe('THE ');
  });

  it('corrects two initial capitals, but not listed exceptions or codes', () => {
    expect(typed('THursday ')).toBe('Thursday ');
    expect(typed('IDs ')).toBe('IDs ');
    expect(typed('AB1c ')).toBe('AB1c ');
    expect(typed('OK ')).toBe('OK ');
  });

  it('fixes a word typed with caps lock on', () => {
    expect(typed('hELLO ')).toBe('Hello ');
  });

  it('capitalizes days and the first word of a sentence, but not the first word of a cell or after an abbreviation', () => {
    expect(typed('due monday ')).toBe('due Monday ');
    expect(typed('done. next ')).toBe('done. Next ');
    expect(typed('next ')).toBe('next ');
    expect(typed('see e.g. this ')).toBe('see e.g. this ');
    expect(typed('J. smith ')).toBe('J. smith ');
  });

  it('leaves formulas, numbers, addresses and links alone', () => {
    expect(typed('=teh ')).toBe('=teh ');
    expect(typed('+teh ')).toBe('+teh ');
    expect(typed('1,')).toBe('1,');
    expect(typed('me@teh.com ')).toBe('me@teh.com ');
    expect(typed('http://teh ')).toBe('http://teh ');
  });

  it('honours switched-off rules and turns on math symbols when asked', () => {
    const off = normalizeAutoCorrect({ replaceText: false, dayNames: false });
    expect(typed('teh ', off)).toBe('teh ');
    expect(typed('due monday ', off)).toBe('due monday ');
    expect(typed('\\alpha ')).toBe('\\alpha ');
    expect(typed('\\alpha ', normalizeAutoCorrect({ mathSymbols: true }))).toBe('α ');
  });

  it('corrects the last word when the entry is committed', () => {
    expect(correctTail('meet on friday', DEFAULT_AUTOCORRECT)).toBe('meet on Friday');
    expect(correctTail('recieve', DEFAULT_AUTOCORRECT)).toBe('receive');
    expect(correctTail('=SUM(A1)', DEFAULT_AUTOCORRECT)).toBe('=SUM(A1)');
  });

  it('reports the span replaced', () => {
    expect(correctWord('say teh', 7, DEFAULT_AUTOCORRECT)).toEqual({ start: 4, end: 7, from: 'teh', to: 'the', rule: 'replace' });
  });

  it('makes stored settings whole, dropping bad entries', () => {
    const s = normalizeAutoCorrect({ replacements: [{ from: 'abc', to: 'xyz' }, { from: 'two words', to: 'x' }, { from: 5 }], sentenceCaps: 'yes' });
    expect(s.replacements).toEqual([{ from: 'abc', to: 'xyz' }]);
    expect(s.sentenceCaps).toBe(true);
    expect(s.initialCapsExceptions).toContain('IDs');
  });
});
