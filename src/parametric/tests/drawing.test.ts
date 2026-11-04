import { describe, expect, it } from 'vitest';
import { PdfPage, arcToCubics, parseSvgPath, pdfString } from '../src/drawing/pdf';
import { buildSheet, projectedSize, scaleLabel, sheetDims, standardLayout, toPdf, toSvg } from '../src/drawing/sheet';
import type { DrawingDoc } from '../src/model/types';

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
});
