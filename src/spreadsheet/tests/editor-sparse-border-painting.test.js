// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Exercise selection intent and large border gestures through the real menus.
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

const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);

async function setup(range, ranges = null) {
  const doc = new Doc({ name: 'Borders', path: 'Spreadsheets/Borders.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.ensureSize(id, 1000, 80);
  if (ranges) wb.setSheetSelection(id, { active: { r: 0, c: 2 }, ranges, activeRange: ranges.length - 1 });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  if (range) select(range);
  return { wb, id };
}
function select(range) {
  const name = view.el.querySelector('.name-box'); name.value = range;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}
async function border(label) {
  view.el.querySelector('[data-menu="format"]').click();
  for (const text of ['Borders', label]) { item(text).click(); await vi.advanceTimersByTimeAsync(1); }
}
it('paints the distant edge through the actual editor without truncating the selection', async () => {
  const { wb, id } = await setup('B2:BS801');
  await border('All borders');
  expect(wb.styleAt(id, 800, 70)).toMatchObject({ bt: true, bb: true, bl: true, br: true });
  expect(wb.styleAt(id, 801, 70)?.br).toBeFalsy();
  expect(wb.activeSheet.cells.size).toBe(0);
  wb.undo(); expect(wb.styleAt(id, 800, 70)?.br).toBeFalsy();
});
it('distinguishes whole columns from a finite range with the same allocated bounds', async () => {
  const { wb, id } = await setup('C:E');
  await border('Outer borders');
  expect(wb.styleAt(id, 800000, 2)?.bl).toBe(true);
  expect(wb.styleAt(id, 0, 2)?.bt).toBeFalsy();
  expect(wb.activeSheet.viewSelection.ranges[0].r2).toBe(1048575);
  wb.undo(); select('C1:E1000');
  await border('Outer borders');
  expect(wb.styleAt(id, 0, 2)?.bt).toBe(true);
  expect(wb.styleAt(id, 999, 4)?.bb).toBe(true);
  expect(wb.styleAt(id, 800000, 2)?.bl).toBeFalsy();
  expect(wb.activeSheet.viewSelection.ranges[0].r2).toBe(999);
});
it('excludes filtered-out rows from a column border gesture', async () => {
  const { wb, id } = await setup('C:E');
  wb.setInput(id, 999, 0, 'last'); // the list's last row: an empty end of the sheet is given back, and filtered columns are bordered as far as the sheet goes
  wb.activeSheet.filterHidden.add(500);
  await border('All borders');
  expect(wb.styleAt(id, 499, 3)?.br).toBe(true);
  expect(wb.styleAt(id, 500, 3)?.br).toBeFalsy();
  expect(wb.styleAt(id, 999, 3)?.br).toBe(true);
  expect(wb.styleAt(id, 1000, 3)?.br).toBeFalsy();
});

it('refuses every selected area when a whole-column border would reach a protected future cell', async () => {
  const { wb } = await setup(null, [{ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 2, r2: 1048575, c2: 2 }]);
  wb.activeSheet.protectedRanges.push({ id: 'future', range: { r1: 3000, c1: 2, r2: 3000, c2: 2 } });
  const before = wb.toJSON();
  await border('All borders');
  expect(wb.toJSON()).toEqual(before);
});
