import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findList, recordCount, readRecord, writeRecord, appendRecord, appendProblem, deleteRecord, matchesCriterion, findRecord } from '../src/core/data-form.js';

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [['Name', 'Qty', 'Price', 'Total'], ['Apple', '3', '2', '=B2*C2'], ['Banana', '10', '1', '=B3*C3'], ['Cherry', '150', '0.5', '=B4*C4']];
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.clearHistory();
  return { wb, id };
}

describe('data form lists', () => {
  it('finds the current region with its header row as the fields', () => {
    const { wb, id } = book();
    const list = findList(wb, id, 2, 1);
    expect(list).toMatchObject({ header: 0, first: 1, last: 3, c1: 0, c2: 3, tableId: null });
    expect(list.fields.map((f) => f.name)).toEqual(['Name', 'Qty', 'Price', 'Total']);
    expect(recordCount(list)).toBe(3);
    const rec = readRecord(wb, list, 1);
    expect(rec.map((f) => f.formula)).toEqual([false, false, false, true]);
    expect(rec[0].text).toBe('Banana');
    expect(rec[3].display).toBe('10');
  });

  it('uses a table at the selection, leaving its totals row out', () => {
    const { wb, id } = book();
    const t = wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 3 }, { headerRow: true });
    wb.setTableTotals(id, (t?.id ?? wb.sheet(id).tables[0].id), true);
    const list = findList(wb, id, 1, 0);
    expect(list.tableId).toBe(wb.sheet(id).tables[0].id);
    expect(recordCount(list)).toBe(3);
  });

  it('writes a changed record as one undo step and never writes formula fields', () => {
    const { wb, id } = book();
    const list = findList(wb, id, 1, 0);
    expect(writeRecord(wb, list, 0, { 0: 'Apricot', 1: '4', 3: '999' })).toBe(2);
    expect(wb.getValue(id, 1, 0)).toBe('Apricot');
    expect(wb.getValue(id, 1, 3)).toBe(8);
    expect(wb.undoLabels()).toEqual(['Edit record']);
    wb.undo();
    expect(wb.getValue(id, 1, 0)).toBe('Apple');
    expect(wb.getValue(id, 1, 1)).toBe(3);
    expect(writeRecord(wb, list, 0, { 0: 'Apple' })).toBe(0);
  });

  it('appends a record under a plain list, carrying its formulas down', () => {
    const { wb, id } = book();
    const list = findList(wb, id, 1, 0);
    const grown = appendRecord(wb, list, { 0: 'Date', 1: '2', 2: '5' });
    expect(grown.last).toBe(4);
    expect(wb.getValue(id, 4, 0)).toBe('Date');
    expect(wb.getCell(id, 4, 3).f).toBe('B5*C5');
    expect(wb.getValue(id, 4, 3)).toBe(10);
    expect(wb.undoLabels()).toEqual(['New record']);
    wb.undo();
    expect(wb.getCell(id, 4, 0)).toBeFalsy();
  });

  it('refuses to grow a plain list into a filled row, but a table makes room', () => {
    const { wb, id } = book();
    wb.setInput(id, 4, 2, 'note');
    const list = findList(wb, id, 1, 0);
    // The note joins the current region, so the list now ends on row 5; put a blocker beyond a gap instead.
    expect(list.last).toBe(4);
    const wb2 = book();
    wb2.wb.addTable(wb2.id, { r1: 0, c1: 0, r2: 3, c2: 3 }, { headerRow: true });
    const tl = findList(wb2.wb, wb2.id, 1, 0);
    expect(appendProblem(wb2.wb, tl)).toBeNull();
    const grown = appendRecord(wb2.wb, tl, { 0: 'Fig', 1: '1', 2: '1' });
    expect(grown.last).toBe(4);
    expect(wb2.wb.sheet(wb2.id).tables[0].range.r2).toBe(4);
    expect(wb2.wb.getValue(wb2.id, 4, 0)).toBe('Fig');
  });

  it('reports a filled row below a list', () => {
    const { wb, id } = book();
    const list = { ...findList(wb, id, 1, 0) };
    wb.setInput(id, 4, 1, 'x');
    expect(appendProblem(wb, list)).toMatch(/not empty/);
    expect(appendRecord(wb, list, { 0: 'y' })).toBeNull();
  });

  it('deletes a record by pulling the rows below up within the list', () => {
    const { wb, id } = book();
    wb.setInput(id, 2, 6, 'outside');
    const list = findList(wb, id, 1, 0);
    const shorter = deleteRecord(wb, list, 0);
    expect(shorter.last).toBe(2);
    expect(wb.getValue(id, 1, 0)).toBe('Banana');
    expect(wb.getValue(id, 1, 3)).toBe(10);
    expect(wb.getValue(id, 2, 6)).toBe('outside');
    wb.undo();
    expect(wb.getValue(id, 1, 0)).toBe('Apple');
  });
});

describe('data form criteria', () => {
  it.each([
    [150, '150', '>100', true], [3, '3', '>100', false], [10, '10', '<=10', true], [10, '10', '<>10', false],
    ['Banana', 'Banana', 'ban', true], ['Banana', 'Banana', 'b*a', true], ['Banana', 'Banana', 'b?n', true], ['Banana', 'Banana', 'nan', false],
    ['Banana', 'Banana', '=banana', true], ['Banana', 'Banana', '=ban', false], ['Banana', 'Banana', '>Apple', true],
    [null, '', '=', true], ['x', 'x', '=', false], ['x', 'x', '<>', true], ['a*b', 'a*b', '=a~*b', true], ['axb', 'axb', '=a~*b', false],
    [5, '5', '', true],
  ])('%j (%j) against %j is %j', (value, shown, criterion, expected) => {
    expect(matchesCriterion(value, shown, criterion)).toBe(expected);
  });

  it('steps to the next and previous matching record without wrapping', () => {
    const { wb, id } = book();
    const list = findList(wb, id, 1, 0);
    const criteria = { 1: '>=10' };
    expect(findRecord(wb, list, -1, 1, criteria)).toBe(1);
    expect(findRecord(wb, list, 1, 1, criteria)).toBe(2);
    expect(findRecord(wb, list, 2, 1, criteria)).toBe(-1);
    expect(findRecord(wb, list, 2, -1, criteria)).toBe(1);
    expect(findRecord(wb, list, 0, 1, { 0: 'ch', 3: '>50' })).toBe(2);
  });
});
