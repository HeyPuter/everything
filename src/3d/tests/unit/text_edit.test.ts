import { describe, expect, it } from 'vitest';
import { layoutTextWith, KERNING_UNIT, type GlyphSource } from '../../src/io/textlayout';
import * as T from '../../src/modes/text/textops';
import type { CurveData, Spline } from '../../src/data/types';

/** Monospace test font: every glyph 0.5 em wide, a unit square outline (spaces are empty). */
const square = (): Spline => ({
  type: 'BEZIER',
  bezier_points: [
    [0, 0],
    [0.4, 0],
    [0.4, 0.7],
    [0, 0.7],
  ].map(([x, y]) => ({ co: [x, y, 0], handle_left: [x, y, 0], handle_right: [x, y, 0], handle_left_type: 'VECTOR', handle_right_type: 'VECTOR', radius: 1, tilt: 0 })),
  points: [],
  use_cyclic_u: true,
  resolution_u: 0,
  order_u: 4,
  use_smooth: false,
  material_index: 0,
});
const mono: GlyphSource = { advance: () => 0.5, outline: (ch) => (ch.trim() ? [square()] : null), hasStyle: (s) => s === 'REGULAR' || s === 'BOLD' };

function text(body: string, extra: Partial<CurveData> = {}): CurveData {
  return { id: 'cu', name: 'Text', dimensions: '2D', splines: [], resolution_u: 12, bevel_depth: 0, bevel_resolution: 0, extrude: 0, offset: 0, fill_mode: 'FULL', use_fill_caps: false, materials: [], body, size: 1, ...extra };
}

describe('text layout', () => {
  it('places carets with character spacing and kerning', () => {
    const cu = text('abc');
    let l = layoutTextWith(cu, mono);
    expect(l.carets.map((c) => +c[0].toFixed(3))).toEqual([0, 0.5, 1, 1.5]);
    T.formats(cu)[0].kerning = 2;
    l = layoutTextWith(cu, mono);
    expect(+l.carets[1][0].toFixed(4)).toBe(+(0.5 + 2 * KERNING_UNIT).toFixed(4));
    expect(l.splines.length).toBe(3);
  });

  it('wraps words inside a text box and flows into the next box', () => {
    const cu = text('aa bb cc dd', { text_boxes: [{ x: 0, y: 0, width: 2.6, height: 1.3 }, { x: 5, y: 0, width: 2.6, height: 0 }] });
    const l = layoutTextWith(cu, mono);
    // "aa bb " fits (2.5), "cc dd" goes to the next line, which no longer fits the first box
    expect(l.lines.map((x) => [x.start, x.end])).toEqual([
      [0, 6],
      [6, 11],
    ]);
    expect(l.carets[6][0]).toBe(5);
    expect(l.carets[0][1]).toBe(0);
  });

  it('aligns lines and justifies', () => {
    const c = layoutTextWith(text('ab\nabcd', { align_x: 'CENTER' }), mono);
    expect(c.carets[0][0]).toBe(-0.5);
    expect(c.carets[3][0]).toBe(-1);
    const j = layoutTextWith(text('a b c d', { align_x: 'JUSTIFY', text_boxes: [{ x: 0, y: 0, width: 2.4, height: 0 }] }), mono);
    // first line "a b " justified to 2.4: the space between a and b grows
    expect(j.lines.length).toBe(2);
    expect(j.carets[2][0]).toBeGreaterThan(1);
  });

  it('small caps, underline and synthesized italics', () => {
    const cu = text('ab');
    const f = T.formats(cu);
    f[0].use_small_caps = true;
    f[1].use_underline = true;
    f[1].use_italic = true;
    const l = layoutTextWith(cu, mono);
    // small caps glyph is scaled down: advance 0.5 * 0.75
    expect(l.carets[1][0]).toBeCloseTo(0.375, 5);
    // glyph a + glyph b + underline bar
    expect(l.splines.length).toBe(3);
    const italic = l.splines[1].bezier_points;
    // slanted: the top-left corner sits right of the bottom-left one
    expect(italic[3].co[0]).toBeGreaterThan(italic[0].co[0]);
  });
});

describe('text box overflow', () => {
  const body = 'aa bb cc dd ee ff';
  const boxes = [{ x: 0, y: 0, width: 2.6, height: 1.3 }];
  it('truncates lines past the last box', () => {
    const full = layoutTextWith(text(body, { text_boxes: boxes }), mono);
    const cut = layoutTextWith(text(body, { text_boxes: boxes, overflow: 'TRUNCATE' }), mono);
    expect(full.lines.length).toBe(3);
    expect(cut.lines.length).toBe(1);
    expect(cut.splines.length).toBeLessThan(full.splines.length);
  });
  it('scales the text down to fit', () => {
    const l = layoutTextWith(text(body, { text_boxes: boxes, overflow: 'SCALE' }), mono);
    expect(l.size).toBeLessThan(1);
    expect((l.lines.length) * l.lineHeight).toBeLessThanOrEqual(1.3 + 1e-6);
  });
});

describe('text editing kernels', () => {
  it('keeps formats in sync with the body', () => {
    const cu = text('Hello');
    T.setStyle(cu, 0, 2, 'use_bold', true);
    T.replaceRange(cu, 1, 3, 'EYY', { use_italic: true });
    expect(cu.body).toBe('HEYYlo');
    expect(T.formats(cu).map((x) => (x.use_bold ? 'b' : x.use_italic ? 'i' : '-')).join('')).toBe('biii--');
  });

  it('moves by words and finds words', () => {
    const s = 'one two, three';
    expect(T.nextWord(s, 0)).toBe(3);
    expect(T.nextWord(s, 3)).toBe(7);
    expect(T.prevWord(s, 14)).toBe(9);
    expect(T.wordAt(s, 5)).toEqual([4, 7]);
    expect(T.wordAt(s, 7)).toEqual([4, 7]);
  });

  it('case, accents and unicode', () => {
    const cu = text('straße');
    T.setCase(cu, 0, 6, 'UPPER');
    expect(cu.body).toBe('STRASSE');
    expect(T.formats(cu).length).toBe(7);
    expect(T.accentCombine('e', "'")).toBe('é');
    expect(T.accentCombine('x', '~')).toBe(null);
    expect(T.unicodeChar('U+00E9')).toBe('é');
    expect(T.unicodeChar('1F600')).toBe('😀');
    expect(T.unicodeChar('zz')).toBe(null);
  });

  it('text boxes', () => {
    const cu = text('x');
    T.addTextBox(cu);
    expect(cu.text_boxes!.length).toBe(2);
    expect(T.removeTextBox(cu, 0)).toBe(true);
    expect(T.removeTextBox(cu, 0)).toBe(false);
  });
});
