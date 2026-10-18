import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

function file(rows) {
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:body><office:spreadsheet><table:table table:name="Data">${rows}</table:table></office:spreadsheet></office:body>
</office:document>`);
}
const block = (rows, cols) => `<table:table-row table:number-rows-repeated="${rows}"><table:table-cell table:number-columns-repeated="${cols}" office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>`;

// A repeated non-empty cell is materialised once per coordinate, so a file of a few hundred
// bytes could ask for billions of cells. The cells repeats produce are budgeted to the app's
// own grid (20000 rows by 702 columns), and the file is refused past it, as an oversized
// repeat count is; a correct budget refuses before materialising, so this test is fast.
it('refuses a small file whose repeats would materialise more cells than the grid holds', async () => {
  await expect(workbookFromFile(file(block(4000, 4000)), 'hostile.fods')).rejects.toMatchObject({ code: 'too-large', message: expect.stringMatching(/too large to open here/) });
  await expect(workbookFromFile(file(block(1048576, 16384)), 'hostile.fods')).rejects.toMatchObject({ code: 'too-large', message: expect.stringMatching(/too large to open here/) });
});

it('counts the cells of every repeated block of the file against the one budget', async () => {
  // Each block fits the budget on its own; together they do not.
  await expect(workbookFromFile(file(block(1, 16384) + block(856, 16384)), 'hostile.fods')).rejects.toMatchObject({ code: 'too-large', message: expect.stringMatching(/too large to open here/) });
});

it('still opens a file whose repeats stay within the budget', async () => {
  const wb = await workbookFromFile(file(block(100, 100) + block(1, 16384)), 'dense.fods');
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 0, 0)).toBe(1);
  expect(wb.getValue(id, 99, 99)).toBe(1);
  expect(wb.getValue(id, 100, 16383)).toBe(1);
  expect(wb.activeSheet.cells.size).toBe(100 * 100 + 16384);
});
