// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Workbook } from '../src/core/workbook.js';
import { Doc } from '../src/lib/doc.js';
import { parseRange } from '../src/core/cell.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { assignTips } from '../src/ui/keytips.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const key = (node, key, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Keyboard' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Item', 'Quantity', 'Price', 'Total'], ['Notebook', '3', '4.5', '=B2*C2'], ['Pencil', '6', '1.25', '=B3*C3'], ['Folder', '2', '3', '=B4*C4']]
    .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const button = label => [...view.el.querySelectorAll(`button[aria-label="${label}"]`)].find(b => !b.closest('[hidden]'));
async function select(range) {
  const name = view.el.querySelector('.name-box'); name.value = range; key(name, 'Enter'); await flush();
}
const ribbonTab = name => [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === name);

const grid = () => view.el.querySelector('.grid-viewport, [role="grid"]');
const press = (k, extra = {}) => { key(document.activeElement || document.body, k, extra); };
const altTap = () => {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true, cancelable: true }));
  document.activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true }));
};
const tips = () => [...document.querySelectorAll('.keytip')].map(t => t.textContent);
const dialogTitle = () => document.querySelector('[role="dialog"]')?.getAttribute('aria-label');

it('never gives a key tip that begins another tip on the same tab', () => {
  const names = {
    Home: ['Undo', 'Redo', 'Paste', 'Paste options', 'Cut', 'Copy', 'Paint format', 'Font: Default', 'Font size: 13', 'Bold', 'Format as currency', 'Rows', 'Columns', 'AutoSum', 'AutoSum options', 'Fill', 'Clear', 'Sort and summarize', 'Find & Select', 'Insert', 'Delete', 'Format'],
    Formulas: ['Insert function', 'AutoSum', 'AutoSum options', 'Recently Used', 'Financial functions', 'More Functions', 'Name Manager', 'Define Name', 'Create from Selection', 'Calculate Now', 'Formulas to Values'],
    Data: ['Get Data', 'Refresh All', 'Sort A to Z', 'Sort Z to A', 'Sort', 'Filter', 'Goal Seek', 'Group', 'Ungroup Rows', 'Subtotal', 'Column Stats'],
    Review: ['Spelling as You Type', 'Workbook Statistics', 'Note', 'Delete Note', 'Select notes on this sheet', 'Protect Sheet', 'Protected Ranges', 'Share', 'Version History'],
    View: ['Normal view', 'Gridlines', 'Headings', 'Show Zeros', 'Show Formulas', 'Zoom', '100%', 'Zoom to Selection', 'Freeze Panes', 'Hide & Unhide', 'Focus Mode', 'Full Screen', 'AI Assistant'],
  };
  for (const [tab, list] of Object.entries(names)) {
    const assigned = assignTips(list);
    expect(assigned.every(Boolean), tab).toBe(true);
    expect(new Set(assigned).size, tab).toBe(assigned.length);
    for (const a of assigned) for (const b of assigned) if (a !== b) expect(b.startsWith(a), `${tab}: ${a} begins ${b}`).toBe(false);
  }
  const tabTips = assignTips(['File', 'Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Table', 'Chart Design', 'Format']);
  expect(new Set(tabTips).size).toBe(tabTips.length);
  for (const a of tabTips) for (const b of tabTips) if (a !== b) expect(b.startsWith(a)).toBe(false);
});

it('works every tip out from the labels: a lone first letter is one key, a shared one takes a second key from the label', () => {
  expect(assignTips(['File', 'Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Table', 'Chart Design', 'Format']))
    .toEqual(['FI', 'H', 'I', 'DR', 'P', 'FO', 'DA', 'R', 'V', 'T', 'C', 'FR']);
  // Later words' initials come first, then the label's other letters, then digits; no letters at all, no tip.
  expect(assignTips(['Sort A to Z', 'Sort Z to A', 'Sort', 'Sort', '%', '100%'])).toEqual(['SA', 'SZ', 'SO', 'SR', null, '1']);
});

it('drives the ribbon from key tips: Alt, a tab letter, then a command letter', async () => {
  await mount(); await select('A1:D4'); grid().focus();
  altTap(); await flush();
  expect(tips()).toEqual(['FI', 'H', 'I', 'DR', 'P', 'FO', 'DA', 'R', 'V', 'A']);
  press('f'); await flush();
  expect(tips()).toEqual(['FI', 'FO']); // a shared first letter narrows to its tabs
  press('o'); await flush(); await flush();
  expect(ribbonTab('Formulas').getAttribute('aria-selected')).toBe('true');
  expect(tips()).toEqual(expect.arrayContaining(['I', 'N', 'CF', 'FT'])); // Insert function, Name Manager, Create from Selection, Formulas to Values
  press('Escape'); await flush();
  expect(tips()).toContain('H'); // back to the tabs
  press('f'); press('o'); await flush(); await flush();
  press('c'); press('f'); await flush();
  expect(dialogTitle()).toBe('Create Names from Selection');
  expect(tips()).toEqual([]);
});

it('opens key tips with F10, ignores unknown letters, and closes with Escape', async () => {
  await mount(); grid().focus();
  press('F10'); await flush();
  expect(tips()).toContain('H');
  press('q'); await flush();
  expect(tips()).toContain('H');
  press('Escape'); await flush();
  expect(tips()).toEqual([]);
});

it('runs a two-key tip and leaves key tips alone while a cell is being edited', async () => {
  const { wb, id } = await mount(); await select('B2:B4'); grid().focus();
  press('F10'); await flush(); press('h'); await flush(); await flush();
  press('f'); await flush();
  expect(tips().every(t => t.startsWith('F'))).toBe(true);
  press('p'); await flush(); // Paint format
  expect(button('Format Painter').getAttribute('aria-pressed')).toBe('true');
  press('Escape'); await flush();
  await select('F1'); grid().focus(); press('1'); await flush();
  altTap(); await flush();
  expect(tips()).toEqual([]);
  press('Escape'); await flush();
  expect(wb.getValue(id, 0, 5)).toBe(null);
});

it('supports name, table, region and ribbon shortcuts', async () => {
  const { wb, id } = await mount(); await select('B2'); grid().focus();
  press('F3', { ctrlKey: true }); await flush();
  expect(dialogTitle()).toBe('Name Manager'); closeAllModals(); await vi.advanceTimersByTimeAsync(300);
  await select('A1:D4'); grid().focus();
  press('F3', { ctrlKey: true, shiftKey: true }); await flush();
  expect(dialogTitle()).toBe('Create Names from Selection');
  document.querySelector('[role="dialog"] button[type="submit"]').click(); await flush(); await vi.advanceTimersByTimeAsync(300);
  expect(wb.names.length).toBeGreaterThan(0);
  await select('F2'); grid().focus();
  press('F3'); await flush();
  const item = [...document.querySelectorAll('.menu [role="menuitem"]')].find(b => b.textContent.includes('Price'));
  item.click(); await flush();
  button('Apply edit').click(); await flush();
  expect(wb.getCell(id, 1, 5).f).toBe('Price');
  await select('B3'); grid().focus();
  press('8', { ctrlKey: true, shiftKey: true, code: 'Digit8' }); await flush();
  expect(view.el.querySelector('.name-box').value).toBe('A1:D4');
  press('l', { ctrlKey: true }); await flush();
  expect(dialogTitle()).toMatch(/table/i); closeAllModals(); await vi.advanceTimersByTimeAsync(300);
  grid().focus();
  press('F1', { ctrlKey: true }); await flush();
  expect(view.el.querySelector('.ribbon').classList.contains('ribbon-collapsed')).toBe(true);
  press('F1', { ctrlKey: true }); await flush();
  expect(view.el.querySelector('.ribbon').classList.contains('ribbon-collapsed')).toBe(false);
});

it('keeps Paint format on after a double-click until Escape', async () => {
  const { wb, id } = await mount(); await select('A1');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
  const paint = button('Format Painter');
  paint.click(); paint.click(); paint.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await flush();
  expect(paint.getAttribute('aria-pressed')).toBe('true');
  await select('B2'); key(grid(), 'Enter'); await flush();
  expect(wb.getCell(id, 1, 1).s?.bold).toBe(true);
  expect(paint.getAttribute('aria-pressed')).toBe('true');
  await select('C3'); key(grid(), 'Enter'); await flush();
  expect(wb.getCell(id, 2, 2).s?.bold).toBe(true);
  key(grid(), 'Escape'); await flush();
  expect(paint.getAttribute('aria-pressed')).toBe('false');
  await select('D4'); key(grid(), 'Enter'); await flush();
  expect(wb.getCell(id, 3, 3)?.s?.bold).toBeFalsy();
});

it('expands and collapses the formula bar with Ctrl+Shift+U, also mid-entry', async () => {
  await mount(); await select('A1'); grid().focus();
  const bar = view.el.querySelector('.formula-bar');
  const was = bar.classList.contains('expanded');
  press('U', { ctrlKey: true, shiftKey: true }); await flush();
  expect(bar.classList.contains('expanded')).toBe(!was);
  press('7'); await flush();
  press('U', { ctrlKey: true, shiftKey: true }); await flush();
  expect(bar.classList.contains('expanded')).toBe(was);
  expect(view.el.querySelector('.status-mode').textContent).toBe('Enter');
});

it('picks an entry from the column with Pick from drop-down list, and offers Define name in the cell menu', async () => {
  const { wb, id } = await mount(); await select('A5');
  grid().focus(); press('F10', { shiftKey: true }); await flush();
  const item = label => [...document.querySelectorAll('.menu [role="menuitem"]')].find(b => b.textContent.trim().startsWith(label));
  expect(item('Pick From Drop-down List')).toBeTruthy();
  item('Pick From Drop-down List').click(); await flush();
  const entries = [...document.querySelectorAll('.menu [role="menuitem"]')].map(b => b.textContent.trim());
  expect(entries).toEqual(['Folder', 'Item', 'Notebook', 'Pencil']);
  [...document.querySelectorAll('.menu [role="menuitem"]')].find(b => b.textContent.trim() === 'Pencil').click(); await flush();
  expect(wb.getValue(id, 4, 0)).toBe('Pencil');
});
