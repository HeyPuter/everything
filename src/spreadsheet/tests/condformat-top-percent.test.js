import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { describeRule } from '../src/core/condformat.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// Excel's Top 10% and Bottom 10% rules (top10 with percent="1") were left out when an .xlsx opened, so the cells
// lost their highlight and saving the file dropped the rules for good. They now open as Top/Bottom rules that
// rank a share of the range's numbers (rounded down, never fewer than one), and save as rules Excel paints alike.
const DXF = '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>';
async function open(rules) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(Array.from({ length: 25 }, (_, i) => [i + 1])), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  edit('/xl/worksheets/sheet1.xml', (xml) => xml.replace('</sheetData>', () => `</sheetData>${rules}`));
  edit('/xl/styles.xml', (xml) => xml.replace('</cellXfs>', () => `</cellXfs>${DXF}`));
  return workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'rules.xlsx');
}
const painted = (wb) => Array.from({ length: 25 }, (_, r) => r).filter((r) => wb.conditionalStyle(wb.activeSheetId, r, 0, wb.getValue(wb.activeSheetId, r, 0))?.bg).map((r) => r + 1);

it.each([
  ['<cfRule type="top10" dxfId="0" priority="1" percent="1" rank="10"/>', [24, 25]],
  ['<cfRule type="top10" dxfId="0" priority="1" percent="1" bottom="1" rank="20"/>', [1, 2, 3, 4, 5]],
  ['<cfRule type="top10" dxfId="0" priority="1" percent="1" rank="1"/>', [25]],
])('opens and saves an Excel percent rule: %s', async (rule, expected) => {
  const wb = await open(`<conditionalFormatting sqref="A1:A25">${rule}</conditionalFormatting>`);
  expect(painted(wb)).toEqual(expected);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'again.xlsx');
  expect(painted(back)).toEqual(expected);
});

it('ranks a share of the numbers in an app rule and names it as a percentage', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let r = 0; r < 25; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.addRule(id, { range: parseRange('A1:A25'), type: 'top', value: 10, percent: true, style: { bg: '#f00' } });
  expect(painted(wb)).toEqual([24, 25]);
  expect(describeRule(wb.sheet(id).rules[0])).toBe('Top 10%');
});

// LibreOffice writes the same rules as top-percent(N) and bottom-percent(N) conditions.
it('opens a LibreOffice percent rule', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"';
  const rows = Array.from({ length: 25 }, (_, i) => `<table:table-row><table:table-cell office:value-type="float" office:value="${i + 1}"><text:p>${i + 1}</text:p></table:table-cell></table:table-row>`).join('');
  const files = {
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'META-INF/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    'styles.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/><style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffcccc"/></style:style></office:styles></office:document-styles>`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:body><office:spreadsheet><table:table table:name="Data">${rows}<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="Data.A1:Data.A25"><calcext:condition calcext:apply-style-name="Bad" calcext:value="bottom-percent(10)" calcext:base-cell-address="Data.A1"/></calcext:conditional-format></calcext:conditional-formats></table:table></office:spreadsheet></office:body></office:document-content>`,
  };
  const zip = X.CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(files)) X.CFB.utils.cfb_add(zip, name, new TextEncoder().encode(text));
  const wb = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'rules.ods');
  expect(painted(wb)).toEqual([1, 2]);
});
