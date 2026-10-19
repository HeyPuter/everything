import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

// Dragging a block of cells shifted the range of every object whose range lay inside it. A chart's range is its
// data, so that is right; but a picture's, text box's or SmartArt's range is only the cell it sits on, and the
// drag left the object where it was. Its range then named a cell it was nowhere near, and every other browser
// editing the workbook together, which rebuilds the range from the cell the object sits on, held a different
// copy. Objects that are not charts now keep their range with their place; a chart's data still moves.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const reloaded = (wb) => new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
const objects = (wb, id) => wb.sheet(id).charts.map(({ id: _, ...ch }) => ({ type: ch.type, anchor: ch.anchor, range: ch.range }));

it('leaves pictures, text boxes and SmartArt where they sit, with ranges that agree with their place', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales'], ['Jan', '10'], ['Feb', '20']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 1, c: 1 }, w: 120, h: 40 });
  wb.addChart(id, { type: 'image', src: PNG, anchor: { r: 2, c: 0 }, w: 40, h: 40 });
  wb.addChart(id, { type: 'smartart', anchor: { r: 0, c: 1 }, w: 300, h: 200 });
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 }, 'columnClustered'));
  const shapes = () => wb.sheet(id).charts.filter((ch) => ch.id !== chartId).map((ch) => ({ type: ch.type, anchor: ch.anchor, range: ch.range }));
  const before = shapes();
  wb.moveRange(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, 5, 4);
  expect(shapes()).toEqual(before);
  for (const ch of shapes()) expect(ch.range).toEqual({ r1: ch.anchor.r, c1: ch.anchor.c, r2: ch.anchor.r, c2: ch.anchor.c });
  expect(objects(reloaded(wb), id)).toEqual(objects(wb, id));
  // The chart's data still follows its cells.
  expect(wb.chartById(id, chartId).range).toEqual({ r1: 5, c1: 4, r2: 7, c2: 5 });
});
