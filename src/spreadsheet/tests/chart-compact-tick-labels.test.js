import { describe, it, expect } from 'vitest';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { axisLabel } from '../src/core/charts.js';

const valueLabels = (svg) => [...svg.matchAll(/<text x="[^"]+" y="[^"]+" text-anchor="end" font-size="11" fill="var\(--ink-3\)">([^<]*)<\/text>/g)]
  .map((m) => m[1]);

describe('compact value-axis tick labels', () => {
  it('gives every tick of a narrow millions range a label of its own', () => {
    const data = { categories: ['A', 'B', 'C'], series: [{ name: 'v', values: [1000000, 1050000, 1100000] }] };
    const labels = valueLabels(renderChartSvg(data, { type: 'column', legend: false }, 480, 300));
    expect(labels.length).toBeGreaterThan(2);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('1.05M');
  });

  it('writes a tick in the decimals its step needs in thousands, millions and billions', () => {
    expect(axisLabel(1250000, null, 250000)).toBe('1.25M');
    expect(axisLabel(1750000, { fmt: 'currency', cur: 'USD' }, 250000)).toBe('$1.75M');
    expect(axisLabel(12250, null, 250)).toBe('12.25K');
    expect(axisLabel(2250000000, null, 250000000)).toBe('2.25B');
    expect(axisLabel(999950, null, 50)).toBe('999.95K');
  });

  it('keeps the short forms where the step needs no more', () => {
    expect(axisLabel(1500000, null, 500000)).toBe('1.5M');
    expect(axisLabel(2000000, null, 500000)).toBe('2M');
    expect(axisLabel(12000, { fmt: 'currency', cur: 'USD' }, 1000)).toBe('$12K');
    expect(axisLabel(12345)).toBe('12.3K');
    expect(axisLabel(999950)).toBe('1M');
  });
});
