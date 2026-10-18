import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// Files written with the Open XML SDK (many .NET reporting tools) spell SpreadsheetML with a namespace
// prefix: <x:worksheet>, <x:table>. The cells, styles and sheet settings of such a file were read, but its
// tables were dropped (the table, its style, its calculated column and its filter were gone, and a formula
// naming the table had nothing to refer to), and so was a tab colour taken from the theme.

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
/** The package as such a tool writes it: every SpreadsheetML part's elements prefixed x:, and no app sidecar. */
function asOpenXmlSdk(bytes) {
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  for (const entry of zip.FileIndex) {
    if (!/\.xml$/.test(entry.name) || !entry.content?.length) continue;
    let xml = new TextDecoder().decode(entry.content);
    if (entry.name === 'workbook.xml') xml = xml.replace(/<sheet name="_puter_meta"[^>]*\/>/, '');
    // A tab coloured from the theme, as Excel's palette sets it.
    xml = xml.replace(/<tabColor rgb="[^"]*"\/>/, '<tabColor theme="5"/>');
    // Only parts whose root element has SpreadsheetML as its default namespace.
    if (xml.match(/<[A-Za-z]+\b[^>]*\sxmlns="([^"]+)"/)?.[1] === MAIN) {
      xml = xml.replace(/<(\/?)([A-Za-z][\w.-]*)(?=[\s>/])/g, '<$1x:$2').replace(` xmlns="${MAIN}"`, ` xmlns:x="${MAIN}"`);
    }
    entry.content = new TextEncoder().encode(xml);
    entry.size = entry.content.length;
  }
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

it('reads the tables and theme tab colour of a file whose SpreadsheetML elements carry a prefix', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Item', 'Qty', 'Price', 'Total'], ['Pens', '4', '2', ''], ['Pads', '2', '5', ''], ['Ink', '1', '9', '']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 3 });
  const table = wb.activeSheet.tables[0];
  wb.setInput(id, 1, 3, `=[@Qty]*[@Price]`);
  wb.setInput(id, 5, 0, `=SUM(${table.name}[Total])`);
  wb.setFilterCriteria(id, 1, { values: ['4', '2'] }, wb.filtersForSheet(id)[0]);
  wb.setSheetColor(id, '#ff0000');
  const bytes = asOpenXmlSdk(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()));
  expect(new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), '/xl/tables/table1.xml').content)).toMatch(/^<\?xml[^>]*\?>\s*<x:table /);

  const back = await workbookFromFile(bytes, 'report.xlsx');
  const sheet = back.sheets[0];
  expect(sheet.tables).toHaveLength(1);
  expect(sheet.tables[0]).toMatchObject({ name: table.name, range: { r1: 0, c1: 0, r2: 3, c2: 3 } });
  expect(sheet.tables[0].calc).toEqual({ 3: '[@Qty]*[@Price]' });
  expect(back.getValue(sheet.id, 5, 0)).toBe(27);
  expect(back.filtersForSheet(sheet.id).map((f) => [f.range, Object.keys(f.criteria)])).toEqual([[{ r1: 0, c1: 0, r2: 3, c2: 3 }, ['1']]]);
  expect(sheet.color).toMatch(/^#[0-9a-f]{6}$/);
});
