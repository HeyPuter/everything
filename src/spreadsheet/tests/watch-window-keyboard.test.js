// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createWatchWindow } from '../src/ui/watchwindow.js';

// The Watch Window's rows took the keyboard's focus and did nothing with it: no key picked a row, went to its
// cell or took the watch away, so Delete Watch and Go To were the mouse's alone. A click on a row drew the list
// again and took the focus with it, as did every change to the workbook while a row had it.
afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 1 } }, { r: 1, c: 0, cell: { v: 2 } }, { r: 2, c: 0, cell: { v: null, f: 'A1+A2' } }]);
  wb.addWatches(id, [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }]);
  let refresh = () => {};
  const went = [];
  const win = createWatchWindow({ wb, subscribe: (fn) => { refresh = fn; return () => {}; }, grid: { focus() {} },
    run() {}, docName: () => 'Book', goTo: (sid, r, c) => went.push([sid, r, c]) });
  document.body.append(win.el);
  win.show();
  return { wb, id, win, went, refresh: () => refresh() };
}
const rows = (win) => [...win.el.querySelectorAll('tbody tr')];
const key = (target, k, opts = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

it('moves between rows with the arrow keys, picks one with Space and removes it with Delete', () => {
  const { wb, win } = mount();
  rows(win)[0].focus();
  key(document.activeElement, 'ArrowDown');
  expect(document.activeElement).toBe(rows(win)[1]);
  key(document.activeElement, ' ');
  expect(rows(win)[1].getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(rows(win)[1]);
  key(document.activeElement, 'Delete');
  expect(wb.watches.map((w) => w.r)).toEqual([0, 2]);
  expect(document.activeElement?.closest('tbody')).toBeTruthy();
});

it('goes to the watched cell with Enter', () => {
  const { id, win, went } = mount();
  rows(win)[2].focus();
  key(document.activeElement, 'Enter');
  expect(went).toEqual([[id, 2, 0]]);
});

it('keeps the focus on its row when a click picks it or the workbook changes', () => {
  const { wb, id, win, refresh } = mount();
  rows(win)[1].focus();
  rows(win)[1].click();
  expect(document.activeElement).toBe(rows(win)[1]);
  expect(rows(win)[1].getAttribute('aria-selected')).toBe('true');
  wb.setInput(id, 0, 0, '5');
  refresh();
  expect(document.activeElement).toBe(rows(win)[1]);
});

it('keeps the picked watch picked when rows are inserted above its cell', () => {
  const { wb, id, win, refresh } = mount();
  rows(win)[0].click();
  wb.insertRows(id, 0, 1);
  refresh();
  expect(rows(win)[0].getAttribute('aria-selected')).toBe('true');
  win.el.querySelectorAll('.watch-actions button')[1].click();
  expect(wb.watches.map((w) => w.r)).toEqual([2, 3]);
});
