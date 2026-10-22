// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createPictures } from '../src/ui/pictures.js';

// An object is anchored to the cell its top-left corner lies in, and follows that cell's column and row as
// lines come and go. Cropping a picture's left or top moves its corner on, often into another column, but the
// anchor stayed with the old cell, the offset reaching past it: inserting a column between the two then left the
// picture where it was, over the new empty column, instead of moving it with the cells it lies on. Cropping
// now anchors the picture again to the cell under its corner, as dragging it does.
const SRC = 'data:image/png;base64,iVBORw0KGgo=';
function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const pid = wb.addChart(id, { type: 'image', src: SRC, anchor: { r: 1, c: 1 }, dx: 0, dy: 0, w: 400, h: 100 });
  const ctx = { wb, sheetId: () => id, grid: { selectedCharts: [pid], selectedChart: pid }, announce() {}, active: () => ({ r: 0, c: 0 }) };
  const pictures = createPictures(ctx, { keepFocus: vi.fn(), selectLocation: vi.fn() });
  return { wb, id, pid, pictures };
}

it('anchors a picture cropped from the left to the cell its corner moved into', async () => {
  const { wb, id, pid, pictures } = setup();
  const before = wb.objectRect(id, pid);
  // A square crop of a 400 × 100 picture keeps its middle 100 pixels: the corner moves 150 pixels right.
  await pictures.run('pictureFormat', { action: 'cropAspect', ratio: 1 });
  const pic = wb.chartById(id, pid), at = wb.objectRect(id, pid);
  expect(pic.w).toBe(100);
  expect(at.x).toBeCloseTo(before.x + 150, 6);
  expect(pic.anchor).toEqual({ r: 1, c: 2 });
  expect(pic.dx).toBeCloseTo(150 - wb.colWidth(id, 1), 6);
  // A column inserted between the old anchor and the picture moves the picture with the cells it lies on.
  wb.insertCols(id, 2, 1);
  expect(wb.objectRect(id, pid).x).toBeCloseTo(at.x + wb.colWidth(id, 2), 6);
});

it('anchors it back when the crop is removed', async () => {
  const { wb, id, pid, pictures } = setup();
  await pictures.run('pictureFormat', { action: 'cropAspect', ratio: 1 });
  await pictures.run('pictureFormat', { action: 'uncrop' });
  const pic = wb.chartById(id, pid);
  expect(pic).toMatchObject({ anchor: { r: 1, c: 1 }, w: 400 });
  expect(pic.dx).toBeCloseTo(0, 6);
});

it('keeps a wide picture at the sheet\'s right edge in place, growing the sheet to its corner', async () => {
  const { wb, id, pid, pictures } = setup();
  const sheet = wb.sheet(id);
  const lastShown = sheet.cols - 1;
  wb.updateChart(id, pid, { anchor: { r: 1, c: lastShown - 1 }, dx: 0, w: 900 });
  const before = wb.objectRect(id, pid);
  // Keeping the middle ninth puts the corner 400 pixels on, past the columns laid out so far.
  await pictures.run('pictureFormat', { action: 'cropAspect', ratio: 1 });
  const at = wb.objectRect(id, pid), pic = wb.chartById(id, pid);
  expect(at.x).toBeCloseTo(before.x + (900 - pic.w) / 2, 6);
  expect(pic.anchor.c).toBeGreaterThan(lastShown);
  expect(wb.sheet(id).cols).toBeGreaterThan(pic.anchor.c);
});
