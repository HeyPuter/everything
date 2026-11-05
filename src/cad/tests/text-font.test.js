import { describe, expect, it } from 'vitest';
import {
  ADVANCES,
  COORDS,
  DESCENDER,
  FALLBACK_GLYPH,
  GLYPH_BOUNDS,
  GLYPH_COUNT,
  GLYPH_STROKES,
  MONO_ADVANCE,
  MONO_SCALE,
  MONO_SHIFT,
  SPACE_GLYPH,
  STROKE_STARTS,
  glyphAdvance,
  glyphIndex,
  glyphStrokes,
  hasGlyph,
} from '../src/core/text/font.js';

const ASCII = [];
for (let c = 32; c <= 126; c++) ASCII.push(c);

describe('font coverage', () => {
  it('has a glyph for every printable ASCII character', () => {
    for (const c of ASCII) expect(hasGlyph(c), String.fromCharCode(c)).toBe(true);
  });

  it('has the drafting symbols', () => {
    expect(hasGlyph(0x00b0)).toBe(true);
    expect(hasGlyph(0x00b1)).toBe(true);
    expect(hasGlyph(0x2300)).toBe(true);
  });

  it('draws accented Latin letters and common symbols', () => {
    const text = 'ÀÉÎÕÜÅÇØßÆŒàéîõüåçøæœĄČĐĘĞŁŃŐŘŚŞŠŢŰŽąčđęğłńőřśşšţűžȘșȚț';
    const symbols = 'µΩΔΣπ€£¥¢©®™«»·¹÷¡¿–—…•‘’“”−';
    for (const ch of text + symbols) expect(hasGlyph(ch.codePointAt(0)), ch).toBe(true);
    const top = (ch) =>
      Math.max(...glyphStrokes(ch.codePointAt(0)).flatMap((st) => [...st].filter((_, i) => i & 1)));
    // Marks sit clear above the letter, and i loses its dot under one.
    expect(top('é')).toBeGreaterThan(top('e') + 0.05);
    expect(top('É')).toBeGreaterThan(1.05);
    expect(top('É')).toBeLessThan(1.3);
    expect(glyphStrokes(0xed).length).toBe(2);
    // Typographic quotes and dashes reuse the ASCII glyphs.
    expect(glyphIndex(0x2019)).toBe(glyphIndex(39));
    expect(glyphIndex(0x201c)).toBe(glyphIndex(34));
    expect(glyphIndex(0x2212)).toBe(glyphIndex(45));
  });

  it('falls back to the box for unknown characters', () => {
    expect(glyphIndex(0x4e2d)).toBe(FALLBACK_GLYPH);
    expect(glyphIndex(127)).toBe(FALLBACK_GLYPH);
    expect(glyphStrokes(0x4e2d).length).toBe(1);
  });

  it('maps control characters to the space', () => {
    expect(glyphIndex(9)).toBe(SPACE_GLYPH);
    expect(glyphIndex(10)).toBe(SPACE_GLYPH);
  });

  it('gives distinct glyphs to distinct characters', () => {
    const seen = new Set(ASCII.map(glyphIndex));
    expect(seen.size).toBe(ASCII.length);
  });
});

describe('font data', () => {
  it('packs into typed arrays', () => {
    expect(COORDS).toBeInstanceOf(Float32Array);
    expect(ADVANCES).toBeInstanceOf(Float32Array);
    expect(GLYPH_STROKES).toBeInstanceOf(Uint32Array);
    expect(STROKE_STARTS).toBeInstanceOf(Uint32Array);
    expect(GLYPH_STROKES[GLYPH_COUNT]).toBe(STROKE_STARTS.length - 1);
    expect(STROKE_STARTS[STROKE_STARTS.length - 1]).toBe(COORDS.length);
  });

  it('has positive advances and finite coordinates', () => {
    for (let g = 0; g < GLYPH_COUNT; g++) expect(ADVANCES[g]).toBeGreaterThan(0);
    for (const v of COORDS) expect(Number.isFinite(v)).toBe(true);
  });

  it('keeps strokes within the em box and near the advance', () => {
    for (const c of [...ASCII, 0xb0, 0xb1, 0x2300]) {
      const g = glyphIndex(c);
      const [x0, y0, x1, y1] = GLYPH_BOUNDS.subarray(g * 4, g * 4 + 4);
      const ch = String.fromCharCode(c);
      expect(y0, ch).toBeGreaterThanOrEqual(DESCENDER - 1e-4);
      expect(y1, ch).toBeLessThanOrEqual(1 + 1e-4);
      expect(x0, ch).toBeGreaterThanOrEqual(-0.1);
      expect(x1, ch).toBeLessThanOrEqual(ADVANCES[g] + 0.05);
    }
  });

  it('draws ink for every non-space character with polylines of 2+ points', () => {
    for (const c of ASCII) {
      const strokes = glyphStrokes(c);
      if (c === 32) {
        expect(strokes.length).toBe(0);
        continue;
      }
      expect(strokes.length, String.fromCharCode(c)).toBeGreaterThan(0);
      for (const s of strokes) expect(s.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('uses the expected vertical metrics', () => {
    const top = (ch) => GLYPH_BOUNDS[glyphIndex(ch.codePointAt(0)) * 4 + 3];
    const bottom = (ch) => GLYPH_BOUNDS[glyphIndex(ch.codePointAt(0)) * 4 + 1];
    expect(top('H')).toBeCloseTo(1, 4);
    expect(bottom('H')).toBeCloseTo(0, 4);
    expect(top('x')).toBeCloseTo(0.7, 4);
    expect(bottom('p')).toBeCloseTo(-0.3, 4);
    expect(top('O')).toBeCloseTo(1, 4);
  });

  it('builds curves from many points', () => {
    const o = glyphStrokes(79);
    expect(o.length).toBe(1);
    expect(o[0].length / 2).toBeGreaterThanOrEqual(32);
    // Closed loop: last point repeats the first.
    expect(o[0][0]).toBeCloseTo(o[0][o[0].length - 2], 5);
    expect(o[0][1]).toBeCloseTo(o[0][o[0].length - 1], 5);
  });

  it('has tabular digits', () => {
    const a = ADVANCES[glyphIndex(48)];
    for (let c = 49; c <= 57; c++) expect(ADVANCES[glyphIndex(c)]).toBe(a);
  });

  it('fits every glyph into the mono cell', () => {
    expect(glyphAdvance(glyphIndex(87), 'mono')).toBe(MONO_ADVANCE);
    expect(glyphAdvance(glyphIndex(105), 'mono')).toBe(MONO_ADVANCE);
    for (let g = 0; g < GLYPH_COUNT; g++) {
      const x0 = GLYPH_BOUNDS[g * 4] * MONO_SCALE[g] + MONO_SHIFT[g];
      const x1 = GLYPH_BOUNDS[g * 4 + 2] * MONO_SCALE[g] + MONO_SHIFT[g];
      expect(x0).toBeGreaterThanOrEqual(-0.05);
      expect(x1).toBeLessThanOrEqual(MONO_ADVANCE + 0.05);
    }
  });
});
