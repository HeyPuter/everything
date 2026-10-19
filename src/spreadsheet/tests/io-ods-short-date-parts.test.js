import { expect, it } from 'vitest';
import { styleToNumFmt } from '../src/core/format.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// LibreOffice writes number:style="long" on a day, hour, minute or second only for the two-digit
// form; a short one (D, H, M, S) carries no attribute, the ODF default being short. The reader took
// a bare element for the long form, so 5. March 2024 opened as 05. March 2024 and 9:05 as 09:05.
const file = (styles, cells) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:automatic-styles>${styles.map((body, i) => `
  <number:${body.startsWith('<number:hours') || body.startsWith('<number:minutes') ? 'time' : 'date'}-style style:name="N${i}">${body}</number:${body.startsWith('<number:hours') || body.startsWith('<number:minutes') ? 'time' : 'date'}-style>
  <style:style style:name="ce${i}" style:family="table-cell" style:data-style-name="N${i}"/>`).join('')}
 </office:automatic-styles>
 <office:body><office:spreadsheet><table:table table:name="Data"><table:table-row>${cells.map(([kind, value], i) => `
  <table:table-cell table:style-name="ce${i}" office:value-type="${kind}" office:${kind}-value="${value}"><text:p>cached</text:p></table:table-cell>`).join('')}
 </table:table-row></table:table></office:spreadsheet></office:body>
</office:document>`);

const t = (s) => `<number:text>${s}</number:text>`;
const cases = [
  ['<number:day/>' + t('. ') + '<number:month number:textual="true" number:style="long"/>' + t(' ') + '<number:year number:style="long"/>', ['date', '2024-03-05'], 'd". "mmmm" "yyyy', '5. March 2024'],
  ['<number:day number:style="long"/>' + t('.') + '<number:month number:style="long"/>' + t('.') + '<number:year/>', ['date', '2024-03-05'], 'dd"."mm"."yy', '05.03.24'],
  ['<number:hours/>' + t(':') + '<number:minutes number:style="long"/>', ['time', 'PT09H05M00S'], 'h":"mm', '9:05'],
  ['<number:hours number:style="long"/>' + t(':') + '<number:minutes/>' + t(':') + '<number:seconds/>', ['time', 'PT09H05M07S'], 'hh":"m":"s', '09:5:7'],
];

it('reads short and long day, hour, minute and second parts as LibreOffice writes them', async () => {
  const wb = await workbookFromFile(file(cases.map((c) => c[0]), cases.map((c) => c[1])), 'dates.fods');
  const saved = await workbookFromFile(await workbookToXlsx(wb), 'dates.xlsx');
  cases.forEach(([, , code, shown], c) => {
    expect(styleToNumFmt(wb.getCell(wb.activeSheetId, 0, c).s)).toBe(code);
    for (const book of [wb, saved]) expect(book.getDisplay(book.activeSheetId, 0, c)).toBe(shown);
  });
});
