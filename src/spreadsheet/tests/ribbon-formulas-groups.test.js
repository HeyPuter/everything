// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Workbook } from '../src/core/workbook.js';
import { Doc } from '../src/lib/doc.js';
import { parseRange } from '../src/core/cell.js';
import { closeAllModals } from '../src/ui/modal.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { closeMenu } from '../src/ui/menu.js';
import { borderSnapshot } from '../src/core/border-regions.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const key = (node, key, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Formulas ribbon groups' }); const wb = doc.wb; const id = wb.activeSheetId;
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

const menuItem = label => [...document.querySelectorAll('.menu [role^="menuitem"]')].find(b => b.querySelector('.menu-label')?.firstChild?.textContent === label);
const openTab = async name => { ribbonTab(name).click(); await flush(); };

it('opens Function Arguments from a Function Library category and remembers the function as recently used', async () => {
  const { wb, id } = await mount(); await select('E2'); await openTab('Formulas');
  button('Financial functions').click(); await flush();
  expect(menuItem('PMT')).toBeTruthy(); expect(menuItem('SUM')).toBeFalsy();
  menuItem('PMT').click(); await flush();
  const dialog = document.querySelector('[role="dialog"][aria-label="Function Arguments"]');
  const field = label => dialog.querySelector(`input[aria-label="${label}"]`);
  field('rate').value = '0.05/12'; field('rate').dispatchEvent(new Event('input'));
  field('periods').value = '36'; field('periods').dispatchEvent(new Event('input'));
  field('present_value').value = '-10000'; field('present_value').dispatchEvent(new Event('input'));
  expect(dialog.querySelector('.fn-args-result').textContent).toMatch(/Formula result = 299\.7/);
  dialog.querySelector('button[type="submit"]').click(); await flush();
  expect(wb.getCell(id, 1, 4).f).toBe('PMT(0.05/12, 36, -10000)');
  expect(wb.getValue(id, 1, 4)).toBeCloseTo(299.71, 2);
  button('Recently Used').click(); await flush();
  const first = [...document.querySelectorAll('.menu [role^="menuitem"]')][0];
  expect(first.textContent).toContain('PMT');
});

it('finds functions in Insert Function by search and category, then fills their arguments', async () => {
  const { wb, id } = await mount(); await select('F2'); await openTab('Formulas');
  button('Lookup & Reference functions').click(); await flush();
  menuItem('Insert Function…').click(); await flush();
  const dialog = document.querySelector('[role="dialog"][aria-label="Insert Function"]');
  const category = dialog.querySelector('select[aria-label="Or select a category"]');
  category.value = 'Math & Trig'; category.dispatchEvent(new Event('change'));
  expect([...dialog.querySelectorAll('[role="option"]')].map(o => o.textContent)).toContain('SUMIF');
  const search = dialog.querySelector('input[aria-label="Search for a function"]');
  search.value = 'round'; key(search, 'Enter');
  const options = [...dialog.querySelectorAll('[role="option"]')].map(o => o.textContent);
  expect(options).toEqual(expect.arrayContaining(['ROUND', 'ROUNDUP', 'ROUNDDOWN']));
  dialog.querySelector('[role="option"]').click();
  expect(dialog.querySelector('.fn-dialog-signature').textContent).toMatch(/^[A-Z.]+\(/);
  [...dialog.querySelectorAll('[role="option"]')].find(o => o.textContent === 'ROUND').click();
  expect(dialog.querySelector('.fn-dialog-signature').textContent).toBe('ROUND(number, [digits])');
  dialog.querySelector('button[type="submit"]').click(); await flush();
  const args = document.querySelector('[role="dialog"][aria-label="Function Arguments"]');
  args.querySelector('input[aria-label="number"]').value = 'C3'; args.querySelector('input[aria-label="number"]').dispatchEvent(new Event('input'));
  expect(args.querySelector('.fn-args-value').textContent).toBe('= 1.25');
  args.querySelector('input[aria-label="number"]').value = 'B2:B4'; args.querySelector('input[aria-label="number"]').dispatchEvent(new Event('input'));
  expect(args.querySelector('.fn-args-value').textContent).toBe('= {3;6;2}');
  args.querySelector('input[aria-label="number"]').value = '"text"'; args.querySelector('input[aria-label="number"]').dispatchEvent(new Event('input'));
  expect(args.querySelector('.fn-args-value').textContent).toBe('= "text"');
  args.querySelector('input[aria-label="number"]').value = 'C3'; args.querySelector('input[aria-label="number"]').dispatchEvent(new Event('input'));
  args.querySelector('input[aria-label="digits"]').value = '1'; args.querySelector('input[aria-label="digits"]').dispatchEvent(new Event('input'));
  args.querySelector('button[type="submit"]').click(); await flush();
  expect(wb.getCell(id, 1, 5).f).toBe('ROUND(C3, 1)');
  expect(wb.getValue(id, 1, 5)).toBe(1.3);
});

it('offers AutoSum choices beside the AutoSum command', async () => {
  const { wb, id } = await mount(); await select('B2:B4'); await openTab('Formulas');
  button('AutoSum options').click(); await flush();
  expect(['Sum', 'Average', 'Count Numbers', 'Max', 'Min'].every(label => menuItem(label))).toBe(true);
  menuItem('Average').click(); await flush();
  expect(wb.getCell(id, 4, 1).f).toBe('AVERAGE(B2:B4)');
  expect(wb.getValue(id, 4, 1)).toBeCloseTo(11 / 3);
});

it('defines names from a selection in one undoable step and uses them in a formula', async () => {
  const { wb, id } = await mount(); await select('A1:D4'); await openTab('Formulas');
  button('Create from Selection').click(); await flush();
  const dialog = document.querySelector('[role="dialog"][aria-label="Create Names from Selection"]');
  expect(dialog).toBeTruthy();
  const box = label => [...dialog.querySelectorAll('label')].find(l => l.textContent === label).querySelector('input');
  expect(box('Top row').checked).toBe(true); expect(box('Left column').checked).toBe(true);
  box('Left column').click(); box('Left column').dispatchEvent(new Event('change'));
  dialog.querySelector('button[type="submit"]').click(); await flush();
  expect(wb.names.map(n => n.name).sort()).toEqual(['Item', 'Price', 'Quantity', 'Total']);
  expect(wb.names.find(n => n.name === 'Total').ref).toBe('Sheet1!$D$2:$D$4');
  await select('F1');
  button('Use in Formula').click(); await flush();
  menuItem('Total').click(); await flush();
  button('Apply edit').click(); await flush();
  expect(wb.getCell(id, 0, 5).f).toBe('Total');
  wb.undo(); wb.undo(); await flush();
  expect(wb.names).toEqual([]);
});

it('opens only the New Name dialog from Define Name', async () => {
  const { wb } = await mount(); await select('D2:D4'); await openTab('Formulas');
  button('Define Name').click(); await flush();
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  expect(dialogs.map(d => d.getAttribute('aria-label'))).toEqual(['New Name']);
  const form = dialogs[0];
  form.querySelector('input[aria-label="Name"]').value = 'LineTotals';
  expect(form.querySelector('input[aria-label="Refers to"]').value).toBe('Sheet1!$D$2:$D$4');
  form.querySelector('button[type="submit"]').click(); await flush();
  expect(wb.names).toEqual([{ name: 'LineTotals', ref: 'Sheet1!$D$2:$D$4' }]);
  await vi.advanceTimersByTimeAsync(300);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('removes trace highlights and selects error cells from Formula Auditing', async () => {
  const { wb, id } = await mount(); wb.setInput(id, 5, 0, '=1/0'); await select('D2'); await openTab('Formulas');
  button('Trace Precedents').click(); await flush();
  expect(view.el.querySelectorAll('.find-hl').length).toBeGreaterThan(0);
  button('Remove Arrows').click(); await flush();
  expect(view.el.querySelectorAll('.find-hl').length).toBe(0);
  button('Error Checking').click(); await flush();
  expect(view.el.querySelector('.name-box').value).toBe('A6');
  expect(button('Watch Window').disabled).toBe(false);
});

it('stores Page Layout choices in the sheet print settings with undo and XLSX round trip', async () => {
  const { wb, id } = await mount(); await select('A1:D4'); await openTab('Page Layout');
  button('Orientation').click(); await flush(); menuItem('Landscape').click(); await flush();
  button('Margins').click(); await flush(); menuItem('Narrow').click(); await flush();
  button('Size').click(); await flush(); menuItem('A4').click(); await flush();
  button('Width').click(); await flush(); menuItem('1 page').click(); await flush();
  button('Print Gridlines').click(); await flush();
  button('Print Area').click(); await flush(); menuItem('Set Print Area').click(); await flush();
  const p = wb.sheet(id).printSettings;
  expect(p).toMatchObject({ orientation: 'landscape', paperSize: 9, fitToPage: true, fitWidth: 1, fitHeight: 0, gridlines: true, areas: [parseRange('A1:D4')] });
  expect(p.margins).toMatchObject({ left: 0.25, right: 0.25, top: 0.75 });
  expect(button('Print Gridlines').getAttribute('aria-pressed')).toBe('true');
  button('Orientation').click(); await flush();
  expect(menuItem('Landscape').getAttribute('aria-checked')).toBe('true'); closeMenu();
  const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'page-layout.xlsx');
  expect(back.sheet(back.activeSheetId).printSettings).toMatchObject({ orientation: 'landscape', paperSize: 9, fitToPage: true, fitWidth: 1, fitHeight: 0, gridlines: true, areas: [parseRange('A1:D4')] });
  wb.undo(); await flush(); expect(wb.sheet(id).printSettings.areas).toEqual([]);
  button('Print Area').click(); await flush(); menuItem('Clear Print Area').click(); await flush();
  expect(wb.sheet(id).printSettings.gridlines).toBe(true);
});

it('inserts the chart subtype picked in a chart gallery and opens the sparkline dialog preset to the chosen type', async () => {
  const { wb, id } = await mount(); await select('A1:B4'); await openTab('Insert');
  button('Insert line chart').click(); await flush();
  document.querySelector('.menu .chart-gallery-tile[aria-label="Line with Markers"]').click(); await flush(); await flush();
  expect(wb.sheet(id).charts).toHaveLength(1);
  expect(wb.sheet(id).charts[0]).toMatchObject({ type: 'line', title: 'Quantity', w: 480, h: 288 });
  expect(ribbonTab('Chart Design').getAttribute('aria-selected')).toBe('true');
  key(view.el.querySelector('.grid-viewport') || document.activeElement, 'Escape'); await flush();
  await openTab('Insert');
  await select('E2:E4');
  button('Insert win/loss sparklines').click(); await flush();
  expect(document.querySelector('select[aria-label="Chart type"]').value).toBe('stacked');
  expect(button('WordArt').disabled).toBe(false); // WordArt, Shapes, Icons and Equation are offered
  expect(button('Equation').disabled).toBe(false);
});

it('zooms to fit the selection in the visible grid', async () => {
  await mount(); await select('A1:B2'); await openTab('View');
  button('Zoom to Selection').click(); await flush();
  const percent = [...view.el.querySelectorAll('.statusbar *, .status-bar *')].map(n => n.textContent).find(t => /^\d+%$/.test(t));
  expect(parseInt(percent, 10)).toBeGreaterThan(100);
});

it('lays out Home with large primary commands and Paste, Format and Find & Select menus', async () => {
  const { wb, id } = await mount(); await select('A1:D4');
  for (const label of ['Paste', 'Conditional formatting', 'Format as Table', 'Cell styles', 'Sort & Filter', 'Find & Select']) {
    expect(button(label).classList.contains('ribbon-large'), label).toBe(true);
  }
  button('Paste options').click(); await flush();
  expect(menuItem('Values')).toBeTruthy(); expect(menuItem('Transpose')).toBeTruthy(); expect(menuItem('Paste Special…')).toBeTruthy(); closeMenu();
  button('Format').click(); await flush();
  expect([...document.querySelectorAll('.menu .menu-header')].map(h => h.textContent)).toEqual(['Cell Size', 'Visibility', 'Organize Sheets', 'Protection']);
  menuItem('AutoFit Column Width').click(); await flush();
  expect(wb.colWidth(id, 0)).not.toBe(100);
  button('Find & Select').click(); await flush();
  expect(['Find…', 'Replace…', 'Go To…', 'Go To Special', 'Formulas', 'Notes', 'Constants'].every(label => menuItem(label))).toBe(true);
  menuItem('Formulas').click(); await flush();
  expect(view.el.querySelector('.name-box').value).toBe('D2:D4');
  await select('A1:D4');
  button('Sort & Filter').click(); await flush();
  menuItem('Filter').click(); await flush();
  expect(wb.filterAt(id, 1, 1)).toBeTruthy();
});

it('adds quick conditional formatting rules from the Home drop-down and clears them from the selection', async () => {
  const { wb, id } = await mount(); await select('B2:B4');
  button('Conditional formatting').click(); await flush();
  menuItem('Highlight Cells Rules').click(); await flush();
  menuItem('Greater Than…').click(); await flush();
  const dialog = document.querySelector('[role="dialog"][aria-label="Greater Than"]');
  expect(dialog.querySelector('input').value).toBe('3.67'); // the selection's average, as a starting point
  dialog.querySelector('input').value = '2.5';
  dialog.querySelector('button[type="submit"]').click(); await flush();
  expect(wb.sheet(id).rules).toEqual([expect.objectContaining({ type: 'gt', value: 2.5, range: parseRange('B2:B4') })]);
  button('Conditional formatting').click(); await flush();
  menuItem('Data Bars').click(); await flush();
  menuItem('Green data bar').click(); await flush();
  expect(wb.sheet(id).rules.map(r => r.type)).toEqual(['gt', 'databar']);
  await select('B3');
  button('Conditional formatting').click(); await flush();
  menuItem('Clear Rules').click(); await flush();
  menuItem('Clear Rules from Selected Cells').click(); await flush();
  expect(wb.sheet(id).rules.map(r => r.range)).toEqual([parseRange('B2'), parseRange('B4'), parseRange('B2'), parseRange('B4')]);
  wb.undo(); await flush();
  expect(wb.sheet(id).rules.map(r => r.range)).toEqual([parseRange('B2:B4'), parseRange('B2:B4')]);
});

it('offers fixed borders and More borders in the Borders menu', async () => {
  const { wb, id } = await mount(); await select('A1:D1');
  button('Borders').click(); await flush();
  menuItem('Bottom double border').click(); await flush();
  // The menu's pens draw each side with its own pen, so read the sides a cell shows rather than its stored style.
  const pen = (r, c) => {
    const s = borderSnapshot(wb.styleAt(id, r, c));
    return Object.fromEntries(['bt', 'bb', 'bl', 'br'].map(k => [k, s[k] ? s[`${k}Border`]?.bs || s.bs || 'thin' : null]));
  };
  expect(pen(0, 1)).toMatchObject({ bb: 'double' });
  await select('A2:D4');
  button('Borders').click(); await flush();
  menuItem('Thick outside borders').click(); await flush();
  expect(pen(1, 0)).toMatchObject({ bt: 'thick', bl: 'thick' });
  expect(pen(2, 1).bt).toBeNull();
  button('Borders').click(); await flush();
  menuItem('More borders…').click(); await flush();
  expect(document.querySelector('[role="dialog"] [role="tab"][aria-selected="true"]')?.textContent).toBe('Border');
});
