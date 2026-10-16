import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A chart's series references followed Insert/Delete rows and cut-paste, but not Move rows/columns (for a
// chart on the moved sheet itself) nor Insert/Delete cells (for any chart): the series went on reading the
// cells that had taken the data's old place.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Val'], ['a', '1'], ['b', '2'], ['c', '3'], ['x', '99']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const other = wb.addSheet('Dash').id;
  wb.setActiveSheet(id);
  const spec = { type: 'column', range: { r1: 0, c1: 0, r2: 3, c2: 1 }, anchor: { r: 1, c: 5 },
    sourceRefs: [{ nameRef: 'Sheet1!$B$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$B$2:$B$4' }] };
  return { wb, id, other, here: wb.addChart(id, spec), there: wb.addChart(other, spec) };
}
const series = (wb, sheetId, chartId) => wb.chartById(sheetId, chartId).sourceRefs[0];

describe('chart series follow block and line moves', () => {
  for (const [label, edit, values, categories] of [
    ['Move rows', (wb, id) => wb.moveRows(id, 4, 1, 1), 'Sheet1!$B$3:$B$5', 'Sheet1!$A$3:$A$5'],
    ['Insert cells', (wb, id) => wb.insertCells(id, { r1: 1, c1: 0, r2: 1, c2: 1 }, 'down'), 'Sheet1!$B$3:$B$5', 'Sheet1!$A$3:$A$5'],
    ['Delete cells', (wb, id) => wb.deleteCells(id, { r1: 1, c1: 0, r2: 1, c2: 1 }, 'up'), 'Sheet1!$B$2:$B$3', 'Sheet1!$A$2:$A$3'],
  ]) {
    it(`${label} renumbers the series of charts on every sheet, and undo puts them back`, () => {
      const { wb, id, other, here, there } = book();
      const before = wb.toJSON();
      edit(wb, id);
      for (const [sheetId, chartId] of [[id, here], [other, there]]) {
        expect(series(wb, sheetId, chartId).values).toBe(values);
        expect(series(wb, sheetId, chartId).categories).toBe(categories);
        expect(series(wb, sheetId, chartId).nameRef).toBe('Sheet1!$B$1');
      }
      wb.undo();
      expect(wb.toJSON()).toEqual(before);
    });
  }

  it('Move columns renumbers a chart on the moved sheet', () => {
    const { wb, id, here } = book();
    wb.moveCols(id, 1, 1, 0);
    expect(series(wb, id, here).values).toBe('Sheet1!$A$2:$A$4');
    expect(series(wb, id, here).categories).toBe('Sheet1!$B$2:$B$4');
  });
});
