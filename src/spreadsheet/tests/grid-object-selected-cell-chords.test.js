// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// A chart inserted from a range is selected over that range, which stays selected behind it out of sight. The
// cell chords went on acting on those cells: Ctrl+D filled the chart's headers down over its own data, Ctrl+R
// filled them right, Ctrl+B and Ctrl+U formatted them, Ctrl+; wrote today's date in, all where nothing showed it.
// Ctrl+D now duplicates the object, as in Excel, and the chords that change cells do nothing while it is selected.
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
const chord = (target, k, code, init = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, code, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};

function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'Region'); wb.setInput(id, 0, 1, 'Sales');
  wb.setInput(id, 1, 0, 'North'); wb.setInput(id, 1, 1, '10');
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd, arg) => commands.push([cmd, arg]) });
  document.body.replaceChildren(grid.el);
  return { wb, id, grid, commands, viewport: grid.el.querySelector('.grid-viewport') };
}

it('duplicates a selected chart with Ctrl+D and leaves the cells behind it to the other cell chords', async () => {
  const { wb, id, grid, viewport, commands } = setup();
  grid.setSelection({ anchor: { r: 0, c: 0 }, focus: { r: 1, c: 1 }, active: { r: 0, c: 0 } });
  const chartId = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 0, c: 3 }, w: 200, h: 120 });
  await flush();
  grid.selectChart(chartId);
  chord(viewport, 'd', 'KeyD');
  expect(commands).toEqual([['duplicateChart', { id: chartId }]]);
  commands.length = 0;
  for (const [k, code, init] of [['r', 'KeyR'], ['b', 'KeyB'], ['i', 'KeyI'], ['u', 'KeyU'], ['k', 'KeyK'], ['e', 'KeyE'], ['t', 'KeyT'],
    ['2', 'Digit2'], ['5', 'Digit5'], ['9', 'Digit9'], ['0', 'Digit0'], ['-', 'Minus'], [';', 'Semicolon'], ["'", 'Quote'],
    ['$', 'Digit4', { shiftKey: true }], ['!', 'Digit1', { shiftKey: true }], ['+', 'Equal', { shiftKey: true }], ['>', 'Period', { shiftKey: true }]]) {
    expect(chord(viewport, k, code, init)).toBe(true);
  }
  expect(commands).toEqual([]);
  expect(grid.selectedChart).toBe(chartId);
  expect(wb.getValue(id, 1, 0)).toBe('North');
  // Undo, find and the formula bar's chord still work; a plain Ctrl+= is left to the browser's zoom.
  chord(viewport, 'z', 'KeyZ');
  chord(viewport, 'f', 'KeyF');
  chord(viewport, 'U', 'KeyU', { shiftKey: true });
  expect(commands.map(([cmd]) => cmd)).toEqual(['undo', 'find', 'toggleFormulaBar']);
  expect(chord(viewport, '=', 'Equal')).toBe(false);
  // With the chart let go, the chords are the cells' again.
  grid.selectChart(null);
  commands.length = 0;
  chord(viewport, 'd', 'KeyD');
  chord(viewport, 'b', 'KeyB');
  expect(commands.map(([cmd]) => cmd)).toEqual(['fillDown', 'bold']);
  grid.destroy();
});

it('leaves AutoSum, Repeat and the drop-down list to the cells while a chart is selected', async () => {
  const { wb, id, grid, viewport, commands } = setup();
  const chartId = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 0, c: 3 }, w: 200, h: 120 });
  await flush();
  grid.selectChart(chartId);
  const press = (k, code, init = {}) => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...init }));
  press('=', 'Equal', { altKey: true });
  press('F4', 'F4');
  press('ArrowDown', 'ArrowDown', { altKey: true });
  expect(commands).toEqual([]);
  expect(grid.selectedChart).toBe(chartId);
  // Shift+F4 still finds the next match.
  press('F4', 'F4', { shiftKey: true });
  expect(commands.map(([cmd]) => cmd)).toEqual(['findNext']);
  grid.selectChart(null);
  commands.length = 0;
  press('=', 'Equal', { altKey: true });
  press('F4', 'F4');
  expect(commands.map(([cmd]) => cmd)).toEqual(['autosum', 'repeat']);
  grid.destroy();
});
