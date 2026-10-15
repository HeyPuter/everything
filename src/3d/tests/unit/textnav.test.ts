import { describe, it, expect } from 'vitest';
import { movePos, wordLeft, wordRight, wordAt, verticalMove, completionPrefix, wordCandidates } from '../../src/scripting/textnav';

const v = 'import bpy\n    ob = bpy.context.object\n\nprint(ob.name)';

describe('caret movement', () => {
  it('line begin toggles between indentation and column 0', () => {
    const p = v.indexOf('ob =') + 3;
    const indent = v.indexOf('ob =');
    expect(movePos(v, p, 'LINE_BEGIN')).toBe(indent);
    expect(movePos(v, indent, 'LINE_BEGIN')).toBe(indent - 4);
    expect(movePos(v, p, 'LINE_END')).toBe(v.indexOf('\n\n'));
  });
  it('moves by words', () => {
    expect(wordRight(v, 0)).toBe(6);
    expect(wordRight(v, 6)).toBe(10);
    expect(wordLeft(v, 10)).toBe(7);
    expect(wordLeft(v, 7)).toBe(0);
    const dot = v.indexOf('.context');
    expect(wordRight(v, dot)).toBe(dot + 1);
  });
  it('moves vertically keeping the column', () => {
    expect(verticalMove(v, 3, 1)).toBe(v.indexOf('\n') + 1 + 3);
    // the empty line clamps the column
    const third = v.indexOf('\n\n') + 1;
    expect(verticalMove(v, v.indexOf('ob =') + 5, 1)).toBe(third);
    expect(verticalMove(v, 3, -1)).toBe(0);
    expect(movePos(v, 2, 'FILE_BOTTOM')).toBe(v.length);
    expect(movePos(v, v.length - 2, 'NEXT_LINE')).toBe(v.length);
  });
  it('finds the word at a position', () => {
    const p = v.indexOf('context') + 2;
    expect(v.slice(...wordAt(v, p))).toBe('context');
  });
});

describe('completion', () => {
  it('takes the identifier chain before the caret', () => {
    expect(completionPrefix('x = bpy.data.ob')).toBe('bpy.data.ob');
    expect(completionPrefix('print(na')).toBe('na');
    expect(completionPrefix('a + ')).toBe('');
  });
  it('offers words of the text and keywords, most frequent first', () => {
    const text = 'location = 1\nlocal_x = location + location\nloc';
    expect(wordCandidates(text, 'loc', 'python').slice(0, 2)).toEqual(['location', 'local_x']);
    expect(wordCandidates('', 'whi', 'python')).toEqual(['while']);
    expect(wordCandidates('', 'whi', 'text')).toEqual([]);
  });
});
