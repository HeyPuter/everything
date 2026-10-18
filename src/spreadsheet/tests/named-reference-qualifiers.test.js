import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

function setup() {
  const wb = new Workbook(), id = wb.activeSheetId;
  const calc = (formula) => { wb.setInput(id, 9, 9, `=${formula}`); return wb.getValue(id, 9, 9); };
  return { wb, id, calc };
}

it.each(['Sheet1!B2#', 'Sheet1!$B$2#', "'Sheet1'!B2#"])
  ('retains the entire named spill %s', (ref) => {
    const { wb, id, calc } = setup();
    wb.setInput(id, 1, 1, '=SEQUENCE(3,2)');
    expect(wb.defineName('Spilled', ref)).toBeNull();
    expect(calc('SUM(Spilled)')).toBe(21);
    expect(calc('ROWS(Spilled)')).toBe(3);
    expect(calc('COLUMNS(Spilled)')).toBe(2);
    expect(calc('ROW(INDEX(Spilled,3,2))')).toBe(4);
    expect(calc('COLUMN(INDEX(Spilled,3,2))')).toBe(3);
  });

it('updates a named spill after growth, shrinking, edits, and undo', () => {
  const { wb, id, calc } = setup();
  wb.setInput(id, 1, 1, '=SEQUENCE(3)');
  wb.defineName('Spilled', 'Sheet1!B2#');
  expect(calc('SUM(Spilled)')).toBe(6);
  wb.setInput(id, 1, 1, '=SEQUENCE(5)');
  expect(wb.getValue(id, 9, 9)).toBe(15);
  wb.undo();
  expect(wb.getValue(id, 9, 9)).toBe(6);
  wb.setInput(id, 1, 1, '=SEQUENCE(2)');
  expect(wb.getValue(id, 9, 9)).toBe(3);
});

it.each(['empty', 'scalar', 'blocked'])('reports an invalid named spill when its anchor is %s', (kind) => {
  const { wb, id, calc } = setup();
  if (kind === 'scalar') wb.setInput(id, 1, 1, '42');
  if (kind === 'blocked') {
    wb.setInput(id, 1, 1, '=SEQUENCE(3)');
    wb.setInput(id, 2, 1, 'occupied');
  }
  wb.defineName('Spilled', 'Sheet1!B2#');
  expect(calc('SUM(Spilled)')).toEqual({ error: '#REF!' });
});

it('discovers a named spill from a covered cell before reading the anchor', () => {
  const { wb, id } = setup();
  const other = wb.addSheet("Source Data").id;
  wb.setInput(other, 1, 1, '=SEQUENCE(3,2)');
  wb.defineName('Spilled', "'Source Data'!B2#");
  wb.setInput(id, 0, 0, '=Spilled');
  expect(wb.getValue(id, 2, 1)).toBe(6);
});

it.each(['Sheet1:Sheet3!B2', 'Sheet1:Sheet3!$B$2:$C$3', "'Sheet1':'Sheet3'!B2"])
  ('includes every sheet in named 3-D reference %s', (ref) => {
    const { wb, id, calc } = setup();
    const mid = wb.addSheet('Sheet2').id, last = wb.addSheet('Sheet3').id;
    [id, mid, last].forEach((sheet, i) => wb.setInput(sheet, 1, 1, String(i + 1)));
    expect(wb.defineName('Across', ref)).toBeNull();
    expect(calc('SUM(Across)')).toBe(6);
    expect(calc('COUNT(Across)')).toBe(3);
    expect(calc('AVERAGE(Across)')).toBe(2);
    wb.setInput(mid, 1, 1, '10');
    expect(calc('SUM(Across)')).toBe(14);
  });

it.each(['Sheet1:Sheet3!A1#', 'Sheet1!A:A#'])
  ('rejects the same malformed named spill as the formula parser: %s', (ref) => {
    const { wb } = setup();
    expect(wb.defineName('Invalid', ref)).toBeTypeOf('string');
    expect(wb.names).toHaveLength(0);
  });

it('reads Sheet1!A1:B2# as the range from A1 to the spill of B2, as the formula parser does', () => {
  const { wb, id, calc } = setup();
  wb.setInput(id, 1, 1, '=SEQUENCE(3,2)');
  wb.setInput(id, 0, 0, '100');
  expect(wb.defineName('Block', 'Sheet1!A1:B2#')).toBeNull();
  expect(calc('SUM(Block)')).toBe(121);
  expect(calc('ROWS(Block)')).toBe(4);
  expect(calc('COLUMNS(Block)')).toBe(3);
});

it('retains spill and sheet-span names after XLSX reopening', async () => {
  let { wb, id, calc } = setup();
  const other = wb.addSheet('Sheet2').id;
  wb.setInput(id, 1, 1, '=SEQUENCE(3)');
  wb.setInput(other, 1, 1, '10');
  wb.defineName('Spilled', 'Sheet1!B2#');
  wb.defineName('Across', 'Sheet1:Sheet2!B2');
  expect(calc('SUM(Spilled)+SUM(Across)')).toBe(17);
  wb = await workbookFromFile(await workbookToXlsx(wb), 'names.xlsx');
  expect(wb.getValue(wb.sheets[0].id, 9, 9)).toBe(17);
});
