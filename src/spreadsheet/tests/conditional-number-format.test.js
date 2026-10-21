// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx, sheetToHtml } from '../src/core/io.js';
import { createGrid } from '../src/ui/grid.js';
import { buildPrintTable } from '../src/ui/print.js';

let grid;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { grid?.destroy(); grid = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Excel's "Format only cells with: Cell Value greater than 1000", formatted as thousands (#,##0.0,"K"), with a
// fill. Opening the file kept the fill but dropped the rule's number format, so 12345 showed as 12345 rather
// than 12.3K, and saving the file again lost it for good.
const DXF = '<dxfs count="1"><dxf><numFmt numFmtId="164" formatCode="#,##0.0,&quot;K&quot;"/><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>';
const RULE = '<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>1000</formula></cfRule></conditionalFormatting>';
function excelFile({ dxf = DXF, rule = RULE } = {}) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[12345], [5], [2500]]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  edit('/xl/worksheets/sheet1.xml', xml => xml.replace('</sheetData>', () => `</sheetData>${rule}`));
  edit('/xl/styles.xml', xml => xml.replace('</cellXfs>', () => `</cellXfs>${dxf}`));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const shown = async wb => {
  grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} }); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 10));
  const out = [0, 1, 2].map(r => grid.el.querySelector(`#gc-${r}-0`).textContent);
  grid.destroy(); grid = null;
  return out;
};
// Saved as Excel would see it: without this app's own record of the workbook.
async function resaved(wb) {
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  return { styles: new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content), bytes: X.CFB.write(zip, { type: 'array', fileType: 'zip' }) };
}

it('shows the cells a rule matches in the rule\'s own number format', async () => {
  const wb = await workbookFromFile(excelFile(), 'rules.xlsx');
  expect(wb.activeSheet.rules[0].style).toMatchObject({ bg: '#ffc7ce', fmt: 'custom', code: '#,##0.0,"K"' });
  expect(await shown(wb)).toEqual(['12.3K', '5', '2.5K']);
  const printed = [...buildPrintTable(wb, wb.activeSheetId, { fit: 'actual' }).querySelectorAll('td')].map(td => td.textContent);
  expect(printed).toEqual(expect.arrayContaining(['12.3K', '5', '2.5K']));
  // The cells keep their own format: the rule's shows only while it matches.
  expect(wb.getCell(wb.activeSheetId, 0, 0).s?.fmt).toBeUndefined();
});

it('saves the rule\'s number format with its fill, and opens it again', async () => {
  const wb = await workbookFromFile(excelFile(), 'rules.xlsx');
  const { styles, bytes } = await resaved(wb);
  expect(styles).toMatch(/<dxf><font><\/font><numFmt numFmtId="\d+" formatCode="#,##0.0,&quot;K&quot;"\/><fill>/);
  const back = await workbookFromFile(bytes, 'again.xlsx');
  expect(back.activeSheet.rules[0].style).toMatchObject({ bg: '#ffc7ce', fmt: 'custom', code: '#,##0.0,"K"' });
  expect(await shown(back)).toEqual(['12.3K', '5', '2.5K']);
});

it('reads a rule that sets General, or a preset such as a percentage', async () => {
  const general = await workbookFromFile(excelFile({ dxf: '<dxfs count="1"><dxf><numFmt numFmtId="0" formatCode="General"/></dxf></dxfs>' }), 'rules.xlsx');
  expect(general.activeSheet.rules[0].style).toMatchObject({ fmt: 'general' });
  expect((await resaved(general)).styles).toMatch(/<dxf><font><\/font><numFmt numFmtId="0" formatCode="General"\/>/);
  const percent = await workbookFromFile(excelFile({ dxf: '<dxfs count="1"><dxf><numFmt numFmtId="10" formatCode="0.00%"/></dxf></dxfs>' }), 'rules.xlsx');
  expect(await shown(percent)).toEqual(['1234500.00%', '5', '250000.00%']);
  const { styles } = await resaved(percent);
  expect(styles).toMatch(/<dxf><font><\/font><numFmt numFmtId="\d+" formatCode="0.00%"\/>/);
});

it('keeps the earlier rule\'s whole number format where two rules match', async () => {
  const dxf = '<dxfs count="2"><dxf><numFmt numFmtId="164" formatCode="0.0"/></dxf><dxf><numFmt numFmtId="10" formatCode="0.00%"/></dxf></dxfs>';
  const rule = '<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>1000</formula></cfRule>'
    + '<cfRule type="cellIs" dxfId="1" priority="2" operator="greaterThan"><formula>0</formula></cfRule></conditionalFormatting>';
  const wb = await workbookFromFile(excelFile({ dxf, rule }), 'rules.xlsx');
  expect(await shown(wb)).toEqual(['12345.0', '500.00%', '2500.0']);
});

it('shows the rule\'s number format in a web page of the sheet', async () => {
  const wb = await workbookFromFile(excelFile(), 'rules.xlsx');
  const cells = [...new DOMParser().parseFromString(sheetToHtml(wb, wb.activeSheetId), 'text/html').querySelectorAll('td')].map(td => td.textContent);
  expect(cells).toEqual(expect.arrayContaining(['12.3K', '5', '2.5K']));
});
