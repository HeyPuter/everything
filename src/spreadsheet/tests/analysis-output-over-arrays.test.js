import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { descriptiveStatistics, readGroups, outputOccupied, writeAnalysisOutput } from '../src/core/analysis-tools.js';

// Data Analysis output aimed at cells an array formula fills: a spilled result was not counted as data, so the
// results went over it without the "Replace existing data?" question and the formula turned to #SPILL!; part of
// an {=A1:A3*2} array refused the whole write, yet the tool reported the results written and nothing was.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [1, 2, 3, 4, 5].forEach((v, r) => wb.setInput(id, r, 0, String(v)));
  const layout = descriptiveStatistics(readGroups(wb, id, { r1: 0, c1: 0, r2: 4, c2: 0 }).groups, {});
  return { wb, id, layout };
}

it('counts a spilled result as data the output would replace', () => {
  const { wb, id, layout } = book();
  wb.setInput(id, 0, 4, '=SEQUENCE(3)*10');
  expect(outputOccupied(wb, id, layout, 1, 3)).toBe(true);
  expect(outputOccupied(wb, id, layout, 1, 6)).toBe(false);
});

it('says so rather than reporting success when the output would cut through an array', () => {
  const { wb, id, layout } = book();
  wb.setArrayFormula(id, { r1: 0, c1: 4, r2: 2, c2: 4 }, '=A1:A3*2');
  expect(outputOccupied(wb, id, layout, 1, 3)).toBe(true);
  const out = writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: id, r: 1, c: 3 });
  expect(out.error).toMatch(/part of an array/);
  expect(wb.getValue(id, 0, 4)).toBe(2);
  expect(wb.getValue(id, 1, 3)).toBe(null);
  // Clear of the array, the output is written as before.
  expect(writeAnalysisOutput(wb, layout, { kind: 'range', sheetId: id, r: 1, c: 6 }).error).toBeUndefined();
  expect(wb.getValue(id, 1, 6)).toBe('Column 1');
});
