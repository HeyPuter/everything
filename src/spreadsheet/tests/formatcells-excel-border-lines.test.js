// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { borderSnapshot } from '../src/core/border-regions.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// A hairline, the dash-dot lines and the medium dashed weights open from an Excel file and are kept, but Format
// Cells' line styles were only the six the app draws itself: a cell bordered with a hairline showed no line style
// chosen, and none of Excel's other seven lines could be picked to draw an edge with.
function open(prepare = () => {}) {
  const wb = new Workbook(), id = wb.activeSheetId, range = parseRange('A1:B2');
  wb.setInput(id, 0, 0, '3');
  prepare(wb, id, range); wb.clearHistory();
  const run = vi.fn((cmd, { patch, borders }) => wb.transaction('Format cells', () => {
    if (Object.keys(patch).length) wb.applyStyle(id, range, patch);
    for (const b of borders || []) wb.applyBorders(id, range, b.kind, b);
  }));
  const modal = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }),
    range: () => range, style: () => wb.styleAt(id, 0, 0) || {}, grid: {}, run }, { panel: 'border' });
  const field = label => modal.panel.querySelector(`[aria-label="${label}"]`);
  const lines = field('Line style');
  const checked = () => [...lines.querySelectorAll('[role="radio"]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label'));
  const apply = () => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { wb, id, field, lines, checked, apply };
}

it('offers Excel\'s thirteen lines', () => {
  const { lines } = open();
  expect([...lines.querySelectorAll('[role="radio"]')].map(b => b.dataset.value)).toEqual(expect.arrayContaining(
    ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair', 'dashDot', 'dashDotDot', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot']));
  expect(lines.querySelectorAll('[role="radio"]')).toHaveLength(13);
});

it('keeps a hairline cell\'s borders on OK, and draws another edge with a hairline picked from the list', () => {
  const { wb, id, field, lines, checked, apply } = open((w, s) => w.applyBorders(s, parseRange('A1'), 'top', { perSide: true, style: 'hair' }));
  lines.querySelector('[data-value="hair"]').click();
  expect(checked()).toEqual(['Hair']);
  field('Bottom border').click(); apply();
  expect(borderSnapshot(wb.styleAt(id, 1, 0))).toMatchObject({ bb: true, bbBorder: { bs: 'hair' } });
  expect(borderSnapshot(wb.styleAt(id, 0, 0))).toMatchObject({ bt: true, btBorder: { bs: 'hair' } });
});

it('leaves the cells\' lines alone when OK is pressed without a change', () => {
  const { wb, id, apply } = open((w, s) => w.applyBorders(s, parseRange('A1'), 'left', { perSide: true, style: 'slantDashDot', color: '#ff0000' }));
  apply();
  expect(borderSnapshot(wb.styleAt(id, 0, 0))).toMatchObject({ bl: true, blBorder: { bs: 'slantDashDot', bc: '#ff0000' } });
});

it('draws an edge with a medium dash-dot line chosen from the list', () => {
  const { wb, id, field, lines, checked, apply } = open();
  lines.querySelector('[data-value="mediumDashDot"]').click();
  expect(checked()).toEqual(['Medium dash-dot']);
  field('Left border').click(); apply();
  expect(borderSnapshot(wb.styleAt(id, 0, 0))).toMatchObject({ bl: true, blBorder: { bs: 'mediumDashDot' } });
});

it('walks the two columns with the arrow keys', () => {
  const { lines, checked } = open();
  const key = (k) => lines.querySelector('[aria-checked="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  expect(checked()).toEqual(['Thin']);
  key('ArrowRight'); expect(checked()).toEqual(['Medium']);
  key('ArrowDown'); expect(checked()).toEqual(['Medium dashed']);
  key('ArrowLeft'); expect(checked()).toEqual(['Hair']);
  key('End'); expect(checked()).toEqual(['Thick']);
});
