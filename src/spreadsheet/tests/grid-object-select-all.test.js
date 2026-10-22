// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Ctrl+A with a text box (or chart) selected selected every cell of the sheet behind it while the object still
// looked selected over them: Delete then removed the object, typing went to A1. It selects every object on the
// sheet now, as in Excel, leaving out those hidden in the Selection Pane.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const pe = (target, type) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5, pointerId: 1, button: 0 }));

it('selects every object shown, not the cells, when one is selected', async () => {
  const wb = new Workbook(), id = wb.sheets[0].id;
  const a = wb.addChart(id, { type: 'text', text: 'One', anchor: { r: 2, c: 1 }, w: 120, h: 60 });
  const b = wb.addChart(id, { type: 'text', text: 'Two', anchor: { r: 2, c: 4 }, w: 120, h: 60 });
  const c = wb.addChart(id, { type: 'text', text: 'Hidden', anchor: { r: 9, c: 1 }, w: 120, h: 60, hidden: true });
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.replaceChildren(grid.el);
  await flush();
  const box = grid.el.querySelector(`.chart-box[data-chart="${a}"]`);
  pe(box, 'pointerdown'); pe(box, 'pointerup');
  await flush();
  const before = grid.range;
  const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
  grid.viewport.dispatchEvent(event);
  await flush();
  expect(event.defaultPrevented).toBe(true);
  expect(grid.selectedCharts.sort()).toEqual([a, b].sort());
  expect(grid.selectedCharts).not.toContain(c);
  expect(grid.range).toEqual(before);
  grid.destroy();
});
