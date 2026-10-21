import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

/** A sheet holding A1 and C5, with one hyperlink over `ref`: to a web page, or to a place in the workbook. */
function linkedFile(ref, external = true) {
  const zip = X.CFB.read(new Uint8Array(X.write({ SheetNames: ['Data'], Sheets: { Data: { '!ref': 'A1' } } }, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  sheet.content = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c r="C5" t="inlineStr"><is><t>Go</t></is></c></row></sheetData>'
    + `<hyperlinks><hyperlink ref="${ref}" ${external ? 'r:id="rId9"' : 'location="Data!A1"'}/></hyperlinks></worksheet>`);
  sheet.size = sheet.content.length;
  if (external) X.CFB.utils.cfb_add(zip, '/xl/worksheets/_rels/sheet1.xml.rels', new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>'));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// A hyperlink in a file covers a range, and the reader made a cell of every coordinate in it to carry the link: a
// link a file stretches over the whole sheet (seventeen billion cells) never finished opening. Where the range holds
// more coordinates than the sheet has cells, the cells the sheet holds in it take the link.
it.each([true, false])('opens a file whose hyperlink covers the whole sheet (external %s)', async external => {
  vi.stubGlobal('Blob', NodeBlob);
  const started = performance.now();
  const wb = await workbookFromFile(linkedFile('A1:XFD1048576', external), 'links.xlsx'), id = wb.activeSheetId;
  expect(performance.now() - started).toBeLessThan(10000);
  const url = external ? 'https://example.com/' : '#Data!A1';
  expect(wb.linkAt(id, 0, 0)?.url).toBe(url);
  expect(wb.linkAt(id, 4, 2)?.url).toBe(url);
  expect(wb.usedRange(id)).toMatchObject({ r2: 4, c2: 2 });
  const back = await workbookFromFile(await workbookToXlsx(wb), 'again.xlsx');
  expect(back.linkAt(back.activeSheetId, 4, 2)?.url).toBe(url);
}, 30000);

it('still links every cell of a small linked range, the empty ones too', async () => {
  const wb = await workbookFromFile(linkedFile('A1:B2'), 'links.xlsx'), id = wb.activeSheetId;
  for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) expect(wb.linkAt(id, r, c)?.url).toBe('https://example.com/');
});
