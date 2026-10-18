import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { parseTableSpec, renderTableSpec, validateTableName, renameColumnInFormula, renameTableInFormula, tableRefsToA1 } from '../src/core/tables.js';
import { tokenize } from '../src/core/formula/tokenizer.js';
import { MAX_ROW } from '../src/core/refs.js';

function book() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const put = (a1, t) => { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, t); };
  const val = (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(id, r, c); };
  const f = (a1) => { const { r, c } = parseCellRef(a1); return wb.getCell(id, r, c)?.f; };
  put('A1', 'Item'); put('B1', 'Qty'); put('C1', 'Price'); put('D1', 'Amount');
  put('A2', 'Pens'); put('B2', '10'); put('C2', '1.5');
  put('A3', 'Ink'); put('B3', '5'); put('C3', '4');
  const tid = wb.addTable(id, parseRange('A1:D3'), { name: 'Sales' });
  return { wb, id, put, val, f, tid };
}

describe('structured reference syntax', () => {
  it('tokenizes table references and parses specs', () => {
    const t = tokenize('SUM(Sales[Amount])+[@Qty]*Sales[[#Totals],[Qty]:[Price]]');
    expect(t.filter((x) => x.type === 'tref').map((x) => [x.table, x.spec])).toEqual([['Sales', 'Amount'], [null, '@Qty'], ['Sales', '[#Totals],[Qty]:[Price]']]);
    expect(parseTableSpec('[Qty]:[Price]')).toEqual({ rows: 'data', cols: ['Qty', 'Price'] });
    expect(parseTableSpec('@[Unit Price]')).toEqual({ rows: 'this', cols: ['Unit Price', 'Unit Price'] });
    expect(parseTableSpec('[#Headers],[Amount]')).toEqual({ rows: 'headers', cols: ['Amount', 'Amount'] });
    expect(parseTableSpec('#This Row')).toEqual({ rows: 'this', cols: null });
    expect(parseTableSpec('#Nope')).toBeNull();
    expect(renderTableSpec({ rows: 'this', cols: ['Unit Price', 'Unit Price'] })).toBe('@[Unit Price]');
    expect(renderTableSpec({ rows: 'totals', cols: ['Qty', 'Price'] })).toBe('[#Totals],[Qty]:[Price]');
    expect(validateTableName('Sales')).toBeNull();
    expect(validateTableName('A1')).toBeTruthy();
    expect(validateTableName('my table')).toBeTruthy();
    expect(validateTableName('Sales', ['sales'])).toBeTruthy();
    expect(renameTableInFormula('SUM(Sales[Amount])+1', 'Sales', 'Orders')).toBe('SUM(Orders[Amount])+1');
    expect(renameColumnInFormula('SUM(Sales[Amount])+[@Amount]', 'Sales', 'Amount', 'Total', 'Sales')).toBe('SUM(Sales[Total])+[@Total]');
    expect(renameColumnInFormula('[@Amount]', 'Sales', 'Amount', 'Total', 'Other')).toBe('[@Amount]');
    expect(tableRefsToA1('SUM(T[X])', () => ({ r1: 1, c1: 0, r2: 3, c2: 0 }))).toBe('SUM($A$2:$A$4)');
    expect(tableRefsToA1('SUM(T[X])', () => null)).toBe('SUM(#REF!)');
  });
});

describe('tables in a workbook', () => {
  it('gives a this-row reference in the header or totals row #VALUE!', () => {
    const { wb, id, put, val, tid } = book();
    wb.setTableTotals(id, tid, true);
    put('E1', '=Sales[@Qty]');
    put('D4', '=[@Qty]');
    put('E4', '=Sales[@Qty]');
    put('D2', '=[@Qty]*[@Price]');
    // The table grew over E1, which became a header: headers hold text, so it keeps what the reference gave.
    expect(wb.getCell(id, 0, 4)).toMatchObject({ v: '#VALUE!', f: null });
    expect(val('D4')).toEqual({ error: '#VALUE!' });
    expect(val('E4')).toEqual({ error: '#VALUE!' });
    expect(val('D2')).toBe(15);
  });

  it('creates a table with a filter, evaluates column, row, header, and whole-table references', () => {
    const { wb, id, put, val, tid } = book();
    const t = wb.tableById(id, tid);
    expect(t.name).toBe('Sales');
    expect(wb.sheet(id).filter.range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 3 });
    put('D2', '=[@Qty]*[@Price]'); put('D3', '=[@Qty]*[@Price]');
    put('F1', '=SUM(Sales[Amount])'); put('F2', '=Sales[[#Headers],[Price]]'); put('F3', '=COUNTA(Sales[#All])');
    put('F4', '=SUM(Sales[[Qty]:[Price]])'); put('F5', '=Sales[Nope]'); put('F6', '=Nope[Qty]'); put('F7', '=[@Qty]');
    expect(val('D2')).toBe(15);
    expect(val('D3')).toBe(20);
    expect(val('F1')).toBe(35);
    expect(val('F2')).toBe('Price');
    expect(val('F3')).toBe(12);
    expect(val('F4')).toBe(20.5);
    expect(val('F5')).toEqual({ error: '#REF!' });
    expect(val('F6')).toEqual({ error: '#NAME?' });
    expect(val('F7')).toEqual({ error: '#REF!' }); // a bare [@Qty] outside any table
    // A column reference spills.
    put('H1', '=Sales[Qty]');
    expect(val('H1')).toBe(10);
    expect(val('H2')).toBe(5);
    expect(wb.getDisplay(id, 0, 3)).toBe('Amount');
    expect(wb.conditionalStyle(id, 0, 0, null)).toMatchObject({ bold: true });
    expect(wb.conditionalStyle(id, 1, 0, null)).toMatchObject({ bg: '#d9e1f2' });
    expect(wb.conditionalStyle(id, 2, 0, null)).toBeNull();
  });

  it('grows when typing just below or beside it, and keeps the filter in step', () => {
    const { wb, id, put, val, tid } = book();
    put('F1', '=SUM(Sales[Qty])');
    put('A4', 'Tape'); put('B4', '2');
    expect(wb.tableById(id, tid).range).toEqual({ r1: 0, c1: 0, r2: 3, c2: 3 });
    expect(wb.sheet(id).filter.range.r2).toBe(3);
    expect(val('F1')).toBe(17);
    put('E2', 'x');
    expect(wb.tableById(id, tid).range.c2).toBe(4);
    expect(wb.getValue(id, 0, 4)).toBe('Column5');
    put('A7', 'far away');
    expect(wb.tableById(id, tid).range.r2).toBe(3);
  });

  it('adds and removes a totals row, renames tables and columns through formulas', () => {
    const { wb, id, put, val, f, tid } = book();
    put('D2', '=[@Qty]*[@Price]'); put('D3', '=[@Qty]*[@Price]'); put('F1', '=SUM(Sales[Amount])');
    wb.setTableTotals(id, tid, true);
    expect(wb.tableById(id, tid).range.r2).toBe(3);
    expect(val('A4')).toBe('Total');
    expect(f('D4')).toBe('SUBTOTAL(109,Sales[Amount])');
    expect(val('D4')).toBe(35);
    expect(val('F1')).toBe(35); // the totals row is not part of the data
    put('A5', 'Below'); // under a totals row: no growth
    expect(wb.tableById(id, tid).range.r2).toBe(3);
    wb.updateTable(id, tid, { name: 'Orders' });
    expect(f('F1')).toBe('SUM(Orders[Amount])');
    put('D1', 'Total value');
    expect(f('F1')).toBe('SUM(Orders[[Total value]])'); // a name with a space gets its own brackets
    expect(f('D4')).toBe('SUBTOTAL(109,Orders[[Total value]])');
    expect(val('F1')).toBe(35);
    wb.setTableTotals(id, tid, false);
    expect(val('A4')).toBeNull();
    expect(wb.tableById(id, tid).range.r2).toBe(2);
    expect(wb.updateTable(id, tid, { name: 'A1' })).toBe(false);
  });

  it('follows inserted and deleted rows and columns, and undoes as one step', () => {
    const { wb, id, put, val, tid } = book();
    put('F1', '=SUM(Sales[Qty])');
    wb.insertRows(id, 2, 1);
    expect(wb.tableById(id, tid).range).toEqual({ r1: 0, c1: 0, r2: 3, c2: 3 });
    expect(val('F1')).toBe(15);
    wb.deleteCols(id, 2, 1);
    expect(wb.tableById(id, tid).range.c2).toBe(2);
    expect(wb.tableColumns(id, wb.tableById(id, tid))).toEqual(['Item', 'Qty', 'Amount']);
    wb.deleteRows(id, 1, 3);
    expect(wb.tableById(id, tid).range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
    wb.undo(); wb.undo(); wb.undo();
    expect(wb.tableById(id, tid).range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 3 });
    expect(val('F1')).toBe(15);
  });

  it('converts back to a range with formulas rewritten to A1, and round-trips through .xlsx', async () => {
    const { wb, id, put, f, val, tid } = book();
    put('D2', '=[@Qty]*[@Price]'); put('F1', '=SUM(Sales[Amount])');
    const blob = await workbookToXlsx(wb);
    const back = await workbookFromFile(await blob.arrayBuffer(), 'x.xlsx');
    const b = back.sheets[0];
    expect(b.tables).toHaveLength(1);
    expect(b.tables[0]).toMatchObject({ name: 'Sales', range: { r1: 0, c1: 0, r2: 2, c2: 3 } });
    expect(back.getCell(b.id, 0, 5).f).toBe('SUM(Sales[Amount])');
    expect(back.getCell(b.id, 1, 3).f).toBe('[@Qty]*[@Price]');
    expect(back.getValue(b.id, 0, 5)).toBe(35); // the formula filled the whole column
    expect(back.sheets[0].tables[0].calc).toEqual({ 3: '[@Qty]*[@Price]' });
    wb.deleteTable(id, tid);
    expect(wb.tablesOn(id)).toHaveLength(0);
    expect(f('F1')).toBe('SUM($D$2:$D$3)');
    expect(f('D2')).toBe('$B$2*$C$2');
    expect(f('D3')).toBe('$B$3*$C$3');
    expect(val('F1')).toBe(35);
    expect(wb.sheet(id).filter).toBeNull();
  });
});

describe('calculated columns', () => {
  it.each(['insert rows above', 'insert first data row', 'delete first data row', 'delete rows above', 'insert columns', 'delete columns'])('keeps calculated columns correct after %s', async (operation) => {
    const { wb, id, put, tid } = book();
    put('D2', '=B2*C2');
    if (operation === 'delete rows above') wb.insertRows(id, 0, 3);
    wb.clearHistory();
    const before = wb.toJSON();
    if (operation === 'insert rows above') wb.insertRows(id, 0, 2);
    if (operation === 'insert first data row') wb.insertRows(id, 1, 2);
    if (operation === 'delete first data row') wb.deleteRows(id, 1, 1);
    if (operation === 'delete rows above') wb.deleteRows(id, 0, 2);
    if (operation === 'insert columns') wb.insertCols(id, 1, 2);
    if (operation === 'delete columns') wb.deleteCols(id, 0, 1);
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    wb.redo();
    const restored = await workbookFromFile(await workbookToXlsx(wb), 'edited.xlsx');
    const sheet = restored.sheetByName('Sheet1');
    const table = sheet.tables[0];
    const row = restored.addTableRow(sheet.id, table.id);
    const resultCol = table.range.c2;
    restored.setInput(sheet.id, row, resultCol - 2, '7');
    restored.setInput(sheet.id, row, resultCol - 1, '3');
    expect(restored.getValue(sheet.id, row, resultCol)).toBe(21);
    expect(wb.tableById(id, tid)).toBeTruthy();
  });

  it('keeps relative references to another sheet when inserting the first data rows', async () => {
    const { wb, id, put, tid } = book();
    const rates = wb.addSheet('Rates');
    for (let r = 0; r < 4; r++) wb.setInput(rates.id, r, 0, String(r + 1));
    put('D2', '=B2*Rates!A1');
    wb.insertRows(id, 1, 2);
    const restored = await workbookFromFile(await workbookToXlsx(wb), 'inserted.xlsx');
    const sheet = restored.sheetByName('Sheet1');
    const row = restored.addTableRow(sheet.id, sheet.tables[0].id);
    restored.setInput(sheet.id, row, 1, '7');
    expect(restored.getCell(sheet.id, row, 3).f).toBe('B6*Rates!A3');
    expect(restored.getValue(sheet.id, row, 3)).toBe(21);
  });

  it('updates templates when rows are inserted and deleted in a referenced sheet', () => {
    const { wb, id, put, tid } = book();
    const rates = wb.addSheet('Rates');
    wb.setInput(rates.id, 1, 0, '3');
    put('D2', '=B2*Rates!$A$2');
    wb.insertRows(rates.id, 0, 2);
    wb.deleteRows(rates.id, 0, 1);
    const row = wb.addTableRow(id, tid);
    wb.setInput(id, row, 1, '7');
    expect(wb.getCell(id, row, 3).f).toBe('B4*Rates!$A$3');
    expect(wb.getValue(id, row, 3)).toBe(21);
  });

  it.each(['sheet', 'table', 'column'])('keeps newly added rows correct after a %s rename', async (kind) => {
    const { wb, id, put, tid } = book();
    const source = wb.addSheet('Rates');
    wb.setInput(source.id, 0, 0, '3');
    const initial = kind === 'sheet' ? 'Rates!$A$1*[@Qty]' : 'Sales[@Qty]*[@Price]';
    const expected = kind === 'sheet' ? "'New Rates'!$A$1*[@Qty]" : kind === 'table' ? 'Orders[@Qty]*[@Price]' : 'Sales[@Count]*[@Price]';
    put('D2', `=${initial}`);
    if (kind === 'sheet') wb.renameSheet(source.id, 'New Rates');
    else if (kind === 'table') wb.updateTable(id, tid, { name: 'Orders' });
    else put('B1', 'Count');
    expect(wb.getCell(id, 1, 3).f).toBe(expected);
    expect(wb.tableById(id, tid).calc[3]).toBe(expected);
    wb.undo();
    expect(wb.tableById(id, tid).calc[3]).toBe(initial);
    wb.redo();
    expect(wb.tableById(id, tid).calc[3]).toBe(expected);
    // The template survives saving and is used when a user adds the next row.
    const restored = await workbookFromFile(await workbookToXlsx(wb), 'renamed.xlsx');
    const sheet = restored.sheetByName(wb.sheet(id).name);
    const row = restored.addTableRow(sheet.id, sheet.tables[0].id);
    restored.setInput(sheet.id, row, 1, '2');
    restored.setInput(sheet.id, row, 2, '4');
    expect(restored.getCell(sheet.id, row, 3).f).toBe(expected);
    expect(restored.getValue(sheet.id, row, 3)).toBe(kind === 'sheet' ? 6 : 8);
  });

  it('fills an empty column with a typed formula and gives new rows the same formula', () => {
    const { wb, id, put, val, f, tid } = book();
    put('D2', '=[@Qty]*[@Price]');
    expect(f('D3')).toBe('[@Qty]*[@Price]');
    expect(val('D3')).toBe(20);
    expect(wb.tableById(id, tid).calc).toEqual({ 3: '[@Qty]*[@Price]' });
    // A1-style formulas shift row by row.
    put('E1', 'Double'); // a new header beside the table extends it
    put('E2', '=B2*2');
    expect(f('E3')).toBe('B3*2');
    expect(val('E3')).toBe(10);
    // A new row below picks up both formulas.
    put('A4', 'Tape'); put('B4', '2'); put('C4', '3');
    expect(f('D4')).toBe('[@Qty]*[@Price]');
    expect(val('D4')).toBe(6);
    expect(f('E4')).toBe('B4*2');
    // Typing a value over one cell of a calculated column only changes that cell.
    put('D3', '99');
    expect(val('D3')).toBe(99);
    expect(f('D2')).toBe('[@Qty]*[@Price]');
    // A column with other content is left alone.
    put('A2', '=1');
    expect(val('A3')).toBe('Ink');
    // Deleting a column keeps the calculated-column bookkeeping straight.
    wb.deleteCols(id, 1, 1);
    expect(wb.tableById(id, tid).calc).toEqual({ 2: '#REF!*[@Price]', 3: '#REF!*2' });
    expect(f('C2')).toBe('#REF!*[@Price]'); // the column's cells and its template both lose the deleted column
    expect(f('D2')).toBe('#REF!*2'); // the referenced Qty column was deleted
    const nextRow = wb.addTableRow(id, tid);
    expect(wb.getValue(id, nextRow, 3)).toEqual({ error: '#REF!' });
  });
});

describe('things drawn over a table grow with it', () => {
  it('extends charts, conditional formats, and validation rules that ended at the last row', () => {
    const { wb, id, put, tid } = book();
    const chartId = wb.addChart(id, { type: 'column', range: parseRange('A1:C3'), anchor: { r: 0, c: 6 } });
    const ruleId = wb.addRule(id, { range: parseRange('B2:B3'), type: 'gt', value: 5, style: { bold: true } });
    wb.addValidation(id, { range: parseRange('C2:C3'), type: 'number', min: 0, strict: false });
    wb.addRule(id, { range: parseRange('F1:F3'), type: 'gt', value: 5, style: { bold: true } }); // outside: untouched
    put('A4', 'Tape'); put('B4', '2');
    expect(wb.tableById(id, tid).range.r2).toBe(3);
    expect(wb.chartById(id, chartId).range).toEqual({ r1: 0, c1: 0, r2: 3, c2: 2 });
    expect(wb.sheet(id).rules.find((r) => r.id === ruleId).range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 1 });
    expect(wb.validationAt(id, 3, 2)?.type).toBe('number');
    expect(wb.sheet(id).rules.find((r) => r.range.c1 === 5).range.r2).toBe(2);
    wb.undo(); // B4
    wb.undo(); // A4, which grew the table and everything on it
    expect(wb.chartById(id, chartId).range.r2).toBe(2);
    expect(wb.tableById(id, tid).range.r2).toBe(2);
  });
});

describe('table-aware range inputs', () => {
  it('resolves table names and columns for validation lists and range boxes', () => {
    const { wb, id, put } = book();
    wb.addValidation(id, { range: parseRange('H1:H5'), type: 'list', source: 'Sales[Item]', strict: false });
    expect(wb.listOptionsFor(id, wb.validationAt(id, 0, 7))).toEqual(['Pens', 'Ink']);
    put('A4', 'Tape'); // the table grows, and so does the list
    expect(wb.listOptionsFor(id, wb.validationAt(id, 0, 7))).toEqual(['Pens', 'Ink', 'Tape']);
    expect(wb.rangeFromText(id, 'Sales')).toEqual({ sheetId: id, range: { r1: 0, c1: 0, r2: 3, c2: 3 } });
    expect(wb.rangeFromText(id, 'Sales[[#Headers],[Qty]:[Price]]')).toEqual({ sheetId: id, range: { r1: 0, c1: 1, r2: 0, c2: 2 } });
    expect(wb.rangeFromText(id, 'b2:c3')).toEqual({ sheetId: id, range: { r1: 1, c1: 1, r2: 2, c2: 2 } });
    wb.defineName('Prices', 'Sheet1!$C$2:$C$4');
    expect(wb.rangeFromText(id, 'Prices')?.range).toEqual({ r1: 1, c1: 2, r2: 3, c2: 2 });
    expect(wb.rangeFromText(id, 'Nope[Qty]')).toBeNull();
    expect(wb.rangeFromText(id, 'A:A')).toEqual({ sheetId: id, range: { r1: 0, c1: 0, r2: MAX_ROW, c2: 0 } });
  });
});

describe('adding rows to a table', () => {
  it('appends a data row, above the totals row when there is one, with the calculated columns', () => {
    const { wb, id, put, f, tid } = book();
    put('D2', '=[@Qty]*[@Price]');
    expect(wb.addTableRow(id, tid)).toBe(3);
    expect(wb.tableById(id, tid).range.r2).toBe(3);
    expect(f('D4')).toBe('[@Qty]*[@Price]');
    wb.setTableTotals(id, tid, true);
    expect(wb.tableById(id, tid).range.r2).toBe(4);
    expect(wb.addTableRow(id, tid)).toBe(4);
    expect(wb.getValue(id, 5, 0)).toBe('Total'); // the totals row moved down
    expect(f('D5')).toBe('[@Qty]*[@Price]');
    expect(wb.tableById(id, tid).range.r2).toBe(5);
    wb.undo();
    expect(wb.getValue(id, 4, 0)).toBe('Total');
  });
});

describe('tables on duplicated and imported sheets', () => {
  it.each(['duplicate', 'import'])('keeps table templates and rules pointing inside the %s copy', (operation) => {
    const { wb, id, put } = book();
    put('D2', '=Sheet1!$C$2*[@Qty]');
    wb.addValidation(id, { range: parseRange('H1:H3'), type: 'list', source: 'Sheet1!A2:A3' });
    wb.addRule(id, { range: parseRange('H1:H3'), type: 'formula', value: '=Sheet1!$B$2>5', style: { bold: true } });
    const copy = operation === 'duplicate' ? wb.duplicateSheet(id) : wb.importSheets(wb)[0];
    wb.setInput(copy.id, 1, 0, 'Copy');
    wb.setInput(copy.id, 1, 1, '1');
    wb.setInput(copy.id, 1, 2, '7');
    const row = wb.addTableRow(copy.id, copy.tables[0].id);
    wb.setInput(copy.id, row, 1, '2');
    expect(wb.getValue(copy.id, row, 3)).toBe(14);
    expect(wb.listOptionsFor(copy.id, wb.sheet(copy.id).validations[0])).toEqual(['Copy', 'Ink']);
    expect(wb.conditionalStyle(copy.id, 0, 7, null)).toBeNull();
    expect(wb.getValue(id, 1, 3)).toBe(15);
  });

  it('keeps every table rename in calculated-column templates when copying multiple tables', () => {
    const { wb, id, put } = book();
    put('G1', 'Rate'); put('G2', '2'); put('G3', '3');
    wb.addTable(id, parseRange('G1:G3'), { name: 'Rates' });
    put('D2', '=Sales[@Qty]*SUM(Rates[Rate])');
    const copy = wb.duplicateSheet(id);
    const table = copy.tables.find((t) => t.name === 'Sales2');
    expect(wb.getCell(copy.id, 1, 3).f).toBe('Sales2[@Qty]*SUM(Rates2[Rate])');
    expect(table.calc[3]).toBe('Sales2[@Qty]*SUM(Rates2[Rate])');
    const row = wb.addTableRow(copy.id, table.id);
    wb.setInput(copy.id, row, 1, '4');
    expect(wb.getCell(copy.id, row, 3).f).toBe('Sales2[@Qty]*SUM(Rates2[Rate])');
    expect(wb.getValue(copy.id, row, 3)).toBe(20);
  });

  it('get unique names, with the copy\'s formulas following', () => {
    const { wb, id, put, f } = book();
    put('F1', '=SUM(Sales[Qty])');
    const copy = wb.duplicateSheet(id);
    expect(copy.tables[0].name).toBe('Sales2');
    expect(wb.getCell(copy.id, 0, 5).f).toBe('SUM(Sales2[Qty])');
    expect(f('F1')).toBe('SUM(Sales[Qty])'); // the original is untouched
    expect(wb.getValue(copy.id, 0, 5)).toBe(15);
    // Importing a workbook with a clashing table name does the same.
    const other = book().wb;
    other.setInput(other.sheets[0].id, 0, 5, '=COUNTA(Sales[Item])');
    const [added] = wb.importSheets(other);
    expect(added.tables[0].name).toBe('Sales3');
    expect(wb.getCell(added.id, 0, 5).f).toBe('COUNTA(Sales3[Item])');
    expect(wb.getValue(added.id, 0, 5)).toBe(2);
  });
});

describe('pasted and filled rows join a table', () => {
  it('extends the table over a block written right under it and fills calculated columns', () => {
    const { wb, id, put, f, tid } = book();
    put('D2', '=[@Qty]*[@Price]');
    wb.pasteValues(id, [['Tape', 2, 3], ['Glue', 1, 4]], 3, 0);
    expect(wb.extendTableToCover(id, { r1: 3, c1: 0, r2: 4, c2: 2 })).toBe(true);
    expect(wb.tableById(id, tid).range.r2).toBe(4);
    expect(f('D4')).toBe('[@Qty]*[@Price]');
    expect(wb.getValue(id, 4, 3)).toBe(4);
    // A block that starts elsewhere, or beside the table, leaves it alone.
    expect(wb.extendTableToCover(id, { r1: 7, c1: 0, r2: 8, c2: 2 })).toBe(false);
    expect(wb.extendTableToCover(id, { r1: 5, c1: 6, r2: 5, c2: 7 })).toBe(false);
    wb.setTableTotals(id, tid, true);
    expect(wb.extendTableToCover(id, { r1: 6, c1: 0, r2: 6, c2: 2 })).toBe(false); // not under a totals row
  });
});

describe('duplicate column names', () => {
  it('suffixes a typed header that repeats another column and re-points formulas to the suffixed name', () => {
    const { wb, id, put, val, f } = book();
    put('G1', '=SUM(Sales[Price])');
    expect(val('G1')).toBe(5.5);
    put('C1', 'Qty');
    expect(wb.tableColumns(id, wb.sheet(id).tables[0])).toEqual(['Item', 'Qty', 'Qty2', 'Amount']);
    expect(val('C1')).toBe('Qty2');
    expect(f('G1')).toBe('SUM(Sales[Qty2])');
    expect(val('G1')).toBe(5.5);
    wb.undo();
    expect(val('C1')).toBe('Price');
    expect(f('G1')).toBe('SUM(Sales[Price])');
  });

  it('keeps pasted headers distinct in order, ignoring case', () => {
    const { wb, id, val } = book();
    wb.setCellsWithTableHeaders(id, [
      { r: 0, c: 1, cell: { v: 'Total', f: null } },
      { r: 0, c: 2, cell: { v: 'total', f: null } },
      { r: 0, c: 3, cell: { v: 'TOTAL', f: null } },
    ], 'Paste');
    expect([val('B1'), val('C1'), val('D1')]).toEqual(['Total', 'total2', 'TOTAL3']);
  });

  it('turns a formula header into its text, numbered when it repeats a column, and leaves blank headers alone', () => {
    const { wb, id, put } = book();
    put('C1', '=B1');
    expect(wb.getCell(id, 0, 2)).toMatchObject({ v: 'Qty2', f: null });
    put('D1', '');
    expect(wb.tableColumns(id, wb.sheet(id).tables[0])).toEqual(['Item', 'Qty', 'Qty2', 'Column4']);
  });
});
