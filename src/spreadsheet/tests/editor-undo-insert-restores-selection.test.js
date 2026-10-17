// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Insert rows (or columns) leaves the new lines selected. Undoing the step took the lines out and
// left that whole-line selection where they had been, so the cells the user had selected before
// the insert had to be found again. Undo now puts the selection back where it was, and
// redoing the step selects the inserted lines again.
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

async function mount() {
  const doc = new Doc({ name: 'Undo', path: 'Spreadsheets/Undo.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 6; r++) wb.setInput(id, r, 1, String(r + 1));
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const menu = async (...path) => {
    view.el.querySelector(`[data-menu="${path[0]}"]`).click();
    for (const label of path.slice(1)) { item(label).click(); await vi.advanceTimersByTimeAsync(1); }
  };
  const goTo = async (range) => { view.goTo(`Sheet1!${range}`); await vi.advanceTimersByTimeAsync(1); };
  const selected = () => view.el.querySelector('.status-left .status-item').textContent;
  return { wb, id, menu, goTo, selected };
}

it('puts the selection back where it was when Insert rows is undone, and on the rows again when it is redone', async () => {
  const { wb, id, menu, goTo, selected } = await mount();
  await goTo('B3:B4');
  const before = selected();
  await menu('insert', 'Rows and columns', 'Row above');
  expect(wb.getValue(id, 2, 1)).toBeNull();
  const after = selected();
  expect(after).not.toBe(before);
  await menu('edit', 'Undo');
  expect(wb.getValue(id, 2, 1)).toBe(3);
  expect(selected()).toBe(before);
  await menu('edit', 'Redo');
  expect(wb.getValue(id, 2, 1)).toBeNull();
  expect(selected()).toBe(after);
  await menu('edit', 'Undo');
  expect(selected()).toBe(before);
});

// Delete rows and Delete columns leave a single cell selected where the lines were; undoing brought the
// lines back but left that one cell selected, so the rows just restored had to be picked out again.
it('puts the deleted rows back under the selection when Delete rows is undone, and clears it again on redo', async () => {
  const { wb, id, menu, goTo, selected } = await mount();
  await goTo('B3:B4');
  const before = selected();
  await menu('edit', 'Delete', 'Rows');
  expect(wb.getValue(id, 2, 1)).toBe(5);
  const after = selected();
  expect(after).not.toBe(before);
  await menu('edit', 'Undo');
  expect(wb.getValue(id, 2, 1)).toBe(3);
  expect(selected()).toBe(before);
  await menu('edit', 'Redo');
  expect(selected()).toBe(after);
});

it('does the same for Delete columns', async () => {
  const { wb, id, menu, goTo, selected } = await mount();
  await goTo('B2:B3');
  const before = selected();
  await menu('edit', 'Delete', 'Columns');
  expect(wb.getValue(id, 1, 1)).toBeNull();
  await menu('edit', 'Undo');
  expect(wb.getValue(id, 1, 1)).toBe(2);
  expect(selected()).toBe(before);
});

it('does the same for Insert columns, and shows the cell when a cell edit is undone', async () => {
  const { wb, id, menu, goTo, selected } = await mount();
  await goTo('B2');
  const before = selected();
  await menu('insert', 'Rows and columns', 'Column left');
  expect(wb.getValue(id, 1, 2)).toBe(2);
  await menu('edit', 'Undo');
  expect(wb.getValue(id, 1, 1)).toBe(2);
  expect(selected()).toBe(before);
  // A cell edit undone after moving away: the cell it changed is selected, as in Excel.
  wb.setInput(id, 4, 3, 'x');
  await goTo('D1');
  await menu('edit', 'Undo');
  expect(wb.getValue(id, 4, 3)).toBeNull();
  expect(selected()).toBe('D5');
});
