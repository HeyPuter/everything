// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Cut and paste moves cells: it clears them where they were and writes them where they land. With sheets grouped,
// both writes were carried to the other sheets as typing is, so on Feb the cell under the cut was erased and Jan's
// cell was written over Feb's at the destination: Feb's "y" was gone and its "keep" became Jan's "x". The move
// now acts on the sheets it names alone, for a plain block and for cells cut from several ranges.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
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

async function mount() {
  const doc = new Doc({ name: 'Cut', path: 'Spreadsheets/Cut.xlsx' });
  const wb = doc.wb;
  const a = wb.activeSheetId;
  wb.renameSheet(a, 'Jan');
  const b = wb.addSheet('Feb').id;
  wb.setActiveSheet(a);
  ['Item', 'x', 'z', 'x2'].forEach((v, r) => wb.setInput(a, r, 0, v));
  ['Item', 'y', 'w', 'y2'].forEach((v, r) => wb.setInput(b, r, 0, v));
  wb.setInput(b, 1, 2, 'keep');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  const event = (type) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: () => '', setData() {}, files: [] } });
    return e;
  };
  const move = (from, to) => {
    view.goTo(`Jan!${from}`);
    viewport.dispatchEvent(event('cut'));
    view.goTo(`Jan!${to}`);
    viewport.dispatchEvent(event('paste'));
  };
  return { wb, a, b, move, column: (id, c) => [0, 1, 2, 3].map((r) => wb.getValue(id, r, c)) };
}

it('moves a block on the sheet in view and leaves a grouped sheet’s cells alone', async () => {
  const { wb, a, b, move, column } = await mount();
  wb.groupSheets([b]);
  move('A2:A4', 'C2');
  expect(column(a, 0)).toEqual(['Item', null, null, null]);
  expect(column(a, 2)).toEqual([null, 'x', 'z', 'x2']);
  expect(column(b, 0)).toEqual(['Item', 'y', 'w', 'y2']);
  expect(column(b, 2)).toEqual([null, 'keep', null, null]);
  expect(wb.undoLabels()).toEqual(['Move cells']);
});

it('moves the rows a filter shows on the sheet in view and leaves a grouped sheet’s cells alone', async () => {
  const { wb, a, b, move, column } = await mount();
  wb.setFilterRange(a, { r1: 0, c1: 0, r2: 3, c2: 0 });
  wb.setFilterCriteria(a, 0, { values: ['x', 'x2'] });
  expect(wb.isRowHidden(a, 2)).toBe(true);
  wb.clearHistory();
  wb.groupSheets([b]);
  move('A2:A4', 'C2');
  expect(column(a, 0)).toEqual(['Item', null, 'z', null]);
  expect([wb.getValue(a, 1, 2), wb.getValue(a, 2, 2)]).toEqual(['x', 'x2']);
  expect(column(b, 0)).toEqual(['Item', 'y', 'w', 'y2']);
  expect(column(b, 2)).toEqual([null, 'keep', null, null]);
});
