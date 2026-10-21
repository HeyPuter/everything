// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Add Watch, Circle Invalid Data, Zoom to Selection, Split, Headings, Tab Color and Move sheet left/right act on the sheet in
// view, but did not finish an entry first, as Freeze Panes and the other commands on lines do: with a formula showing
// another sheet to pick references on, they acted on that sheet (or, for Split, on a mix of the two) and left the
// formula open. The entry now goes in first, and its own sheet is the one acted on.
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

async function pointingAway(setup) {
  const doc = new Doc({ name: 'Sheets', path: 'Spreadsheets/Sheets.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  setup?.(wb, home, other);
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

const entered = (wb, home) => {
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect(wb.activeSheetId).toBe(home);
};

it('Add Watch watches the cell the formula went into', async () => {
  const { wb, home } = await pointingAway();
  await view.run('addWatch');
  entered(wb, home);
  expect(wb.watches).toEqual([{ sheetId: home, r: 2, c: 1 }]);
});

it('Circle Invalid Data circles the invalid cells of the formula\'s sheet', async () => {
  const rule = { range: { r1: 0, c1: 0, r2: 9, c2: 0 }, type: 'number', min: 0, max: 10 };
  const { wb, home } = await pointingAway((wb, home, other) => {
    wb.setInput(home, 0, 0, '50'); wb.addValidation(home, rule);
    wb.setInput(other, 0, 0, '7'); wb.addValidation(other, rule);
  });
  await view.run('circleInvalid');
  await vi.advanceTimersByTimeAsync(20);
  entered(wb, home);
  expect(view.el.querySelectorAll('.invalid-circle')).toHaveLength(1);
});

it('Zoom to Selection fits the cell the formula went into', async () => {
  const { wb, home } = await pointingAway((wb, home, other) => wb.setColWidth(other, 0, 2000));
  await view.run('zoomSelection');
  entered(wb, home);
  expect(Number(localStorage.getItem('spreadsheet:zoom'))).toBeGreaterThan(1);
});

it('Split splits the formula\'s sheet, whatever the sheet showing had', async () => {
  const { wb, home, other } = await pointingAway((wb, home, other) => wb.setSplit(other, { x: 100, y: 100, r: 0, c: 0 }));
  await view.run('split');
  entered(wb, home);
  expect(wb.sheet(home).split).toBeTruthy();
  expect(wb.sheet(other).split).toBeTruthy();
});

it('Tab Color offers the colours of the formula\'s sheet', async () => {
  const { wb, home } = await pointingAway();
  await view.run('sheetColor');
  entered(wb, home);
});

it('Move sheet right moves the formula\'s sheet', async () => {
  const { wb, home, other } = await pointingAway();
  await view.run('moveSheet', 'right');
  entered(wb, home);
  expect(wb.sheets.map((s) => s.id)).toEqual([other, home]);
});

it('Headings hides the headings of the formula\'s sheet', async () => {
  const { wb, home, other } = await pointingAway();
  await view.run('toggleHeaders');
  entered(wb, home);
  expect(wb.sheet(other).headers).not.toBe(false);
  expect(wb.sheet(home).headers).toBe(false);
});
