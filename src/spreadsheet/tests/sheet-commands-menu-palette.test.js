// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';
import { paletteCommands } from '../src/ui/palette.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

// Renaming, duplicating, moving, colouring, protecting, hiding and deleting a sheet lived in the sheet
// tab's menu alone. The Insert menu's Sheet submenu and the palette now offer them for the active sheet,
// through the editor's commands, greyed as the tab menu greys them; the tab menu's Rename and Delete go
// through the same commands, so an open cell edit is committed before either asks.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

const sheetLeaves = (flags) => menuLeaves(menubarMenus(flags).find((m) => m.id === 'insert').items.find((it) => it.label === 'Sheet').submenu);
const leaf = (flags, label) => sheetLeaves(flags).find((it) => it.label === label);

describe('menu and palette definitions', () => {
  it('offer every tab-menu action for the active sheet, greyed as the tab menu greys them', () => {
    const lone = { sheet: { only: true, first: true, last: true, protected: false, holdsWork: false } };
    expect(sheetLeaves(lone).map((it) => it.label)).toEqual(['New sheet', 'Duplicate sheet', 'Move or Copy sheet…', 'Copy sheet to another spreadsheet…', 'Rename sheet…', 'Sheet color…', 'Move sheet left', 'Move sheet right', 'Protect sheet', 'Hide sheet', 'Delete sheet', 'Select all sheets']);
    for (const label of ['Move sheet left', 'Move sheet right', 'Hide sheet', 'Delete sheet', 'Select all sheets']) expect(leaf(lone, label).disabled, label).toBe(true);
    for (const label of ['Rename sheet…', 'Duplicate sheet', 'Move or Copy sheet…', 'Sheet color…', 'Protect sheet']) expect(leaf(lone, label).disabled, label).toBeFalsy();
    const middle = { sheet: { only: false, first: false, last: false, protected: true, holdsWork: true } };
    for (const label of ['Move sheet left', 'Move sheet right', 'Hide sheet', 'Delete sheet…']) expect(leaf(middle, label).disabled, label).toBeFalsy();
    expect(leaf(middle, 'Unprotect sheet')).toBeTruthy();
    expect(leaf(middle, 'Delete sheet…').danger).toBe(true);
    // Without the flags (as the menu definitions are listed on their own) nothing is greyed.
    expect(sheetLeaves({}).filter((it) => it.disabled)).toEqual([]);
  });

  it('list the sheet actions in the palette and leave out what the tab menu greys', () => {
    const labels = (flags) => paletteCommands(flags).filter((c) => /sheet/i.test(c.label) && c.section === 'Insert').map((c) => c.label);
    expect(labels({})).toEqual(['New sheet', 'Duplicate sheet', 'Move or Copy sheet…', 'Copy sheet to another spreadsheet…', 'Rename sheet…', 'Sheet color…', 'Move sheet left', 'Move sheet right', 'Protect sheet', 'Hide sheet', 'Delete sheet', 'Select all sheets']);
    expect(labels({ sheet: { only: true, first: true, last: true, protected: true, holdsWork: true } })).toEqual(['New sheet', 'Duplicate sheet', 'Move or Copy sheet…', 'Copy sheet to another spreadsheet…', 'Rename sheet…', 'Sheet color…', 'Unprotect sheet']);
  });
});

describe('the editor', () => {
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
  afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
  const dialog = (title) => document.querySelector(`.modal-panel[aria-label='${title}']`);
  const dialogButton = (text) => [...document.querySelectorAll('.modal-panel button')].find((b) => b.textContent === text);

  /** Sheet1 holds a value, Sheet2 is empty; the editor starts on Sheet1. */
  async function setup() {
    const doc = new Doc({ name: 'Tabs', path: 'Spreadsheets/Tabs.xlsx' });
    const wb = doc.wb;
    const first = wb.activeSheetId;
    const second = wb.addSheet('Sheet2').id;
    wb.setInput(first, 0, 0, 'work');
    wb.setActiveSheet(first);
    wb.clearHistory();
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.querySelector('#app').append(view.el);
    await vi.advanceTimersByTimeAsync(1);
    const menu = async (...path) => {
      view.el.querySelector(`[data-menu="${path[0]}"]`).click();
      for (const label of path.slice(1)) { item(label).click(); await vi.advanceTimersByTimeAsync(1); }
    };
    const open = async () => { view.el.querySelector('[data-menu="insert"]').click(); item('Sheet').click(); await vi.advanceTimersByTimeAsync(1); };
    return { wb, first, second, menu, open };
  }

  it('renames, duplicates, moves, protects and colours the active sheet from the Insert menu', async () => {
    const { wb, first, menu, open } = await setup();
    await menu('insert', 'Sheet', 'Rename sheet…');
    expect(dialog('Rename sheet')).toBeTruthy();
    const input = document.querySelector('.modal-panel input');
    input.value = 'Budget';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialogButton('Rename').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheet(first).name).toBe('Budget');

    await menu('insert', 'Sheet', 'Duplicate sheet');
    expect(wb.sheets).toHaveLength(3);
    wb.setActiveSheet(first);
    await vi.advanceTimersByTimeAsync(1);

    await open();
    expect(item('Move sheet left').disabled).toBe(true); // first among the tabs
    item('Move sheet right').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheets.indexOf(wb.sheet(first))).toBe(1);

    await menu('insert', 'Sheet', 'Protect sheet');
    expect(wb.sheet(first).protected).toBe(true);
    await open();
    expect(item('Unprotect sheet')).toBeTruthy();
    expect(item('Protect sheet')).toBeUndefined();
    closeMenu();

    await menu('insert', 'Sheet', 'Sheet color…');
    const swatch = document.querySelector('[role="menu"][aria-label="Tab color"] .swatch[title="#c22a2a"]');
    expect(swatch).toBeTruthy();
    swatch.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheet(first).color).toBe('#c22a2a');
  });

  it('hides and deletes the active sheet, asking first only when it holds work, and greys both for the last sheet', async () => {
    const { wb, first, second, menu, open } = await setup();
    // Sheet2 is empty: Delete sheet goes at once, with no question.
    wb.setActiveSheet(second);
    await vi.advanceTimersByTimeAsync(1);
    await open();
    expect(item('Delete sheet')).toBeTruthy();
    expect(item('Delete sheet…')).toBeUndefined();
    item('Delete sheet').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.modal-panel')).toBeNull();
    expect(wb.sheets.map((s) => s.id)).toEqual([first]);
    // The last sheet showing can be neither hidden nor deleted.
    await open();
    expect(item('Hide sheet').disabled).toBe(true);
    expect(item('Delete sheet…').disabled).toBe(true);
    closeMenu();
    wb.addSheet('Sheet3');
    wb.setActiveSheet(first);
    await vi.advanceTimersByTimeAsync(1);
    // Sheet1 holds work: the question comes first, and No keeps the sheet.
    await menu('insert', 'Sheet', 'Delete sheet…');
    expect(dialog('Delete "Sheet1"?')).toBeTruthy();
    dialogButton('Cancel').click();
    await vi.advanceTimersByTimeAsync(400);
    expect(wb.sheets).toHaveLength(2);
    await menu('insert', 'Sheet', 'Delete sheet…');
    dialogButton('Delete sheet').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet3']);
    wb.undo();
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet3']);
    // Hide sheet from the menu.
    wb.setActiveSheet(first);
    await vi.advanceTimersByTimeAsync(1);
    await menu('insert', 'Sheet', 'Hide sheet');
    expect(wb.sheet(first).hidden).toBe(true);
    expect(wb.visibleSheets.map((s) => s.name)).toEqual(['Sheet3']);
  });

  it('runs the sheet actions from the palette, and commits an open edit before the tab menu renames', async () => {
    const { wb, first } = await setup();
    const viewport = view.el.querySelector('.grid-viewport');
    viewport.focus();
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    const input = document.querySelector('.palette-input');
    input.value = 'Duplicate sheet';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheets).toHaveLength(3);
    // An entry left open is committed before the tab menu's Rename asks, as before it duplicates.
    wb.setActiveSheet(first);
    await vi.advanceTimersByTimeAsync(1);
    view.goTo('Sheet1!B1');
    await vi.advanceTimersByTimeAsync(1);
    viewport.focus();
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
    const editor = view.el.querySelector('.grid-editor');
    editor.value = 'hello';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    view.el.querySelector('.tab-menu-btn').click();
    item('Rename…').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(first, 0, 1)).toBe('hello');
    expect(dialog('Rename sheet')).toBeTruthy();
  });
});
