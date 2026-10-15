import { describe, it, expect } from 'vitest';
import { wrapRanges, wrapLines } from '../../src/sequencer/text';
import { moveCursor, lineOf, colOf, replaceRange, deleteAt, prevWord, nextWord } from '../../src/sequencer/textcursor';

const mono = (s: string) => s.length * 10;

describe('text wrapping with positions', () => {
  it('keeps source positions across explicit and soft line breaks', () => {
    const text = 'hello brave new\nworld';
    const r = wrapRanges(text, 110, mono);
    expect(r.map((l) => l.text)).toEqual(['hello brave', 'new', 'world']);
    expect(r.map((l) => l.start)).toEqual([0, 12, 16]);
    for (const l of r) expect(text.slice(l.start, l.start + l.text.length)).toBe(l.text);
    expect(wrapLines(text, 110, mono)).toEqual(['hello brave', 'new', 'world']);
  });
});

describe('text cursor', () => {
  const text = 'hello brave new\nworld';
  const lines = wrapRanges(text, 110, mono);
  const mv = (i: number, t: Parameters<typeof moveCursor>[3]) => moveCursor(text, lines, i, t, mono);

  it('maps positions to lines and columns', () => {
    expect(lineOf(lines, 11)).toBe(0);
    expect(colOf(lines, 11)).toBe(11);
    expect(lineOf(lines, 12)).toBe(1);
    expect(lineOf(lines, 16)).toBe(2);
  });

  it('moves by characters, words, lines and to the ends', () => {
    expect(mv(0, 'PREVIOUS_CHARACTER')).toBe(0);
    expect(mv(0, 'NEXT_CHARACTER')).toBe(1);
    expect(mv(0, 'NEXT_WORD')).toBe(5);
    expect(mv(8, 'PREVIOUS_WORD')).toBe(6);
    expect(mv(13, 'LINE_BEGIN')).toBe(12);
    expect(mv(13, 'LINE_END')).toBe(15);
    expect(mv(3, 'NEXT_LINE')).toBe(15);
    expect(mv(18, 'PREVIOUS_LINE')).toBe(14);
    expect(mv(5, 'TEXT_END')).toBe(text.length);
    expect(mv(5, 'PREVIOUS_LINE')).toBe(0);
    expect(prevWord('a  b', 3)).toBe(0);
    expect(nextWord('a  b', 1)).toBe(4);
  });

  it('edits replace the selection and delete around the cursor', () => {
    expect(replaceRange('abcdef', 4, 2, 'XY')).toEqual({ text: 'abXYef', cursor: 4 });
    expect(deleteAt('abc', 1, 1, false)).toEqual({ text: 'bc', cursor: 0 });
    expect(deleteAt('abc', 1, 1, true)).toEqual({ text: 'ac', cursor: 1 });
    expect(deleteAt('abc', 0, 3, true)).toEqual({ text: '', cursor: 0 });
    expect(deleteAt('abc', 0, 0, false)).toEqual({ text: 'abc', cursor: 0 });
  });
});
