import { describe, expect, it } from 'vitest';
import { breakOpportunities, hyphenationPoints } from '../src/imaging/text/breaks';
import { cssFont, layoutText, type Measure } from '../src/imaging/text/layout';
import {
  applyCharStyle, applyParagraphStyle, defaultCharStyle, fromPlainText, plainText, type Align, type TextLayerData,
} from '../src/imaging/text/model';

// Monospace stand-in: every character is half an em wide; ascent 0.8 em, descent 0.2 em.
const sizeOf = (font: string) => Number(/([\d.]+)px/.exec(font)![1]);
const mono: Measure = (text, font) => {
  const s = sizeOf(font);
  return { width: [...text.replace(/‌/g, '')].length * s * 0.5, ascent: s * 0.8, descent: s * 0.2 };
};
const style = { ...defaultCharStyle(), size: 20 }; // 20 px at 72 ppi: 10 px per character

function para(text: string, width: number, align: Align = 'left', height = 1000): TextLayerData {
  return {
    content: applyParagraphStyle(fromPlainText(text, style), 0, text.length, { align }),
    mode: 'paragraph', box: { width, height }, origin: { x: 5, y: 7 }, orientation: 'horizontal', antiAlias: 'smooth',
  };
}
const linesOf = (d: TextLayerData) => {
  const t = plainText(d.content);
  return layoutText(d, { measure: mono }).lines.map((l) => t.slice(l.start, l.end));
};

describe('break opportunities', () => {
  it('breaks after spaces, between word hyphens and around CJK', () => {
    const b = breakOpportunities([...'a b-c -d']);
    expect(b).toEqual([false, true, false, true, false, true, false, false]);
    const cjk = breakOpportunities([...'日本語。です']);
    // No break before the ideographic full stop.
    expect(cjk).toEqual([true, true, false, true, true, false]);
  });
  it('hyphenates common English words conservatively', () => {
    expect(hyphenationPoints('computer')).toEqual([3, 5]);
    expect(hyphenationPoints('happen')).toEqual([3]);
    expect(hyphenationPoints('window')).toEqual([3]);
    expect(hyphenationPoints('table')).toEqual([]); // too short
    expect(hyphenationPoints('tables', { minWord: 5 })).toEqual([2]);
    expect(hyphenationPoints('information')).toContain(7);
    expect(hyphenationPoints('Paris')).toEqual([]);
    expect(hyphenationPoints('x2y2z2a')).toEqual([]);
  });
});

describe('line breaking', () => {
  it('fills lines greedily with the exact expected contents', () => {
    expect(linesOf(para('The quick brown fox jumps over the lazy dog', 100))).toEqual([
      'The quick ', 'brown fox ', 'jumps over ', 'the lazy ', 'dog',
    ]);
  });
  it('breaks overlong words by character and after word hyphens', () => {
    expect(linesOf(para('abcdefghijklmno', 50))).toEqual(['abcde', 'fghij', 'klmno']);
    expect(linesOf(para('well-known fact', 60))).toEqual(['well-', 'known ', 'fact']);
  });
  it('keeps paragraphs and empty paragraphs as their own lines', () => {
    expect(linesOf(para('ab\n\ncd', 100))).toEqual(['ab', '', 'cd']);
  });
  it('point text only breaks at newlines', () => {
    const d: TextLayerData = { ...para('a very long line of text that never wraps\nnext', 10), mode: 'point', box: undefined };
    expect(linesOf(d)).toEqual(['a very long line of text that never wraps', 'next']);
  });
  it('hyphenates when enabled', () => {
    const d = para('see computer', 80);
    d.content = applyParagraphStyle(d.content, 0, 0, { hyphenate: true });
    const lay = layoutText(d, { measure: mono });
    // "see com-" is 8 cells (80 px) and fits exactly.
    expect(lay.lines[0].hyphen).toBe(true);
    expect(plainText(d.content).slice(lay.lines[0].start, lay.lines[0].end)).toBe('see com');
    const last = lay.runs.filter((r) => r.y === lay.lines[0].y).pop()!;
    expect(last.text.endsWith('-')).toBe(true);
    expect(lay.lines[0].width).toBe(80);
  });
  it('shows a soft hyphen only where it breaks', () => {
    const lay = layoutText(para('aaaa­bbbb', 60), { measure: mono });
    expect(lay.lines.length).toBe(2);
    expect(lay.lines[0].hyphen).toBe(true);
    expect(lay.runs[0].text).toBe('aaaa-');
    const one = layoutText(para('aaaa­bbbb', 200), { measure: mono });
    expect(one.runs.map((r) => r.text).join('')).toBe('aaaabbbb');
  });
});

describe('alignment and justification', () => {
  it('offsets lines by alignment inside the frame', () => {
    const xs = (align: Align) => layoutText(para('dog', 100, align), { measure: mono }).lines[0].x;
    expect(xs('left')).toBe(5);
    expect(xs('center')).toBe(5 + 35);
    expect(xs('right')).toBe(5 + 70);
  });
  it('justified lines span the frame exactly; the last line keeps its alignment', () => {
    for (const align of ['justify-left', 'justify-center', 'justify-right'] as Align[]) {
      const lay = layoutText(para('The quick brown fox jumps over the lazy dog', 100, align), { measure: mono });
      for (const l of lay.lines.slice(0, -1)) {
        expect(l.width).toBeCloseTo(100, 9);
        expect(l.x).toBe(5);
        const lineRuns = lay.runs.filter((r) => r.y === l.y);
        const last = lineRuns[lineRuns.length - 1];
        expect(last.x + last.width).toBeCloseTo(105, 9);
        // Stretch goes to inner spaces only: glyph advances stay 10 px.
        for (const r of lineRuns) for (const a of r.advances) expect(a).toBe(10);
      }
      const last = lay.lines[lay.lines.length - 1];
      expect(last.width).toBe(30);
      expect(last.x).toBe(align === 'justify-left' ? 5 : align === 'justify-center' ? 40 : 75);
    }
    const all = layoutText(para('The quick brown fox jumps over the lazy dog', 100, 'justify-all'), { measure: mono });
    // A single word cannot stretch at spaces, so its letters spread instead.
    expect(all.lines[all.lines.length - 1].width).toBeCloseTo(100, 9);
  });
  it('applies indents and first-line indent', () => {
    const d = para('aaaa bbbb cccc', 100);
    d.content = applyParagraphStyle(d.content, 0, 0, { indentLeft: 10, indentFirst: 20, indentRight: 10 });
    const lay = layoutText(d, { measure: mono });
    // First line has 60 px available ("aaaa " fits, "bbbb" does not); later lines 80 px.
    expect(lay.lines.map((l) => l.x)).toEqual([35, 15, 15]);
    expect(lay.lines[0].end).toBe(5);
  });
  it('aligns point text around its origin', () => {
    const at = (align: Align) => {
      const d: TextLayerData = { ...para('abcd', 0, align), mode: 'point', box: undefined };
      return layoutText(d, { measure: mono }).lines[0].x;
    };
    expect(at('left')).toBe(5);
    expect(at('center')).toBe(5 - 20);
    expect(at('right')).toBe(5 - 40);
  });
});

describe('vertical metrics', () => {
  it('auto leading is 120% and the first baseline sits at the ascent', () => {
    const lay = layoutText(para('aa bb cc', 30), { measure: mono });
    expect(lay.lines.map((l) => l.y)).toEqual([7 + 16, 7 + 16 + 24, 7 + 16 + 48]);
    const pt = layoutText({ ...para('a\nb', 0), mode: 'point', box: undefined }, { measure: mono });
    expect(pt.lines.map((l) => l.y)).toEqual([7, 31]);
  });
  it('uses the largest leading on a line and paragraph spacing', () => {
    let c = fromPlainText('ab\ncd', { ...style, leading: 30 });
    c = applyCharStyle(c, 1, 2, { leading: 50 });
    c = applyParagraphStyle(c, 0, 0, { spaceAfter: 6 });
    c = applyParagraphStyle(c, 3, 3, { spaceBefore: 4 });
    const lay = layoutText({ content: c, mode: 'point', origin: { x: 0, y: 0 }, orientation: 'horizontal', antiAlias: 'smooth' }, { measure: mono });
    expect(lay.lines[1].y - lay.lines[0].y).toBe(30 + 10);
  });
  it('detects overflow and hides lines that do not fit', () => {
    const lay = layoutText(para('aa bb cc dd', 30, 'left', 45), { measure: mono });
    // Lines at baselines 16 and 40 (descent 4 -> bottoms 20, 44) fit; the third does not.
    expect(lay.overflow).toBe(true);
    expect(lay.lines.filter((l) => l.visible).length).toBe(2);
    expect(lay.visibleEnd).toBe(6);
    expect(new Set(lay.runs.map((r) => r.text))).toEqual(new Set(['aa', 'bb']));
    expect(layoutText(para('aa bb', 30, 'left', 45), { measure: mono }).overflow).toBe(false);
  });
  it('converts sizes with the document resolution', () => {
    const d: TextLayerData = { content: fromPlainText('ab', { ...style, size: 24 }), mode: 'point', origin: { x: 0, y: 0 }, orientation: 'horizontal', antiAlias: 'smooth' };
    const lay = layoutText(d, { measure: mono, resolution: 300 });
    expect(lay.runs[0].sizePx).toBeCloseTo(100, 9);
    expect(lay.runs[0].font).toBe(cssFont(style, 100));
    expect(lay.lines[0].width).toBeCloseTo(100, 9);
  });
});

describe('kerning', () => {
  // Monospace plus a -3 px kern for the pair "AV" when kerning is on.
  const kerned: Measure = (text, font, kerning = true) => {
    const base = mono(text, font);
    const pairs = kerning ? (text.match(/AV/g) ?? []).length : 0;
    return { ...base, width: base.width - 3 * pairs };
  };
  const pt = (patch = {}): TextLayerData => ({ content: fromPlainText('AVA', { ...style, ...patch }), mode: 'point', origin: { x: 0, y: 0 }, orientation: 'horizontal', antiAlias: 'smooth' });
  it('applies pair kerning to the second glyph and can be turned off', () => {
    expect(layoutText(pt(), { measure: kerned }).runs[0].advances).toEqual([10, 7, 10]);
    expect(layoutText(pt({ kerning: 'none' }), { measure: kerned }).runs[0].advances).toEqual([10, 10, 10]);
    expect(layoutText(pt({ kerning: 'optical' }), { measure: kerned }).lines[0].width).toBe(27);
  });
});

describe('character attributes', () => {
  const point = (content = fromPlainText('abcd', style)): TextLayerData => ({ content, mode: 'point', origin: { x: 0, y: 100 }, orientation: 'horizontal', antiAlias: 'smooth' });
  it('tracking adds a fixed fraction of the em after each character', () => {
    const lay = layoutText(point(applyCharStyle(fromPlainText('abcd', style), 0, 4, { tracking: 100 })), { measure: mono });
    expect(lay.lines[0].width).toBeCloseTo(4 * 12, 9);
    expect(lay.runs[0].letterSpacing).toBeCloseTo(2, 9);
  });
  it('horizontal scale multiplies advances; baseline shift raises the run', () => {
    const c = applyCharStyle(fromPlainText('abcd', style), 2, 4, { scaleX: 50, baselineShift: 5 });
    const lay = layoutText(point(c), { measure: mono });
    expect(lay.runs.map((r) => [r.text, r.width, r.y])).toEqual([['ab', 20, 100], ['cd', 10, 95]]);
  });
  it('superscript, subscript, small caps and all caps', () => {
    let c = fromPlainText('aBcd', style);
    c = applyCharStyle(c, 0, 1, { superscript: true });
    c = applyCharStyle(c, 1, 2, { subscript: true });
    c = applyCharStyle(c, 2, 3, { smallCaps: true });
    c = applyCharStyle(c, 3, 4, { allCaps: true });
    const r = layoutText(point(c), { measure: mono }).runs;
    expect(r.map((x) => x.text)).toEqual(['a', 'B', 'C', 'D']);
    expect(r[0].sizePx).toBeCloseTo(20 * 0.583, 9);
    expect(r[0].y).toBeCloseTo(100 - 20 * 0.333, 9);
    expect(r[1].y).toBeCloseTo(100 + 20 * 0.333, 9);
    expect(r[2].sizePx).toBeCloseTo(14, 9);
    expect(r[3].sizePx).toBe(20);
  });
  it('emits underline segments continuous across inner spaces', () => {
    const lay = layoutText(point(applyCharStyle(fromPlainText('ab cd', style), 0, 5, { underline: true })), { measure: mono });
    expect(lay.decorations.length).toBe(1);
    expect(lay.decorations[0]).toMatchObject({ kind: 'underline', x: 0, width: 50 });
  });
});

describe('caret geometry', () => {
  it('caret positions round-trip through hit testing', () => {
    const d = para('The quick brown fox jumps over the lazy dog\nend', 100, 'center');
    const lay = layoutText(d, { measure: mono });
    for (let i = 0; i <= lay.length; i++) {
      const r = lay.caretRect(i);
      const hit = lay.hitTest(r.x, r.y + r.height / 2);
      expect(hit, `index ${i}`).toBe(i);
    }
  });
  it('soft wraps place the downstream caret on the next line', () => {
    const lay = layoutText(para('aaaa bbbb', 50), { measure: mono });
    expect(lay.caretRect(5).y).toBeGreaterThan(lay.caretRect(4).y);
    expect(lay.caretRect(5, 'up').y).toBe(lay.caretRect(4).y);
    // Clicking far right of the first line lands before its trailing space.
    expect(lay.hitTest(500, lay.caretRect(0).y + 1)).toBe(4);
    expect(lay.hitTest(-50, lay.caretRect(6).y + 1)).toBe(5);
  });
  it('selection rectangles cover each line of the range', () => {
    const lay = layoutText(para('aaaa bbbb cccc', 50), { measure: mono });
    const rs = lay.selectionRects(2, 12);
    expect(rs.length).toBe(3);
    expect(rs[0].x).toBe(5 + 20);
    expect(rs[0].width).toBe(30); // through the trailing space
    expect(rs[1].x).toBe(5);
    expect(rs[2]).toMatchObject({ x: 5, width: 20 });
  });
  it('moves between lines keeping the horizontal position', () => {
    const lay = layoutText(para('aaaa bbbb cccc', 50), { measure: mono });
    expect(lay.moveLine(2, 1)).toBe(7);
    expect(lay.moveLine(7, -1)).toBe(2);
    expect(lay.moveLine(2, -1)).toBe(0);
  });
  it('empty text still has a caret with the caret style metrics', () => {
    const lay = layoutText({ ...para('', 100), mode: 'point', box: undefined }, { measure: mono });
    expect(lay.caretRect(0)).toEqual({ x: 5, y: 7 - 16, width: 0, height: 20 });
    expect(lay.hitTest(300, 300)).toBe(0);
    expect(lay.runs).toEqual([]);
    expect(lay.selectionRects(0, 0)).toEqual([]);
  });
  it('bounds of point text', () => {
    const lay = layoutText({ ...para('abc\nab', 0), mode: 'point', box: undefined }, { measure: mono });
    expect(lay.bounds).toEqual({ x: 5, y: 7 - 16, width: 30, height: 24 + 20 });
  });
});

describe('vertical orientation', () => {
  it('stacks upright glyphs in columns from right to left', () => {
    const d: TextLayerData = { content: fromPlainText('ab\ncd', style), mode: 'point', origin: { x: 100, y: 10 }, orientation: 'vertical', antiAlias: 'smooth' };
    const lay = layoutText(d, { measure: mono });
    expect(lay.lines.map((l) => l.x)).toEqual([100, 76]);
    expect(lay.runs.length).toBe(4);
    // Cells are one em tall; glyphs centered on the column.
    expect(lay.runs[0].x).toBe(95);
    expect(lay.runs[1].y - lay.runs[0].y).toBe(20);
    const r = lay.caretRect(1);
    expect(r.y).toBe(30);
    expect(lay.hitTest(100, 31)).toBe(1);
    expect(lay.hitTest(76, 49)).toBe(5);
  });
  it('wraps vertical paragraph text at the frame height', () => {
    const d: TextLayerData = { content: fromPlainText('aaaa', style), mode: 'paragraph', box: { width: 100, height: 40 }, origin: { x: 0, y: 0 }, orientation: 'vertical', antiAlias: 'smooth' };
    const lay = layoutText(d, { measure: mono });
    expect(lay.lines.length).toBe(2);
    expect(lay.lines[0].x).toBe(100 - 12);
  });
});

describe('CSS font strings', () => {
  it('quotes family names that are not plain identifiers or that read as keywords', () => {
    const f = (family: string) => cssFont({ family, weight: 400, italic: false }, 12);
    expect(f('Inter')).toBe('400 12px Inter, sans-serif');
    // A name starting with a digit is not a CSS identifier: unquoted, the whole font is ignored.
    expect(f('04B_03')).toBe('400 12px "04B_03", sans-serif');
    // Generic and CSS-wide keywords match in any case.
    expect(f('Serif')).toBe('400 12px "Serif", sans-serif');
    expect(f('Inherit')).toBe('400 12px "Inherit", sans-serif');
    expect(f('--x')).toBe('400 12px "--x", sans-serif');
  });
});
