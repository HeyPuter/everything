import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

const book = () => {
  const cells = {};
  for (let r = 0; r < 21; r++) { cells[`${r},0`] = { v: r === 0 ? 'Item' : `i${r}` }; cells[`${r},1`] = { v: r === 0 ? 'Qty' : r }; }
  const wb = new Workbook({ sheets: [{ name: 'Data', cells }] });
  wb.setFilterRange(wb.activeSheetId, { r1: 0, c1: 0, r2: 20, c2: 1 });
  return wb;
};
const filterBy = (wb, op, value) => { const s = wb.activeSheet; wb._setFilter(s, { range: s.filter.range, criteria: { 1: { op, value } } }, 'Filter'); };

describe('sheet views', () => {
  it('filter in a temporary view without touching the default view, which a file keeps', async () => {
    const wb = book(), id = wb.activeSheetId, sheet = wb.activeSheet;
    filterBy(wb, 'lt', '6');
    expect(sheet.filterHidden.size).toBe(15);
    const view = wb.newSheetView(id);
    expect(sheet.personalView.id).toBe(view);
    // Inside the view this person filters differently.
    filterBy(wb, 'gt', '15');
    expect(sheet.filterHidden.size).toBe(15);
    expect(sheet.filterHidden.has(16)).toBe(false);
    // Files and drafts hold the default view's filter.
    const json = wb.toJSON().sheets[0];
    expect(json.filter.criteria[1]).toMatchObject({ op: 'lt' });
    expect(json.filterHidden).toContain(16);
    expect(json.sheetViews ?? []).toEqual([]);
    expect(json.personalView).toBeUndefined();
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'views.xlsx');
    expect(back.activeSheet.filter.criteria[1]).toMatchObject({ op: 'lt' });
    expect(back.activeSheet.filterHidden.has(16)).toBe(true);
    // Exit lets a temporary view go and brings the default back.
    wb.exitSheetView(id);
    expect(sheet.personalView).toBeUndefined();
    expect(sheet.sheetViews ?? []).toEqual([]);
    expect(sheet.filter.criteria[1]).toMatchObject({ op: 'lt' });
    expect(sheet.filterHidden.has(16)).toBe(true);
  });

  it('keeps a named view with its own filters, switches between views, and saves them with the workbook', async () => {
    const wb = book(), id = wb.activeSheetId, sheet = wb.activeSheet;
    const view = wb.newSheetView(id);
    filterBy(wb, 'gt', '18');
    expect(wb.keepSheetView(id, 'Big orders')).toBe(true);
    expect(sheet.sheetViews.map(v => [v.name, !!v.temporary])).toEqual([['Big orders', false]]);
    wb.exitSheetView(id);
    expect(Object.keys(sheet.filter.criteria)).toEqual([]);
    expect(sheet.sheetViews[0].filter.criteria[1]).toMatchObject({ op: 'gt', value: '18' });
    wb.enterSheetView(id, view);
    expect(sheet.filterHidden.size).toBe(18);
    // Saved with the workbook, in both formats, with nobody in it.
    const json = new Workbook(wb.toJSON());
    expect(json.activeSheet.sheetViews[0].name).toBe('Big orders');
    expect(json.activeSheet.personalView).toBeUndefined();
    expect(json.activeSheet.filterHidden.size).toBe(0);
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'views.xlsx');
    expect(back.activeSheet.sheetViews.map(v => v.name)).toEqual(['Big orders']);
    expect(back.activeSheet.sheetViews[0].filter.criteria[1]).toMatchObject({ op: 'gt' });
  });

  it('entering, filtering and leaving are undo steps that never leak into the default view', () => {
    const wb = book(), id = wb.activeSheetId, sheet = wb.activeSheet;
    const view = wb.newSheetView(id);
    wb.keepSheetView(id, 'Mine');
    filterBy(wb, 'gt', '10');
    wb.exitSheetView(id);
    expect(sheet.filterHidden.size).toBe(0);
    wb.undo(); // back into the view, its filter on show
    expect(sheet.personalView.id).toBe(view);
    expect(sheet.filterHidden.size).toBe(10);
    wb.undo(); // the view's filter undone, still in the view
    expect(sheet.filterHidden.size).toBe(0);
    wb.redo(); wb.redo();
    expect(sheet.personalView).toBeUndefined();
    expect(Object.keys(sheet.filter.criteria)).toEqual([]);
  });

  it('a structural edit and its undo inside a view keep the person in it, and a sheet copy is in no view', () => {
    const wb = book(), id = wb.activeSheetId, sheet = wb.activeSheet;
    const view = wb.newSheetView(id);
    filterBy(wb, 'gt', '10');
    wb.insertRows(id, 0, 1);
    expect(wb.activeSheet.personalView.id).toBe(view);
    wb.undo();
    expect(wb.activeSheet.personalView.id).toBe(view);
    expect(wb.activeSheet.filterHidden.size).toBe(10);
    const copy = wb.duplicateSheet(id);
    expect(copy.personalView).toBeUndefined();
    expect(copy.filterHidden.size).toBe(10);
    expect(sheet.id).toBe(id);
  });

  it('views follow rows inserted above them, and rename, duplicate and delete', () => {
    const wb = book(), id = wb.activeSheetId, sheet = wb.activeSheet;
    wb.newSheetView(id);
    filterBy(wb, 'gt', '10');
    wb.keepSheetView(id, 'Mine');
    wb.exitSheetView(id);
    wb.insertRows(id, 0, 2);
    expect(sheet.filter.range.r1).toBe(2);
    expect(sheet.sheetViews[0].filter.range.r1).toBe(2);
    expect(wb.renameSheetView(id, sheet.sheetViews[0].id, 'Large')).toBe(true);
    const copy = wb.duplicateSheetView(id, sheet.sheetViews[0].id);
    expect(sheet.sheetViews.map(v => v.name)).toEqual(['Large', 'Large (2)']);
    wb.enterSheetView(id, copy);
    expect(wb.deleteSheetView(id, copy)).toBe(true);
    expect(sheet.personalView).toBeUndefined();
    expect(sheet.sheetViews.map(v => v.name)).toEqual(['Large']);
  });
});
