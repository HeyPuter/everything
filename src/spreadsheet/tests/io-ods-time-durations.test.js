import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { workbookFromFile } from '../src/core/io.js';

function ods(cells) {
  const xml = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2">
 <office:body><office:spreadsheet><table:table table:name="Data">${cells.map((cell) => `<table:table-row>${cell}</table:table-row>`).join('')}</table:table></office:spreadsheet></office:body>
</office:document-content>`);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[0]]), 'Data');
  const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'ods' })), { type: 'array' });
  XLSX.CFB.utils.cfb_add(zip, 'content.xml', xml);
  return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

const time = (value) => `<table:table-cell office:value-type="time" office:time-value="${value}"><text:p>t</text:p></table:table-cell>`;

// The ODS reader dropped a time's minus sign, read 23.45 seconds as 23, and refused the whole file
// when a duration counted days (P1DT02H00M00S, as a time past 24 hours may be written).
it.each([
  ['-PT01H30M00S', -5400],
  ['PT00H01M23.45S', 83.45],
  ['PT12H00M00S', 43200],
  ['P1DT02H00M00S', 26 * 3600],
  ['PT36H00M00S', 36 * 3600],
  ['-P2DT00H00M00.5S', -(2 * 86400 + 0.5)],
])('reads the time %s', async (value, seconds) => {
  const wb = await workbookFromFile(ods([`${time(value)}<table:table-cell table:formula="of:=[.A1]*86400" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>`]), 'times.ods');
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 0, 0)).toBeCloseTo(seconds / 86400, 15);
  expect(wb.getValue(id, 0, 1)).toBeCloseTo(seconds, 9);
});

it('still refuses a duration counted in years, which have no fixed length', async () => {
  await expect(workbookFromFile(ods([time('P1Y')]), 'years.ods')).rejects.toThrow();
});
