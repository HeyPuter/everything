// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Collapse or Expand all groups, Gridlines and Show zeros act on the sheet in view, but did not finish an entry
// first, as Freeze Panes and the other commands on lines do: with a formula showing another sheet to pick references
// on, they changed that sheet and left the formula open. The entry now goes in first, and its own sheet changes.
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

async function pointingAway(grouped = false, collapsed = false) {
  const doc = new Doc({ name: 'Sheets', path: 'Spreadsheets/Sheets.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  if (grouped) for (const id of [home, other]) { wb.groupLines(id, 'row', 4, 5); if (collapsed) wb.setAllGroups(id, 'row', true); }
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

it.each([
  ['gridlines', undefined, (wb, id) => wb.sheet(id).gridlines === false],
  ['zeros', undefined, (wb, id) => wb.sheet(id).zeros === false],
  ['collapseAll', 'row', (wb, id) => wb.isRowHidden(id, 4)],
])('%s enters the formula and changes its own sheet', async (cmd, arg, changed) => {
  const { wb, home, other } = await pointingAway(cmd === 'collapseAll');
  view.run(cmd, arg);
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect(changed(wb, other)).toBe(false);
  expect(changed(wb, home)).toBe(true);
});

it('expands every group on its own sheet', async () => {
  const { wb, home, other } = await pointingAway(true, true);
  view.run('expandAll', 'row');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect(wb.isRowHidden(home, 4)).toBe(false);
  expect(wb.isRowHidden(other, 4)).toBe(true);
});
