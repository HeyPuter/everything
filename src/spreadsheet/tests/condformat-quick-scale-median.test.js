import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { presetRule, SCALES } from '../src/ui/condformat-quick.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// Excel's three-color scale presets put the middle color at the 50th percentile, not halfway between the extremes.
const [label, from, mid, to] = SCALES[0];
const values = [1, 2, 3, 4, 100];
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  values.forEach((v, r) => wb.setInput(id, r, 0, String(v)));
  wb.addRule(id, presetRule(parseRange('A1:A5'), { kind: 'scale', from, mid, to }));
  return wb;
}
const bg = (wb, r) => wb.conditionalStyle(wb.activeSheetId, r, 0, wb.getValue(wb.activeSheetId, r, 0))?.bg;

it(`paints the median of the range in the middle color of ${label}`, async () => {
  const wb = book();
  expect(bg(wb, 2)).toBe(mid);
  expect(bg(wb, 0)).toBe(from);
  expect(bg(wb, 4)).toBe(to);
  // 4 sits between the median and the top: on its way to the top color, not still near the bottom one.
  expect(bg(wb, 3)).not.toBe(bg(wb, 1));
  const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'scale.xlsx');
  expect(bg(back, 2)).toBe(mid);
  // Editing the data moves the median with it.
  wb.setInput(wb.activeSheetId, 1, 0, '50');
  expect(bg(wb, 2)).not.toBe(mid);
  expect(bg(wb, 3)).toBe(mid);
});

it('keeps two-color presets running from the lowest to the highest value', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  values.forEach((v, r) => wb.setInput(id, r, 0, String(v)));
  const [, a, , b] = SCALES.find(s => !s[2]);
  wb.addRule(id, presetRule(parseRange('A1:A5'), { kind: 'scale', from: a, to: b }));
  expect([bg(wb, 0), bg(wb, 4)]).toEqual([a, b]);
});
