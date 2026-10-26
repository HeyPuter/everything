import { MAX_DOCUMENT_CHARACTERS } from '../src/engine/text-limits.js';
import { describe, it, expect } from 'vitest';
import { TextDocument, paragraph, boundaries } from '../src/engine/model.js';

describe('canvas document transactions', () => {
  it('replaces a backwards selection spanning two paragraphs and restores it on undo', () => {
    const doc = new TextDocument([paragraph('Hello world'), paragraph('Second paragraph')]);
    doc.select(18, 6);
    doc.replace('new\ntext');
    expect(doc.text).toBe('Hello new\ntext paragraph');
    expect(doc.selection).toEqual({ anchor: 14, focus: 14 });
    doc.undo();
    expect(doc.text).toBe('Hello world\nSecond paragraph');
    expect(doc.selection).toEqual({ anchor: 18, focus: 6 });
    doc.redo();
    expect(doc.text).toBe('Hello new\ntext paragraph');
  });
  it('applies bold to partial runs across paragraphs, retaining the rest of their properties', () => {
    const doc = new TextDocument([paragraph('hello'), paragraph('world')]);
    doc.paragraphs[0].runs[0].properties = '<rPr/>';
    doc.select(2, 9);
    doc.toggleBold();
    expect(doc.paragraphs.map(p => p.runs.map(r => [r.text, r.bold]))).toEqual([
      [['he', false], ['llo', true]], [['wor', true], ['ld', false]],
    ]);
    expect(doc.paragraphs[0].runs[1].properties).toBe('<rPr/>');
    expect(doc.bold).toBe(true);
    doc.undo();
    expect(doc.bold).toBe(false);
  });
  it('inserts bold text at a caret without changing neighboring text', () => {
    const doc = new TextDocument([paragraph('ab')]);
    doc.select(1); doc.toggleBold(); doc.replace('X');
    expect(doc.paragraphs[0].runs.map(r => [r.text, r.bold])).toEqual([['a', false], ['X', true], ['b', false]]);
    doc.undo(); expect(doc.text).toBe('ab');
  });
  it('deletes a whole emoji, the accent of a combining sequence, and restores the caret with undo', () => {
    const doc = new TextDocument([paragraph('a👨‍👩‍👧‍👦é')]);
    doc.select(doc.text.length);
    // Backspace takes back the accent typed after its letter, as text fields do (backspace-clusters.test.js).
    doc.delete(-1); expect(doc.text).toBe('a👨‍👩‍👧‍👦e');
    doc.delete(-1); expect(doc.text).toBe('a👨‍👩‍👧‍👦');
    doc.delete(-1); expect(doc.text).toBe('a');
    doc.undo(); expect(doc.selection.focus).toBe('a👨‍👩‍👧‍👦'.length);
    expect(boundaries('é')).toEqual([0, 2]);
  });
  it('splits and merges paragraphs without losing suffix formatting', () => {
    const doc = new TextDocument([paragraph('abcdef')]);
    doc.select(3, 6); doc.toggleBold(); doc.select(2); doc.replace('\n');
    expect(doc.text).toBe('ab\ncdef');
    expect(doc.paragraphs[1].runs.at(-1).bold).toBe(true);
    doc.delete(-1); expect(doc.text).toBe('abcdef');
    expect(doc.paragraphs[0].runs.at(-1).bold).toBe(true);
  });
  it('does not erase the redo stack on a no-op edit', () => {
    const doc = new TextDocument([paragraph('a')]);
    doc.replace('b'); doc.undo(); doc.replace('');
    expect(doc.redo()).toBe(true);
    expect(doc.text).toBe('ba');
  });
  it('rejects oversize changes before recording history and cleans invalid XML characters', () => {
    const doc = new TextDocument([paragraph('a')]);
    expect(() => doc.replace('b'.repeat(MAX_DOCUMENT_CHARACTERS + 1))).toThrow('5,000,000');
    expect(doc.history).toHaveLength(0);
    doc.replace('\u0000\ud800'); expect(doc.text).toBe('��a');
  });
});

describe('paragraph formatting transactions', () => {
  it('formats a backward multi-paragraph selection as one undo step, excluding an endpoint at the next paragraph start', () => {
    const doc = new TextDocument([paragraph('One'), paragraph('Two'), paragraph('Three')]);
    doc.select(8, 1);
    doc.setParagraphFormat({ alignment: 'center', spaceAfter: 18 });
    expect(doc.paragraphs.map(p => p.format?.alignment)).toEqual(['center', 'center', undefined]);
    expect(doc.selection).toEqual({ anchor: 8, focus: 1 });
    expect(doc.history).toHaveLength(1);
    doc.undo(); expect(doc.paragraphFormatting.alignment).toBe('left');
    doc.redo(); expect(doc.paragraphFormatting.alignment).toBe('center');
  });
  it('formats an empty paragraph at the caret and inherits properties when splitting and merging', () => {
    const doc = new TextDocument([paragraph('')]);
    doc.setParagraphFormat({ alignment: 'right', lineRule: 'auto', lineSpacing: 1.5, spaceBefore: 12 });
    doc.replace('One\nTwo');
    expect(doc.paragraphs.map(p => p.format.alignment)).toEqual(['right', 'right']);
    doc.select(4); doc.delete(-1);
    expect(doc.text).toBe('OneTwo');
    expect(doc.paragraphFormatting.spaceBefore).toBe(12);
    doc.undo(); expect(doc.paragraphs).toHaveLength(2);
  });
  it('shows mixed fields individually and preserves redo on a formatting no-op', () => {
    const doc = new TextDocument([paragraph('One'), paragraph('Two')]);
    doc.setParagraphFormat({ alignment: 'right' });
    doc.select(0, doc.text.length);
    expect(doc.paragraphFormatting).toMatchObject({ alignment: null, lineSpacing: 1, spaceAfter: 9 });
    doc.setParagraphFormat({ spaceAfter: 18 }); doc.undo();
    expect(doc.setParagraphFormat({ spaceAfter: 9 })).toBe(false);
    expect(doc.redo()).toBe(true);
  });
  it('rejects invalid formatting before modifying history or content', () => {
    const doc = new TextDocument([paragraph('One')]);
    for (const patch of [{ alignment: 'justify' }, { spaceAfter: NaN }, { spaceBefore: -1 }, { lineSpacing: -1 }, { lineSpacing: 100 }, { nope: true }]) {
      expect(() => doc.setParagraphFormat(patch)).toThrow();
    }
    expect(doc.history).toHaveLength(0);
    expect(doc.text).toBe('One');
  });
});

describe('font size, italic and underline transactions', () => {
  it('formats partial runs across paragraphs without changing neighboring text or losing XML properties', () => {
    const doc = new TextDocument([paragraph('Alpha'), paragraph('Beta')]);
    doc.paragraphs[0].runs[0].properties = '<rPr/>';
    doc.select(2, 8); doc.setRunFormat({ fontSize: 24, italic: true, underline: true });
    expect(doc.paragraphs.map(p => p.runs.map(r => [r.text, r.fontSize, r.italic, r.underline]))).toEqual([
      [['Al', 12, false, false], ['pha', 24, true, true]], [['Be', 24, true, true], ['ta', 12, false, false]],
    ]);
    expect(doc.runFormatting).toMatchObject({ fontSize: 24, italic: true, underline: true });
    expect(doc.paragraphs[0].runs[1].properties).toBe('<rPr/>');
    doc.select(0, 10); expect(doc.runFormatting.fontSize).toBeNull();
    doc.undo(); expect(doc.paragraphs.every(p => p.runs.length === 1)).toBe(true);
    doc.redo(); expect(doc.paragraphs[0].runs[1].italic).toBe(true);
  });
  it('keeps caret formatting for subsequent typing and restores it through undo/redo', () => {
    const doc = new TextDocument([paragraph('ab')]);
    doc.select(1); doc.setRunFormat({ fontSize: 13.5, italic: true }); doc.toggleUnderline();
    doc.replace('X'); doc.replace('Y');
    expect(doc.paragraphs[0].runs[1]).toMatchObject({ text: 'XY', fontSize: 13.5, italic: true, underline: true });
    doc.undo(); doc.undo();
    expect(doc.text).toBe('ab');
    expect(doc.runFormatting).toMatchObject({ fontSize: 13.5, italic: true, underline: true });
    doc.redo(); expect(doc.paragraphs[0].runs[1].text).toBe('X');
  });
  it('stores empty-paragraph formatting as an undoable paragraph-mark change', () => {
    const doc = new TextDocument([paragraph()]);
    expect(doc.setRunFormat({ fontSize: 24, italic: true, underline: true })).toBe(true);
    expect(doc.paragraphs[0].markFormat).toMatchObject({ fontSize: 24, italic: true });
    doc.replace('Heading\n');
    expect(doc.paragraphs[1].markFormat.fontSize).toBe(24);
    doc.undo(); expect(doc.runFormatting.fontSize).toBe(24);
    doc.undo(); expect(doc.runFormatting.fontSize).toBe(12);
  });
  it('rejects non-half-point sizes and preserves redo on no-op formatting', () => {
    const doc = new TextDocument([paragraph('A')]);
    for (const fontSize of [0, NaN, Infinity, 1638.5, 12.25]) expect(() => doc.setRunFormat({ fontSize })).toThrow();
    doc.select(0, 1); doc.setRunFormat({ italic: true }); doc.undo();
    expect(doc.setRunFormat({ italic: false })).toBe(false);
    expect(doc.redo()).toBe(true);
  });
});
