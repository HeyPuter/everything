import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

function odsFile(table) {
  const zip = X.CFB.utils.cfb_new();
  const add = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  add('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  add('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  add('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">'
    + `<office:body><office:spreadsheet>${table}</office:spreadsheet></office:body></office:document-content>`);
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}
const row = (n) => `<table:table-row><table:table-cell office:value-type="float" office:value="${n}"><text:p>${n}</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="${n}"><text:p>${n}</text:p></table:table-cell></table:table-row>`;

// LibreOffice keeps a sheet's print ranges on its table (table:print-ranges) and the rows to repeat at the top
// of every page as the table's header rows. Neither was read, so a report set up to print in LibreOffice printed
// here whole, without its headings on each page, and the next save lost the setup; nor was a print area set
// here written for LibreOffice.
it('reads LibreOffice print ranges and repeated rows and columns', async () => {
  const wb = await workbookFromFile(odsFile(`<table:table table:name="My Report" table:print-ranges="$'My Report'.$A$1:.$B$4 'My Report'.A6:'My Report'.B7">`
    + '<table:table-header-columns><table:table-column/></table:table-header-columns><table:table-column/>'
    + `<table:table-header-rows>${row(1)}</table:table-header-rows>${row(2)}${row(3)}${row(4)}${row(5)}${row(6)}${row(7)}</table:table>`), 'report.ods');
  const p = wb.activeSheet.printSettings;
  expect(p.areas).toEqual([{ r1: 0, c1: 0, r2: 3, c2: 1 }, { r1: 5, c1: 0, r2: 6, c2: 1 }]);
  expect(p.titleRows).toEqual([0, 0]);
  expect(p.titleCols).toEqual([0, 0]);
  expect(wb.getValue(wb.activeSheetId, 6, 1)).toBe(7);
});

it('writes a print area for LibreOffice and reads it back', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  expect(wb.renameSheet(id, "Q1 'Sales")).toBe(true);
  for (let r = 0; r < 8; r++) wb.setInput(id, r, 0, String(r));
  wb.setPrintSettings(id, { areas: [{ r1: 0, c1: 0, r2: 4, c2: 2 }, { r1: 6, c1: 0, r2: 7, c2: 0 }] });
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  expect(content(bytes).replace(/&apos;/g, "'")).toContain(`table:print-ranges="'Q1 ''Sales'.A1:'Q1 ''Sales'.C5 'Q1 ''Sales'.A7:'Q1 ''Sales'.A8"`);
  const back = await workbookFromFile(bytes, 'sales.ods');
  expect(back.activeSheet.printSettings.areas).toEqual([{ r1: 0, c1: 0, r2: 4, c2: 2 }, { r1: 6, c1: 0, r2: 7, c2: 0 }]);
});

it('gives a LibreOffice sheet without print ranges no print settings', async () => {
  const wb = await workbookFromFile(odsFile(`<table:table table:name="S">${row(1)}</table:table>`), 'plain.ods');
  expect(wb.activeSheet.printSettings).toBeNull();
});
