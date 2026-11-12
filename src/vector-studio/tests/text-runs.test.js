import { describe, it, expect } from 'vitest';
import { createText } from '../src/model/nodes.js';
import {
  runsOf,
  styledRuns,
  styleAt,
  applyRunStyle,
  replaceRange,
  rangeStyle,
  normalizeRuns,
  wholeStylePatch,
  paraStylePatch,
  paraAt,
  paragraphRanges,
  changeCase,
  wordAt,
  prevWordIndex,
  nextWordIndex,
  nextCharIndex,
  prevCharIndex,
  backspaceIndex,
  isCaretStop,
  MIXED,
} from '../src/model/text-runs.js';

const node = (text, extra = {}) => createText(text, 0, 0, extra);
const red = { type: 'solid', color: '#ff0000' };

describe('style runs', () => {
  it('treats nodes without runs as one default run (backward compatible)', () => {
    const n = node('hello');
    expect(runsOf(n)).toEqual([{ len: 5 }]);
    expect(styleAt(n, 2).fontFamily).toBe('Inter');
    expect(styleAt(n, 2).fill).toEqual(n.fill);
  });

  it('splits a run when styling a middle range and merges back when equal', () => {
    const n = node('abcdefgh');
    const runs = applyRunStyle(n, 2, 5, { fontWeight: 700 });
    expect(runs).toEqual([{ len: 2 }, { len: 3, fontWeight: 700 }, { len: 3 }]);
    const n2 = { ...n, runs };
    expect(styleAt(n2, 3).fontWeight).toBe(700);
    expect(styleAt(n2, 5).fontWeight).toBe(400);
    // Styling the rest the same merges everything into one override run.
    const all = applyRunStyle(n2, 0, 8, { fontWeight: 700 });
    expect(all).toEqual([{ len: 8, fontWeight: 700 }]);
    // Setting it back to the default removes runs entirely.
    expect(applyRunStyle({ ...n, runs: all }, 0, 8, { fontWeight: 400 })).toBeUndefined();
  });

  it('carries paint overrides per character', () => {
    const n = node('ab', { runs: [{ len: 1, fill: red }] });
    expect(styleAt(n, 0).fill).toEqual(red);
    expect(styleAt(n, 1).fill.color).toBe('#000000');
    const rs = rangeStyle(n, 0, 2);
    expect(rs.fill).toBe(MIXED);
    expect(rs.fontFamily).toBe('Inter');
  });

  it('normalizes away overrides equal to the defaults and empty runs', () => {
    const n = node('abcd');
    expect(normalizeRuns([{ len: 2, fontFamily: 'Inter' }, { len: 0, fontWeight: 700 }, { len: 2 }], n)).toBeUndefined();
    expect(normalizeRuns([{ len: 1, underline: true }, { len: 1, underline: true }, { len: 2 }], n)).toEqual([{ len: 2, underline: true }, { len: 2 }]);
  });

  it('pads runs that are shorter than the text with default style', () => {
    const n = node('abcdef', { runs: [{ len: 2, fontSize: 30 }] });
    const r = styledRuns(n);
    expect(r).toHaveLength(2);
    expect(r[1].style.fontSize).toBe(12);
    expect(r[1].end).toBe(6);
  });
});

describe('editing ranges', () => {
  it('inserted text takes the style of the character before it', () => {
    const n = node('abcd', { runs: [{ len: 2, fontWeight: 700 }, { len: 2 }] });
    const p = replaceRange(n, 2, 2, 'XY');
    expect(p.text).toBe('abXYcd');
    expect(p.runs).toEqual([{ len: 4, fontWeight: 700 }, { len: 2 }]);
  });

  it('text typed over a selection takes the style of the first selected character', () => {
    const n = node('ab CD ef', { runs: [{ len: 3 }, { len: 2, fontWeight: 700 }, { len: 3 }] });
    const p = replaceRange(n, 3, 5, 'X');
    expect(p.text).toBe('ab X ef');
    expect(p.runs).toEqual([{ len: 3 }, { len: 1, fontWeight: 700 }, { len: 3 }]);
  });

  it('inserts with a pending style', () => {
    const n = node('abcd');
    const p = replaceRange(n, 4, 4, 'ef', { fontStyle: 'italic' });
    expect(p.runs).toEqual([{ len: 4 }, { len: 2, fontStyle: 'italic' }]);
  });

  it('deletes across runs', () => {
    const n = node('aabbcc', { runs: [{ len: 2 }, { len: 2, underline: true }, { len: 2, strike: true }] });
    const p = replaceRange(n, 1, 5, '');
    expect(p.text).toBe('ac');
    expect(p.runs).toEqual([{ len: 1 }, { len: 1, strike: true }]);
  });

  it('keeps the deleted style when the text becomes empty', () => {
    const n = node('ab', { runs: [{ len: 2, fontSize: 40 }] });
    const p = replaceRange(n, 0, 2, '');
    expect(p.text).toBe('');
    expect(p.runs).toBeUndefined();
    expect(p.char.fontSize).toBe(40);
  });

  it('keeps paragraph overrides in step with inserted and deleted newlines', () => {
    const n = node('one\ntwo\nthree', { paras: [null, { align: 'center' }, null] });
    expect(paraAt(n, 1).align).toBe('center');
    const split = replaceRange(n, 5, 5, '\n');
    expect(split.text).toBe('one\nt\nwo\nthree');
    expect(split.paras).toEqual([null, { align: 'center' }, { align: 'center' }, null]);
    const merged = replaceRange(n, 3, 4, '');
    expect(merged.paras).toBeUndefined();
  });

  it('applies whole-object styles and clears matching run overrides', () => {
    const n = node('abcd', { runs: [{ len: 2, fontSize: 30, underline: true }, { len: 2 }] });
    const p = wholeStylePatch(n, { fontSize: 18, fill: red });
    expect(p.char.fontSize).toBe(18);
    expect(p.fill).toEqual(red);
    expect(p.runs).toEqual([{ len: 2, underline: true }, { len: 2 }]);
  });

  it('applies paragraph styles to a range or to the whole object', () => {
    const n = node('a\nb\nc');
    const some = paraStylePatch(n, 1, 1, { align: 'right' });
    expect(some.paras).toEqual([null, { align: 'right' }, null]);
    const all = paraStylePatch(n, 0, 2, { align: 'justify' });
    expect(all.para.align).toBe('justify');
    expect(paragraphRanges('a\nb')).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });
});

describe('case conversion and words', () => {
  it('converts case without changing the length', () => {
    expect(changeCase('hello World', 'upper')).toBe('HELLO WORLD');
    expect(changeCase('HELLO World', 'lower')).toBe('hello world');
    expect(changeCase('the quick BROWN fox', 'title')).toBe('The Quick Brown Fox');
    expect(changeCase('first one. second ONE! third', 'sentence')).toBe('First one. Second one! Third');
    expect(changeCase('stra\u00dfe', 'upper')).toHaveLength(6);
  });

  it('finds word boundaries', () => {
    const t = 'Hello, big world';
    expect(wordAt(t, 1)).toEqual([0, 5]);
    expect(wordAt(t, 8)).toEqual([7, 10]);
    expect(prevWordIndex(t, 10)).toBe(7);
    expect(prevWordIndex(t, 11)).toBe(7);
    expect(nextWordIndex(t, 0)).toBe(5);
    expect(nextWordIndex(t, 5)).toBe(6);
  });
});

describe('user-perceived characters', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  it('steps over emoji, flags and letters with marks as one character', () => {
    expect(nextCharIndex('a\u{1F600}b', 1)).toBe(3);
    expect(prevCharIndex('a\u{1F600}b', 3)).toBe(1);
    expect(nextCharIndex(`x${family}y`, 1)).toBe(9);
    expect(prevCharIndex(`x${family}y`, 9)).toBe(1);
    expect(nextCharIndex('x\u{1F1EB}\u{1F1F7}y', 1)).toBe(5);
    expect(nextCharIndex('cafe\u0301!', 3)).toBe(5);
    expect(prevCharIndex('cafe\u0301!', 5)).toBe(3);
    expect(nextCharIndex('ab', 2)).toBe(2);
    expect(prevCharIndex('ab', 0)).toBe(0);
    expect(isCaretStop('a\u{1F600}b', 2)).toBe(false);
    expect(isCaretStop('a\u{1F600}b', 3)).toBe(true);
  });

  it('Backspace removes a whole emoji but only the last mark of a letter', () => {
    expect(backspaceIndex(`x${family}y`, 9)).toBe(1);
    expect(backspaceIndex('x\u{1F44D}\u{1F3FD}y', 5)).toBe(1);
    expect(backspaceIndex('x\u{1F1EB}\u{1F1F7}y', 5)).toBe(1);
    expect(backspaceIndex('cafe\u0301', 5)).toBe(4);
    expect(backspaceIndex('ab', 2)).toBe(1);
  });

  it('word navigation keeps combining marks in words and emoji whole', () => {
    expect(wordAt('cafe\u0301 noir', 1)).toEqual([0, 5]);
    expect(wordAt('\u0928\u092E\u0938\u094D\u0924\u0947 x', 0)).toEqual([0, 6]);
    expect(nextWordIndex('cafe\u0301 noir', 0)).toBe(5);
    expect(prevWordIndex('a \u{1F600}', 4)).toBe(2);
    expect(nextWordIndex('\u{1F600} a', 0)).toBe(2);
  });
});
