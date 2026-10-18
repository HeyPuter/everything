import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { recommendPivots } from '../src/core/pivot-recommend.js';
import { buildPivot } from '../src/core/pivot.js';
import { formatValue } from '../src/core/format.js';

const ROWS = [['Item', 'Region', 'Units', 'Amount'], ['Item 10', 'North', 3, 30], ['Item 2', 'South', 5, 50], ['Item 10', 'North', 2, 12],
  ['item 2', 'East', 4, 24], ['Item 1', 'South', 1, 9], ['Item 2 ', 'North', 6, 5]];

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ROWS.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  for (let r = 1; r < ROWS.length; r++) wb.setCells(id, [{ r, c: 3, cell: { v: ROWS[r][3], f: null, s: { fmt: 'currency', dec: 2 } } }]);
  const picks = recommendPivots(wb, id, { r1: 0, c1: 0, r2: ROWS.length - 1, c2: 3 });
  /** The rows the inserted pivot shows: its labels and its first value column. */
  const inserted = (spec) => {
    const built = buildPivot(wb, id, spec);
    const sheet = wb.addSheet();
    wb.setCells(sheet.id, built.cells, 'Pivot');
    return Array.from({ length: built.rowCount }, (_, i) => Array.from({ length: built.cols }, (_, c) => wb.getValue(sheet.id, built.headerRow + 1 + i, c)));
  };
  return { wb, id, picks, inserted };
}

it('previews a recommendation across two fields with a column per label of the second, as the pivot it inserts', () => {
  const { picks, inserted } = setup();
  const cross = picks.find((p) => p.title === 'Sum of Units by Item and Region');
  expect(cross.headers).toEqual(['Item', 'East', 'North', 'South', 'Total']);
  expect(cross.preview).toEqual(inserted(cross.spec).map((row) => row.map((v) => (v === '' || v == null ? 0 : v))));
  expect(cross.preview).toEqual([['Item 1', 0, 0, 1, 1], ['Item 10', 0, 5, 0, 5], ['Item 2', 4, 0, 5, 9], ['Item 2 ', 0, 6, 0, 6]]);
});

it('lists the labels in the order and grouping of the inserted pivot', () => {
  const { picks, inserted } = setup();
  const byItem = picks.find((p) => p.title === 'Sum of Units by Item');
  // Text sorts as text (Item 10 before Item 2), case is ignored, and a trailing space is a label of its own.
  expect(byItem.preview).toEqual(inserted(byItem.spec));
  expect(byItem.preview.map(([label]) => label)).toEqual(['Item 1', 'Item 10', 'Item 2', 'Item 2 ']);
});

it('gives the preview the number format the pivot shows its values in', () => {
  const { picks } = setup();
  const amount = picks.find((p) => p.title === 'Sum of Amount by Region');
  expect(formatValue(amount.preview[0][1], amount.format)).toBe('$24.00');
  expect(picks.find((p) => p.title === 'Count of Region by Region').format).toBeNull();
});
