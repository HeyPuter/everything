import { describe, expect, it } from 'vitest';
import {
  aggregate,
  barChartSvg,
  createDashboard,
  maxValue,
  sumField,
} from '../src/engine/dashboard.js';

describe('analytics dashboard', () => {
  it('seeds rows and widgets', () => {
    const d = createDashboard();
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.widgets.length).toBeGreaterThan(0);
  });

  it('aggregates revenue by region', () => {
    const points = aggregate(createDashboard(), 'region', 'revenue');
    expect(points.find((p) => p.label === 'West')?.value).toBe(290);
  });

  it('sums kpi field', () => {
    expect(sumField(createDashboard(), 'revenue')).toBe(825);
  });

  it('builds svg bars', () => {
    const points = aggregate(createDashboard(), 'region', 'units');
    const svg = barChartSvg(points);
    expect(svg).toContain('<svg');
    expect(svg).toContain('North');
    expect(maxValue(points)).toBeGreaterThan(0);
  });
});
