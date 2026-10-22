// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// With a formula open, Ctrl/Cmd+PgDn shows another sheet to pick references on. Bold, italic and the
// other formatting commands do not commit the entry (the cell is formatted mid-edit), but
// they formatted the selection of the sheet on show, a cell the user never chose, and left the cell
// being edited alone. They now format the edited cell on its own sheet, from the chord, the toolbar
// and the menu bar alike, and the entry stays open on the sheet shown.
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

/** Sheet1 (home) and Sheet2 (other), the editor on Sheet1 at `cell`. */
async function setup(cell) {
  const doc = new Doc({ name: 'Sheets', path: 'Spreadsheets/Sheets.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  wb.setActiveSheet(home);
  wb.setInput(home, 0, 0, '1');
  wb.setInput(other, 0, 0, 'x');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo(`Sheet1!${cell}`);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, home, other };
}

/** Type an open formula and press Ctrl+PgDn: the next sheet is shown with the edit still alive. */
async function formulaOnOtherSheet(wb, other) {
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=SUM(';
  editor.setSelectionRange(5, 5);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(1);
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.activeSheetId).toBe(other);
  expect(editor.hidden).toBe(false);
  return editor;
}

async function menu(...path) {
  view.el.querySelector(`[data-menu="${path[0]}"]`).click();
  for (const label of path.slice(1)) { item(label).click(); await vi.advanceTimersByTimeAsync(1); }
}

const chord = (target, key) => {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};

// A dozen menu round trips: under load the default 5 s is not always enough.
it('formats the cell being edited on its own sheet, not the selection of the sheet shown for references', { timeout: 20000 }, async () => {
  const { wb, home, other } = await setup('A4');
  const editor = await formulaOnOtherSheet(wb, other);
  const edited = () => wb.getCell(home, 3, 0)?.s || {};
  // The chord.
  expect(chord(editor, 'b')).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(edited().bold).toBe(true);
  expect(wb.getCell(other, 0, 0)?.s?.bold).toBeUndefined();
  expect(editor.hidden).toBe(false);
  expect(wb.activeSheetId).toBe(other);
  expect(document.activeElement).toBe(editor);
  // The menu bar's Format items, which run mid-edit too.
  await menu('format', 'Number', 'Percent');
  expect(edited().fmt).toBe('percent');
  await menu('format', 'Alignment', 'Center');
  expect(edited().align).toBe('center');
  await menu('format', 'Alignment', 'Top');
  expect(edited().valign).toBe('top');
  await menu('format', 'Alignment', 'Increase indent');
  expect(edited().indent).toBe(1);
  await menu('format', 'Wrapping', 'Wrap');
  expect(edited().wrap).toBe(true);
  await menu('format', 'Borders', 'All borders');
  expect(edited().bt).toBeTruthy();
  await menu('format', 'Text', 'Larger font');
  expect(edited().size).toBe(10 * 4 / 3); // the next size up from 13px (9.75pt): 10pt
  await menu('format', 'Text', 'Strikethrough');
  expect(edited().strike).toBe(true);
  await menu('format', 'Cell styles', 'Title');
  expect(edited().size).toBe(24); // Title: 18pt
  // The toolbar's Bold button toggles the edited cell as well (Title set it; the click takes it off).
  const boldBtn = [...view.el.querySelectorAll('.toolbar button')].find((b) => /^Bold/.test(b.getAttribute('aria-label') || b.title || ''));
  expect(boldBtn).toBeTruthy();
  boldBtn.click();
  await vi.advanceTimersByTimeAsync(1);
  expect(edited().bold).toBeUndefined();
  // Sheet2!A1, the selection of the sheet shown, was never touched, and the entry is still open there.
  expect(wb.getCell(other, 0, 0).s).toBeUndefined();
  expect(editor.hidden).toBe(false);
  expect(wb.activeSheetId).toBe(other);
  // Enter commits the formula on Sheet1 with the formatting kept.
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.activeSheetId).toBe(home);
  expect(wb.getCell(home, 3, 0).f).toBe('SUM()');
  expect(wb.getCell(home, 3, 0).s).toMatchObject({ fmt: 'percent', align: 'center', valign: 'top', strike: true, wrap: true });
});

it('reads the toggle state from the edited cell, so a second Ctrl+B takes bold off again', async () => {
  const { wb, home, other } = await setup('A4');
  wb.applyStyle(home, { r1: 3, c1: 0, r2: 3, c2: 0 }, { bold: true });
  wb.clearHistory();
  const editor = await formulaOnOtherSheet(wb, other);
  chord(editor, 'b');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(home, 3, 0)?.s?.bold).toBeUndefined();
  expect(wb.getCell(other, 0, 0)?.s).toBeUndefined();
  expect(wb.undoLabels()).toEqual(['Format']);
});

it('still formats the selection when nothing is being edited', async () => {
  const { wb, home } = await setup('A1');
  await menu('format', 'Text', 'Bold');
  expect(wb.getCell(home, 0, 0).s.bold).toBe(true);
});
