import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// The .ods writer found the end of each run of empty cells by probing every column after it, so each
// row with content cost as much as the sheet was wide: one cell typed in a far column (XFD, say) of a
// 4,000-row list took half a minute to save. Runs now end at the row's next cell or merged block.
const list = (rows, far) => {
  const cells = {};
  for (let r = 0; r < rows; r++) cells[`${r},0`] = { v: r };
  cells[`0,${far}`] = { v: 'far' };
  cells[`5,${far - 2}`] = { v: 'near the end' };
  return new Workbook({ sheets: [{ name: 'List', cells, merges: [{ r1: 3, c1: 4, r2: 4, c2: 6 }] }] });
};
const timed = async (wb) => {
  const started = performance.now();
  const blob = await workbookToOds(wb, { settings: false });
  return { ms: performance.now() - started, blob };
};

it('saves a long list with a far-off cell as .ods without scanning each row to the far column', async () => {
  await timed(list(200, 100));
  // A ratio, so a busy machine slows both saves alike: 160 times the columns cost far less than 160 times
  // the time (about the same, measured); the probing took over 100 times as long.
  const narrow = await timed(list(1500, 100));
  const wide = await timed(list(1500, 16000));
  expect(wide.ms).toBeLessThan(narrow.ms * 10 + 50);
  const sheet = (await workbookFromFile(new Uint8Array(await wide.blob.arrayBuffer()), 'list.ods')).activeSheet;
  expect(sheet.cells.get('0,16000')?.v).toBe('far');
  expect(sheet.cells.get('5,15998')?.v).toBe('near the end');
  expect(sheet.cells.get('1499,0')?.v).toBe(1499);
  expect(sheet.merges).toEqual([{ r1: 3, c1: 4, r2: 4, c2: 6 }]);
});
