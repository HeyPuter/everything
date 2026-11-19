import { describe, expect, it } from 'vitest';
import { layoutText, type Measure } from '../src/imaging/text/layout';
import {
  defaultCharStyle,
  fromPlainText,
  plainText,
  type TextFit,
  type TextLayerData,
} from '../src/imaging/text/model';
import { autoLines, releaseFit, resolveFit, scaleTextContent } from '../src/imaging/text/fit';
import { scaleTextData, validateTextData } from '../src/model/text-layer';

// Monospace stand-in: every character is half an em wide; ascent 0.8 em, descent 0.2 em.
const sizeOf = (font: string) => Number(/([\d.]+)px/.exec(font)![1]);
const mono: Measure = (text, font) => {
  const s = sizeOf(font);
  return { width: [...text].length * s * 0.5, ascent: s * 0.8, descent: s * 0.2 };
};
const style = { ...defaultCharStyle(), size: 20 }; // 20 px at 72 ppi: 10 px per character
const opts = { measure: mono };

function fitted(text: string, fit: Partial<TextFit>, origin = { x: 0, y: 0 }): TextLayerData {
  return {
    content: fromPlainText(text, style),
    mode: 'point',
    origin,
    orientation: 'horizontal',
    antiAlias: 'smooth',
    fit: { shape: 'block', width: 200, height: 100, bend: 50, gap: 0, autoLines: false, ...fit },
  };
}
const inkTop = (lay: ReturnType<typeof layoutText>, i: number) =>
  lay.lines[i].y -
  0.7 *
    Math.max(
      ...lay.runs
        .filter((r) => r.start >= lay.lines[i].start && r.end <= lay.lines[i].end)
        .map((r) => r.sizePx),
    );

describe('dynamic block text', () => {
  it('scales each line to the box width and centers a short stack', () => {
    const d = fitted('AB\nABCD', { width: 200, height: 400 });
    const lay = layoutText(d, opts);
    expect(lay.lines.map((l) => Math.round(l.width))).toEqual([200, 200]);
    expect(lay.fitBox).toEqual({ x: 0, y: 0, width: 200, height: 400 });
    // Line 1: 20 px natural width -> scale 10 (200 px type); line 2: scale 5.
    const top = inkTop(lay, 0);
    const bottom = lay.lines[1].y; // no descenders
    expect(bottom - top).toBeCloseTo(0.7 * 200 + 0.7 * 100, 5);
    // Centered vertically in the box.
    expect(top).toBeCloseTo((400 - (bottom - top)) / 2, 5);
  });

  it('shrinks a stack taller than the box and keeps it aligned', () => {
    const d = fitted('AB\nABCD', { width: 200, height: 105 });
    const lay = layoutText(d, opts);
    const top = inkTop(lay, 0),
      bottom = lay.lines[1].y;
    expect(bottom - top).toBeCloseTo(105, 5);
    expect(top).toBeCloseTo(0, 5);
    // 210 px of stack in 105 px: half the width, at the left edge.
    expect(lay.lines[0].width).toBeCloseTo(100, 5);
    expect(lay.lines[0].x).toBeCloseTo(0, 5);
    // Centered paragraphs center the narrower block in the box.
    const c = fitted('AB\nABCD', { width: 200, height: 105 });
    c.content.paragraphs.forEach((p) => (p.style.align = 'center'));
    expect(layoutText(c, opts).lines[0].x).toBeCloseTo(50, 5);
  });

  it('refits when the text changes or the box is resized', () => {
    const a = layoutText(fitted('HELLO', { width: 300, height: 300 }), opts);
    const b = layoutText(fitted('HELLO THERE', { width: 300, height: 300 }), opts);
    expect(a.lines[0].width).toBeCloseTo(300, 5);
    expect(b.lines[0].width).toBeCloseTo(300, 5);
    expect(b.runs[0].sizePx).toBeLessThan(a.runs[0].sizePx);
    const wide = layoutText(fitted('HELLO', { width: 600, height: 600 }), opts);
    expect(wide.runs[0].sizePx).toBeCloseTo(a.runs[0].sizePx * 2, 5);
  });

  it('breaks lines automatically to fill the box, preserving text indices', () => {
    const d = fitted('THE BIG SUMMER SALE', { width: 200, height: 200, autoLines: true });
    const content = autoLines(d, d.fit!, opts, layoutText);
    expect(plainText(content).length).toBe(plainText(d.content).length);
    expect(content.paragraphs.length).toBeGreaterThan(1);
    // A flat, wide box keeps one line.
    const flat = fitted('THE BIG SUMMER SALE', { width: 1000, height: 60, autoLines: true });
    expect(autoLines(flat, flat.fit!, opts, layoutText).paragraphs.length).toBe(1);
    // The layout uses the broken lines; carets still address the original text.
    const lay = layoutText(d, opts);
    expect(lay.length).toBe(19);
    expect(lay.lines.length).toBe(content.paragraphs.length);
    // Taller boxes ask for more lines.
    const tall = fitted('THE BIG SUMMER SALE', { width: 200, height: 2000, autoLines: true });
    expect(autoLines(tall, tall.fit!, opts, layoutText).paragraphs.length).toBeGreaterThanOrEqual(
      content.paragraphs.length,
    );
  });

  it('never joins paragraphs the user typed', () => {
    const d = fitted('ONE\nTWO THREE FOUR', { width: 1000, height: 50, autoLines: true });
    expect(autoLines(d, d.fit!, opts, layoutText).paragraphs.length).toBeGreaterThanOrEqual(2);
  });

  it('with automatic height follows its lines from the first baseline', () => {
    const d = fitted('AB\nABCD', { width: 200, height: undefined }, { x: 10, y: 300 });
    const lay = layoutText(d, opts);
    expect(lay.lines[0].y).toBe(300);
    expect(lay.fitBox!.x).toBe(10);
    expect(lay.fitBox!.y).toBeCloseTo(300 - 0.7 * 200, 5);
    expect(lay.fitBox!.height).toBeCloseTo(0.7 * 200 + 0.7 * 100, 5);
  });

  it('releases to point text that looks the same', () => {
    const d = fitted('AB\nABCD', { width: 200, height: 400 });
    const before = layoutText(d, opts);
    const released = releaseFit(d, opts, layoutText);
    expect(released.fit).toBeUndefined();
    expect(released.block).toBeUndefined();
    validateTextData(released);
    const after = layoutText(released, opts);
    expect(after.lines.map((l) => Math.round(l.y * 1000) / 1000)).toEqual(
      before.lines.map((l) => Math.round(l.y * 1000) / 1000),
    );
    expect(after.lines.map((l) => Math.round(l.width))).toEqual([200, 200]);
    expect(after.lines.map((l) => Math.round(l.x * 1000) / 1000)).toEqual(
      before.lines.map((l) => Math.round(l.x * 1000) / 1000),
    );
    expect(plainText(released.content)).toBe('AB\nABCD');
  });
});

describe('dynamic text on curves', () => {
  for (const shape of ['arch', 'bow', 'wave', 'circle'] as const)
    it(`${shape}: fills the curve and fits the box`, () => {
      const d = fitted('ROUND AND ROUND', { shape, width: 400, height: 300, bend: 40 });
      const lay = layoutText(d, opts);
      expect(lay.path).toBeDefined();
      expect(lay.overflow).toBe(false);
      // Every glyph is placed, inside the box (with a little slack for glyph boxes).
      expect(lay.runs.length).toBe('ROUNDANDROUND'.length);
      const b = lay.bounds;
      expect(b.x).toBeGreaterThan(-2);
      expect(b.y).toBeGreaterThan(-2);
      expect(b.x + b.width).toBeLessThan(402);
      expect(b.y + b.height).toBeLessThan(302);
      // It touches the box on at least one axis.
      expect(Math.max(b.width / 400, b.height / 300)).toBeGreaterThan(0.85);
      // The text runs (nearly) the length of the curve.
      const { a, span } = lay.path!;
      const g = lay.path!.geometry;
      expect(a).toBe(0);
      expect(span).toBeCloseTo(g.length, 3);
    });

  it('shrinks the type when the text grows and grows with the box', () => {
    const size = (text: string, w: number, h: number) =>
      layoutText(fitted(text, { shape: 'arch', width: w, height: h }), opts).runs[0].sizePx;
    expect(size('ARCHED WORDS HERE', 400, 300)).toBeLessThan(size('ARCHED', 400, 300));
    expect(size('ARCHED', 800, 600)).toBeCloseTo(size('ARCHED', 400, 300) * 2, 1);
  });

  it('releases to arc text that can still be reshaped', () => {
    const d = fitted('CURVED', { shape: 'arch', width: 300, height: 200 });
    const r = releaseFit(d, opts, layoutText);
    expect(r.fit).toBeUndefined();
    expect(r.path?.arc?.preset).toBe('arch');
    validateTextData(r);
    const a = layoutText(d, opts),
      b = layoutText(r, opts);
    expect(b.runs.map((x) => [Math.round(x.x * 100), Math.round(x.y * 100)])).toEqual(
      a.runs.map((x) => [Math.round(x.x * 100), Math.round(x.y * 100)]),
    );
  });
});

describe('fit data', () => {
  it('validates and scales with the layer', () => {
    const d = fitted('X', { shape: 'arch', width: 120, height: 80, gap: 4 }, { x: 10, y: 20 });
    validateTextData(d);
    const s = scaleTextData(d, 2, 0, 0);
    expect(s.fit).toMatchObject({ width: 240, height: 160, gap: 8 });
    expect(s.origin).toEqual({ x: 20, y: 40 });
    expect(() => validateTextData({ ...d, fit: { ...d.fit!, shape: 'spiral' } })).toThrow();
    expect(() => validateTextData({ ...d, fit: { ...d.fit!, height: undefined } })).toThrow();
    expect(() => validateTextData({ ...d, orientation: 'vertical' })).toThrow();
  });

  it('scales content sizes in points', () => {
    const c = scaleTextContent(
      fromPlainText('a', { ...style, leading: 30, baselineShift: 2 }),
      1.5,
    );
    expect(c.paragraphs[0].runs[0].style).toMatchObject({
      size: 30,
      leading: 45,
      baselineShift: 3,
    });
  });

  it('resolves to ordinary text data', () => {
    const r = resolveFit(
      fitted('AB', { shape: 'circle', width: 200, height: 200 }),
      opts,
      layoutText,
    );
    expect(r.data.fit).toBeUndefined();
    expect(r.data.path?.closed).toBe(true);
  });
});
