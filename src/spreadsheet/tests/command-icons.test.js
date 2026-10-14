// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { COMMAND_ICONS, commandIcon } from '../src/ui/command-icons.js';
import { icon } from '../src/ui/icons.js';

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
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Chrome' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Item', 'Total'], ['Notebook', '3'], ['Pencil', '6']].forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const tab = name => [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === name);
const ribbonButton = label => [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === label) || null;
const menuItem = label => [...document.querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label')?.textContent === label);

it('draws every command icon as shapes and outlined letters, with no text to be read out', () => {
  for (const name of Object.keys(COMMAND_ICONS)) {
    const host = document.createElement('div');
    host.innerHTML = commandIcon(name, 20);
    const svg = host.firstElementChild;
    expect(svg.getAttribute('aria-hidden'), name).toBe('true');
    expect(svg.querySelector('text'), name).toBeNull();
    expect(host.textContent, name).toBe('');
    expect(svg.children.length, name).toBeGreaterThan(0);
  }
  // Commands use the drawn set; interface glyphs keep their plain line icons.
  expect(icon('paste', 20)).toContain('class="ico"');
  expect(icon('chevD', 12)).not.toContain('class="ico"');
  expect(icon('back', 20)).not.toContain('class="ico"');
});

it('keeps one drawing per icon name, so no later entry silently replaces an earlier one', () => {
  const source = readFileSync('src/ui/command-icons.js', 'utf8');
  const names = [...source.slice(source.indexOf('export const COMMAND_ICONS')).matchAll(/^ {2}([A-Za-z0-9]+):/gm)].map(m => m[1]);
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  // The Table tab's Header Row and Power Query's Use First Row as Headers are different pictures.
  expect(COMMAND_ICONS.headerRow).not.toBe(COMMAND_ICONS.promoteHeaders);
});

it('gives each ribbon command a drawn icon, whatever tab it is on', async () => {
  await mount();
  for (const name of ['Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View']) {
    tab(name).click(); await flush();
    const panel = [...view.el.querySelectorAll('.ribbon [role="tabpanel"]')].find(p => !p.hidden);
    const commands = [...panel.querySelectorAll('button.ribbon-command:not(.ribbon-split-arrow), button.ribbon-large')]
      .filter(b => !['AI Assistant'].includes(b.getAttribute('aria-label')));
    expect(commands.length, name).toBeGreaterThan(3);
    for (const b of commands) expect(b.querySelector('svg.ico'), `${name}: ${b.getAttribute('aria-label')}`).not.toBeNull();
  }
});

it('names every labelled ribbon command with the words it shows (WCAG 2.5.3)', async () => {
  await mount();
  const words = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const name of ['Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View']) {
    tab(name).click(); await flush();
    const panel = [...view.el.querySelectorAll('.ribbon [role="tabpanel"]')].find(p => !p.hidden);
    for (const b of panel.querySelectorAll('button')) {
      const label = b.querySelector('.ribbon-button-label')?.textContent;
      if (label) expect(words(b.getAttribute('aria-label') || ''), `${name}: ${label}`).toContain(words(label));
    }
  }
});

it('draws the commands of one ribbon group as different pictures', async () => {
  await mount();
  for (const name of ['Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View']) {
    tab(name).click(); await flush();
    const panel = [...view.el.querySelectorAll('.ribbon [role="tabpanel"]')].find(p => !p.hidden);
    for (const group of panel.querySelectorAll('.ribbon-group')) {
      const seen = new Map();
      // A colour button's face and its palette arrow are one command.
      for (const b of group.querySelectorAll('button.tb-btn:not(.tb-color-arrow)')) {
        const drawing = b.querySelector('svg.ico')?.innerHTML;
        if (!drawing) continue;
        const label = b.getAttribute('aria-label');
        expect(seen.get(drawing), `${name} ▸ ${group.getAttribute('aria-label')}: ${label}`).toBeUndefined();
        seen.set(drawing, label);
      }
    }
  }
});

it('puts Save, Undo and Redo in the title row and the menus beside them, as a desktop window does', async () => {
  const { wb, id } = await mount();
  const header = view.el.querySelector('.editor-header');
  const qat = header.querySelector('.quick-access');
  expect([...qat.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))).toEqual(['AutoSave', 'Save', 'Undo', 'Undo history', 'Redo', 'Customize Quick Access Toolbar']);
  expect(header.querySelector('.menubar [data-menu="file"]')).not.toBeNull();
  expect(view.el.querySelector('.ribbon-home [aria-label="Undo"]')).toBeNull();
  wb.setInput(id, 3, 0, 'Folder'); await flush();
  const undo = qat.querySelector('[aria-label="Undo"]');
  expect(undo.disabled).toBe(false);
  // Each is a tab stop, as AutoSave and Save are: the Home toolbar's roving tab stop does not reach this row.
  expect([...qat.querySelectorAll('button')].map(b => b.tabIndex)).toEqual([0, 0, 0, 0, 0, 0]);
  view.el.querySelector('.ribbon-home .tb-btn:not([disabled])').focus();
  view.el.querySelector('.ribbon-home').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  expect(undo.tabIndex).toBe(0);
  undo.click(); await flush();
  expect(wb.getValue(id, 3, 0)).toBe(null);
});

it('lists the undo history from the arrow beside Undo and undoes down to the step picked', async () => {
  const { wb, id } = await mount();
  const arrow = view.el.querySelector('.quick-access [aria-label="Undo history"]');
  wb.clearHistory();
  wb.setInput(id, 3, 0, 'One'); wb.setInput(id, 4, 0, 'Two'); wb.setInput(id, 5, 0, 'Three'); await flush();
  expect(arrow.disabled).toBe(false);
  arrow.click(); await flush();
  const items = [...document.querySelectorAll('.menu-item .menu-label')].map(n => n.textContent);
  expect(items).toHaveLength(3);
  [...document.querySelectorAll('.menu-item')][1].click(); await flush();
  expect([wb.getValue(id, 3, 0), wb.getValue(id, 4, 0), wb.getValue(id, 5, 0)]).toEqual(['One', null, null]);
});

it('names the Home commands and lists the number formats in order', async () => {
  await mount();
  for (const label of ['Format Painter', 'Orientation', 'Accounting Number Format', 'Comma Style', 'Insert', 'Delete', 'Format', 'Clear', 'Find & Select']) {
    expect(ribbonButton(label), label).not.toBeNull();
  }
  expect(view.el.querySelector('.ribbon-home .tb-fmt-label').textContent).toBe('General');
  view.el.querySelector('.ribbon-home .tb-fmt').click(); await flush();
  const labels = [...document.querySelectorAll('.menu-item .menu-label')].map(n => n.textContent);
  expect(labels.slice(0, 11)).toEqual(['General', 'Number', 'Currency', 'Accounting', 'Short Date', 'Long Date', 'Time', 'Percentage', 'Fraction', 'Scientific', 'Text']);
});

it('inserts and deletes sheet rows and columns from the Cells group', async () => {
  const { wb, id } = await mount();
  view.goTo('A2'); await flush();
  ribbonButton('Insert').click(); await flush();
  expect(['Insert Cells…', 'Insert Sheet Rows', 'Insert Sheet Columns', 'Insert Sheet'].every(menuItem)).toBe(true);
  menuItem('Insert Sheet Rows').click(); await flush();
  expect(wb.getValue(id, 1, 0)).toBe(null);
  expect(wb.getValue(id, 2, 0)).toBe('Notebook');
  ribbonButton('Delete').click(); await flush();
  menuItem('Delete Sheet Rows').click(); await flush();
  expect(wb.getValue(id, 1, 0)).toBe('Notebook');
  ribbonButton('Insert').click(); await flush();
  const sheets = wb.sheets.length;
  menuItem('Insert Sheet').click(); await flush();
  expect(wb.sheets.length).toBe(sheets + 1);
});

it('clears all, notes or links from the Clear menu, each as one undo step', async () => {
  const { wb, id } = await mount();
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 2, c2: 1 }, { bold: true });
  wb.setNote(id, 1, 0, 'Check stock');
  wb.setInput(id, 2, 0, 'https://example.com');
  view.goTo('A2:B3'); await flush();
  const clear = async label => { ribbonButton('Clear').click(); await flush(); menuItem(label).click(); await flush(); };
  expect(wb.linkAt(id, 2, 0)).toBeTruthy();
  await clear('Clear Hyperlinks');
  expect(wb.linkAt(id, 2, 0)).toBeFalsy();
  expect(wb.getValue(id, 2, 0)).toBe('https://example.com');
  await clear('Clear Comments and Notes');
  expect(wb.getNote(id, 1, 0)).toBe(null);
  wb.undo();
  expect(wb.getNote(id, 1, 0)).toBe('Check stock');
  await clear('Clear All');
  expect([wb.getValue(id, 1, 0), wb.getValue(id, 1, 1), wb.getCell(id, 1, 0)?.s, wb.getNote(id, 1, 0)]).toEqual([null, null, undefined, null]);
  wb.undo();
  expect([wb.getValue(id, 1, 0), wb.getCell(id, 1, 0).s.bold, wb.getNote(id, 1, 0)]).toEqual(['Notebook', true, 'Check stock']);
});

it('opens the cell menu on a right-click, with Insert… and Delete… by how the cells move', async () => {
  const { wb, id } = await mount();
  view.goTo('A2'); await flush();
  const cell = view.el.querySelector('.cell[data-r="1"][data-c="0"]');
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 40, button: 2 }));
  await flush();
  const top = [...document.querySelectorAll('.menu:not(.submenu) > .menu-item .menu-label, .menu:not(.submenu) .menu-item .menu-label')].map(n => n.textContent);
  const order = ['Cut', 'Copy', 'Paste', 'Paste Special', 'Insert…', 'Delete…', 'Clear Contents', 'Filter', 'Sort', 'New Note', 'Format Cells…', 'Pick From Drop-down List…', 'Define Name…', 'Link…'];
  expect(top.filter(label => order.includes(label))).toEqual(order);
  menuItem('Insert…').click(); await flush();
  // The right-click selects the cell under the pointer; the inserted cell goes in there, pushing the column down.
  const r = Number(/\d+/.exec(document.querySelector('.name-box, [aria-label="Name Box"]').value)[0]) - 1;
  const before = [0, 1, 2, 3].map(row => wb.getValue(id, row, 0));
  const beside = wb.getValue(id, r, 1);
  menuItem('Shift cells down').click(); await flush();
  expect(wb.getValue(id, r, 0)).toBe(null);
  expect(wb.getValue(id, r + 1, 0)).toBe(before[r]);
  expect(wb.getValue(id, r, 1)).toBe(beside); // only the selected column shifts
});

it('inserts a symbol from Insert ▸ Symbol into the active cell, and remembers it among the recently used', async () => {
  const { wb, id } = await mount();
  view.goTo('C1'); await flush();
  tab('Insert').click(); await flush();
  ribbonButton('Symbol').click(); await flush();
  const dialog = document.querySelector('.symbol-dialog');
  const search = dialog.querySelector('input[type="search"]');
  search.value = 'euro'; search.dispatchEvent(new Event('input', { bubbles: true }));
  const euro = [...dialog.querySelectorAll('.symbol-grid .symbol-cell')].find(b => b.textContent === '€');
  euro.click();
  dialog.requestSubmit(); await flush();
  const editor = view.el.querySelector('.grid-editor');
  expect(editor.value ?? editor.textContent).toBe('€');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush();
  expect(wb.getValue(id, 0, 2)).toBe('€');
  expect(JSON.parse(localStorage.getItem('spreadsheet:recent-symbols'))[0]).toBe('€');
});

it('keeps watched cells in the Watch Window, current as they change, and saves the list with the workbook', async () => {
  const { wb, id } = await mount();
  view.goTo('B2:B3'); await flush();
  tab('Formulas').click(); await flush();
  ribbonButton('Watch Window').click(); await flush();
  const win = view.el.querySelector('.watch-window');
  expect(win.hidden).toBe(false);
  [...win.querySelectorAll('button')].find(b => b.textContent.includes('Add Watch')).click(); await flush();
  const rows = () => [...win.querySelectorAll('tbody tr')].map(tr => [...tr.children].slice(1).map(td => td.textContent));
  expect(rows()).toEqual([['Sheet1', '', 'B2', '3', ''], ['Sheet1', '', 'B3', '6', '']]);
  wb.setInput(id, 1, 1, '=2*5'); await flush();
  expect(rows()[0]).toEqual(['Sheet1', '', 'B2', '10', '=2*5']);
  expect(wb.toJSON().watches).toEqual([{ sheetId: id, r: 1, c: 1 }, { sheetId: id, r: 2, c: 1 }]);
  win.querySelector('tbody tr').click(); await flush();
  [...win.querySelectorAll('button')].find(b => b.textContent === 'Delete Watch').click(); await flush();
  expect(rows().map(r => r[2])).toEqual(['B3']);
});

it('shows Page Break Preview from View and the status bar, with each printed page numbered', async () => {
  const { wb, id } = await mount();
  for (let r = 0; r < 120; r++) wb.setInput(id, r, 0, `Row ${r + 1}`);
  await flush();
  tab('View').click(); await flush();
  ribbonButton('Page Break Preview').click(); await flush();
  const layer = view.el.querySelector('.grid-pages');
  expect(layer.hidden).toBe(false);
  const labels = [...layer.querySelectorAll('.page-label')].map(n => n.textContent);
  expect(labels.length).toBeGreaterThan(1);
  expect(labels[0]).toBe('Page 1');
  expect(view.el.querySelector('.status-view[data-mode="pageBreak"]').getAttribute('aria-pressed')).toBe('true');
  view.el.querySelector('.status-view[data-mode="normal"]').click(); await flush();
  expect(layer.hidden).toBe(true);
});

it('puts a shape from the Shapes gallery and chosen icons on the sheet as pictures', async () => {
  const { wb, id } = await mount();
  view.goTo('D2'); await flush();
  tab('Insert').click(); await flush();
  ribbonButton('Shapes').click(); await flush();
  document.querySelector('.shape-cell[aria-label="Oval"]').click(); await flush();
  let pictures = wb.sheet(id).charts.filter(c => c.type === 'image');
  expect(pictures).toHaveLength(1);
  expect(pictures[0].src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  expect(pictures[0].anchor).toEqual({ r: 1, c: 3 });
  ribbonButton('Icons').click(); await flush();
  const dialog = document.querySelector('.icons-dialog');
  [...dialog.querySelectorAll('.icon-pick')].slice(0, 2).forEach(b => b.click());
  dialog.requestSubmit(); await flush();
  pictures = wb.sheet(id).charts.filter(c => c.type === 'image');
  expect(pictures).toHaveLength(3);
  expect(wb.undoLabels()[0]).toBe('Insert icons');
});

it('opens a gallery of table styles from Format as Table and restyles a table in place', async () => {
  const { wb, id } = await mount();
  view.goTo('A1'); await flush();
  ribbonButton('Format as Table').click(); await flush();
  const items = [...document.querySelectorAll('.table-gallery-item')];
  expect(items.map(b => b.title)).toEqual(['Blue', 'Gray', 'Green', 'Orange', 'Purple', 'Red', 'Light', 'None']);
  items.find(b => b.title === 'Green').click(); await flush();
  const dialog = document.querySelector('.modal-panel');
  expect(dialog.querySelector('[role="radio"][aria-checked="true"]').getAttribute('aria-label')).toBe('Green');
  dialog.querySelector('form').requestSubmit(); await vi.advanceTimersByTimeAsync(500);
  const table = wb.tableAt(id, 0, 0);
  expect(table.style).toBe('green');
  ribbonButton('Format as Table').click(); await flush();
  [...document.querySelectorAll('.table-gallery-item')].find(b => b.title === 'Purple').click(); await flush();
  expect(wb.tableAt(id, 0, 0).style).toBe('purple');
  expect(document.querySelector('.modal-root:not(.closing)')).toBeNull();
});

it('applies the last colour picked with one click of Fill Color or Font Color, yellow and red to begin with', async () => {
  const { wb, id } = await mount();
  view.goTo('A1'); await flush();
  const apply = label => view.el.querySelector(`.ribbon-home [aria-label^="Apply ${label}"]`);
  expect(apply('fill color').getAttribute('aria-label')).toBe('Apply fill color #ffff00');
  apply('fill color').click(); await flush();
  expect(wb.styleAt(id, 0, 0).bg).toBe('#ffff00');
  apply('font color').click(); await flush();
  expect(wb.styleAt(id, 0, 0).color).toBe('#ff0000');
  // A colour from the arrow's palette is applied and becomes the button's colour.
  view.el.querySelector('.ribbon-home [aria-label="Fill color"]').click(); await flush();
  const swatch = document.querySelector('.menu .swatches:not(.swatches-theme) .swatch:not(.none)');
  const hex = swatch.getAttribute('aria-label');
  swatch.click(); await flush();
  expect(apply('fill color').getAttribute('aria-label')).toBe(`Apply fill color ${hex}`);
  view.goTo('B2'); await flush();
  apply('fill color').click(); await flush();
  expect(wb.styleAt(id, 1, 1).bg).toBe(hex);
});

it('sets the names of large ribbon buttons on two lines', async () => {
  await mount();
  const large = label => [...view.el.querySelectorAll('.ribbon-large')].find(b => b.textContent.replace(/\s+/g, ' ').trim() === label);
  const lines = label => [...large(label).querySelectorAll('.ribbon-label-line')].map(n => n.textContent.trim());
  expect(lines('Sort & Filter')).toEqual(['Sort &', 'Filter']);
  expect(lines('Format as Table')).toEqual(['Format', 'as Table']);
  expect(lines('Conditional Formatting')).toEqual(['Conditional', 'Formatting']);
  expect(lines('Cell Styles')).toEqual(['Cell', 'Styles']);
});

it('merges across, merges without centring and unmerges from the arrow beside Merge & Center', async () => {
  const { wb, id } = await mount();
  const choose = async (label) => {
    view.el.querySelector('.ribbon-home [aria-label="Merge options"]').click(); await flush();
    [...document.querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label')?.textContent === label).click(); await flush();
  };
  view.goTo('F1:G2'); await flush();
  await choose('Merge Across');
  expect(wb.sheet(id).merges.map(m => [m.r1, m.c1, m.r2, m.c2])).toEqual([[0, 5, 0, 6], [1, 5, 1, 6]]);
  view.goTo('F1:G2'); await flush();
  await choose('Unmerge Cells');
  expect(wb.sheet(id).merges).toEqual([]);
  view.goTo('F4:G5'); await flush();
  await choose('Merge Cells');
  expect(wb.sheet(id).merges.map(m => [m.r1, m.c1, m.r2, m.c2])).toEqual([[3, 5, 4, 6]]);
  expect(wb.styleAt(id, 3, 5)?.align).toBeUndefined();
});

it('formats as Accounting in another currency from the arrow beside the Accounting button', async () => {
  const { wb, id } = await mount();
  view.goTo('F1'); await flush();
  view.el.querySelector('.ribbon-home [aria-label="Accounting Number Format options"]').click(); await flush();
  [...document.querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label')?.textContent === '£ English (United Kingdom)').click(); await flush();
  expect(wb.styleAt(id, 0, 5).code).toContain('£');
});
