// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// AutoFit Column Width, AutoFit Row Height and View > Page Breaks did not finish an entry first, as Freeze Panes and
// the commands on lines do: with a formula showing another sheet to pick references on, they fitted the columns or
// rows picked there, or showed that sheet's page breaks, and left the formula open. The entry now goes in first,
// which brings the formula's sheet back, and that sheet is the one changed.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function pointingAway() {
  const doc = new Doc({ name: 'Sheets', path: 'Spreadsheets/Sheets.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  wb.setActiveSheet(home);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!B3');
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=1+';
  editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.activeSheetId).toBe(other);
  return { wb, home, other };
}

it('fits the columns of its own sheet', async () => {
  const { wb, home, other } = await pointingAway();
  for (const id of [home, other]) for (const c of [0, 1]) wb.setInput(id, 0, c, 'a fairly long piece of text here');
  view.run('autofit');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect([wb.colWidth(other, 0), wb.colWidth(other, 1)]).toEqual([100, 100]);
  expect(wb.colWidth(home, 1)).toBeGreaterThan(100);
});

it('fits the rows of its own sheet', async () => {
  const { wb, home, other } = await pointingAway();
  for (const id of [home, other]) for (const r of [0, 2]) wb.setRowHeight(id, r, 60);
  view.run('fitRows');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect([wb.rowHeight(other, 0), wb.rowHeight(other, 2)]).toEqual([60, 60]);
  expect(wb.rowHeight(home, 2)).toBeLessThan(60);
});

it('shows the page breaks of its own sheet', async () => {
  const { wb, home, other } = await pointingAway();
  view.run('showPageBreaks');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect(!!wb.sheet(other).showPageBreaks).toBe(false);
  expect(!!wb.sheet(home).showPageBreaks).toBe(true);
});
