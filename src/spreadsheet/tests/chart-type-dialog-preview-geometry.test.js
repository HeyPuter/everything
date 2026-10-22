// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openChartTypeDialog } from '../src/ui/chart-type-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// The Insert Chart dialog drew its previews from the new chart's settings as made, before the workbook fills
// them in and checks them: a bar or scatter chart's plot came out at x="NaN" (about thirty console errors per
// preview), with no plot, axes or gridlines where the chart inserted has them.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each(['bar', 'scatter', 'column', 'combo'])('draws the %s previews without invalid coordinates', (family) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Name', 'Qty', 'P'], ['A', '3', '1'], ['B', '5', '2'], ['C', '7', '=B4*2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const range = { r1: 0, c1: 0, r2: 3, c2: 2 };
  openChartTypeDialog({ wb, sheetId: () => id, range: () => range, ranges: () => [range], dataRange: r => r, grid: { focus() {} } }, { mode: 'insert', family });
  const dialog = document.querySelector('[role="dialog"]');
  for (const tile of dialog.querySelectorAll('.chart-gallery-tile')) {
    tile.click();
    const svg = dialog.querySelector('.chart-type-preview svg');
    expect(svg).not.toBeNull();
    expect(svg.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(svg.querySelector('[data-el="plotArea"]')).not.toBeNull();
  }
});
