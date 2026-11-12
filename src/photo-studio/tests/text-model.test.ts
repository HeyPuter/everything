import { describe, expect, it } from 'vitest';
import {
  applyCharStyle, applyParagraphStyle, charStyleAt, charStyleOfRange, defaultCharStyle, deleteRange, fromPlainText,
  insertContent, insertText, locate, nextChar, nextWord, paragraphAt, paragraphStyleOfRange, plainText, prevChar, prevWord,
  ptToPx, pxToPt, replaceRange, setPlainText, sliceContent, textLength, wordAt, type TextContent,
} from '../src/imaging/text/model';

const base = () => fromPlainText('Hello world', defaultCharStyle());
const runsOf = (c: TextContent, p = 0) => c.paragraphs[p].runs.map((r) => [r.text, r.style.weight, r.style.italic] as const);

describe('units', () => {
  it('converts points and pixels at 72 and 300 ppi', () => {
    expect(ptToPx(12, 72)).toBe(12);
    expect(ptToPx(72, 300)).toBe(300);
    expect(ptToPx(12, 300)).toBeCloseTo(50, 10);
    expect(pxToPt(50, 300)).toBeCloseTo(12, 10);
    expect(pxToPt(ptToPx(17.5, 300), 300)).toBeCloseTo(17.5, 12);
  });
});

describe('runs', () => {
  it('splits a run when styling the middle and merges back when unstyled', () => {
    let c = applyCharStyle(base(), 2, 7, { weight: 700 });
    expect(runsOf(c)).toEqual([['He', 400, false], ['llo w', 700, false], ['orld', 400, false]]);
    c = applyCharStyle(c, 4, 9, { italic: true });
    expect(runsOf(c)).toEqual([
      ['He', 400, false], ['ll', 700, false], ['o w', 700, true], ['or', 400, true], ['ld', 400, false],
    ]);
    c = applyCharStyle(c, 0, 11, { weight: 400, italic: false });
    expect(runsOf(c)).toEqual([['Hello world', 400, false]]);
  });
  it('does not mutate the input content', () => {
    const c = base();
    applyCharStyle(c, 0, 5, { weight: 900 });
    insertText(c, 3, 'xx');
    deleteRange(c, 0, 4);
    expect(runsOf(c)).toEqual([['Hello world', 400, false]]);
  });
  it('styles across paragraphs and handles reversed ranges', () => {
    const c = applyCharStyle(fromPlainText('ab\ncd\nef'), 7, 1, { size: 40 });
    expect(c.paragraphs.map((p) => p.runs.map((r) => [r.text, r.style.size]))).toEqual([
      [['a', 24], ['b', 40]], [['cd', 40]], [['e', 40], ['f', 24]],
    ]);
  });
  it('superscript and subscript are exclusive', () => {
    let c = applyCharStyle(base(), 0, 5, { superscript: true });
    c = applyCharStyle(c, 0, 5, { subscript: true });
    expect(charStyleOfRange(c, 0, 5)).toMatchObject({ subscript: true, superscript: false });
  });
});

describe('style queries', () => {
  it('reports mixed values as undefined', () => {
    let c = applyCharStyle(base(), 0, 5, { weight: 700, color: [255, 0, 0] });
    c = applyCharStyle(c, 3, 8, { color: [255, 0, 0] });
    const s = charStyleOfRange(c, 0, 8);
    expect(s.weight).toBeUndefined();
    expect(s.color).toEqual([255, 0, 0]);
    expect(s.family).toBe('Inter');
    expect(charStyleOfRange(c, 0, 5).weight).toBe(700);
    expect(charStyleOfRange(c, 5, 0).weight).toBe(700);
  });
  it('caret style comes from the character before, or the first at paragraph start', () => {
    const c = applyCharStyle(fromPlainText('ab\ncd'), 0, 1, { weight: 700 });
    expect(charStyleAt(c, 0).weight).toBe(700);
    expect(charStyleAt(c, 1).weight).toBe(700);
    expect(charStyleAt(c, 2).weight).toBe(400);
    expect(charStyleAt(c, 3).weight).toBe(400);
  });
  it('mixed paragraph styles', () => {
    let c = fromPlainText('a\nb\nc');
    c = applyParagraphStyle(c, 2, 2, { align: 'center', hyphenate: true });
    expect(c.paragraphs.map((p) => p.style.align)).toEqual(['left', 'center', 'left']);
    expect(paragraphStyleOfRange(c, 0, 3).align).toBeUndefined();
    expect(paragraphStyleOfRange(c, 0, 3).indentLeft).toBe(0);
    expect(paragraphStyleOfRange(c, 2, 3).align).toBe('center');
  });
});

describe('insert and delete', () => {
  it('inserts with the caret style and keeps neighbouring styles', () => {
    let c = applyCharStyle(base(), 0, 5, { weight: 700 });
    c = insertText(c, 5, '!!');
    expect(runsOf(c)).toEqual([['Hello!!', 700, false], [' world', 400, false]]);
    c = insertText(c, 0, '>');
    expect(runsOf(c)[0]).toEqual(['>Hello!!', 700, false]);
    c = insertText(c, 9, 'X', { ...defaultCharStyle(), italic: true });
    expect(plainText(c)).toBe('>Hello!! Xworld');
    expect(runsOf(c)).toEqual([['>Hello!!', 700, false], [' ', 400, false], ['X', 400, true], ['world', 400, false]]);
  });
  it('splits paragraphs on newline and keeps paragraph styles', () => {
    let c = applyParagraphStyle(applyCharStyle(base(), 6, 11, { italic: true }), 0, 0, { align: 'right' });
    c = insertText(c, 8, 'A\nB\n');
    expect(plainText(c)).toBe('Hello woA\nB\nrld');
    expect(c.paragraphs.length).toBe(3);
    expect(c.paragraphs.every((p) => p.style.align === 'right')).toBe(true);
    expect(runsOf(c, 2)).toEqual([['rld', 400, true]]);
    expect(runsOf(c, 1)).toEqual([['B', 400, true]]);
    expect(textLength(c)).toBe(plainText(c).length);
  });
  it('deletes across paragraphs and merges', () => {
    let c = applyParagraphStyle(fromPlainText('one\ntwo\nthree'), 5, 5, { align: 'center' });
    c = applyCharStyle(c, 8, 13, { weight: 700 });
    const d = deleteRange(c, 2, 9);
    expect(plainText(d)).toBe('onhree');
    expect(d.paragraphs.length).toBe(1);
    expect(d.paragraphs[0].style.align).toBe('left');
    expect(runsOf(d)).toEqual([['on', 400, false], ['hree', 700, false]]);
    // Deleting the separator alone joins paragraphs.
    expect(plainText(deleteRange(c, 3, 4))).toBe('onetwo\nthree');
  });
  it('emptied paragraphs keep the deleted style for typing', () => {
    let c = applyCharStyle(fromPlainText('abc'), 0, 3, { size: 50 });
    c = deleteRange(c, 0, 3);
    expect(plainText(c)).toBe('');
    expect(c.paragraphs[0].runs.length).toBe(1);
    c = insertText(c, 0, 'z');
    expect(charStyleOfRange(c, 0, 1).size).toBe(50);
  });
  it('replaces a selection with the style of its first character', () => {
    const c = applyCharStyle(base(), 6, 11, { italic: true });
    const r = replaceRange(c, 6, 11, 'there');
    expect(plainText(r)).toBe('Hello there');
    expect(charStyleOfRange(r, 6, 11).italic).toBe(true);
  });
  it('slices and re-inserts formatted content', () => {
    const c = applyCharStyle(fromPlainText('ab\ncd'), 1, 4, { weight: 800 });
    const piece = sliceContent(c, 1, 4);
    expect(plainText(piece)).toBe('b\nc');
    const out = insertContent(fromPlainText('XY'), 1, piece);
    expect(plainText(out)).toBe('Xb\ncY');
    expect(charStyleOfRange(out, 1, 2).weight).toBe(800);
    expect(charStyleOfRange(out, 3, 4).weight).toBe(800);
    expect(charStyleOfRange(out, 4, 5).weight).toBe(400);
  });
  it('pasted formatted text keeps its own optional styles', () => {
    // Copied plain text has no features, digits or linked style; pasting it into
    // text that has them must not hand them over.
    const piece = sliceContent(fromPlainText('abc'), 0, 3);
    const dest = applyCharStyle(fromPlainText('XY'), 0, 2, { features: 'smcp', digits: 'arabic', charStyle: 'cs1', vertical: 'rotate' });
    const out = insertContent(dest, 1, piece);
    expect(plainText(out)).toBe('XabcY');
    const st = charStyleOfRange(out, 1, 4);
    expect(st.features || '').toBe('');
    expect(st.digits || '').toBe('');
    expect(st.charStyle || '').toBe('');
    expect(st.vertical || '').toBe('');
    expect(charStyleOfRange(out, 4, 5).features).toBe('smcp');
  });
  it('plain text with Windows or old Mac line ends makes clean paragraphs', () => {
    // Data set values from CSV files can carry CRLF or CR inside quoted fields.
    const c = setPlainText(base(), 'one\r\ntwo\rthree');
    expect(c.paragraphs.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['one', 'two', 'three']);
    expect(plainText(fromPlainText('a\r\nb'))).toBe('a\nb');
  });
  it('setPlainText keeps the first styles', () => {
    const c = setPlainText(applyCharStyle(base(), 0, 11, { family: 'Caveat' }), 'x\ny');
    expect(c.paragraphs.length).toBe(2);
    expect(c.paragraphs[1].runs[0].style.family).toBe('Caveat');
  });
  it('locates indices across paragraphs', () => {
    const c = fromPlainText('ab\n\ncd');
    expect(locate(c, 2)).toEqual({ p: 0, offset: 2 });
    expect(locate(c, 3)).toEqual({ p: 1, offset: 0 });
    expect(locate(c, 4)).toEqual({ p: 2, offset: 0 });
    expect(locate(c, 99)).toEqual({ p: 2, offset: 2 });
  });
});

describe('navigation', () => {
  it('steps over surrogate pairs and combining marks', () => {
    const t = 'a😀éb';
    expect(nextChar(t, 1)).toBe(3);
    expect(prevChar(t, 3)).toBe(1);
    expect(nextChar(t, 3)).toBe(5);
    expect(prevChar(t, 5)).toBe(3);
  });
  it('word movement and selection', () => {
    const t = 'The quick, brown fox';
    expect(nextWord(t, 0)).toBe(3);
    expect(nextWord(t, 3)).toBe(9);
    expect(prevWord(t, 11)).toBe(4);
    expect(prevWord(t, 12)).toBe(11);
    expect(wordAt(t, 5)).toEqual({ start: 4, end: 9 });
    expect(wordAt(t, 9)).toEqual({ start: 4, end: 9 });
    const c = fromPlainText('ab\ncdef\ng');
    expect(paragraphAt(c, 5)).toEqual({ start: 3, end: 7 });
  });
});
