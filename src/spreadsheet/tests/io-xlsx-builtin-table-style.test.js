import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

const part = (bytes, path) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), path).content);
const saved = async (wb) => new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());

/** An .xlsx as Excel writes a table in one of its own styles: the style named, no definition of it in the file. */
async function excelTable(style) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) wb.setInput(id, r, c, r ? String(r * c) : `H${c}`);
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 2 }, {});
  const zip = X.CFB.read(await saved(wb), { type: 'array' });
  const edit = (path, fn) => { const e = X.CFB.find(zip, path); e.content = new TextEncoder().encode(fn(new TextDecoder().decode(e.content))); e.size = e.content.length; };
  edit('/xl/tables/table1.xml', (xml) => xml.replace(/name="PuterTableStyle1"/, `name="${style}"`));
  edit('/xl/styles.xml', (xml) => xml.replace(/<tableStyles\b[\s\S]*?<\/tableStyles>/, ''));
  // Without this app's own record of the book, as a file from Excel has none.
  const book = X.read(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), { type: 'array' });
  edit(`/xl/worksheets/sheet${book.SheetNames.indexOf('_puter_meta') + 1}.xml`, (xml) => xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, '<sheetData/>'));
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

// A table in one of Excel's own styles (TableStyleMedium9: a dark blue header, white bold names) opens here in the
// nearest of this app's colours, and was saved as a style of this app's own making in that colour: opened in
// Excel again after an edit here, every such table had lost its look. The style Excel named now goes back out
// as long as the table keeps it, and a style chosen here replaces it.
it('saves a table in an Excel built-in style with that style, through repeated saves', async () => {
  let wb = await workbookFromFile(await excelTable('TableStyleMedium9'), 'tables.xlsx');
  for (let round = 0; round < 2; round++) {
    const bytes = await saved(wb);
    expect(part(bytes, '/xl/tables/table1.xml')).toMatch(/<tableStyleInfo name="TableStyleMedium9"/);
    expect(part(bytes, '/xl/styles.xml')).not.toContain('PuterTableStyle');
    wb = await workbookFromFile(bytes, 'tables.xlsx');
  }
  const id = wb.activeSheetId, table = wb.sheet(id).tables[0];
  // An edit that keeps the style (a rename, in the table dialog) keeps it.
  wb.updateTable(id, table.id, { name: 'Sales', style: table.style });
  expect(part(await saved(wb), '/xl/tables/table1.xml')).toMatch(/<tableStyleInfo name="TableStyleMedium9"/);
});

it('replaces the built-in style with one chosen here', async () => {
  const wb = await workbookFromFile(await excelTable('TableStyleLight15'), 'tables.xlsx');
  const id = wb.activeSheetId, table = wb.sheet(id).tables[0];
  wb.updateTable(id, table.id, { style: table.style, customStyle: null });
  const bytes = await saved(wb);
  expect(part(bytes, '/xl/tables/table1.xml')).toMatch(/<tableStyleInfo name="PuterTableStyle1"/);
  wb.undo();
  expect(part(await saved(wb), '/xl/tables/table1.xml')).toMatch(/<tableStyleInfo name="TableStyleLight15"/);
});
