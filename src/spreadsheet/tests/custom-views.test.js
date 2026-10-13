import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { captureSheetView, customViewNameProblem, normalizeCustomViews, remapCustomViews } from '../src/core/custom-views.js';

const book = () => {
  const cells = {};
  for (let r = 0; r < 30; r++) { cells[`${r},0`] = { v: r === 0 ? 'Name' : `n${r}` }; cells[`${r},1`] = { v: r === 0 ? 'Size' : r }; }
  return new Workbook({ sheets: [{ name: 'Data', cells }, { name: 'Notes', cells: { '0,0': { v: 'x' } } }] });
};

describe('custom views', () => {
  it('captures every sheet and shows it again', () => {
    const wb = book(), data = wb.sheets[0], notes = wb.sheets[1];
    wb.setSheetView(data.id, { viewZoom: 1.5 });
    wb.setSheetSelection(data.id, { active: { r: 4, c: 1 }, ranges: [{ r1: 4, c1: 1, r2: 6, c2: 1 }], activeRange: 0 });
    wb.setSheetOrigin(data.id, { r: 3, c: 0 });
    wb.setFrozen(data.id, 1, 0);
    wb.setHidden(data.id, 'row', [10, 11], true);
    wb.setPrintSettings(data.id, { orientation: 'landscape' });
    const id = wb.addCustomView('Review', { print: true, hidden: true });
    expect(wb.customViews).toHaveLength(1);
    expect(wb.customViews[0].sheets[data.id]).toMatchObject({ zoom: 1.5, frozenRows: 1, hiddenRows: [10, 11], printSettings: { orientation: 'landscape' } });
    expect(wb.customViews[0].sheets[notes.id]).toBeTruthy();

    // Change everything, then show the view.
    wb.setSheetView(data.id, { viewZoom: 0.75 });
    wb.setSheetSelection(data.id, { active: { r: 0, c: 0 }, ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }], activeRange: 0 });
    wb.setFrozen(data.id, 0, 0);
    wb.setHidden(data.id, 'row', [10, 11], false);
    wb.setHidden(data.id, 'col', [1], true);
    wb.setPrintSettings(data.id, { orientation: 'portrait' });
    wb.setActiveSheet(notes.id);
    expect(wb.showCustomView(id)).toBe(true);
    expect(wb.activeSheetId).toBe(data.id);
    expect(data.viewZoom).toBe(1.5);
    expect(data.viewSelection.active).toEqual({ r: 4, c: 1 });
    expect(data.viewOrigin).toEqual({ r: 3, c: 0 });
    expect(data.frozenRows).toBe(1);
    expect([...data.hiddenRows].sort()).toEqual([10, 11]);
    expect([...data.hiddenCols]).toEqual([]);
    expect(data.printSettings.orientation).toBe('landscape');
    // The edits are one undo step.
    wb.undo();
    expect(data.frozenRows).toBe(0);
    expect([...data.hiddenCols]).toEqual([1]);
    expect(data.printSettings.orientation).toBe('portrait');
    wb.redo();
    expect(data.frozenRows).toBe(1);
  });

  it('leaves hidden lines, filters and page setup alone when the view does not include them', () => {
    const wb = book(), data = wb.sheets[0];
    const id = wb.addCustomView('Plain', { print: false, hidden: false });
    expect(wb.customViews[0].sheets[data.id]).not.toHaveProperty('hiddenRows');
    expect(wb.customViews[0].sheets[data.id]).not.toHaveProperty('printSettings');
    wb.setHidden(data.id, 'row', [5], true);
    wb.setPrintSettings(data.id, { orientation: 'landscape' });
    wb.showCustomView(id);
    expect(data.hiddenRows.has(5)).toBe(true);
    expect(data.printSettings.orientation).toBe('landscape');
  });

  it('keeps a filter with the view and runs it again on the current data', () => {
    const wb = book(), data = wb.sheets[0];
    wb.setFilterRange(data.id, { r1: 0, c1: 0, r2: 29, c2: 1 });
    wb._setFilter(data, { range: data.filter.range, criteria: { 1: { op: 'gt', value: '20' } } }, 'Filter');
    const hiddenBefore = data.filterHidden.size;
    expect(hiddenBefore).toBeGreaterThan(0);
    const id = wb.addCustomView('Big ones');
    wb.clearFilter(data.id);
    expect(data.filter).toBeNull();
    wb.showCustomView(id);
    expect(data.filter.criteria[1]).toMatchObject({ op: 'gt' });
    expect(data.filterHidden.size).toBe(hiddenBefore);
  });

  it('replaces a view of the same name, deletes views as undo steps, and survives the app format', () => {
    const wb = book();
    const a = wb.addCustomView('One');
    wb.setSheetView(wb.sheets[0].id, { viewZoom: 2 });
    const b = wb.addCustomView('one');
    expect(b).toBe(a);
    expect(wb.customViews).toHaveLength(1);
    expect(wb.customViews[0].sheets[wb.sheets[0].id].zoom).toBe(2);
    wb.addCustomView('Two', { print: false });
    const back = new Workbook(wb.toJSON());
    expect(back.customViews.map(v => [v.name, v.print])).toEqual([['one', true], ['Two', false]]);
    expect(wb.deleteCustomView(a)).toBe(true);
    expect(wb.customViews.map(v => v.name)).toEqual(['Two']);
    wb.undo();
    expect(wb.customViews.map(v => v.name)).toEqual(['one', 'Two']);
  });

  it('validates names and stored views', () => {
    expect(customViewNameProblem('  ')).toMatch(/name/);
    expect(customViewNameProblem('A', [{ id: 'x', name: 'a' }])).toMatch(/exists/);
    expect(customViewNameProblem('A', [{ id: 'x', name: 'a' }], 'x')).toBeNull();
    const views = normalizeCustomViews([
      { name: 'Ok', sheets: { s1: { zoom: 9, frozenRows: 3, hiddenRows: [1, -1, 1.5], selection: { active: { r: 0, c: 0 }, ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }] } } } },
      { name: 'ok', sheets: { s1: {} } },
      { name: 'Gone', sheets: { other: {} } },
    ], ['s1']);
    expect(views).toHaveLength(1);
    expect(views[0].sheets.s1).toMatchObject({ zoom: 1, frozenRows: 3, hiddenRows: [1] });
    expect(views[0].id).toMatch(/^\{[0-9A-F-]{36}\}$/);
    expect(remapCustomViews(views, id => id === 's1' ? 's9' : null)[0].sheets).toHaveProperty('s9');
  });

  it('captures a sheet without its own selection or page setup', () => {
    const wb = new Workbook();
    const state = captureSheetView(wb.activeSheet);
    expect(state).toMatchObject({ zoom: 1, mode: 'normal', frozenRows: 0, hiddenRows: [], printSettings: null });
  });
});
