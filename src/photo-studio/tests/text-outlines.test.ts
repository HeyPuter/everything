import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutText } from '../src/imaging/text/layout';
import { applyCharStyle, defaultCharStyle, fromPlainText, type TextLayerData } from '../src/imaging/text/model';
import { parseCssFont, sfntMeasure, textToPath, type FontResolver } from '../src/imaging/text/outlines';
import { parseFont, type SfntFont } from '../src/imaging/text/sfnt';
import { warpPoint } from '../src/imaging/text/warp';

const load = (rel: string) => parseFont(readFileSync(join(__dirname, '..', 'public', 'fonts', rel)));
const inter = load('inter/Inter-Variable.woff');
const interItalic = load('inter/Inter-Italic-Variable.woff');
const crimson = load('crimson-pro/CrimsonPro-Variable.woff');
const bebas = load('bebas-neue/BebasNeue-Regular.woff');
const fonts: FontResolver = (family, italic) =>
  ({ inter: italic ? interItalic : inter, 'crimson pro': italic ? undefined : crimson, 'bebas neue': italic ? undefined : bebas } as Record<string, SfntFont | undefined>)[family.toLowerCase()];

const bbox = (f: SfntFont, ch: string, wght: number) => {
  const g = f.glyph(f.glyphIndex(ch.codePointAt(0)!), f.normalize({ wght }));
  const p = g.contours.flat();
  return { adv: g.advance, n: g.contours.length, b: [Math.min(...p.map((q) => q.x)), Math.min(...p.map((q) => q.y)), Math.max(...p.map((q) => q.x)), Math.max(...p.map((q) => q.y))] };
};
const near = (a: number[], b: number[], tol = 1) => a.forEach((v, i) => expect(Math.abs(v - b[i]), `${a} vs ${b}`).toBeLessThanOrEqual(tol));

describe('sfnt reader', () => {
  it('reads the bundled WOFF files', () => {
    expect([inter.unitsPerEm, inter.numGlyphs, inter.axes.map((a) => a.tag)]).toEqual([2048, 1333, ['wght']]);
    expect(bebas.axes).toEqual([]);
    expect(inter.glyphIndex(0x41)).toBeGreaterThan(0);
    expect(inter.glyphIndex(0x4e2d)).toBe(0); // no CJK in the Latin subset
  });
  // Reference values from fontTools' instancer at wght=700 (rounded there).
  it('applies variations (avar + gvar with phantom points) like fontTools', () => {
    const a = bbox(inter, 'A', 700);
    expect(Math.abs(a.adv - 1529)).toBeLessThanOrEqual(1);
    near(a.b, [49, 0, 1480, 1490]);
    const o = bbox(inter, 'o', 700);
    expect(Math.abs(o.adv - 1256)).toBeLessThanOrEqual(1);
    near(o.b, [81, -22, 1175, 1132]);
    const thin = bbox(inter, 'o', 100);
    expect(thin.adv).toBe(1186);
    near(thin.b, [130, -24, 1056, 1134]);
    const c = bbox(crimson, 'o', 700);
    expect(Math.abs(c.adv - 533)).toBeLessThanOrEqual(1);
    near(c.b, [34, -8, 498, 447]);
    expect(bbox(inter, 'o', 400).adv).toBe(1228);
  });
  it('resolves composite glyphs, including varied component offsets', () => {
    const e = bbox(inter, 'é', 700);
    expect(Math.abs(e.adv - 1220)).toBeLessThanOrEqual(1);
    near(e.b, [81.3, -21.8, 1142.6, 1571]);
    expect(bbox(crimson, 'é', 700).b[3]).toBeCloseTo(677, 0);
    expect(bbox(inter, 'H', 400).n).toBe(1);
    expect(bbox(crimson, 'H', 400).n).toBe(3);
    expect(bbox(bebas, '%', 400).n).toBe(5);
    expect(bbox(bebas, 'i', 400).adv).toBe(192);
  });
  it('reads GPOS pair kerning', () => {
    const g = (c: string) => inter.glyphIndex(c.codePointAt(0)!);
    expect(inter.kerning(g('A'), g('V'))).toBe(-140);
    expect(inter.kerning(g('T'), g('o'))).toBe(-160);
    expect(inter.kerning(g('H'), g('H'))).toBe(0);
  });
});

describe('font-file measure', () => {
  const m = sfntMeasure(fonts);
  it('parses CSS fonts written by the layout', () => {
    expect(parseCssFont('italic 700 12.5px "Crimson Pro", sans-serif')).toEqual({ family: 'Crimson Pro', weight: 700, italic: true, size: 12.5 });
    expect(parseCssFont('400 20px Inter, sans-serif')).toEqual({ family: 'Inter', weight: 400, italic: false, size: 20 });
  });
  it('measures advances with kerning and weight', () => {
    const f = '400 2048px Inter, sans-serif';
    expect(m('A', f).width).toBe(1413);
    expect(m('AV', f).width).toBe(1413 * 2 - 140);
    expect(m('AV', f, false).width).toBe(1413 * 2);
    expect(m('A', '700 2048px Inter, sans-serif').width).toBeCloseTo(1529, 0);
    expect(m('A‌V', f).width).toBe(1413 * 2 - 140);
    expect(m('', f).ascent).toBe(inter.ascent);
  });
  it('drives the layout with real metrics', () => {
    const d: TextLayerData = { content: fromPlainText('Type AV', { ...defaultCharStyle(), size: 48 }), mode: 'point', origin: { x: 0, y: 0 }, orientation: 'horizontal', antiAlias: 'smooth' };
    const lay = layoutText(d, { measure: m, resolution: 72 });
    const expected = m('Type', '400 48px Inter, sans-serif').width + m(' ', '400 48px Inter, sans-serif').width + m('AV', '400 48px Inter, sans-serif').width;
    expect(lay.lines[0].width).toBeCloseTo(expected, 6);
  });
});

describe('textToPath', () => {
  const layer = (text: string, patch = {}): TextLayerData => ({
    content: fromPlainText(text, { ...defaultCharStyle(), size: 100, ...patch }), mode: 'point', origin: { x: 10, y: 200 }, orientation: 'horizontal', antiAlias: 'smooth',
  });
  it('emits one closed subpath per glyph contour in document pixels', () => {
    const p = textToPath(layer('Ho'), { fonts });
    expect(p.contours.length).toBe(1 + 2);
    expect(p.d.startsWith('M')).toBe(true);
    expect((p.d.match(/Z/g) ?? []).length).toBe(3);
    // Cap height of Inter H (1490/2048 em) above the baseline at 100 px.
    expect(p.bounds.y).toBeCloseTo(200 - (1490 / 2048) * 100, 1);
    expect(p.bounds.x).toBeCloseTo(10 + (180 / 2048) * 100, 1);
    expect(p.missingFonts).toEqual([]);
  });
  it('matches the advances the layout uses (kerning, tracking)', () => {
    const a = textToPath(layer('AV'), { fonts });
    const b = textToPath(layer('AV', { tracking: 200 }), { fonts });
    expect(b.bounds.width - a.bounds.width).toBeCloseTo(20, 1); // 0.2 em between the two glyphs
  });
  it('applies faux italic, scale and reports approximations', () => {
    const up = textToPath(layer('I'), { fonts });
    const it = textToPath(layer('I', { fauxItalic: true, fauxBold: true }), { fonts });
    expect(it.bounds.width).toBeGreaterThan(up.bounds.width + 10);
    expect(it.approximations).toContain('faux bold');
    const wide = textToPath(layer('I', { scaleX: 200 }), { fonts });
    expect(wide.bounds.width).toBeCloseTo(up.bounds.width * 2, 1);
  });
  it('adds decorations and falls back for unknown families', () => {
    const p = textToPath(layer('a b', { underline: true, family: 'Nonexistent Sans' }), { fonts });
    expect(p.missingFonts).toEqual(['Nonexistent Sans']);
    const rects = p.contours.filter((c) => c.length === 5 && c.every((cmd) => cmd[0] !== 'Q'));
    expect(rects.length).toBeGreaterThanOrEqual(1);
    expect(p.bounds.y + p.bounds.height).toBeGreaterThan(200);
  });
  it('warps outline points with the same mapping as the bitmap', () => {
    const d = { ...layer('HHHH'), warp: { style: 'arc' as const, bend: 50, horizontal: 0, vertical: 0, axis: 'horizontal' as const } };
    const flat = textToPath(layer('HHHH'), { fonts });
    const bent = textToPath(d, { fonts });
    const lay = layoutText(layer('HHHH'), { measure: sfntMeasure(fonts) });
    // The first point of the first glyph maps exactly through warpPoint.
    const [x0, y0] = [flat.contours[0][0][1] as number, flat.contours[0][0][2] as number];
    const [wx, wy] = warpPoint(d.warp, lay.bounds, x0, y0);
    expect(bent.contours[0][0][1]).toBeCloseTo(wx, 6);
    expect(bent.contours[0][0][2]).toBeCloseTo(wy, 6);
    expect(bent.bounds.height).toBeGreaterThan(flat.bounds.height + 10);
  });
  it('lays out mixed fonts and weights', () => {
    let c = fromPlainText('Ab', { ...defaultCharStyle(), size: 50 });
    c = applyCharStyle(c, 1, 2, { family: 'Crimson Pro', weight: 800 });
    const p = textToPath({ content: c, mode: 'point', origin: { x: 0, y: 0 }, orientation: 'horizontal', antiAlias: 'smooth' }, { fonts });
    expect(p.contours.length).toBe(2 + 2);
  });
});
