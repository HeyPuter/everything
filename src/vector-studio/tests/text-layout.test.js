import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { createText } from '../src/model/nodes.js';
import { layoutText, registerMeasureFont, caretPosition, hitTestText, selectionPolygons, glyphPlacements, measure, lineIndexOf } from '../src/model/text-layout.js';

const fontPath = (f) => resolve(process.cwd(), 'node_modules/@fontsource/inter/files', f);
let inter;

beforeAll(() => {
  const buf = readFileSync(fontPath('inter-latin-400-normal.woff'));
  inter = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  registerMeasureFont('Inter', 400, 'normal', inter);
});

const text = (t, extra = {}) => createText(t, 10, 50, extra);

describe('point type', () => {
  it('measures with the registered font', () => {
    const w = measure('Hello', { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 100 });
    const glyphs = [...'Hello'].map((c) => inter.charToGlyph(c));
    let ot = 0;
    glyphs.forEach((g, i) => {
      ot += g.advanceWidth;
      if (i) ot += inter.getKerningValue(glyphs[i - 1], g);
    });
    ot = (ot * 100) / inter.unitsPerEm;
    expect(Math.abs(w - ot)).toBeLessThan(0.5);
  });

  it('puts the first baseline at y and stacks paragraphs by leading', () => {
    const lay = layoutText(text('One\nTwo\nThree'));
    expect(lay.lines).toHaveLength(3);
    expect(lay.lines[0].y).toBe(50);
    expect(lay.lines[1].y).toBeCloseTo(50 + 12 * 1.2);
    expect(lay.lines[2].start).toBe(8);
    expect(lay.lines[0].x).toBe(10);
  });

  it('aligns around the anchor', () => {
    const c = layoutText(text('Hello', { para: { align: 'center' } }));
    expect(c.lines[0].x + c.lines[0].width / 2).toBeCloseTo(10);
    const r = layoutText(text('Hello', { para: { align: 'right' } }));
    expect(r.lines[0].x + r.lines[0].width).toBeCloseTo(10);
  });

  it('applies tracking and horizontal scale', () => {
    const base = layoutText(text('AAAA')).lines[0].width;
    const tracked = layoutText(text('AAAA', { char: { ...text('').char, tracking: 100 } })).lines[0].width;
    expect(tracked - base).toBeCloseTo(4 * 1.2, 3);
    const scaled = layoutText(text('AAAA', { char: { ...text('').char, horizontalScale: 50 } })).lines[0].width;
    expect(scaled).toBeCloseTo(base / 2, 3);
  });

  it('uses the largest size in a line for auto leading', () => {
    const n = text('ab\ncd', { runs: [{ len: 1, fontSize: 40 }] });
    const lay = layoutText(n);
    expect(lay.lines[0].lead).toBeCloseTo(48);
    expect(lay.lines[1].y - lay.lines[0].y).toBeCloseTo(12 * 1.2);
  });
});

describe('area type', () => {
  const area = (t, w, h, extra = {}) => createText(t, 0, 0, { kind: 'area', width: w, height: h, ...extra });

  it('wraps words inside the width', () => {
    const lay = layoutText(area('the quick brown fox jumps over the lazy dog', 60, 200));
    expect(lay.lines.length).toBeGreaterThan(2);
    for (const l of lay.lines) expect(l.width).toBeLessThanOrEqual(60 + 1e-6);
    // Lines cover the text without gaps.
    for (let i = 1; i < lay.lines.length; i++) expect(lay.lines[i].start).toBe(lay.lines[i - 1].end);
    expect(lay.lines[lay.lines.length - 1].end).toBe(43);
  });

  it('breaks long words by character', () => {
    const lay = layoutText(area('abcdefghijklmnopqrstuvwxyz', 30, 400));
    expect(lay.lines.length).toBeGreaterThan(3);
    for (const l of lay.lines) expect(l.width).toBeLessThanOrEqual(30 + 1e-6);
  });

  it('flags overflow when text does not fit', () => {
    const lay = layoutText(area('one two three four five six seven eight nine ten', 40, 30));
    expect(lay.overflow).toBe(true);
    expect(lay.visibleEnd).toBeLessThan(48);
    const ok = layoutText(area('one', 100, 100));
    expect(ok.overflow).toBe(false);
  });

  it('justifies all but the last line', () => {
    const n = area('aaa bbb ccc ddd eee fff ggg hhh iii', 70, 400, { para: { align: 'justify' } });
    const lay = layoutText(n);
    const [first] = lay.lines;
    const last = lay.lines[lay.lines.length - 1];
    expect(first.xs[first.contentEnd - first.start]).toBeCloseTo(70, 3);
    expect(last.xs[last.contentEnd - last.start]).toBeLessThan(70);
  });

  it('flows into columns', () => {
    const n = area('one two three four five six seven eight nine ten eleven twelve', 200, 30, { areaOptions: { columns: 2, columnGutter: 20 } });
    const lay = layoutText(n);
    const xs = new Set(lay.lines.map((l) => Math.round(l.x)));
    expect(xs.has(0)).toBe(true);
    expect(xs.has(110)).toBe(true);
  });

  it('wraps inside a shape by scanline intervals', () => {
    // A triangle pointing up: lines get wider toward the bottom.
    const tri = [
      { x: 100, y: 0, ix: 100, iy: 0, ox: 100, oy: 0 },
      { x: 200, y: 200, ix: 200, iy: 200, ox: 200, oy: 200 },
      { x: 0, y: 200, ix: 0, iy: 200, ox: 0, oy: 200 },
    ];
    const n = area('word '.repeat(80), 200, 200, { areaPath: tri });
    const lay = layoutText(n);
    expect(lay.lines.length).toBeGreaterThan(4);
    const a = lay.lines[1];
    const b = lay.lines[lay.lines.length - 1];
    expect(b.width).toBeGreaterThan(a.width);
    for (const l of lay.lines) {
      // Every line stays inside the triangle at its baseline.
      const half = (l.y / 200) * 100;
      expect(l.x).toBeGreaterThanOrEqual(100 - half - 1);
      expect(l.x + l.width).toBeLessThanOrEqual(100 + half + 1);
    }
  });
});

describe('caret mapping', () => {
  it('round-trips caret positions and hit tests', () => {
    const n = createText('Hello world\nSecond line', 0, 20, { kind: 'area', width: 300, height: 200 });
    const lay = layoutText(n);
    for (const i of [0, 3, 11, 12, 17, 23]) {
      const c = caretPosition(lay, i);
      expect(hitTestText(lay, c.x + 0.01, c.y - 2)).toBe(i);
    }
    expect(caretPosition(lay, 12).line).toBe(1);
    expect(lineIndexOf(lay, 11)).toBe(0);
  });

  it('gives the end of a soft-wrapped line to the next line start', () => {
    const n = createText('aaa bbb ccc', 0, 0, { kind: 'area', width: 40, height: 200 });
    const lay = layoutText(n);
    const second = lay.lines[1];
    expect(caretPosition(lay, second.start).line).toBe(1);
  });

  it('builds selection rectangles per line', () => {
    const lay = layoutText(createText('one\ntwo', 0, 20));
    const polys = selectionPolygons(lay, 1, 6);
    expect(polys).toHaveLength(2);
    expect(polys[0][0].x).toBeCloseTo(lay.lines[0].xs[1]);
  });
});

describe('vertical and path type', () => {
  it('stacks vertical characters downward and columns leftward', () => {
    const n = createText('ab\ncd', 100, 0, { vertical: true });
    const lay = layoutText(n);
    const g = glyphPlacements(lay);
    expect(g).toHaveLength(4);
    expect(g[1].m[5]).toBeGreaterThan(g[0].m[5]);
    expect(g[2].m[4]).toBeLessThan(g[0].m[4]);
  });

  it('places glyphs along a path with rotation', () => {
    const anchors = [
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 0, y: 300, ix: 0, iy: 300, ox: 0, oy: 300 },
    ];
    const n = createText('abc', 0, 0, { kind: 'path', pathAnchors: anchors, pathClosed: false });
    const lay = layoutText(n);
    const g = glyphPlacements(lay);
    expect(g).toHaveLength(3);
    // A downward path rotates glyphs 90 degrees: x axis points down.
    expect(g[0].m[0]).toBeCloseTo(0);
    expect(g[0].m[1]).toBeCloseTo(1);
    expect(g[1].m[5]).toBeGreaterThan(g[0].m[5]);
    expect(lay.overflow).toBe(false);
    const short = createText('a long text that cannot fit', 0, 0, { kind: 'path', pathAnchors: [anchors[0], { ...anchors[1], y: 20, iy: 20, oy: 20 }] });
    expect(layoutText(short).overflow).toBe(true);
  });

  it('draws an emoji or a letter with its marks as one glyph on a path and in vertical type', () => {
    const anchors = [
      { x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
      { x: 600, y: 0, ix: 600, iy: 0, ox: 600, oy: 0 },
    ];
    const text = 'a\u{1F600}b cafe\u0301';
    for (const extra of [{ kind: 'path', pathAnchors: anchors, pathClosed: false }, { kind: 'area', vertical: true, width: 40, height: 600 }]) {
      const lay = layoutText(createText(text, 0, 0, extra));
      const strs = glyphPlacements(lay).map((g) => g.ch);
      expect(strs).toEqual(['a', '\u{1F600}', 'b', 'c', 'a', 'f', 'e\u0301']);
      // The second code unit of each cluster takes no room.
      expect(lay.chars.adv[2]).toBe(0);
      expect(lay.chars.adv[9]).toBe(0);
    }
  });
});
