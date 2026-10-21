import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { histogram, writeAnalysisOutput } from '../src/core/analysis-tools.js';

// A Data Analysis tool whose output range crossed a protected range wrote none of its cells (the protection
// refused them all) but still added its chart, and the dialog reported the output written. The output is now
// refused with a reason the dialog shows, before anything goes in.
it('refuses output over a protected range, chart included', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [1, 2, 3, 4, 5].forEach((v, r) => wb.setInput(id, r, 0, String(v)));
  wb.protectRange(id, { r1: 3, c1: 4, r2: 3, c2: 4 });
  const layout = histogram({ label: 'X', values: [1, 2, 3, 4, 5] }, { chart: true });
  const before = wb.historyTop;
  expect(writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: id, r: 0, c: 3 }).error).toMatch(/protected/);
  expect(wb.getValue(id, 0, 3)).toBeNull();
  expect(wb.sheet(id).charts).toHaveLength(0);
  expect(wb.historyTop).toBe(before);
  expect(writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: id, r: 0, c: 7 }).error).toBeUndefined();
  expect(wb.getValue(id, 0, 7)).toBe('Bin');
  expect(wb.sheet(id).charts).toHaveLength(1);
});
