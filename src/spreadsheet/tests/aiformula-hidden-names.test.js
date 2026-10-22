// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { describeSheet } from '../src/core/aiformula.js';
import { buildPivot } from '../src/core/pivot.js';
import { insertPivotSheet } from '../src/ui/pivotdialog.js';

// A pivot table built from the PivotTable dialog keeps its definition as hidden names scoped to its sheet. The sheet
// described to the AI (shown in the dialog as what is sent) listed every name, so asking for a formula on a pivot
// table's sheet sent its workings, _PuterPivot_Fields = "{""row"":…}", among the sheet's named ranges.
it('describes only the names the Name Manager shows', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Units'], ['East', '5'], ['West', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  insertPivotSheet(wb, id, buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 2, c2: 1 }, rowField: 0, colField: null, valueField: 1, agg: 'sum', filters: [] }));
  const pivot = wb.sheets.at(-1);
  wb.defineName('Top', `'${pivot.name}'!$B$2`);
  const text = describeSheet(wb, pivot.id, { r: 0, c: 0 });
  expect(text).toContain('Named ranges: Top = ');
  expect(text).not.toContain('_PuterPivot');
});
