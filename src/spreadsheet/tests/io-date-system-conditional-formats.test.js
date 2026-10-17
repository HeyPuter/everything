import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { ymdToSerial } from '../src/core/format.js';

// A 1904-system file's date cells were moved to this app's 1900 serials, but a conditional format's
// bare-number threshold over them (Excel stores "greater than 2024-01-01" as the serial) was not, so
// the rule compared 1900 dates against a 1904 threshold four years early. It now moves with the cells
// when the rule's cells are dates, and stays put over plain numbers.
const S1904 = (y, m, d) => ymdToSerial(y, m, d) - 1462;
const DXF = '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFF0000"/></patternFill></fill></dxf></dxfs>';

function file(date1904, rules) {
  const book = XLSX.utils.book_new();
  book.Workbook = { WBProps: { date1904 } };
  const shift = date1904 ? S1904 : ymdToSerial;
  XLSX.utils.book_append_sheet(book, {
    '!ref': 'A1:B2',
    A1: { t: 'n', v: shift(2023, 6, 1), z: 'yyyy-mm-dd' }, A2: { t: 'n', v: shift(2024, 6, 1), z: 'yyyy-mm-dd' },
    B1: { t: 'n', v: 40000 }, B2: { t: 'n', v: 45000 },
  }, 'Data');
  const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const text = (path) => new TextDecoder().decode(XLSX.CFB.find(zip, path).content);
  const put = (path, xml) => XLSX.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(xml));
  put('/xl/worksheets/sheet1.xml', text('/xl/worksheets/sheet1.xml').replace('</sheetData>', `</sheetData>${rules}`));
  const styles = text('/xl/styles.xml').replace(/<dxfs\b[^>]*\/>|<dxfs\b[\s\S]*?<\/dxfs>/, '');
  put('/xl/styles.xml', styles.replace(/(<tableStyles\b|<\/styleSheet>)/, `${DXF}$1`));
  return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

const greater = (sqref, value) => `<conditionalFormatting sqref="${sqref}"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>${value}</formula></cfRule></conditionalFormatting>`;
const fill = (wb, r, c) => wb.conditionalStyle(wb.activeSheetId, r, c, wb.getValue(wb.activeSheetId, r, c))?.bg ?? null;

it('moves a date threshold with the date cells in a 1904 file', async () => {
  const wb = await workbookFromFile(file(true, greater('A1:A2', S1904(2024, 1, 1)) + greater('B1:B2', 42000).replace('priority="1"', 'priority="2"')), 'mac.xlsx');
  expect(wb.getDisplay(wb.activeSheetId, 0, 0)).toBe('2023-06-01');
  expect([fill(wb, 0, 0), fill(wb, 1, 0)]).toEqual([null, '#ff0000']);
  // A rule over plain numbers keeps its number.
  expect([fill(wb, 0, 1), fill(wb, 1, 1)]).toEqual([null, '#ff0000']);
  // Saved by this app the file is on the 1900 system, so nothing moves twice.
  const back = await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx');
  expect([fill(back, 0, 0), fill(back, 1, 0), fill(back, 0, 1), fill(back, 1, 1)]).toEqual([null, '#ff0000', null, '#ff0000']);
});

it('moves a between rule and a color scale\'s number stops too', async () => {
  const between = `<conditionalFormatting sqref="A1:A2"><cfRule type="cellIs" dxfId="0" priority="1" operator="between"><formula>${S1904(2024, 1, 1)}</formula><formula>${S1904(2024, 12, 31)}</formula></cfRule></conditionalFormatting>`;
  const scale = `<conditionalFormatting sqref="A1:A2"><cfRule type="colorScale" priority="2"><colorScale><cfvo type="num" val="${S1904(2023, 1, 1)}"/><cfvo type="num" val="${S1904(2025, 1, 1)}"/><color rgb="FFFFFFFF"/><color rgb="FF000000"/></colorScale></cfRule></conditionalFormatting>`;
  const wb = await workbookFromFile(file(true, between), 'mac.xlsx');
  expect([fill(wb, 0, 0), fill(wb, 1, 0)]).toEqual([null, '#ff0000']);
  const stops = (await workbookFromFile(file(true, scale), 'mac.xlsx')).activeSheet.rules.find((r) => r.type === 'scale');
  expect([stops.scaleMin, stops.scaleMax]).toEqual([String(ymdToSerial(2023, 1, 1)), String(ymdToSerial(2025, 1, 1))]);
});

it('leaves thresholds as they are in a 1900 file', async () => {
  const wb = await workbookFromFile(file(false, greater('A1:A2', ymdToSerial(2024, 1, 1))), 'pc.xlsx');
  expect([fill(wb, 0, 0), fill(wb, 1, 0)]).toEqual([null, '#ff0000']);
});
