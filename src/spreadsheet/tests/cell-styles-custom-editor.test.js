// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { openMergeStylesDialog } from '../src/ui/cellstyles-ui.js';
import { menubarMenus, menuLeaves } from '../src/ui/menubar.js';

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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = () => vi.advanceTimersByTimeAsync(1);
const dialog = (title) => [...document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')].find((d) => d.getAttribute('aria-label') === title);
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
const partBox = (root, label) => [...root.querySelectorAll('.style-part')].find((n) => n.querySelector('label').textContent === label).querySelector('input');
const menuItem = (label) => [...document.querySelectorAll('.menu-item')].find((n) => (n.querySelector('.menu-label')?.textContent ?? n.textContent) === label);

async function mount() {
  const doc = new Doc({ name: 'Styles', path: 'Spreadsheets/Styles.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Total');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true, bg: '#fff2cc', color: '#1f3b73' });
  wb.setInput(id, 0, 1, '42');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await flush();
  const select = async (where) => { view.goTo(`Sheet1!${where}`); await flush(); };
  return { wb, id, select };
}

describe('cell styles management in the editor', () => {
  it('makes a style by example, applies only its parts, and follows a modification with one undo step', async () => {
    const { wb, id, select } = await mount();
    await select('A1');
    await view.run('newCellStyle');
    const box = dialog('New Cell Style');
    expect(box).toBeTruthy();
    const name = box.querySelector('input[aria-label="Style name"]');
    name.value = 'Brand';
    name.dispatchEvent(new Event('input'));
    // The fill stays the cell's own: the style leaves it out.
    partBox(box, 'Fill').click();
    expect(box.querySelector('.style-part-summary.muted').textContent).toMatch(/Shaded/);
    button(box, 'OK').click();
    await flush();
    expect(wb.cellStyles.map((s) => s.name)).toEqual(['Brand']);
    expect(wb.cellStyles[0].parts.fill).toBe(false);
    expect(wb.undoLabel()).toBe('New cell style: Brand');

    await select('B1');
    await view.run('cellStyle', { custom: 'Brand' });
    expect(wb.getCell(id, 0, 1).s).toMatchObject({ bold: true, color: '#1f3b73', cellStyle: 'Brand' });
    expect(wb.getCell(id, 0, 1).s.bg).toBeUndefined();

    // Modify: Format… changes the font on a scratch style; OK reformats B1, which is linked to the style.
    await view.run('modifyCellStyle', { custom: 'Brand' });
    const modify = dialog('Modify Cell Style');
    button(modify, 'Format…').click();
    await flush();
    const format = dialog('Format Style: Brand');
    expect(format).toBeTruthy();
    const italic = [...format.querySelectorAll('.find-option')].find((n) => n.textContent === 'Italic').querySelector('input');
    italic.click();
    button(format, 'OK').click();
    await flush();
    expect(modify.querySelectorAll('.style-part-summary')[2].textContent).toMatch(/italic/);
    button(modify, 'OK').click();
    await flush();
    expect(wb.getCell(id, 0, 1).s).toMatchObject({ bold: true, italic: true, cellStyle: 'Brand' });
    expect(wb.cellStyles[0].style.italic).toBe(true);
    // One step undoes the definition and the cells it reformatted together.
    wb.undo();
    expect(wb.cellStyles[0].style.italic).toBeUndefined();
    expect(wb.getCell(id, 0, 1).s.italic).toBeUndefined();
  });

  it('lists custom styles in the gallery, with Modify, Duplicate and Delete on right-click', async () => {
    const { wb, id, select } = await mount();
    wb.setCellStyles([{ name: 'Brand', parts: { number: false, alignment: false, font: true, border: false, fill: false, protection: false }, style: { bold: true } }]);
    await select('B1');
    await view.run('cellStyle', { custom: 'Brand' });
    await view.run('cellStylesMenu', { x: 10, y: 10 });
    expect([...document.querySelectorAll('.menu-header')].map((h) => h.textContent)).toContain('Custom');
    expect(menuItem('New Cell Style…')).toBeTruthy();
    expect(menuItem('Merge Styles…')).toBeTruthy();
    const sample = [...document.querySelectorAll('.cell-style-item')].find((b) => b.textContent === 'Brand');
    sample.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
    await flush();
    expect(document.querySelector('[role="menu"]').getAttribute('aria-label')).toBe('Brand style');
    expect(menuItem('Duplicate…')).toBeTruthy();
    menuItem('Delete').click();
    await flush();
    const confirm = dialog('Delete style "Brand"?');
    button(confirm, 'Delete style').click();
    await flush();
    expect(wb.cellStyles).toEqual([]);
    // The cell keeps its look, without the link to a style that is gone.
    expect(wb.getCell(id, 0, 1).s.bold).toBe(true);
    expect(wb.getCell(id, 0, 1).s.cellStyle).toBeUndefined();
  });

  it('modifies a built-in style for this workbook and resets it', async () => {
    const { wb, id, select } = await mount();
    await select('B1');
    await view.run('cellStyle', 'good');
    expect(wb.getCell(id, 0, 1).s).toMatchObject({ bg: '#d8f3dc', cellStyle: 'Good' });
    await view.run('modifyCellStyle', 'good');
    const box = dialog('Modify Cell Style');
    expect(box.querySelector('input[aria-label="Style name"]').disabled).toBe(true);
    partBox(box, 'Font').click(); // the modified Good leaves the ink alone
    button(box, 'OK').click();
    await flush();
    expect(wb.cellStyles).toHaveLength(1);
    expect(wb.cellStyles[0]).toMatchObject({ builtin: 'good', name: 'Good' });
    expect(wb.cellStyles[0].parts.font).toBe(false);
    await view.run('deleteCellStyle', { builtin: 'good' });
    expect(wb.cellStyles).toEqual([]);
    expect(wb.getCell(id, 0, 1).s).toMatchObject({ bg: '#d8f3dc', color: '#0b6b3a' });
  });

  it('offers the style tools in Format ▸ Cell styles', () => {
    const items = menuLeaves(menubarMenus({ customCellStyles: ['Brand'] }).find((m) => m.id === 'format').items);
    expect(items.find((it) => it.label === 'Brand')).toMatchObject({ cmd: 'cellStyle', arg: { custom: 'Brand' } });
    expect(items.some((it) => it.cmd === 'newCellStyle')).toBe(true);
    expect(items.some((it) => it.cmd === 'mergeCellStyles')).toBe(true);
    expect(items.find((it) => it.cmd === 'deleteCellStyle')).toMatchObject({ arg: { custom: 'Brand' } });
  });
});

describe('Merge Styles', () => {
  const other = () => new Workbook({ cellStyles: [{ name: 'Brand', style: { italic: true } }, { name: 'Accent', style: { bold: true } }] });

  it('copies another spreadsheet’s styles in, asking before same-named ones are replaced', async () => {
    const wb = new Workbook({ cellStyles: [{ name: 'Brand', style: { bold: true } }] });
    const io = { listFiles: async () => [{ name: 'Other.xlsx', path: 'Spreadsheets/Other.xlsx' }, { name: 'Mine.xlsx', path: 'Spreadsheets/Mine.xlsx' }],
      readFile: vi.fn(async () => new Uint8Array([1])), open: vi.fn(async () => other()), currentPath: 'Spreadsheets/Mine.xlsx' };
    openMergeStylesDialog({ wb, run: vi.fn() }, io);
    await flush();
    const box = dialog('Merge Styles');
    expect([...box.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Other.xlsx']);
    button(box, 'Merge').click();
    await flush();
    expect(io.readFile).toHaveBeenCalledWith('Spreadsheets/Other.xlsx');
    const ask = [...document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]')].at(-1);
    expect(ask.textContent).toMatch(/already has styles named Brand/);
    button(ask, 'Keep mine').click();
    await flush();
    expect(wb.cellStyles.map((s) => [s.name, s.style])).toEqual([['Brand', { bold: true }], ['Accent', { bold: true }]]);
    expect(wb.undoLabel()).toBe('Merge styles');
  });
});
