// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

// The strip across a heading's edge that resizes the line is 9px (grid.css), 4px of it reaching into the
// next line. Zoomed to 50% a row is 10px tall, so its own strip and the one of the row above covered all of
// it: pressing a row's number started a resize instead of selecting the row, at 50% and below. A line
// shorter than the strip needs now gets a strip about a third of its size, so its middle selects it.
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
  const wb = new Workbook({ sheets: [{ name: 'Data', rows: 200, cols: 40 }] });
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} });
  grids.push(grid);
  document.body.append(grid.el);
  await frame();
  return { wb, grid };
}

/** The part of a row heading its strips take, from its bottom (its own) and from its top (the row above's), in px. */
function stripsOver(grid, r) {
  const own = grid.el.querySelector(`.grid-rowhead .row-resizer[data-r="${r}"]`);
  const above = grid.el.querySelector(`.grid-rowhead .row-resizer[data-r="${r - 1}"]`);
  // grid.css: 9px tall, 4px below the edge.
  const size = (node) => ({ height: parseFloat(node.style.height || '9'), below: -parseFloat(node.style.bottom || '-4') });
  const o = size(own), a = size(above);
  return { bottom: o.height - o.below, top: a.below };
}

it('leaves the middle of a short row heading free for the press that selects the row', async () => {
  const { grid } = await mount();
  for (const zoom of [0.5, 0.33, 0.25]) {
    grid.setZoom(zoom);
    await frame();
    const height = parseFloat(grid.el.querySelector('.grid-rowhead .hcell[data-r="7"]').style.height);
    const { bottom, top } = stripsOver(grid, 7);
    expect(top + bottom).toBeLessThan(height / 2);
    expect(bottom).toBeGreaterThanOrEqual(0);
  }
});

it('keeps the stylesheet strips where the lines are tall enough for them', async () => {
  const { grid } = await mount();
  await frame();
  const rowStrip = grid.el.querySelector('.grid-rowhead .row-resizer[data-r="7"]');
  const colStrip = grid.el.querySelector('.grid-colhead .col-resizer[data-c="3"]');
  expect(rowStrip.style.height).toBe('');
  expect(rowStrip.style.bottom).toBe('');
  expect(colStrip.style.width).toBe('');
  // Zoomed out to 25% a 100px column is still 25px wide: room for its 9px strip.
  grid.setZoom(0.25);
  await frame();
  expect(grid.el.querySelector('.grid-colhead .col-resizer[data-c="3"]').style.width).toBe('');
});
