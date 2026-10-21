import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
/** An .ods as LibreOffice writes one whose column B was filled yellow as a whole: the column names the cell style its cells take. */
function lodsFile() {
  const files = {
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'META-INF/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    'styles.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:automatic-styles>`
      + '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffff00"/></style:style>'
      + '<style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>'
      + '</office:automatic-styles><office:body><office:spreadsheet><table:table table:name="Data">'
      + '<table:table-column table:default-cell-style-name="Default"/><table:table-column table:default-cell-style-name="ce1"/><table:table-column table:number-columns-repeated="1022" table:default-cell-style-name="Default"/>'
      + '<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1022"/></table:table-row>'
      + '<table:table-row><table:table-cell/><table:table-cell table:style-name="ce2" office:value-type="string"><text:p>own</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1022"/></table:table-row>'
      + '<table:table-row table:number-rows-repeated="1048574"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
      + '</table:table></office:spreadsheet></office:body></office:document-content>',
  };
  const zip = X.CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(files)) X.CFB.utils.cfb_add(zip, name, new TextEncoder().encode(text));
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

// LibreOffice keeps a whole column's format as the cell style the column gives its cells (table:default-cell-style-name),
// and the reader looked at it only for the cells the file writes out: column B, filled yellow in LibreOffice, opened
// yellow in its one stored cell and white everywhere below. The column's style is now the column's format.
it('opens a LibreOffice column format as the column\'s format', async () => {
  const wb = await workbookFromFile(lodsFile(), 'columns.ods'), id = wb.activeSheetId;
  expect(wb.activeSheet.colStyles.get(1)).toEqual({ bg: '#ffff00' });
  expect(wb.activeSheet.colStyles.has(0)).toBe(false);
  expect(wb.styleAt(id, 500, 1)).toMatchObject({ bg: '#ffff00' });
  expect(wb.styleAt(id, 0, 1)).toMatchObject({ bg: '#ffff00' });
  // A cell with a style of its own takes that style alone, as in LibreOffice.
  expect(wb.styleAt(id, 1, 1)).toMatchObject({ bold: true });
  expect(wb.styleAt(id, 1, 1)?.bg ?? null).toBeNull();
  expect(wb.styleAt(id, 500, 2)?.bg ?? null).toBeNull();
});

// Saving to .ods wrote a column's format only into the cells the sheet stores (and into this app's own settings),
// so LibreOffice showed column B yellow in its one filled cell and white below it.
it('saves a column format as the column\'s cell style, and reads it back without the app\'s settings', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(lodsFile(), 'columns.ods');
  wb.activeSheet.colStyles.set(3, { bold: true, fmt: 'percent', dec: 1 });
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(content).toMatch(/<table:table-column\b[^>]*table:default-cell-style-name="cs\d+"/);
  const back = await workbookFromFile(bytes, 'again.ods'), id = back.activeSheetId;
  expect(back.activeSheet.colStyles.get(1)).toEqual({ bg: '#ffff00' });
  expect(back.activeSheet.colStyles.get(3)).toMatchObject({ bold: true, fmt: 'percent', dec: 1 });
  expect(back.styleAt(id, 900, 1)).toMatchObject({ bg: '#ffff00' });
  expect(back.styleAt(id, 1, 1)).toMatchObject({ bold: true });
  expect(back.styleAt(id, 1, 1)?.bg ?? null).toBeNull();
});
