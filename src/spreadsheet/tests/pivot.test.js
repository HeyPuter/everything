import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { buildPivot, pivotFields, pivotFieldValues, pivotRangeProblem, PIVOT_ALL } from '../src/core/pivot.js';

function source() {
  const wb = new Workbook({ sheets: [{ name: 'Sales Data' }] });
  const id = wb.sheets[0].id;
  const rows = [
    ['Region', 'Quarter', 'Amount'],
    ['East', 'Q1', '100'], ['West', 'Q1', '50'], ['East', 'Q2', '25'], ['east', 'Q1', '10'], ['North', 'Q2', '7'], ['', 'Q2', '999'],
  ];
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.applyStyle(id, parseRange('C2:C7'), { fmt: 'currency', dec: 0 });
  return { wb, id };
}

/** Place a built pivot on a fresh sheet and read it back. */
function place(wb, built) {
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells, 'pivot');
  const at = (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(sheet.id, r, c); };
  const f = (a1) => { const { r, c } = parseCellRef(a1); return wb.getCell(sheet.id, r, c)?.f; };
  return { at, f, sheet };
}

describe('pivot tables', () => {
  it('lists fields and validates the range', () => {
    const { wb, id } = source();
    expect(pivotFields(wb, id, parseRange('A1:C7')).map((x) => x.label)).toEqual(['Region', 'Quarter', 'Amount']);
    expect(pivotRangeProblem(wb, id, parseRange('A1:C1'))).toMatch(/header row/);
    expect(pivotRangeProblem(wb, id, parseRange('A1:A7'))).toMatch(/two columns/);
    expect(pivotRangeProblem(wb, id, parseRange('A1:C7'))).toBeNull();
  });

  it('summarizes one field with live SUMIFS formulas and a total', () => {
    const { wb, id } = source();
    const built = buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: null, valueField: 2, agg: 'sum' });
    expect(built.rowCount).toBe(4); // East (case-insensitive), North, West, and the rows with no region
    const { at, f } = place(wb, built);
    expect(at('A1')).toBe('Region');
    expect(at('B1')).toBe('Sum of Amount');
    expect([at('A2'), at('A3'), at('A4'), at('A5')]).toEqual(['East', 'North', 'West', '(blank)']);
    expect(f('B2')).toBe("SUMIFS('Sales Data'!$C$2:$C$7,'Sales Data'!$A$2:$A$7,$A2)");
    expect(at('B2')).toBe(135);
    expect(at('B3')).toBe(7);
    expect(at('B4')).toBe(50);
    expect([at('A5'), at('B5')]).toEqual(['(blank)', 999]); // the rows with no region, so the categories add up
    expect(at('A6')).toBe('Total');
    expect(at('B6')).toBe(1191); // SUM of the whole column
    // The value column's number format carries over.
    expect(wb.getCell(wb.sheets[1].id, 1, 1).s).toMatchObject({ fmt: 'currency', dec: 0 });
    // Live: change the data and the pivot follows.
    wb.setInput(id, 1, 2, '200');
    expect(at('B2')).toBe(235);
  });

  it('crosses rows with columns and supports every aggregation', () => {
    const { wb, id } = source();
    const sum = place(wb, buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: 1, valueField: 2, agg: 'sum' }));
    expect([sum.at('B1'), sum.at('C1'), sum.at('D1')]).toEqual(['Q1', 'Q2', 'Total']);
    expect(sum.at('B2')).toBe(110); // East Q1 (100 + 10)
    expect(sum.at('C2')).toBe(25);
    expect(sum.at('D2')).toBe(135);
    expect([sum.at('A5'), sum.at('B5'), sum.at('C5'), sum.at('D5')]).toEqual(['(blank)', '', 999, 999]); // the row with no region
    expect(sum.at('B6')).toBe(160); // Q1 total
    expect(sum.at('D6')).toBe(1191);
    const count = place(wb, buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 1, colField: null, valueField: 2, agg: 'count' }));
    expect(count.f('B2')).toBe("COUNTIFS('Sales Data'!$B$2:$B$7,$A2,'Sales Data'!$C$2:$C$7,\"<>\")");
    expect(count.at('B2')).toBe(3); // three Q1 rows
    expect(count.at('B4')).toBe(6);
    const avg = place(wb, buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: null, valueField: 2, agg: 'average' }));
    expect(avg.at('B2')).toBe(45);
    const max = place(wb, buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: null, valueField: 2, agg: 'max' }));
    expect(max.at('B4')).toBe(50);
    const min = place(wb, buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: null, valueField: 2, agg: 'min' }));
    expect(min.at('B2')).toBe(10);
  });
});

describe('pivot filters', () => {
  it('lists a field\'s values', () => {
    const { wb, id } = source();
    expect(pivotFieldValues(wb, id, parseRange('A1:C7'), 1)).toEqual(['Q1', 'Q2']);
    expect(pivotFieldValues(wb, id, parseRange('A1:C7'), 0)).toEqual(['East', 'North', 'West']);
  });

  it('puts the filter in a cell above the table that every formula reads, with (All) for no filter', () => {
    const { wb, id } = source();
    const built = buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: null, valueField: 2, agg: 'sum', filters: [{ field: 1, value: 'Q1' }] });
    expect(built.headerRow).toBe(2);
    expect(built.filterCells).toEqual([{ r: 0, c: 1, values: [PIVOT_ALL, 'Q1', 'Q2'] }]);
    const { at, f, sheet } = place(wb, built);
    expect(at('A1')).toBe('Quarter');
    expect(at('B1')).toBe('Q1');
    expect(at('A3')).toBe('Region');
    expect(at('B3')).toBe('Sum of Amount');
    expect(f('B4')).toContain("SUMIFS('Sales Data'!$C$2:$C$7,'Sales Data'!$A$2:$A$7,");
    expect(f('B4')).toContain(`CHOOSE(IF($B$1="(All)",1,2),'Sales Data'!$C$2:$C$7,'Sales Data'!$B$2:$B$7),IF($B$1="(All)","<>",`);
    expect([at('A4'), at('B4')]).toEqual(['East', 110]); // East in Q1: 100 + 10
    expect(at('B5')).toBe(''); // North has no Q1 rows
    expect(at('B6')).toBe(50);
    expect([at('A7'), at('B7')]).toEqual(['(blank)', '']); // the row with no region is a Q2 row
    expect(at('A8')).toBe('Total');
    expect(at('B8')).toBe(160); // the grand total honors the filter too
    // Picking another value in the filter cell re-filters the live table.
    wb.setInput(sheet.id, 0, 1, 'Q2');
    expect(at('B4')).toBe(25);
    expect(at('B8')).toBe(1031);
    wb.setInput(sheet.id, 0, 1, PIVOT_ALL);
    expect(at('B4')).toBe(135);
    expect(at('B8')).toBe(1191);
  });

  it('starts at (All) for an unknown value, works with columns and counts, and ignores a filter on the row field', () => {
    const { wb, id } = source();
    const crossed = place(wb, buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: 1, valueField: 2, agg: 'count', filters: [{ field: 2, value: 'nope' }] }));
    expect(crossed.at('A1')).toBe('Amount');
    expect(crossed.at('B1')).toBe(PIVOT_ALL);
    expect([crossed.at('B3'), crossed.at('C3'), crossed.at('D3')]).toEqual(['Q1', 'Q2', 'Total']);
    expect(crossed.f('B4')).toContain("COUNTIFS('Sales Data'!$A$2:$A$7,$A4,'Sales Data'!$B$2:$B$7,B$3,");
    expect(crossed.f('B4')).toContain(`CHOOSE(IF($B$1="(All)",1,2),'Sales Data'!$C$2:$C$7,'Sales Data'!$C$2:$C$7),IF($B$1="(All)","<>",`);
    expect(crossed.at('B4')).toBe(2); // East, Q1
    expect(crossed.at('D7')).toBe(1); // the row with no region
    expect(crossed.at('D8')).toBe(6); // every row has an amount
    wb.setInput(crossed.sheet.id, 0, 1, '50');
    expect(crossed.at('B4')).toBe('');
    expect(crossed.at('B6')).toBe(1); // West 50
    const same = buildPivot(wb, id, { range: parseRange('A1:C7'), rowField: 0, colField: null, valueField: 2, agg: 'sum', filters: [{ field: 0, value: 'East' }] });
    expect(same.headerRow).toBe(0);
    expect(same.filterCells).toEqual([]);
  });
});

describe('pivots over tables', () => {
  it('reference the table\'s columns by name and follow new rows', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Pivot' }] });
    const [data, out] = wb.sheets;
    const put = (a1, t) => { const { r, c } = parseCellRef(a1); wb.setInput(data.id, r, c, t); };
    put('A1', 'Region'); put('B1', 'Amount');
    put('A2', 'West'); put('B2', '10'); put('A3', 'East'); put('B3', '5'); put('A4', 'West'); put('B4', '20');
    wb.addTable(data.id, parseRange('A1:B4'), { name: 'Sales' });
    const built = buildPivot(wb, data.id, { range: parseRange('A1:B4'), rowField: 0, colField: null, valueField: 1, agg: 'sum' });
    const formulas = built.cells.filter((c) => c.cell.f).map((c) => c.cell.f);
    expect(formulas[0]).toBe('SUMIFS(Sales[Amount],Sales[Region],$A2)');
    expect(formulas.at(-1)).toBe('SUM($B$2:$B$3)'); // the categories, so the rows always add up to the total
    wb.setCells(out.id, built.cells.map(({ r, c, cell }) => ({ r, c, cell })), 'Pivot');
    expect(wb.getValue(out.id, 1, 1)).toBe(5); // East
    expect(wb.getValue(out.id, 2, 1)).toBe(30); // West
    expect(wb.getValue(out.id, 3, 1)).toBe(35);
    put('A5', 'East'); put('B5', '7'); // the table grows, and so do the pivot's sums
    expect(wb.getValue(out.id, 1, 1)).toBe(12);
    expect(wb.getValue(out.id, 3, 1)).toBe(42);
  });
});
