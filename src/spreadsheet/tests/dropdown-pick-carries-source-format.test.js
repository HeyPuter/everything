// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A dropdown drawn from cells of dates, amounts or percentages lists them as those cells show them
// (2024-01-15, $5.50, 12.5%), but the number picked landed bare in a General cell: the cell read 45306,
// 5.5 and 0.125. Excel enters the option as if its text were typed, so the cell reads as the list did. A
// picked number now brings its source cell's number format into a cell that has none of its own.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

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

async function pick(r, label) {
  view.goTo(`Sheet1!A${r + 1}`);
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector('.grid-viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const item = [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
  expect(item, label).toBeTruthy();
  item.click();
  await vi.advanceTimersByTimeAsync(1);
}

it('shows a picked date, amount or percentage the way the list showed it', async () => {
  const doc = new Doc({ name: 'Picks', path: 'Spreadsheets/Picks.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  const lists = wb.addSheet('Lists').id;
  ['2024-01-15', '$5.50', '12.5%', 'Other', '7'].forEach((text, r) => wb.setInput(lists, r, 0, text));
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 9, c2: 0 }, type: 'list', source: 'Lists!$A$1:$A$5' });
  // A cell with a number format of its own keeps it.
  wb.applyStyle(id, { r1: 5, c1: 0, r2: 5, c2: 0 }, { fmt: 'number', dec: 3 });
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  wb.setActiveSheet(id);
  await vi.advanceTimersByTimeAsync(1);

  await pick(0, '2024-01-15');
  await pick(1, '$5.50');
  await pick(2, '12.50%');
  await pick(3, 'Other');
  await pick(4, '7');
  await pick(5, '$5.50');
  expect([0, 1, 2, 3, 4, 5].map((r) => wb.getValue(id, r, 0))).toEqual([45306, 5.5, 0.125, 'Other', 7, 5.5]);
  expect([0, 1, 2, 3, 4, 5].map((r) => wb.getDisplay(id, r, 0))).toEqual(['2024-01-15', '$5.50', '12.50%', 'Other', '7', '5.500']);
  // The pick and its format are one step.
  wb.undo();
  wb.undo();
  wb.undo();
  wb.undo();
  expect(wb.getValue(id, 1, 0)).toBe(5.5);
  wb.undo();
  expect(wb.getCell(id, 1, 0)).toBeUndefined();
  expect(wb.getDisplay(id, 0, 0)).toBe('2024-01-15');
});
