import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { nativeSparklineData } from '../src/core/native-sparkline-data.js';
import { renderNativeSparklineSvg } from '../src/ui/native-sparkline.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// New sparklines plotted an empty cell as zero, so a month with no figure yet dropped the line to the
// floor, and the points Sparkline settings can mark (negative, high, low, first, last) came out black.
// A new group now takes Excel's defaults: empty cells are gaps, and those points take accent colours.
const make = () => {
  const wb = new Workbook({ sheets: [{ id: 's', name: 'Data', cells: {} }] });
  ['5', '', '7', '-2', '9'].forEach((v, c) => { if (v) wb.setInput('s', 0, c, v); });
  expect(wb.createNativeSparklines('s', { source: 'A1:E1', location: 'F1' })).toBeNull();
  return wb;
};

it('leaves a gap for an empty cell in a new line sparkline', () => {
  const wb = make();
  const data = nativeSparklineData(wb, 's', 0, 5);
  expect(data.points.map((p) => p.value)).toEqual([5, null, 7, -2, 9]);
  const path = renderNativeSparklineSvg(data, 80, 20).match(/<path d="([^"]+)"/)[1];
  expect(path.match(/M/g)).toHaveLength(2); // the line breaks at the empty cell
  expect(data.min).toBe(-2);
});

it('colours a new group’s marked points as Excel does, and keeps them through a save', async () => {
  const wb = make();
  const group = wb.sheet('s').sparklineGroups[0];
  expect(group).toMatchObject({ displayEmptyCellsAs: 'gap', colorSeries: { theme: 4 }, colorNegative: { theme: 5 }, colorHigh: { theme: 4 }, colorLow: { theme: 4 } });
  expect(nativeSparklineData(wb, 's', 0, 5).colors.negative).not.toBe('#000000');
  const back = await workbookFromFile(new File([await workbookToXlsx(wb)], 'spark.xlsx'));
  expect(back.sheets[0].sparklineGroups[0]).toMatchObject({ displayEmptyCellsAs: 'gap', colorNegative: { theme: 5 } });
});
