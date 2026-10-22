// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// The quick sort from a single cell kept a header row in place only when the
// sorted column held text over numbers, so sorting a text column moved "Name"
// in among the names. The block around the cell is now read for a header the way
// the sort dialog reads it; an explicit selection keeps its first row only when
// a text row sits over typed values, so a plain list of names still sorts whole.
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
import { insertTableSlicers } from '../src/core/slicer-insert.js';
import { slicerTarget } from '../src/core/slicer.js';
import { workbookToXlsx } from '../src/core/io.js';
import { tableFilterButtonOn } from '../src/core/table-header-row.js';

// Data ▸ Filter (Ctrl+Shift+L) in a table removed the table's filter outright. A slicer on the table filters through
// that filter, so it was left unbound ("The linked table column is unavailable") and every save failed; and a table
// whose buttons were hidden from Table Design ▸ Filter Button lost its filter instead of getting the buttons back.
// In a table the command now shows or hides the buttons, as Excel's does, and hiding them shows every row.
async function mount() {
  const doc = new Doc({ name: 'Filter', path: 'Spreadsheets/Filter.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  [['Region', 'V'], ['East', '1'], ['West', '2'], ['East', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A2');
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, table: wb.sheet(id).tables[0] };
}

it('hides and shows a table’s filter buttons, keeping its slicer working and the workbook saveable', async () => {
  const { wb, id, table } = await mount();
  const [slicer] = insertTableSlicers(wb, id, table.id, ['Region']);
  wb.setFilterCriteria(id, 0, { values: ['East'] }, wb.filterAt(id, 0, 0));
  expect([...wb.sheet(id).filterHidden]).toEqual([2]);
  await view.run('filter');
  expect(tableFilterButtonOn(wb, id, table)).toBe(false);
  expect([...wb.sheet(id).filterHidden]).toEqual([]);
  expect(slicerTarget(wb, wb.chartById(id, slicer))).toBeTruthy();
  await expect(workbookToXlsx(wb)).resolves.toBeTruthy();
  await view.run('filter');
  expect(tableFilterButtonOn(wb, id, table)).toBe(true);
  wb.undo(); wb.undo();
  expect(tableFilterButtonOn(wb, id, table)).toBe(true);
  expect([...wb.sheet(id).filterHidden]).toEqual([2]);
});

// The Filter command read as on (ticked in the Data menu, "Remove Filter" in the cell menu) for a table whose
// buttons are hidden, such as the filter a slicer adds; it now reads as off there, since the command shows them.
it('shows the Filter command as off for a table whose buttons are hidden', async () => {
  const { wb, id, table } = await mount();
  insertTableSlicers(wb, id, table.id, ['Region']); // the slicer filters through the table's own filter
  await view.run('filter'); // hide the buttons
  const filterItem = async () => {
    view.el.querySelector('[data-menu="data"]').click();
    await vi.advanceTimersByTimeAsync(1);
    const item = [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === 'Filter');
    const checked = item?.getAttribute('aria-checked');
    closeMenu();
    return checked;
  };
  expect(tableFilterButtonOn(wb, id, table)).toBe(false);
  expect(await filterItem()).toBe('false');
  await view.run('filter');
  expect(tableFilterButtonOn(wb, id, table)).toBe(true);
  expect(await filterItem()).toBe('true');
});
