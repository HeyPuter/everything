import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile } from '../src/core/io.js';

// A LibreOffice cell style (Heading, Accent, Good, Bad, or one the user named) keeps its font, fill, borders
// and alignment in styles.xml. The reader took only its name and parent from there, so a cell with a named
// style, or an automatic style built on one, opened plain: a sheet's "Heading 1" titles and "Bad" cells lost
// their bold, colour and fill.
const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
function lodsFile(styles, autoStyles, table) {
  const files = {
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'META-INF/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    'styles.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles>${styles}</office:styles></office:document-styles>`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:version="1.3"><office:automatic-styles>${autoStyles}</office:automatic-styles><office:body><office:spreadsheet>${table}</office:spreadsheet></office:body></office:document-content>`,
  };
  const zip = X.CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(files)) X.CFB.utils.cfb_add(zip, name, new TextEncoder().encode(text));
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}
const STYLES = `<style:style style:name="Default" style:family="table-cell"><style:text-properties fo:font-size="10pt"/></style:style>
  <style:style style:name="Heading" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-size="24pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="table-cell" style:parent-style-name="Heading"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="18pt"/></style:style>
  <style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffcccc" fo:border-bottom="0.74pt solid #cc0000"/><style:text-properties fo:color="#cc0000"/></style:style>`;

it('opens cells with LibreOffice\'s named cell styles as they look there', async () => {
  const auto = '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Bad"><style:text-properties fo:font-style="italic"/></style:style>';
  const table = `<table:table table:name="Sheet1">
    <table:table-row><table:table-cell table:style-name="Heading_20_1" office:value-type="string"><text:p>Title</text:p></table:table-cell></table:table-row>
    <table:table-row><table:table-cell table:style-name="Bad" office:value-type="float" office:value="-3"><text:p>-3</text:p></table:table-cell><table:table-cell table:style-name="ce1" office:value-type="float" office:value="-4"><text:p>-4</text:p></table:table-cell></table:table-row>
    <table:table-row><table:table-cell office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell></table:table-row>
  </table:table>`;
  const wb = await workbookFromFile(lodsFile(STYLES, auto, table), 'styles.ods');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 0, 0).s).toMatchObject({ bold: true, size: 24, align: 'center' });
  expect(wb.getCell(id, 1, 0).s).toMatchObject({ color: '#cc0000', bg: '#ffcccc', bb: true });
  expect(wb.getCell(id, 1, 1).s).toMatchObject({ color: '#cc0000', bg: '#ffcccc', italic: true });
  // Default is the workbook's own look, not a format of each cell.
  expect(wb.getCell(id, 2, 0).s?.size).toBeUndefined();
});
