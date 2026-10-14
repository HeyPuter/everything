import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { linkEntries, linkName, linkPath, targetForPath, formulaUsesLink, linkUsage, updateLinkValues, changeLinkSource, breakLink } from '../src/core/edit-links.js';

const books = () => ({ version: 1, books: [
  { target: 'Prices.xlsx', sheets: [{ name: 'Rates', cells: { '0,0': 5, '1,0': 7 } }], names: [] },
  { target: '../Archive/Old%20Totals.xlsx', sheets: [{ name: 'Sum', cells: { '0,0': 100 } }], names: [] },
] });

function book() {
  const wb = new Workbook({ externalWorkbooks: books(), sheets: [{ name: 'Main' }, { name: 'Other' }] });
  const [main, other] = wb.sheets.map((s) => s.id);
  wb.setCells(main, [
    { r: 0, c: 0, cell: { f: '[1]Rates!A1*2' } },
    { r: 1, c: 0, cell: { f: '[2]Sum!A1+1' } },
    { r: 2, c: 0, cell: { f: 'SUM([1]Rates!A1:A2)' } },
  ]);
  wb.setCells(other, [{ r: 0, c: 0, cell: { f: '[2]Sum!A1' } }]);
  wb.clearHistory();
  return { wb, main, other };
}

describe('link names and paths', () => {
  it('names a link by its file and finds it on the drive beside this book', () => {
    expect(linkName('../Archive/Old%20Totals.xlsx')).toBe('Old Totals.xlsx');
    expect(linkName('file:///C:/Data/Book.xlsx')).toBe('Book.xlsx');
    expect(linkPath('Prices.xlsx', '/alice/Documents/Budget.xlsx')).toBe('/alice/Documents/Prices.xlsx');
    expect(linkPath('../Archive/Old%20Totals.xlsx', '/alice/Documents/Budget.xlsx')).toBe('/alice/Archive/Old Totals.xlsx');
    expect(linkPath('/alice/Shared/X.xlsx', null)).toBe('/alice/Shared/X.xlsx');
    expect(linkPath('Prices.xlsx', null)).toBeNull();
    expect(linkPath('file:///C:/Data/Book.xlsx', '/alice/a.xlsx')).toBeNull();
    expect(linkPath('https://example.com/a.xlsx', '/alice/a.xlsx')).toBeNull();
    expect(targetForPath('/alice/Documents/Other Book.xlsx', '/alice/Documents/Budget.xlsx')).toBe('Other%20Book.xlsx');
    expect(targetForPath('/bob/x.xlsx', null)).toBe('/bob/x.xlsx');
  });

  it('lists each link with its type and where it is read', () => {
    const { wb, main } = book();
    expect(linkEntries(wb).map(({ index, name, type, update }) => ({ index, name, type, update }))).toEqual([
      { index: 1, name: 'Prices.xlsx', type: 'Workbook', update: 'Automatic' },
      { index: 2, name: 'Old Totals.xlsx', type: 'Workbook', update: 'Automatic' },
    ]);
    expect(formulaUsesLink('[1]Rates!A1*2', 1)).toBe(true);
    expect(formulaUsesLink('[12]Rates!A1', 1)).toBe(false);
    expect(formulaUsesLink('"[1]"&A1', 1)).toBe(false);
    expect(linkUsage(wb, 1).cells).toEqual([{ sheetId: main, r: 0, c: 0 }, { sheetId: main, r: 2, c: 0 }]);
    expect(linkUsage(wb, 2).cells).toHaveLength(2);
  });
});

describe('editing links', () => {
  it('updates a link from its source workbook as one undo step', () => {
    const { wb, main } = book();
    expect(wb.getValue(main, 0, 0)).toBe(10);
    const source = new Workbook({ sheets: [{ name: 'rates' }] });
    source.setInput(source.activeSheetId, 0, 0, '6');
    source.setInput(source.activeSheetId, 1, 0, '4');
    const result = updateLinkValues(wb, 1, source);
    expect(result).toEqual({ missing: [], updated: true });
    expect(wb.getValue(main, 0, 0)).toBe(12);
    expect(wb.getValue(main, 2, 0)).toBe(10);
    expect(wb.undoLabels()).toEqual(['Update link values']);
    wb.undo();
    expect(wb.getValue(main, 0, 0)).toBe(10);
    wb.redo();
    expect(wb.getValue(main, 0, 0)).toBe(12);
  });

  it('marks a sheet the source no longer has, keeping its last values', () => {
    const { wb, main } = book();
    const source = new Workbook({ sheets: [{ name: 'Elsewhere' }] });
    expect(updateLinkValues(wb, 1, source).missing).toEqual(['Rates']);
    expect(wb.externalWorkbooks.books[0].sheets[0].refreshError).toBe(true);
    expect(wb.getValue(main, 0, 0)).toBeTypeOf('object');
  });

  it('changes a link source, refreshing from the new file', () => {
    const { wb, main } = book();
    const source = new Workbook({ sheets: [{ name: 'Rates' }] });
    source.setInput(source.activeSheetId, 0, 0, '50');
    changeLinkSource(wb, 1, 'New%20Prices.xlsx', source);
    expect(wb.externalWorkbooks.books[0].target).toBe('New%20Prices.xlsx');
    expect(linkEntries(wb)[0].name).toBe('New Prices.xlsx');
    expect(wb.getValue(main, 0, 0)).toBe(100);
    wb.undo();
    expect(wb.externalWorkbooks.books[0].target).toBe('Prices.xlsx');
    expect(wb.getValue(main, 0, 0)).toBe(10);
  });

  it('breaks a link into values, drops it and renumbers the links after it, all in one step', () => {
    const { wb, main, other } = book();
    const result = breakLink(wb, 1);
    expect(result).toEqual({ converted: 2, removed: true, kept: 0 });
    expect(wb.getCell(main, 0, 0)).toMatchObject({ v: 10, f: null });
    expect(wb.getCell(main, 2, 0)).toMatchObject({ v: 12, f: null });
    expect(wb.externalWorkbooks.books).toHaveLength(1);
    expect(wb.getCell(main, 1, 0).f.replace(/'/g, '')).toBe('[1]Sum!A1+1');
    expect(wb.getCell(other, 0, 0).f.replace(/'/g, '')).toBe('[1]Sum!A1');
    expect(wb.getValue(main, 1, 0)).toBe(101);
    expect(wb.undoLabels()).toEqual(['Break link']);
    wb.undo();
    expect(wb.externalWorkbooks.books).toHaveLength(2);
    expect(wb.getCell(main, 0, 0).f).toBe('[1]Rates!A1*2');
    expect(wb.getCell(main, 1, 0).f).toBe('[2]Sum!A1+1');
    expect(wb.getValue(main, 1, 0)).toBe(101);
    wb.redo();
    expect(wb.getCell(main, 1, 0).f.replace(/'/g, '')).toBe('[1]Sum!A1+1');
    expect(wb.getValue(main, 1, 0)).toBe(101);
  });

  it('keeps a link a defined name still reads', () => {
    const { wb } = book();
    wb.defineName('Rate', '[1]Rates!$A$1');
    const result = breakLink(wb, 1);
    expect(result.removed).toBe(false);
    expect(result.kept).toBe(1);
    expect(wb.externalWorkbooks.books).toHaveLength(2);
  });
});

describe('startup prompt', () => {
  it.each(['update', 'none'])('keeps %s through the app format and an .xlsx', async (mode) => {
    const { wb } = book();
    wb.setLinkStartup(mode);
    expect(new Workbook(wb.toJSON()).linkStartup).toBe(mode);
    const blob = await workbookToXlsx(wb);
    const back = await workbookFromFile(new Uint8Array(await blob.arrayBuffer()), 'Back.xlsx');
    expect(back.linkStartup).toBe(mode);
    expect(back.externalWorkbooks.books).toHaveLength(2);
  });

  it('asks by default and writes nothing for it', async () => {
    const { wb } = book();
    expect(wb.linkStartup).toBe('ask');
    expect(wb.toJSON().linkStartup).toBeUndefined();
    const blob = await workbookToXlsx(wb);
    expect((await workbookFromFile(new Uint8Array(await blob.arrayBuffer()), 'Back.xlsx')).linkStartup).toBe('ask');
  });
});
