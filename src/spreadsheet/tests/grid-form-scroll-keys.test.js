// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { insertTimeline } from '../src/core/timeline.js';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';

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

// A form scroll bar on the sheet takes the keyboard once its track is clicked or tabbed to: the arrows, Page Up and
// Down, Home and End move it. Other keys went on to the grid, which acted on the cells selected behind it: Delete
// cleared them, and a letter began typing into the active cell, out of sight of someone working the scroll bar.
it('keys pressed on a form scroll bar do not reach the cells behind it', async () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'keep me');
  wb.addChart(id, { type: 'scroll', anchor: { r: 2, c: 1 }, w: 200, h: 20, min: 0, max: 100, step: 1, page: 10, value: 5, horizontal: true });
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce() {}, onCommand: (cmd) => commands.push(cmd) });
  document.body.replaceChildren(grid.el);
  await flush();
  const track = grid.el.querySelector('.form-scroll-track');
  expect(track).toBeTruthy();
  track.focus();
  for (const key of ['Delete', 'Backspace', 'x', 'F2']) track.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  expect(commands).toEqual([]);
  expect(grid.editing).toBe(false);
  // The scroll bar's own keys still move it.
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(track.getAttribute('aria-valuenow')).toBe('6');
  grid.destroy();
});

// A timeline's periods take the keyboard the same way (the arrows, Home and End, Space and Enter), and Delete on
// one cleared the cells selected behind the timeline.
it('keys pressed on a timeline period do not reach the cells behind it', async () => {
  const { wb, report, pivot } = pivotBook({ dateField: true });
  insertTimeline(wb, report.id, pivot, 2);
  const commands = [];
  const grid = createGrid({ wb, sheetId: report.id, announce() {}, onCommand: (cmd) => commands.push(cmd) });
  document.body.replaceChildren(grid.el);
  await flush();
  const tile = grid.el.querySelector('.timeline-tile[tabindex="0"]');
  expect(tile).toBeTruthy();
  tile.focus();
  for (const key of ['Delete', 'Backspace', 'x']) tile.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  expect(commands).toEqual([]);
  expect(grid.editing).toBe(false);
  grid.destroy();
});
