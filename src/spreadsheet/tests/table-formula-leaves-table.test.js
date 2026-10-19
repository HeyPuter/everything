import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange, parseCellRef } from '../src/core/cell.js';
import { composePaste } from '../src/core/paste-special.js';

// A bare structured reference ([@Qty]) reads the table its formula sits in. Copied, filled or moved out of the
// table it read #REF!, and pasted into another table with a Qty column it silently read that table's numbers.
// As in Excel, a formula leaving its table now names it (Sales[@Qty]); one pasted within the table, or into rows
// the table then grows over, keeps the bare form.
function book() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const put = (sheetId, a1, text) => { const { r, c } = parseCellRef(a1); wb.setInput(sheetId, r, c, text); };
  [['A1', 'Qty'], ['B1', 'Price'], ['C1', 'Total'], ['A2', '2'], ['B2', '10'], ['A3', '3'], ['B3', '20'], ['A4', '4'], ['B4', '30']].forEach(([a, t]) => put(id, a, t));
  wb.addTable(id, parseRange('A1:C4'), { name: 'Sales' });
  for (let r = 1; r <= 3; r++) wb.setInput(id, r, 2, '=[@Qty]*[@Price]');
  [['H1', 'Qty'], ['I1', 'Price'], ['J1', 'Out'], ['H2', '100'], ['I2', '1'], ['H3', '200'], ['I3', '2'], ['H4', '300'], ['I4', '3']].forEach(([a, t]) => put(id, a, t));
  wb.addTable(id, parseRange('H1:J4'), { name: 'Other' });
  const other = wb.addSheet('Other sheet');
  return { wb, id, other: other.id };
}
const at = (wb, id, a1) => { const { r, c } = parseCellRef(a1); return { f: wb.getCell(id, r, c)?.f, v: wb.getValue(id, r, c) }; };
const copy = (wb, id, a1) => { const range = parseRange(a1); return { cells: wb.copyRange(id, range, { sameBook: true }), origin: { r: range.r1, c: range.c1, sheetId: id } }; };

describe('a table formula carried out of its table', () => {
  it('names its table when pasted outside any table, into another table or onto another sheet', () => {
    const { wb, id, other } = book();
    const { cells, origin } = copy(wb, id, 'C3');
    wb.pasteCells(id, cells, 2, 4, origin); // E3
    expect(at(wb, id, 'E3')).toEqual({ f: 'Sales[@Qty]*Sales[@Price]', v: 60 });
    wb.pasteCells(id, cells, 2, 9, origin); // J3, in Other, which has a Qty and a Price of its own
    expect(at(wb, id, 'J3')).toEqual({ f: 'Sales[@Qty]*Sales[@Price]', v: 60 });
    wb.pasteCells(other, cells, 2, 1, origin); // B3 of another sheet
    expect(at(wb, other, 'B3')).toEqual({ f: 'Sales[@Qty]*Sales[@Price]', v: 60 });
    wb.undo();
    expect(wb.getCell(other, 2, 1)).toBeUndefined();
  });

  it('keeps the bare form pasted within its own table', () => {
    const { wb, id } = book();
    const { cells, origin } = copy(wb, id, 'C2');
    wb.pasteCells(id, cells, 3, 2, origin);
    expect(at(wb, id, 'C4')).toEqual({ f: '[@Qty]*[@Price]', v: 120 });
  });

  it('names its table pasted transposed, and in a Paste Special that adds', () => {
    const { wb, id } = book();
    const { cells, origin } = copy(wb, id, 'C2:C3');
    wb.pasteCells(id, cells, 1, 4, origin, null, { transpose: true }); // E2:F2
    expect(at(wb, id, 'E2').f).toBe('Sales[@Qty]*Sales[@Price]');
    expect(at(wb, id, 'F2').f).toBe('Sales[@Qty]*Sales[@Price]');
    wb.setInput(id, 5, 4, '5');
    composePaste(wb, id, { cells: cells.slice(0, 1), origin }, 5, 4, null, { what: 'formulas', operation: 'add' }, { rows: 1000, cols: 100 });
    expect(at(wb, id, 'E6').f).toMatch(/Sales\[@Qty\]\*Sales\[@Price\]/);
  });

  it('keeps the bare form in rows pasted under the table that the table grows over', () => {
    const { wb, id } = book();
    const { cells, origin } = copy(wb, id, 'A4:C4');
    wb.pasteCells(id, cells, 4, 0, origin); // A5:C5, outside the table as it is written
    expect(at(wb, id, 'C5').f).toBe('Sales[@Qty]*Sales[@Price]');
    wb.extendTableToCover(id, parseRange('A5:C5')); // as the editor does after a paste beside a table
    expect(wb.sheet(id).tables[0].range).toEqual(parseRange('A1:C5'));
    expect(at(wb, id, 'C5')).toEqual({ f: '[@Qty]*[@Price]', v: 120 });
    // A column pasted beside the table joins it the same way.
    const column = copy(wb, id, 'C2:C3');
    wb.pasteCells(id, column.cells, 1, 3, column.origin); // D2:D3
    expect(at(wb, id, 'D2').f).toBe('Sales[@Qty]*Sales[@Price]');
    wb.extendTableToCover(id, parseRange('D2:D3'));
    expect(wb.sheet(id).tables[0].range).toEqual(parseRange('A1:D5'));
    expect(at(wb, id, 'D2')).toEqual({ f: '[@Qty]*[@Price]', v: 20 });
    wb.undo();
    expect(wb.sheet(id).tables[0].range).toEqual(parseRange('A1:C5'));
    expect(at(wb, id, 'D2').f).toBe('Sales[@Qty]*Sales[@Price]');
  });

  it('names its table filled out of it across, and stays bare filled down into rows the table takes in', () => {
    const { wb, id } = book();
    wb.fill(id, parseRange('C3'), parseRange('C3:D3'));
    // Filled across, the columns move along (Qty→Price, Price→Total), as Excel moves them.
    expect(at(wb, id, 'D3')).toEqual({ f: 'Sales[@Price]*Sales[@Total]', v: 1200 });
    wb.fill(id, parseRange('C4'), parseRange('C4:C6'));
    expect(wb.sheet(id).tables[0].range).toEqual(parseRange('A1:C6'));
    expect(at(wb, id, 'C6').f).toBe('[@Qty]*[@Price]');
  });

  it('names its table cut or dragged out of it, and keeps the bare form moved within it or with the whole table', () => {
    const cut = book();
    const from = { sheetId: cut.id, range: parseRange('C3'), all: true };
    expect(cut.wb.placeMoved(cut.id, 7, 4, cut.wb.copyRange(cut.id, from.range, { sameBook: true }), from)).toBeTruthy(); // E8
    expect(at(cut.wb, cut.id, 'E8').f).toBe('Sales[@Qty]*Sales[@Price]');

    const across = book();
    const fromAcross = { sheetId: across.id, range: parseRange('C2'), all: true };
    across.wb.placeMoved(across.other, 1, 1, across.wb.copyRange(across.id, fromAcross.range, { sameBook: true }), fromAcross);
    expect(at(across.wb, across.other, 'B2')).toEqual({ f: 'Sales[@Qty]*Sales[@Price]', v: 20 });

    const drag = book();
    drag.wb.moveRange(drag.id, parseRange('C4'), 3, 9); // J4, in Other
    expect(at(drag.wb, drag.id, 'J4')).toEqual({ f: 'Sales[@Qty]*Sales[@Price]', v: 120 });

    const within = book();
    within.wb.setInput(within.id, 3, 2, '');
    within.wb.moveRange(within.id, parseRange('C3'), 3, 2);
    expect(at(within.wb, within.id, 'C4').f).toBe('[@Qty]*[@Price]');

    const whole = book();
    whole.wb.moveRange(whole.id, parseRange('A1:C4'), 10, 0);
    expect(at(whole.wb, whole.id, 'C13')).toEqual({ f: '[@Qty]*[@Price]', v: 60 });
  });

  it('names its table when a filtered cut moves it out', () => {
    const { wb, id } = book();
    const cells = wb.copyCells(id, [2], [2], { sameBook: true });
    const carried = wb.transaction('Move cells', () => wb.preparePackedMoveCells(id, id, [2], [2], 7, 4, cells));
    expect(carried[0][0].f).toBe('Sales[@Qty]*Sales[@Price]');
  });

  it('leaves formulas that already name a table, and cells from no table, as they are', () => {
    const { wb, id } = book();
    wb.setInput(id, 1, 9, '=Sales[@Qty]+[@Qty]'); // J2, in Other
    const { cells, origin } = copy(wb, id, 'J2');
    wb.pasteCells(id, cells, 9, 4, origin); // E10
    expect(at(wb, id, 'E10').f).toBe('Sales[@Qty]+Other[@Qty]');
    wb.setInput(id, 9, 6, '=SUM(Sales[Qty])');
    const plain = copy(wb, id, 'G10');
    wb.pasteCells(id, plain.cells, 2, 9, plain.origin); // J3
    expect(at(wb, id, 'J3').f).toBe('SUM(Sales[Qty])');
  });
});
