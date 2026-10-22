import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { buildPivot, previewPivot, pivotFieldValues, pivotBlankLabel, PIVOT_BLANK } from '../src/core/pivot.js';

function source(rows) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  return { wb, id };
}

function place(wb, built) {
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells, 'pivot');
  return (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(sheet.id, r, c); };
}

it('gives rows with a blank label their own (blank) row so the total reconciles', () => {
  const { wb, id } = source([['Region', 'Amount'], ['East', '10'], ['', '5'], ['West', '20'], ['=""', '7']]);
  const spec = { range: parseRange('A1:B5'), rowField: 0, colField: null, valueField: 1, agg: 'sum' };
  const built = buildPivot(wb, id, spec);
  expect(built.rowCount).toBe(3);
  expect(previewPivot(wb, id, spec)).toMatchObject({ rowCount: 3, rows: 5 });
  const at = place(wb, built);
  expect([at('A2'), at('A3'), at('A4'), at('A5')]).toEqual(['East', 'West', PIVOT_BLANK, 'Total']);
  expect([at('B2'), at('B3'), at('B4'), at('B5')]).toEqual([10, 20, 12, 42]);
  // The filter dropdown keeps listing real values only; (All) already covers the blanks.
  expect(pivotFieldValues(wb, id, parseRange('A1:B5'), 0)).toEqual(['East', 'West']);
});

it('adds a (blank) column as well, and counts blank-labelled rows', () => {
  const { wb, id } = source([['Region', 'Quarter', 'Amount'], ['East', 'Q1', '10'], ['', '', '5'], ['West', 'Q1', '20'], ['East', '', '1']]);
  const at = place(wb, buildPivot(wb, id, { range: parseRange('A1:C5'), rowField: 0, colField: 1, valueField: 2, agg: 'sum' }));
  expect([at('B1'), at('C1'), at('D1')]).toEqual(['Q1', PIVOT_BLANK, 'Total']);
  expect([at('A2'), at('A3'), at('A4'), at('A5')]).toEqual(['East', 'West', PIVOT_BLANK, 'Total']);
  expect([at('B2'), at('C2'), at('D2')]).toEqual([10, 1, 11]);
  expect([at('B4'), at('C4'), at('D4')]).toEqual(['', 5, 5]);
  expect([at('B5'), at('C5'), at('D5')]).toEqual([30, 6, 36]);
  const count = place(wb, buildPivot(wb, id, { range: parseRange('A1:C5'), rowField: 0, colField: null, valueField: 2, agg: 'count' }));
  expect([count('B2'), count('B3'), count('B4'), count('B5')]).toEqual([2, 1, 1, 4]);
});

it('leaves the (blank) row out when every label is filled, and steps aside for a real "(blank)" value', () => {
  const full = source([['Region', 'Amount'], ['East', '10'], ['West', '20']]);
  expect(buildPivot(full.wb, full.id, { range: parseRange('A1:B3'), rowField: 0, colField: null, valueField: 1, agg: 'sum' }).rowCount).toBe(2);
  const clash = source([['Region', 'Amount'], ['(blank)', '10'], ['', '5']]);
  const built = buildPivot(clash.wb, clash.id, { range: parseRange('A1:B3'), rowField: 0, colField: null, valueField: 1, agg: 'sum' });
  const at = place(clash.wb, built);
  expect(at('A2')).toBe('(blank)');
  expect(at('A3')).toBe(pivotBlankLabel(['(blank)']));
  expect(at('A3')).not.toBe('(blank)');
  expect([at('B2'), at('B3'), at('B4')]).toEqual([10, 5, 15]);
});
