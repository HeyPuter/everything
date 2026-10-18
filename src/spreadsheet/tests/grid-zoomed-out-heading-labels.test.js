// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// Zoomed far out a row is 2px tall and a column 6px wide, but their numbers and letters are drawn no
// smaller than 6px: every row's number piled onto its neighbours' into an unreadable smear down the row
// headings, and two-letter column names ran together. A label that does not fit its line now shows on
// every k-th line only (1, 2, 5, 10…), like a ruler; at 100% every line keeps its label.
const grids = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function ({ left, top }) { this.scrollLeft = left; this.scrollTop = top; };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
});
afterEach(() => { for (const grid of grids.splice(0)) grid.destroy(); document.body.replaceChildren(); });

const frame = () => new Promise((r) => setTimeout(r, 5));

async function mount() {
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 400, cols: 60 }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  grids.push(grid);
  document.body.append(grid.el);
  await frame();
  const rowLabels = () => Object.fromEntries([...grid.el.querySelectorAll('.grid-rowhead .hcell')].map((h) => [Number(h.dataset.r) + 1, h.textContent]));
  const colLabels = () => [...grid.el.querySelectorAll('.grid-colhead .hcell')].map((h) => h.textContent);
  return { wb, grid, rowLabels, colLabels };
}

it('labels every row and column at 100%, a narrow one too', async () => {
  const { wb, grid, rowLabels, colLabels } = await mount();
  wb.setRowHeight(wb.activeSheetId, 3, 4);
  wb.setColWidth(wb.activeSheetId, 2, 6);
  grid.refresh();
  await frame();
  const rows = rowLabels();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(rows[n]).toBe(String(n));
  expect(colLabels().slice(0, 5)).toEqual(['A', 'B', 'C', 'D', 'E']);
});

it('labels only every fifth row at 10%, instead of piling every number up', async () => {
  const { grid, rowLabels } = await mount();
  grid.setZoom(0.1);
  await frame();
  const rows = rowLabels();
  expect(Object.keys(rows).length).toBeGreaterThan(100);
  for (const [n, text] of Object.entries(rows)) expect(text).toBe(Number(n) % 5 === 0 ? n : '');
});

it('spaces out the column letters that do not fit their column', async () => {
  const { grid, colLabels } = await mount();
  grid.setZoom(0.1);
  await frame();
  // A 100px column is 10px wide at 10%: room for one 6px letter, not for two, so A to Z are all named
  // and from AA on every other column is, the rest left blank.
  const labels = colLabels();
  expect(labels.slice(0, 26).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  expect(labels.slice(26, 32)).toEqual(['', 'AB', '', 'AD', '', 'AF']);
});
