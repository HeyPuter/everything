import { describe, expect, it } from 'vitest';
import { PdfPage, arcToCubics, parseSvgPath, pdfString, textWidth } from '../src/drawing/pdf';
import { SHEETS, STANDARD_SCALES, buildSheet, projectedSize, scaleLabel, sheetDims, standardLayout, toPdf, toSvg } from '../src/drawing/sheet';
import type { Vec3 } from '../src/math/vec';
import type { DrawingDoc, SheetSize } from '../src/model/types';

describe('SVG path parsing', () => {
  it('handles absolute and relative commands with implicit repeats', () => {
    const segs = parseSvgPath('M 0 0 L 10 0 10 10 l -10 0 z');
    expect(segs.map((s) => s.op)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    expect(segs[3]).toMatchObject({ op: 'L', p: [0, 10] });
    const hv = parseSvgPath('M1 1H5V7h-2v-1');
    expect(hv[hv.length - 1]).toMatchObject({ p: [3, 6] });
  });

  it('turns arcs into cubic Beziers that end exactly at the target', () => {
    const segs = arcToCubics(10, 0, 10, 10, 0, false, true, -10, 0);
    expect(segs.length).toBe(2);
    const last = segs[segs.length - 1] as { p: [number, number] };
    expect(last.p).toEqual([-10, 0]);
    // The midpoint of a half circle from (10,0) to (-10,0) sweeping positively is (0,10).
    const first = segs[0] as { p: [number, number] };
    expect(first.p[0]).toBeCloseTo(0, 9);
    expect(Math.abs(first.p[1])).toBeCloseTo(10, 9);
    expect(parseSvgPath('M 10 0 A 10 10 0 1 1 -10 0').filter((s) => s.op === 'C').length).toBeGreaterThan(0);
  });
});

describe('PDF writer', () => {
  it('writes a valid single-page PDF with a cross-reference table', () => {
    const p = new PdfPage(297, 210);
    p.rect(10, 10, 277, 190, { width: 0.5 });
    p.path('M 0 0 L 10 10', 50, 50, 2, { width: 0.35, dash: [1, 1] });
    p.text('Hello (world)', 20, 20, 4, { bold: true });
    const bytes = p.build('Test');
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 841.89 595.28]');
    expect(text).toContain('(Hello \\(world\\)) Tj');
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    // Every object offset in the table points at "n 0 obj".
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  it('keeps accented letters and drawing symbols in text and the title', () => {
    // WinAnsiEncoding bytes as octal escapes; characters it lacks become '?'.
    expect(pdfString('Größe Ø10 ±0.5° – 5€ (a\\b) 中\n')).toBe('Gr\\366\\337e \\33010 \\2610.5\\260 \\226 5\\200 \\(a\\\\b\\) ??');
    const p = new PdfPage(100, 100);
    p.text('Zoë', 10, 10, 3);
    const text = new TextDecoder().decode(p.build('Größe'));
    expect(text).toContain('(Zo\\353) Tj');
    expect(text).toContain('/Title <FEFF0047007200F600DF0065>');
    // Still pure ASCII, so the byte offsets in the cross-reference table hold.
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true);
  });
});

describe('sheet layout', () => {
  it('chooses a standard scale that fits the views', () => {
    const sheet = sheetDims({ sheet: 'A4', landscape: true });
    expect(sheet).toEqual({ w: 297, h: 210 });
    const small = standardLayout(sheet, [0, 0, 0], [40, 20, 10]);
    expect(small.scale).toBeGreaterThanOrEqual(1);
    const big = standardLayout(sheet, [0, 0, 0], [800, 300, 200]);
    expect(big.scale).toBeLessThan(1);
    expect(scaleLabel(0.5)).toBe('1:2');
    expect(scaleLabel(2)).toBe('2:1');
    expect(projectedSize('top', [0, 0, 0], [40, 20, 10])).toEqual([40, 10]);
    expect(projectedSize('right', [0, 0, 0], [40, 20, 10])).toEqual([10, 20]);
  });

  it('builds an SVG and PDF sheet with views, dimensions and a title block', () => {
    const doc: DrawingDoc = {
      sheet: 'A4', landscape: true, scale: 1, title: 'Plate', drawnBy: 'Tester', notes: '',
      views: [{ id: 'v1', kind: 'front', x: 100, y: 100, hidden: true, dims: true }],
    };
    const proj = new Map([['v1', { id: 'v1', visible: ['M 0 0 L 40 0 L 40 -20 L 0 -20 Z'], hidden: ['M 10 0 L 10 -20'], bounds: [0, -20, 40, 0] as [number, number, number, number] }]]);
    const sheet = buildSheet(doc, proj, { partName: 'Plate', material: 'Steel', units: 'mm', date: '2026-10-12', formatLength: (v) => v.toFixed(1) });
    expect(sheet.frames[0]).toMatchObject({ x0: 80, x1: 120, y0: 90, y1: 110 });
    const svg = toSvg(sheet.items, sheet.w, sheet.h);
    expect(svg).toContain('data-view="v1"');
    expect(svg).toContain('>40.0<');
    expect(svg).toContain('>20.0<');
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('>Plate<');
    expect(svg).toContain('>FRONT<');
    const pdf = new TextDecoder().decode(toPdf(sheet.items, sheet.w, sheet.h, 'Plate'));
    expect(pdf).toContain('(Plate) Tj');
  });

  it('keeps the SVG well-formed when a title holds control characters', () => {
    const doc: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: 'Bra\u0007cket \ud83d\udd27 <A&B>\u0000\ud800', drawnBy: 'Tab\tbed', notes: 'x\u001by', views: [] };
    const sheet = buildSheet(doc, new Map(), { partName: 'P', material: 'Steel', units: 'mm', date: '2026-10-12', formatLength: String });
    const svg = toSvg(sheet.items, sheet.w, sheet.h);
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(svg).toContain('>Bracket \ud83d\udd27 &lt;A&amp;B&gt;<');
    expect(svg).toContain('>xy<');
    expect(new TextDecoder().decode(toPdf(sheet.items, sheet.w, sheet.h, doc.title))).toContain('(Bra?cket ? <A&B>??) Tj');
  });

  it('fits long title block entries inside their cells', () => {
    const notes = 'Break all sharp edges 0.5 x 45°. Anodize clear after machining. Tolerances ISO 2768-mK.';
    const doc: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title: 'T'.repeat(120), drawnBy: 'Short', notes, views: [] };
    const { items } = buildSheet(doc, new Map(), { partName: 'P', material: 'Steel', units: 'mm', date: '2026-10-12', formatLength: String });
    const texts = items.filter((i) => i.t === 'text') as Extract<(typeof items)[number], { t: 'text' }>[];
    const title = texts.find((t) => t.s.startsWith('TTT'))!;
    const note = texts.find((t) => t.s.startsWith('Break'))!;
    // Title cell 110 mm, notes cell 60 mm (less 3 mm padding), in Helvetica's widths.
    expect(textWidth(title.s, title.size, true)).toBeLessThanOrEqual(107);
    expect(textWidth(note.s, note.size)).toBeLessThanOrEqual(57);
    expect(note.size).toBeGreaterThanOrEqual(1.8);
    expect(note.s.endsWith('…')).toBe(true);
    // Short values keep their size.
    expect(texts.find((t) => t.s === 'Short')!.size).toBe(2.8);
  });

  it('fits capitals, which are wider than average, inside their cells', () => {
    const title = 'MOUNTING BRACKET ASSEMBLY FOR LEFT WING MK2 REV';
    const notes = 'BREAK ALL SHARP EDGES. DEBURR. ANODIZE BLACK';
    const doc: DrawingDoc = { sheet: 'A4', landscape: true, scale: 1, title, drawnBy: '', notes, views: [] };
    const { items } = buildSheet(doc, new Map(), { partName: 'P', material: 'Steel', units: 'mm', date: '2026-10-12', formatLength: String });
    const texts = items.filter((i) => i.t === 'text') as Extract<(typeof items)[number], { t: 'text' }>[];
    const t = texts.find((x) => x.s === title)!;
    const n = texts.find((x) => x.s === notes)!;
    expect(textWidth(t.s, t.size, true)).toBeLessThanOrEqual(107);
    expect(textWidth(n.s, n.size)).toBeLessThanOrEqual(57);
    // Shrunk, not cut short, while that keeps them legible.
    expect(n.size).toBeGreaterThanOrEqual(1.8);
  });

  it('measures Helvetica text', () => {
    expect(textWidth('FRONT', 1)).toBeCloseTo(3.444, 3);
    expect(textWidth('60.00', 1)).toBeCloseTo(2.502, 3);
    expect(textWidth('W', 1, true)).toBeCloseTo(0.944, 3);
  });

  // Rectangle outlines the size of each view's box projection, centred on 0.
  const boxProjections = (doc: DrawingDoc, min: Vec3, max: Vec3) =>
    new Map(doc.views.map((v) => {
      const [pw, ph] = projectedSize(v.kind, min, max);
      return [v.id, { id: v.id, visible: [`M ${-pw / 2} ${-ph / 2} H ${pw / 2} V ${ph / 2} H ${-pw / 2} Z`], hidden: [], bounds: [-pw / 2, -ph / 2, pw / 2, ph / 2] as [number, number, number, number] }];
    }));
  const info = { partName: 'P', material: 'Steel', units: 'mm', date: '2026-10-12', formatLength: (v: number) => v.toFixed(2) };
  const labelsOverlappingViews = (doc: DrawingDoc, proj: ReturnType<typeof boxProjections>) => {
    const sheet = buildSheet(doc, proj, info);
    const labels = sheet.items.filter((i) => i.t === 'text' && /^[A-Z]+$/.test(i.s) && i.size === 2.6) as Extract<(typeof sheet.items)[number], { t: 'text' }>[];
    expect(labels.length).toBe(doc.views.length);
    const hits: string[] = [];
    for (const l of labels) {
      const half = textWidth(l.s, l.size) / 2;
      const x0 = l.anchor === 'start' ? l.x : l.x - half, x1 = x0 + 2 * half, y0 = l.y - l.size * 0.75, y1 = l.y;
      for (const f of sheet.frames) {
        const v = doc.views.find((x) => x.id === f.id)!;
        // A view with dimensions also owns the room they take left of and below it.
        const dims = v.dims && v.kind !== 'isometric';
        const fx0 = dims ? f.x0 - 11.5 : f.x0, fy1 = dims ? f.y1 + 10 : f.y1;
        if (x0 < f.x1 && x1 > fx0 && y0 < fy1 && y1 > f.y0) hits.push(`${l.s} over ${v.kind}`);
      }
    }
    return hits;
  };

  it('keeps view labels off the other views', () => {
    // The Pipe Flange: a 90 x 26 disc on A4 at 1:2.
    const min: Vec3 = [-45, 0, -45], max: Vec3 = [45, 26, 45];
    const layout = standardLayout(sheetDims({ sheet: 'A4', landscape: true }), min, max);
    expect(layout.scale).toBe(0.5);
    const doc: DrawingDoc = { sheet: 'A4', landscape: true, scale: layout.scale, title: '', drawnBy: '', notes: '', views: layout.views.map((v, i) => ({ ...v, id: `v${i + 1}` })) };
    const proj = boxProjections(doc, min, max);
    expect(labelsOverlappingViews(doc, proj)).toEqual([]);
    // Dragged right under the top view's label: the label moves above the top view.
    const top = doc.views.find((v) => v.kind === 'top')!, front = doc.views.find((v) => v.kind === 'front')!;
    front.y = top.y + 22.5 + 12;
    front.x = top.x;
    expect(labelsOverlappingViews(doc, proj)).toEqual([]);
    const svg = toSvg(buildSheet(doc, proj, info).items, 297, 210);
    const y = Number(/<text x="[\d.]+" y="([\d.]+)"[^>]*>TOP</.exec(svg)![1]);
    expect(y).toBeLessThan(top.y - 22.5);
  });

  it('lays out standard views with their labels clear of each other on every sheet', () => {
    const parts: [Vec3, Vec3][] = [[[0, 0, 0], [40, 20, 10]], [[-45, 0, -45], [45, 26, 45]], [[0, 0, 0], [800, 300, 200]], [[0, 0, 0], [10, 120, 10]], [[0, 0, 0], [200, 5, 200]]];
    for (const sheet of Object.keys(SHEETS) as SheetSize[]) {
      for (const landscape of [true, false]) {
        for (const [min, max] of parts) {
          const layout = standardLayout(sheetDims({ sheet, landscape }), min, max);
          expect(STANDARD_SCALES).toContain(layout.scale);
          const doc: DrawingDoc = { sheet, landscape, scale: layout.scale, title: '', drawnBy: '', notes: '', views: layout.views.map((v, i) => ({ ...v, id: `v${i + 1}` })) };
          expect(labelsOverlappingViews(doc, boxProjections(doc, min, max)), `${sheet} ${landscape} ${max}`).toEqual([]);
        }
      }
    }
  });
});
