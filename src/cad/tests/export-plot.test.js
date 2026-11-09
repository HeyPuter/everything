import { describe, it, expect } from 'vitest';
import {
  PAPER_SIZES,
  findPaper,
  computePlot,
  standardScale,
  lineweightMm,
  dashArray,
  plotColor,
  fitToSize,
  scaleText,
} from '../src/io/export/plot.js';

const apply = (T, x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];

describe('paper sizes', () => {
  it('lists ISO, ANSI, Arch and other sizes in portrait millimetres', () => {
    for (const id of ['A0', 'A4', 'ANSI-A', 'ANSI-E', 'ARCH-A', 'ARCH-E', 'LEGAL', 'TABLOID']) {
      const p = PAPER_SIZES.find((s) => s.id === id);
      expect(p).toBeTruthy();
      expect(p.w).toBeLessThanOrEqual(p.h);
    }
    expect(findPaper('a4')).toMatchObject({ w: 210, h: 297 });
    expect(findPaper('Letter')).toMatchObject({ w: 215.9, h: 279.4 });
  });
});

describe('computePlot', () => {
  it('fits a 297 x 210 drawing on A4 landscape inside 10 mm margins', () => {
    const p = computePlot({ paper: 'A4', orientation: 'landscape', area: [0, 0, 297, 210], scale: 'fit', margins: 10 });
    expect(p.pageW).toBe(297);
    expect(p.pageH).toBe(210);
    expect(p.printable).toEqual({ x: 10, y: 10, w: 277, h: 190 });
    expect(p.scale).toBeCloseTo(190 / 210, 12);
    // Centered: the drawing center lands on the page center.
    const [cx, cy] = apply(p.transform, 148.5, 105);
    expect(cx).toBeCloseTo(148.5, 9);
    expect(cy).toBeCloseTo(105, 9);
    // The fitted height fills the printable height exactly.
    const [, y0] = apply(p.transform, 0, 0);
    const [, y1] = apply(p.transform, 0, 210);
    expect(y0).toBeCloseTo(10, 9);
    expect(y1).toBeCloseTo(200, 9);
    expect(p.scaleText).toBe('1:1.105');
  });

  it('maps a 10000-unit line to 100 mm at 1 mm = 100 units', () => {
    const p = computePlot({ paper: 'A3', orientation: 'landscape', area: [0, 0, 10000, 5000], scale: { paper: 1, drawing: 100 } });
    const [x0] = apply(p.transform, 0, 0);
    const [x1] = apply(p.transform, 10000, 0);
    expect(x1 - x0).toBeCloseTo(100, 12);
    expect(p.scaleText).toBe('1:100');
  });

  it('labels the true scale of drawings in other units', () => {
    // 1 mm on paper = 0.5 m (500 mm): 1:500, not "2:1".
    const m = computePlot({ paper: 'A3', area: [0, 0, 100, 50], units: 'm', scale: { paper: 1, drawing: 0.5 } });
    expect(m.scaleText).toBe('1:500');
    expect(computePlot({ paper: 'A3', area: [0, 0, 100, 50], units: 'in', scale: { ratio: 100 } }).scaleText).toBe('1:100');
    expect(computePlot({ paper: 'A3', area: [0, 0, 100, 50], units: 'ft', scale: { ratio: 48 } }).scaleText).toBe('1:48');
  });

  it('converts drawing units for a true-scale ratio', () => {
    const mm = computePlot({ paper: 'A3', area: [0, 0, 1, 1], scale: 100, units: 'mm' });
    expect(mm.scale).toBeCloseTo(0.01, 12);
    const m = computePlot({ paper: 'A3', area: [0, 0, 1, 1], scale: { ratio: 100 }, units: 'm' });
    expect(m.scale).toBeCloseTo(10, 12);
  });

  it('places at the printable origin when not centered, with offset', () => {
    const p = computePlot({
      paper: 'A4',
      area: [50, 50, 60, 60],
      scale: { paper: 1, drawing: 1 },
      center: false,
      margins: 10,
      offset: { x: 5, y: 2 },
    });
    expect(apply(p.transform, 50, 50)).toEqual([15, 12]);
    // y-down transform for SVG and canvas.
    const [, yd] = apply(p.transformDown, 50, 50);
    expect(yd).toBeCloseTo(297 - 12, 9);
    expect(p.clip).toEqual({ x: 15, y: 12, w: 10, h: 10 });
    expect(p.clipDown.y).toBeCloseTo(297 - 22, 9);
  });

  it('uses the drawing bounds when no area is given and swaps for orientation', () => {
    const p = computePlot({ custom: { w: 100, h: 50 }, orientation: 'portrait', margins: 0 }, [0, 0, 10, 20]);
    expect(p.pageW).toBe(50);
    expect(p.pageH).toBe(100);
    expect(p.scale).toBeCloseTo(5, 12);
  });
});

describe('helpers', () => {
  it('converts lineweights', () => {
    expect(lineweightMm(0)).toBe(0.05);
    expect(lineweightMm(-1)).toBe(0.25);
    expect(lineweightMm(undefined)).toBe(0.25);
    expect(lineweightMm(50)).toBe(0.5);
    expect(lineweightMm(50, { scale: 2 })).toBe(1);
    expect(lineweightMm(50, { ignore: true })).toBe(0.1);
  });

  it('normalizes dash patterns', () => {
    expect(dashArray([], 1)).toBeNull();
    expect(dashArray([12, -6], 2)).toEqual({ array: [24, 12], offset: 0, hasDot: false });
    expect(dashArray([0, -3], 1)).toEqual({ array: [0, 3], offset: 0, hasDot: true });
    expect(dashArray([-2, 5], 1)).toEqual({ array: [5, 2], offset: 5, hasDot: false });
    expect(dashArray([5, -1, 3], 1)).toEqual({ array: [8, 1], offset: 3, hasDot: false });
    expect(dashArray([12, -4, 0, -4], 1).array).toEqual([12, 4, 0, 4]);
    expect(dashArray([12, -6], 1, 100)).toBeNull();
  });

  it('resolves plot colors', () => {
    const red = { rgb: [255, 0, 0] };
    const fg = { rgb: [255, 255, 255], aci7: true };
    expect(plotColor(red, {})).toEqual([255, 0, 0]);
    expect(plotColor(red, { monochrome: true })).toEqual([0, 0, 0]);
    expect(plotColor(fg, {})).toEqual([0, 0, 0]);
    expect(plotColor(fg, { background: '#202020' })).toEqual([255, 255, 255]);
    // Black and white on a dark background prints white, not invisible black.
    expect(plotColor(red, { monochrome: true, background: '#1f242c' })).toEqual([255, 255, 255]);
  });

  it('fits to a pixel size and formats scales', () => {
    const { transform, scale } = fitToSize([0, 0, 10, 5], 200, 100, 0);
    expect(scale).toBe(20);
    expect(apply(transform, 0, 0)).toEqual([0, 100]);
    expect(scaleText(2)).toBe('2:1');
  });
});

describe('standardScale', () => {
  it('picks the largest 1-2-5 scale that still fits, in the drawing units', () => {
    // A small mm part that fits at 1.538 mm per unit plots at 1:1, not 1:100.
    expect(standardScale(1.538, 'mm')).toEqual({ paper: 1, drawing: 1 });
    expect(standardScale(0.0123, 'mm')).toEqual({ paper: 1, drawing: 100 });
    expect(standardScale(4, 'mm')).toEqual({ paper: 2, drawing: 1 });
    expect(standardScale(12, 'm')).toEqual({ paper: 10, drawing: 1 });
    expect(standardScale(0.25, 'm')).toEqual({ paper: 1, drawing: 5 });
    expect(standardScale(0.4, 'in')).toEqual({ paper: 25.4, drawing: 100 });
  });

  it('never chooses a scale larger than the fit scale', () => {
    for (const s of [0.003, 0.07, 0.9, 1, 3.3, 45]) {
      const { paper, drawing } = standardScale(s, 'mm');
      expect(paper / drawing).toBeLessThanOrEqual(s * (1 + 1e-9));
      expect(paper / drawing).toBeGreaterThan(s / 2.6);
    }
  });
});
