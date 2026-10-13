// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openEditLinks, openLinkStartupDialog, updateAllLinks } from '../src/ui/editlinks.js';
import { closeAllModals } from '../src/ui/modal.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup({ links = true } = {}) {
  const wb = new Workbook({
    sheets: [{ name: 'Main' }],
    ...(links ? { externalWorkbooks: { version: 1, books: [
      { target: 'Prices.xlsx', sheets: [{ name: 'Rates', cells: { '0,0': 5 } }], names: [] },
      { target: 'file:///C:/Old/Gone.xlsx', sheets: [{ name: 'Data', cells: { '0,0': 1 } }], names: [] },
    ] } } : {}),
  });
  const id = wb.activeSheetId;
  if (links) wb.setCells(id, [{ r: 0, c: 0, cell: { f: '[1]Rates!A1*2' } }, { r: 1, c: 0, cell: { f: '[2]Data!A1' } }]);
  wb.clearHistory();
  const fresh = new Workbook({ sheets: [{ name: 'Rates' }] });
  fresh.setInput(fresh.activeSheetId, 0, 0, '21');
  const other = new Workbook({ sheets: [{ name: 'Rates' }] });
  other.setInput(other.activeSheetId, 0, 0, '100');
  const files = { '/me/Docs/Prices.xlsx': fresh, '/me/Docs/Other.xlsx': other };
  const host = {
    docPath: () => '/me/Docs/Budget.xlsx',
    read: vi.fn(async (path) => { if (!files[path]) { const e = new Error('not found'); e.code = 'subject_does_not_exist'; throw e; } return files[path]; }),
    open: vi.fn(),
    pick: vi.fn(async () => ({ path: '/me/Docs/Other.xlsx' })),
    allow: vi.fn(async () => true),
  };
  return { wb, id, host, ctx: { wb, grid: { focus() {} } } };
}

const panel = () => [...document.querySelectorAll('.modal-panel')].at(-1);
const button = (label, root = panel()) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
const rows = () => [...document.querySelector('.modal-panel[aria-label="Edit Links"]').querySelectorAll('[role="option"]')].map((r) => [...r.children].map((c) => c.textContent));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Edit Links dialog', () => {
  it('lists each link with its source, type, update and status', () => {
    const { ctx, host } = setup();
    openEditLinks(ctx, host);
    expect(panel().getAttribute('aria-label')).toBe('Edit Links');
    expect(rows()).toEqual([['Prices.xlsx', 'Workbook', 'Automatic', 'Unknown'], ['Gone.xlsx', 'Workbook', 'Automatic', 'Unknown']]);
    expect(panel().querySelector('[aria-selected="true"]').textContent).toContain('Prices.xlsx');
    expect(panel().querySelector('.el-details').textContent).toContain('/me/Docs/Prices.xlsx');
    expect(button('Open Source').disabled).toBe(false);
  });

  it('says there are no links, with the buttons off', () => {
    const { ctx, host } = setup({ links: false });
    openEditLinks(ctx, host);
    expect(panel().querySelector('.el-empty').hidden).toBe(false);
    for (const label of ['Update Values', 'Change Source…', 'Open Source', 'Break Link…', 'Check Status']) expect(button(label).disabled).toBe(true);
  });

  it('checks every source and updates the selected link', async () => {
    const { ctx, host, wb, id } = setup();
    openEditLinks(ctx, host);
    button('Check Status').click();
    await settle(); await settle();
    expect(rows().map((r) => r[3])).toEqual(['OK', 'Error: Source not on this drive']);
    button('Update Values').click();
    await settle(); await settle();
    expect(wb.getValue(id, 0, 0)).toBe(42);
    expect(wb.undoLabels()).toEqual(['Update link values']);
    // Down to the second link: it lives on another computer, so it cannot be opened.
    panel().querySelector('[role="listbox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(button('Open Source').disabled).toBe(true);
  });

  it('changes a source through the picker and opens a source', async () => {
    const { ctx, host, wb, id } = setup();
    openEditLinks(ctx, host);
    button('Change Source…').click();
    await settle(); await settle(); await settle();
    expect(wb.externalWorkbooks.books[0].target).toBe('Other.xlsx');
    expect(wb.getValue(id, 0, 0)).toBe(200);
    expect(rows()[0][0]).toBe('Other.xlsx');
    button('Open Source').click();
    expect(host.open).toHaveBeenCalledWith('/me/Docs/Other.xlsx');
  });

  it('breaks a link after asking', async () => {
    const { ctx, host, wb, id } = setup();
    openEditLinks(ctx, host);
    button('Break Link…').click();
    await settle();
    button('Break Link', panel()).click();
    await settle(); await settle();
    expect(wb.getCell(id, 0, 0)).toMatchObject({ v: 10, f: null });
    expect(wb.externalWorkbooks.books).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(wb.getCell(id, 1, 0).f.replace(/'/g, '')).toBe('[1]Data!A1');
  });

  it('sets the startup prompt', () => {
    const { ctx, wb } = setup();
    openLinkStartupDialog(ctx);
    const radios = [...panel().querySelectorAll('input[type="radio"]')];
    expect(radios.find((r) => r.checked).value).toBe('ask');
    radios.find((r) => r.value === 'update').checked = true;
    button('OK').click();
    expect(wb.linkStartup).toBe('update');
  });

  it('updates every link it can reach', async () => {
    const { ctx, host, wb, id } = setup();
    const result = await updateAllLinks(ctx, host, { quiet: true });
    expect(result).toEqual({ updated: 1, failed: 1 });
    expect(wb.getValue(id, 0, 0)).toBe(42);
  });
});
