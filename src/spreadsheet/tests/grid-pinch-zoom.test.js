// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

/** A touch event as a browser sends it: `fingers` are [x, y, target] for each finger still down. */
const touchEvent = (target, type, fingers) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: fingers.map(([clientX, clientY, t]) => ({ clientX, clientY, target: t })) });
  target.dispatchEvent(e);
  return e;
};

function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (let r = 0; r < 30; r++) wb.setInput(id, r, 2, `C${r + 1}`);
  const zooms = [];
  const grid = createGrid({ wb, sheetId: id, onZoom: (z) => zooms.push(z) });
  document.body.replaceChildren(grid.el);
  vi.runOnlyPendingTimers();
  return { grid, wb, zooms };
}

// Pinching the sheet on a phone zoomed the whole page (toolbar, tabs and all) and left the sheet at its zoom.
describe('a two-finger pinch on the grid', () => {
  it('zooms the sheet by the spread of the fingers, one step a frame, ending at their last spread', () => {
    const { grid, wb, zooms } = setup();
    const cell = grid.el.querySelector('#gc-3-2');
    touchEvent(cell, 'touchstart', [[100, 100, cell]]);
    touchEvent(cell, 'touchstart', [[100, 100, cell], [200, 100, cell]]);
    // The zoom draws the cells again: the cell the fingers began on leaves the page, yet its events still count.
    const move = touchEvent(cell, 'touchmove', [[90, 100, cell], [240, 100, cell]]);
    expect(move.defaultPrevented).toBe(true); // the browser's own pinch-zoom of the page is held off
    const version = wb.version;
    vi.runOnlyPendingTimers();
    expect(grid.zoom).toBe(1.5);
    // The sheet's saved view takes the zoom when the fingers lift, not at every step of the pinch.
    expect(wb.version).toBe(version);
    vi.runOnlyPendingTimers();
    expect(cell.isConnected).toBe(false);
    touchEvent(cell, 'touchmove', [[80, 100, cell], [280, 100, cell]]);
    touchEvent(cell, 'touchend', [[80, 100, cell]]);
    expect(grid.zoom).toBe(2);
    expect(zooms.at(-1)).toBe(2);
    expect(wb.sheets[0].viewZoom).toBe(2);
    // A finger left down after the pinch moves nothing.
    touchEvent(cell, 'touchmove', [[20, 100, cell]]);
    vi.runOnlyPendingTimers();
    expect(grid.zoom).toBe(2);
    grid.destroy();
  });

  it('stays within the zoom range and leaves one finger to the browser', () => {
    const { grid } = setup();
    const cell = grid.el.querySelector('#gc-3-2');
    touchEvent(cell, 'touchstart', [[100, 100, cell], [110, 100, cell]]);
    touchEvent(cell, 'touchmove', [[100, 100, cell], [900, 100, cell]]);
    touchEvent(cell, 'touchend', []);
    expect(grid.zoom).toBe(4);
    const one = grid.el.querySelector('.cell');
    touchEvent(one, 'touchstart', [[100, 100, one]]);
    const scroll = touchEvent(one, 'touchmove', [[100, 40, one]]);
    expect(scroll.defaultPrevented).toBe(false);
    vi.runOnlyPendingTimers();
    expect(grid.zoom).toBe(4);
    grid.destroy();
  });

  it('keeps the spot between the fingers where it was', () => {
    const { grid, wb } = setup();
    const s = wb.sheets[0];
    const scrolls = [];
    grid.viewport.scrollTo = ({ left, top }) => scrolls.push([left, top]);
    const cell = grid.el.querySelector('#gc-3-2');
    // Midway between the fingers: 300px across (part way into column E) and 200px down, the top of row 11.
    touchEvent(cell, 'touchstart', [[250, 200, cell], [350, 200, cell]]);
    touchEvent(cell, 'touchmove', [[200, 200, cell], [400, 200, cell]]);
    touchEvent(cell, 'touchend', []);
    expect(grid.zoom).toBe(2);
    // Each line is drawn at its size times the zoom, rounded: the same line, the same part of it, under the same spot.
    const at = (size, pos, z) => { const one = Math.round(size), line = Math.floor(pos / one); return Math.round(line * Math.round(size * z) + ((pos - line * one) / one) * Math.round(size * z)); };
    expect(scrolls.at(-1)).toEqual([at(s.defaultColWidth, 300, 2) - 300, at(s.defaultRowHeight, 200, 2) - 200]);
    grid.destroy();
  });

  it('leaves no pinch of the page itself over the cells', () => {
    const css = readFileSync(new FileURL('../src/styles/grid.css', import.meta.url), 'utf8');
    const rule = css.match(/\n\.grid-viewport \{[^}]*\}/)[0];
    expect(rule).toMatch(/touch-action:\s*pan-x pan-y/);
  });
});
