import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFont, type GlyphPoint, type SfntFont } from '../src/imaging/text/sfnt';
import { rasterizePolygon } from '../src/imaging/segment/mask-ops';
import {
  analyzeText,
  binarize,
  estimateSkew,
  grayscale,
  rankFonts,
  rerank,
  rotateGray,
  segmentLine,
  splitLines,
  variantsOf,
  type FontCandidate,
} from '../src/imaging/text/match-font';
import { aiCodec, matchFontWithAI } from '../src/imaging/ai/puter-ai';
import type { Mask8, RGBA8 } from '../src/imaging/types';

// A small font-file rasterizer stands in for canvas text: glyph outlines from
// the bundled WOFF files, laid out by advance width and filled.
const files: Record<string, string> = {
  Inter: 'public/fonts/inter/Inter-Variable.woff',
  'Inter|italic': 'public/fonts/inter/Inter-Italic-Variable.woff',
  'Crimson Pro': 'public/fonts/crimson-pro/CrimsonPro-Variable.woff',
  'Bebas Neue': 'public/fonts/bebas-neue/BebasNeue-Regular.woff',
  Caveat: 'public/fonts/caveat/Caveat-Variable.woff',
  'JetBrains Mono': 'public/fonts/jetbrains-mono/JetBrainsMono-Variable.woff',
};
const fonts = new Map<string, SfntFont>();
function font(family: string, italic: boolean) {
  const key = italic && files[`${family}|italic`] ? `${family}|italic` : family;
  let f = fonts.get(key);
  if (!f) fonts.set(key, (f = parseFont(readFileSync(files[key]))));
  return f;
}
function contourPoints(pts: GlyphPoint[], map: (x: number, y: number) => [number, number]): [number, number][] {
  const n = pts.length;
  if (!n) return [];
  // Start at an on-curve point (or the midpoint of two off-curve points).
  let start = pts.findIndex((p) => p.on);
  const seq = start < 0 ? [{ x: (pts[0].x + pts[1 % n].x) / 2, y: (pts[0].y + pts[1 % n].y) / 2, on: true }, ...pts.slice(1), pts[0]] : [...pts.slice(start), ...pts.slice(0, start)];
  start = 0;
  const out: [number, number][] = [map(seq[0].x, seq[0].y)];
  let prev = seq[0];
  for (let i = 1; i <= seq.length; i++) {
    const p = seq[i % seq.length];
    if (p.on) {
      out.push(map(p.x, p.y));
      prev = p;
      continue;
    }
    const nx = seq[(i + 1) % seq.length];
    const end = nx.on ? nx : { x: (p.x + nx.x) / 2, y: (p.y + nx.y) / 2, on: true };
    for (let k = 1; k <= 6; k++) {
      const t = k / 6, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
      out.push(map(a * prev.x + b * p.x + c * end.x, a * prev.y + b * p.y + c * end.y));
    }
    prev = end;
    if (nx.on) i++;
  }
  return out;
}
const render = (text: string, f: FontCandidate, px: number): RGBA8 => {
  const sf = font(f.family, f.italic);
  const coords = sf.normalize({ wght: f.weight });
  const s = px / sf.unitsPerEm, lineH = Math.ceil(px * 1.4);
  const lines = text.split('\n');
  const widths = lines.map((l) => [...l].reduce((w, ch) => w + sf.advance(sf.glyphIndex(ch.codePointAt(0)!), coords) * s, 0));
  const W = Math.ceil(Math.max(...widths) + px), H = lineH * lines.length + px;
  const contours: [number, number][][] = [];
  lines.forEach((line, li) => {
    let x = px / 2;
    const base = px / 2 + li * lineH + px;
    for (const ch of line) {
      const g = sf.glyphIndex(ch.codePointAt(0)!), o = sf.glyph(g, coords);
      for (const c of o.contours) contours.push(contourPoints(c, (gx, gy) => [x + gx * s, base - gy * s]));
      x += sf.advance(g, coords) * s;
    }
  });
  const m = rasterizePolygon(contours, W, H, true);
  return toRGBA(m, true);
};
// Coverage to dark-on-white (or white-on-dark) RGBA.
function toRGBA(m: Mask8, dark: boolean): RGBA8 {
  const data = new Uint8ClampedArray(m.width * m.height * 4);
  for (let i = 0; i < m.data.length; i++) {
    const v = dark ? 255 - m.data[i] : m.data[i];
    data.set([v, v, v, 255], i * 4);
  }
  return { width: m.width, height: m.height, data };
}
const asRGBA = (g: Mask8) => {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) data.set([g.data[i], g.data[i], g.data[i], 255], i * 4);
  return { width: g.width, height: g.height, data };
};

describe('Match Font image analysis', () => {
  it('detects dark text on light and light text on dark', () => {
    const img = render('Hello', { family: 'Inter', weight: 400, italic: false }, 48);
    const dark = binarize(grayscale(img));
    expect(dark.polarity).toBe('dark');
    const inverted: RGBA8 = { ...img, data: img.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)) as Uint8ClampedArray };
    const light = binarize(grayscale(inverted));
    expect(light.polarity).toBe('light');
    // The same pixels are ink either way.
    const count = (m: Mask8) => m.data.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(Math.abs(count(dark.ink) - count(light.ink))).toBeLessThan(count(dark.ink) * 0.05);
  });

  it('estimates and removes skew', () => {
    const img = render('Skewed text line', { family: 'Crimson Pro', weight: 400, italic: false }, 40);
    for (const deg of [-8, 5, 12]) {
      const rotated = rotateGray(grayscale(img), (deg * Math.PI) / 180);
      const skew = (estimateSkew(binarize(rotated).ink) * 180) / Math.PI;
      expect(Math.abs(skew - deg)).toBeLessThan(0.8);
      const sample = analyzeText(asRGBA(rotated))!;
      expect(Math.abs((sample.skew * 180) / Math.PI - deg)).toBeLessThan(0.8);
      expect(sample.lines).toBe(1);
    }
  });

  it('segments lines and glyphs, keeping dots with their letters', () => {
    const img = render('ijk lmn\nABC', { family: 'Inter', weight: 400, italic: false }, 48);
    const ink = binarize(grayscale(img)).ink;
    const lines = splitLines(ink);
    expect(lines.length).toBe(2);
    expect(segmentLine(ink, ...lines[0]).length).toBe(6);
    expect(segmentLine(ink, ...lines[1]).length).toBe(3);
  });

  it('measures heavier strokes for bold and a slant for italic', () => {
    const regular = analyzeText(render('Handgloves', { family: 'Inter', weight: 400, italic: false }, 64))!;
    const bold = analyzeText(render('Handgloves', { family: 'Inter', weight: 800, italic: false }, 64))!;
    const italic = analyzeText(render('Handgloves', { family: 'Inter', weight: 400, italic: true }, 64))!;
    expect(bold.stroke).toBeGreaterThan(regular.stroke * 1.4);
    expect(Math.abs(italic.slant)).toBeGreaterThan(Math.abs(regular.slant) + 0.1);
  });
});

describe('Match Font ranking', () => {
  const families: FontCandidate[] = ['Inter', 'Crimson Pro', 'Bebas Neue', 'Caveat', 'JetBrains Mono'].map((family) => ({ family, weight: 400, italic: false }));
  for (const truth of families)
    it(`ranks ${truth.family} first for text set in it`, async () => {
      // The sample is rendered at another size and slightly rotated, like a photo of a sign.
      const sample = analyzeText(asRGBA(rotateGray(grayscale(render('Quick Brown Fox', truth, 44)), 0.05)))!;
      const typed = await rankFonts(sample, families, render, { text: 'Quick Brown Fox' });
      expect(typed[0].family).toBe(truth.family);
      const untyped = await rankFonts(sample, families, render);
      expect(untyped[0].family).toBe(truth.family);
      expect(typed[0].similarity).toBeGreaterThan(typed[typed.length - 1].similarity);
    });

  it('tells weights and italics apart within a family', async () => {
    const truth = { family: 'Inter', weight: 700, italic: true };
    const sample = analyzeText(render('Matching Weights', truth, 50))!;
    const ranked = await rankFonts(sample, variantsOf('Inter', [100, 200, 300, 400, 500, 600, 700, 800, 900], true), render, { text: 'Matching Weights' });
    expect(ranked[0]).toMatchObject({ family: 'Inter', italic: true });
    expect(Math.abs(ranked[0].weight - 700)).toBeLessThanOrEqual(200);
  });

  it('lists variants by the weights a family offers', () => {
    expect(variantsOf('Bebas Neue', [400], false)).toEqual([{ family: 'Bebas Neue', weight: 400, italic: false }]);
    expect(variantsOf('Caveat', [400, 500, 600, 700], false).map((v) => v.weight)).toEqual([400, 500, 700]);
    expect(variantsOf('X', [400, 700], true)).toHaveLength(4);
  });

  it('moves families an outside opinion prefers to the top', () => {
    const m = (family: string, distance: number) => ({ family, weight: 400, italic: false, distance, similarity: 0 });
    const ranked = rerank([m('A', 1), m('B', 2), m('C', 3), m('B', 4)], ['c', 'B']);
    expect(ranked.map((x) => x.family)).toEqual(['C', 'B', 'B', 'A']);
  });
});

describe('Ask AI for a font match', () => {
  const g = globalThis as unknown as { puter?: unknown };
  const codec = { ...aiCodec };
  afterEach(() => {
    delete g.puter;
    Object.assign(aiCodec, codec);
  });
  it('sends the crop with the candidate names and reads back an order', async () => {
    aiCodec.toDataUri = async () => 'data:image/png;base64,iVBORw0KGgo=';
    const chat = vi.fn(async () => ({ message: { content: 'Crimson Pro\n2. inter\nSomething Else' } }));
    g.puter = { ai: { txt2img: vi.fn(), chat } };
    const img = render('Ab', { family: 'Crimson Pro', weight: 400, italic: false }, 30);
    const order = await matchFontWithAI(img, ['Inter', 'Crimson Pro', 'Caveat']);
    expect(order).toEqual(['Crimson Pro', 'Inter']);
    expect(chat).toHaveBeenCalledTimes(1);
    const [prompt, media] = chat.mock.calls[0] as unknown as [string, unknown];
    expect(prompt).toContain('Inter');
    expect(prompt).toContain('Caveat');
    expect(media).toBeInstanceOf(File);
  });
  it('fails clearly without Puter', async () => {
    await expect(matchFontWithAI(render('A', { family: 'Inter', weight: 400, italic: false }, 20), ['Inter'])).rejects.toThrow(/Puter/);
  });
});
