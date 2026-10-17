import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';
import { evaluate } from '../src/core/formula/evaluator.js';
import { parseFormula } from '../src/core/formula/parser.js';

async function setup(formula) {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (const [i, header] of ['Value', 'Price', 'Result'].entries()) wb.setInput(id, 2, 2 + i, header);
  for (const [i, values] of [[10, 2], [20, 3], [30, 4]].entries()) {
    wb.setInput(id, 3 + i, 2, String(values[0]));
    wb.setInput(id, 3 + i, 3, String(values[1]));
  }
  wb.addTable(id, { r1: 2, c1: 2, r2: 5, c2: 4 }, { name: 'Sales' });
  wb.defineName('Current', formula);
  // Explicit references also work in callers outside the table columns.
  const c = formula.includes('Sales') ? 6 : 4;
  for (let r = 3; r <= 5; r++) wb.setInput(id, r, c, '=Current');
  const copy = await workbookFromFile(await workbookToOds(wb), 'structural.ods');
  return { wb: copy, id: copy.sheets[0].id, c };
}

const formulas = [
  { formula: 'SUM([Value])', values: [60, 60, 60] },
  { formula: 'SUM([@Value])', values: [10, 20, 30] },
  { formula: 'SUM(Sales[@Value])', values: [10, 20, 30] },
  { formula: 'SUM(Sales[@[Value]:[Price]])', values: [12, 23, 34] },
];
const edits = [
  { title: 'rows before the table', method: 'insertRows', at: 0, n: 2, rows: [5, 6, 7], dc: 0 },
  { title: 'a row inside the table', method: 'insertRows', at: 4, n: 1, rows: [3, 5, 6], dc: 0 },
  { title: 'columns before the table', method: 'insertCols', at: 0, n: 2, rows: [3, 4, 5], dc: 2 },
  { title: 'a column inside the source range', method: 'insertCols', at: 3, n: 1, rows: [3, 4, 5], dc: 1 },
  { title: 'deletion before the table rows', method: 'deleteRows', at: 0, n: 1, rows: [2, 3, 4], dc: 0 },
  { title: 'deletion before the table columns', method: 'deleteCols', at: 0, n: 1, rows: [3, 4, 5], dc: -1 },
];
it.each(formulas.flatMap((formula) => edits.map((edit) => ({ ...formula, ...edit }))))(
  'keeps $formula valid after $title in a reopened ODS', async ({ formula, values, method, at, n, rows, dc }) => {
    const { wb, id, c } = await setup(formula);
    const read = (rs, col) => rs.map((r) => wb.getValue(id, r, col));
    expect(read([3, 4, 5], c)).toEqual(values);
    wb[method](id, at, n);
    expect(read(rows, c + dc)).toEqual(values);
    wb.undo();
    expect(read([3, 4, 5], c)).toEqual(values);
    wb.redo();
    expect(read(rows, c + dc)).toEqual(values);
    const again = await workbookFromFile(await workbookToOds(wb), 'edited.ods');
    expect(rows.map((r) => again.getValue(again.sheets[0].id, r, c + dc))).toEqual(values);
  },
);

it('includes inserted source columns in an exported current-row span', async () => {
  const { wb, id, c } = await setup('SUM(Sales[@[Value]:[Price]])');
  wb.insertCols(id, 3, 1);
  wb.setInput(id, 3, 3, '100');
  expect(wb.getValue(id, 3, c + 1)).toBe(112);
});

it('keeps current-row references independent of other dependent rows after insertion', async () => {
  const { wb, id, c } = await setup('SUM(Sales[@Value])');
  wb.setInput(id, 5, 2, '=G4+20');
  wb.insertRows(id, 0, 2);
  expect(wb.getValue(id, 5, c)).toBe(10);
  expect(wb.getValue(id, 7, c)).toBe(30);
  wb.setInput(id, 5, 2, '40');
  expect(wb.getValue(id, 7, c)).toBe(60);
});

it.each([
  // A whole-column or whole-row reference numbers the rows (columns) in use, starting at its first
  // index, however large the sheet: here no used area is known, so only the first.
  ['ROW', 'Data!A:A'], ['COLUMN', 'Data!1:1'],
])('%s reads no cell to answer for %s', (fn, ref) => {
  const failRead = () => { throw new Error('An address check read cell values'); };
  expect(evaluate(parseFormula(`${fn}(${ref})`), {
    sheetExists: () => true, getValue: failRead, getRangeValues: failRead,
  }).values).toEqual([[1]]);
});

it.each(['ROW', 'COLUMN'])('%s reads no cell for a written-out span of the whole grid', (fn) => {
  const failRead = () => { throw new Error('An address check read cell values'); };
  // The point of the guard is that no cell is read. What comes back is the span's own numbering,
  // or #NUM! when the span is longer than an array may be, never a quiet 1 for a range of many rows.
  const got = evaluate(parseFormula(`${fn}(Data!A1:XFD1048576)`), {
    sheetExists: () => true, getValue: failRead, getRangeValues: failRead,
  });
  if (fn === 'ROW') expect(got).toEqual({ error: '#NUM!' });
  else { expect(got.range).toBe(true); expect(got.values[0][0]).toBe(1); expect(got.values[0]).toHaveLength(16384); }
});

it.each(['rows', 'columns'])('keeps other tables usable after deleting a source table’s %s', async (axis) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.defineName('Current', 'SUM([@Value])');
  const tables = axis === 'rows' ? [[2, 2], [8, 2]] : [[2, 2], [2, 8]];
  for (const [i, [r, c]] of tables.entries()) {
    wb.setInput(id, r, c, 'Value'); wb.setInput(id, r, c + 1, 'Result');
    wb.setInput(id, r + 1, c, String((i + 1) * 10));
    wb.addTable(id, { r1: r, c1: c, r2: r + 1, c2: c + 1 }, { name: `Table_${i}` });
    wb.setInput(id, r + 1, c + 1, '=Current');
  }
  const copy = await workbookFromFile(await workbookToOds(wb), 'deleted-source.ods'), target = copy.sheets[0].id;
  copy[axis === 'rows' ? 'deleteRows' : 'deleteCols'](target, 2, 2);
  const row = axis === 'rows' ? 7 : 3, col = axis === 'rows' ? 3 : 7;
  expect(copy.getValue(target, row, col)).toBe(20);
  copy.undo();
  expect(copy.getValue(target, tables[1][0] + 1, tables[1][1] + 1)).toBe(20);
});
