// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRibbon } from '../src/ui/ribbon.js';
import { activeChart, isChartObject } from '../src/ui/chart-actions.js';
import { Workbook } from '../src/core/workbook.js';
import { normalizeTimeline } from '../src/core/timeline.js';

let ribbon;
afterEach(() => { ribbon?.destroy(); ribbon = null; document.body.replaceChildren(); localStorage.clear(); });

// A timeline is a filter control, not a chart: Chart Design's Change Chart Type turned a selected one into an
// empty column chart, taking the PivotTable's date filter control with it.
it('offers no Chart Design or Format tab for a selected timeline, and the chart commands do not act on it', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const timeline = wb.addChart(id, normalizeTimeline({ anchor: { r: 1, c: 4 }, report: { owner: id, name: 'PivotTable1' }, field: 'When', title: 'When', level: 'months' }));
  const state = { style: {}, gridlines: true, headers: true, singleCell: true };
  const ctx = { wb, flags: () => state, run: vi.fn(), style: () => state.style, active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId,
    grid: { editing: false, focus: vi.fn(), selectedChart: timeline }, subscribe: () => () => {} };
  expect(isChartObject(wb.chartById(id, timeline))).toBe(false);
  expect(activeChart(ctx)).toBeNull();
  ribbon = createRibbon(ctx);
  document.body.append(ribbon.el);
  ribbon.refresh();
  const tab = (name) => [...ribbon.el.querySelectorAll('[role="tab"]')].find((b) => b.textContent === name);
  expect(tab('Chart Design').hidden).toBe(true);
  expect(tab('Format').hidden).toBe(true);
  expect(tab('Home').getAttribute('aria-selected')).toBe('true');
});
