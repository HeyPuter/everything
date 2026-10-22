// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals } from '../src/core/subtotal.js';

// The outline had no level buttons: after Subtotal, seeing only the totals meant collapsing every group by
// hand, and Collapse all left nothing but the grand total. As in Excel, buttons 1, 2, 3 … in the corner
// show the lines down to that level, one undo step each.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
const flush = () => new Promise((r) => setTimeout(r, 5));

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['West', 10], ['East', 20], ['West', 30], ['North', 1]].forEach((row, r) => row.forEach((v, c) => wb.setCells(id, [{ r, c, cell: { v } }])));
  addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, code: 9, totalCols: [1] });
  wb.clearHistory();
  const shown = () => Array.from({ length: 9 }, (_, r) => r).filter((r) => !wb.sheet(id).hiddenRows.has(r)).map((r) => wb.getValue(id, r, 0));
  return { wb, id, shown };
}

it('shows the lines down to a level, the deepest button showing every line', () => {
  const { wb, id, shown } = book();
  expect(wb.showOutlineLevel(id, 'row', 2)).toBe(true);
  expect(shown()).toEqual(['Region', 'East Total', 'North Total', 'West Total', 'Grand Total']);
  wb.showOutlineLevel(id, 'row', 1);
  expect(shown()).toEqual(['Region', 'Grand Total']);
  wb.showOutlineLevel(id, 'row', 3);
  expect(shown()).toHaveLength(9);
  expect(wb.showOutlineLevel(id, 'row', 3)).toBe(false);
  wb.undo();
  expect(shown()).toEqual(['Region', 'Grand Total']);
  wb.undo();
  expect(shown()).toEqual(['Region', 'East Total', 'North Total', 'West Total', 'Grand Total']);
});

it('draws a level button per level and one more in the corner, and a click asks for that level', async () => {
  const { wb, id } = book();
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd, arg) => commands.push([cmd, arg]) });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const buttons = [...grid.el.querySelectorAll('.outline-levels .outline-level')];
    expect(buttons.map((b) => b.textContent)).toEqual(['1', '2', '3']);
    expect(buttons[1].getAttribute('aria-label')).toBe('Show row outline level 2');
    buttons[1].click();
    expect(commands).toEqual([['outlineLevel', { axis: 'row', level: 2 }]]);
    wb.groupLines(id, 'col', 1, 1);
    await flush();
    expect([...grid.el.querySelectorAll('.outline-level[data-axis="col"]')].map((b) => b.textContent)).toEqual(['1', '2']);
  } finally { grid.destroy(); }
});
