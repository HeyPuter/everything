// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { heightForLines } from '../src/core/textfit.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });


// Automatic rows were fitted at 1.3 lines of their largest font plus 8px, so in a new spreadsheet (11 point Calibri,
// 20px rows) a row of plain 11 point text measured 27px: a row grown for 28 point and set back to 11 settled 7px
// taller than its neighbours, and 12 point made a 29px row where Excel's is 21px. Rows now take Excel's heights:
// a line is 1.3 times its size, rounded up to a whole pixel, and a blank cell in a larger font counts too.
const pt = (points) => points * 4 / 3;

async function open() {
  const doc = Doc.blank({ excel: true });
  const { wb } = doc;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Plain');
  wb.setInput(id, 1, 0, 'Two');
  wb.setInput(id, 1, 1, 'Sizes');
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const size = async (ref, points) => { view.goTo(`Sheet1!${ref}`); view.run('fontSize', pt(points)); await vi.advanceTimersByTimeAsync(1); };
  return { wb, id, size };
}

it('fits automatic rows to Excel heights for each font size', async () => {
  const { wb, id, size } = await open();
  expect(wb.rowHeight(id, 0)).toBe(20);
  await size('A1', 28);
  expect(wb.rowHeight(id, 0)).toBe(49);
  await size('A1', 11);
  expect(wb.rowHeight(id, 0)).toBe(20); // back to the height of the rows around it
  await size('A1', 12);
  expect(wb.rowHeight(id, 0)).toBe(21);
  // The largest font in a row sets it.
  await size('B2', 20);
  expect(wb.rowHeight(id, 1)).toBe(35);
  await size('A2', 14);
  expect(wb.rowHeight(id, 1)).toBe(35);
  await size('B2', 11);
  expect(wb.rowHeight(id, 1)).toBe(25);
  // A blank cell in a large font makes room for its entry.
  await size('C5', 28);
  expect(wb.rowHeight(id, 4)).toBe(49);
  await size('C5', 11);
  expect(wb.rowHeight(id, 4)).toBe(20);
});

it('fits wrapped and multi-line text at 20px a line of 11 point', async () => {
  const { wb, id } = await open();
  wb.setInput(id, 3, 0, 'one\ntwo');
  wb.applyStyle(id, { r1: 3, c1: 0, r2: 3, c2: 0 }, { wrap: true });
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A4');
  view.run('fitRows');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.rowHeight(id, 3)).toBe(40);
});
