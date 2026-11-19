import { describe, expect, it } from 'vitest';
import {
  canvasSizeProblem,
  formatLength,
  formatNumber,
  linkedSize,
  normalizeAngle,
  orientedSize,
  parseLength,
  parseNumber,
  plannedCanvasSize,
  unitFromText,
} from '../src/features/panels/property-values';
import { TileStore, readRGBA, writeRect, emptyGrid } from '../src/model/tiles';
import { solidGrid, uniformColor } from '../src/features/panels/document-properties';

const px = { unit: 'px' as const, ppi: 72, base: 400 };

describe('parseLength', () => {
  it('reads plain numbers in the field unit', () => {
    expect(parseLength('1800', px)).toBe(1800);
    expect(parseLength(' 12.5 ', px)).toBe(12.5);
    expect(parseLength('12,5', px)).toBe(12.5);
    expect(parseLength('2', { ...px, unit: 'in' })).toBe(144);
    expect(parseLength('50', { ...px, unit: 'percent' })).toBe(200);
  });
  it('converts typed units', () => {
    expect(parseLength('2 in', px)).toBe(144);
    expect(parseLength('2"', px)).toBe(144);
    expect(parseLength('2.54cm', px)).toBeCloseTo(72);
    expect(parseLength('25.4 mm', px)).toBeCloseTo(72);
    expect(parseLength('72pt', px)).toBe(72);
    expect(parseLength('25%', px)).toBe(100);
    expect(parseLength('100 px', { ...px, unit: 'in' })).toBe(100);
    expect(parseLength('3 pixels', px)).toBe(3);
  });
  it('evaluates arithmetic with precedence, signs and parentheses', () => {
    expect(parseLength('1800 + 200', px)).toBe(2000);
    expect(parseLength('1000/2', px)).toBe(500);
    expect(parseLength('100 + 10 * 2', px)).toBe(120);
    expect(parseLength('(100 + 10) * 2', px)).toBe(220);
    expect(parseLength('-20', px)).toBe(-20);
    expect(parseLength('1in + 28', px)).toBe(100);
    expect(parseLength('2 × 3', px)).toBe(6);
  });
  it('rejects text it cannot read', () => {
    for (const bad of [
      '',
      'wide',
      '10 furlongs',
      '10 +',
      '1/0',
      '10px * 2px',
      '(1 + 2',
      '1 2',
      '1..2',
    ])
      expect(parseLength(bad, px), bad).toBeUndefined();
  });
});

describe('parseNumber and formatting', () => {
  it('ignores expected suffixes only', () => {
    expect(parseNumber('45°')).toBe(45);
    expect(parseNumber('50%')).toBe(50);
    expect(parseNumber('300 ppi', ['ppi'])).toBe(300);
    expect(parseNumber('300 px')).toBeUndefined();
    expect(parseNumber('90 + 45')).toBe(135);
  });
  it('formats short numbers', () => {
    expect(formatNumber(1800)).toBe('1800');
    expect(formatNumber(12.3456)).toBe('12.35');
    expect(formatNumber(-0.001)).toBe('0');
    expect(formatLength(300, { unit: 'in', ppi: 72, base: 0 })).toBe('4.167');
    expect(formatLength(200, { unit: 'percent', ppi: 72, base: 400 })).toBe('50');
  });
  it('recognizes unit words', () => {
    expect(unitFromText('Inches')).toBe('in');
    expect(unitFromText('%')).toBe('percent');
    expect(unitFromText('furlong')).toBeUndefined();
  });
});

describe('size planning', () => {
  it('keeps proportions only when linked', () => {
    expect(linkedSize(400, 300, 'width', 800, false)).toEqual({ width: 800, height: 300 });
    expect(linkedSize(400, 300, 'width', 800, true)).toEqual({ width: 800, height: 600 });
    expect(linkedSize(400, 300, 'height', 100, true, true)).toEqual({ width: 133, height: 100 });
    expect(linkedSize(400, 300, 'height', 0.2, true, true)).toEqual({ width: 1, height: 1 });
  });
  it('plans canvas sizes in whole pixels and skips no-ops', () => {
    expect(plannedCanvasSize({ width: 400, height: 300 }, 'width', 500.4, false)).toEqual({
      width: 500,
      height: 300,
    });
    expect(plannedCanvasSize({ width: 400, height: 300 }, 'width', 400.2, true)).toBeUndefined();
    expect(plannedCanvasSize({ width: 1000, height: 600 }, 'width', 748, true)).toEqual({
      width: 748,
      height: 449,
    });
  });
  it('validates document limits', () => {
    expect(canvasSizeProblem(8192, 2000)).toBeUndefined();
    expect(canvasSizeProblem(0, 10)).toMatch(/at least 1/);
    expect(canvasSizeProblem(9000, 10)).toMatch(/8192/);
    expect(canvasSizeProblem(8000, 8000)).toMatch(/megapixels/);
  });
  it('swaps sides for the other orientation only', () => {
    expect(orientedSize(400, 300, 'portrait')).toEqual({ width: 300, height: 400 });
    expect(orientedSize(400, 300, 'landscape')).toBeUndefined();
    expect(orientedSize(300, 400, 'landscape')).toEqual({ width: 400, height: 300 });
    expect(orientedSize(300, 300, 'portrait')).toBeUndefined();
  });
  it('folds angles into (-180, 180]', () => {
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(-360)).toBe(0);
    expect(normalizeAngle(NaN)).toBe(0);
  });
});

describe('background fill helpers', () => {
  it('fills a canvas-sized grid with one color and detects it', () => {
    const store = new TileStore();
    const grid = solidGrid(store, 300, 520, '#336699');
    const img = readRGBA(store, grid, { x: 299, y: 519, width: 1, height: 1 });
    expect([...img.data]).toEqual([0x33, 0x66, 0x99, 255]);
    expect(uniformColor(store, grid, 300, 520)).toBe('#336699');
  });
  it('reports mixed, partial or transparent grids as not uniform', () => {
    const store = new TileStore();
    let grid = solidGrid(store, 300, 300, '#ffffff');
    grid = writeRect(store, grid, 299, 299, {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255]),
    });
    expect(uniformColor(store, grid, 300, 300)).toBeNull();
    const small = solidGrid(store, 100, 100, '#ffffff');
    expect(uniformColor(store, small, 300, 300)).toBeNull();
    expect(uniformColor(store, emptyGrid(4), 10, 10)).toBeNull();
    const clear = writeRect(store, emptyGrid(4), 0, 0, {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(16),
    });
    expect(uniformColor(store, clear, 2, 2)).toBeNull();
  });
});
