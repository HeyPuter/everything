import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const content = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

// LibreOffice indents a cell by its paragraph's left margin, 0.353cm (10pt) a step of Increase Indent. The
// .ods writer and reader knew nothing of it: an indented line of a statement (a sub-total under its heading)
// lost its indent in LibreOffice, and an indented LibreOffice sheet opened here flat.
it('writes an indent as the left margin LibreOffice indents by, and reads it back', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Revenue');
  wb.setInput(id, 1, 0, 'Product');
  wb.setInput(id, 2, 0, 'Services');
  wb.setInput(id, 3, 0, 'Right');
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { indent: 1 });
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, { indent: 6, align: 'left' });
  wb.applyStyle(id, { r1: 3, c1: 0, r2: 3, c2: 0 }, { indent: 2, align: 'right' });
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = content(bytes);
  expect(xml).toContain('fo:margin-left="10pt"');
  expect(xml).toContain('fo:margin-left="60pt"');
  // LibreOffice indents from the left edge only: a right-aligned cell's indent stays with the app's own settings.
  expect(xml).not.toContain('fo:margin-left="20pt"');
  const back = await workbookFromFile(bytes, 'statement.ods');
  const sid = back.activeSheetId;
  expect(back.styleAt(sid, 0, 0)?.indent).toBeUndefined();
  expect(back.styleAt(sid, 1, 0)).toMatchObject({ indent: 1 });
  expect(back.styleAt(sid, 1, 0)?.align).toBeUndefined();
  expect(back.styleAt(sid, 2, 0)).toMatchObject({ indent: 6, align: 'left' });
  expect(back.styleAt(sid, 3, 0)?.indent).toBeUndefined();
});

it.each([['0.353cm', 1], ['0.706cm', 2], ['1.764cm', 5], ['100pt', 10], ['0.1cm', undefined]])('reads a LibreOffice left margin of %s as indent %s', async (margin, indent) => {
  const zip = X.CFB.utils.cfb_new();
  const add = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  add('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  add('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  add('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">'
    + `<office:automatic-styles><style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties style:text-align-source="fix" style:repeat-content="false"/><style:paragraph-properties fo:text-align="start" fo:margin-left="${margin}"/></style:style></office:automatic-styles>`
    + '<office:body><office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell table:style-name="ce1" office:value-type="string"><text:p>Item</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>');
  const wb = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'lo.ods');
  expect(wb.styleAt(wb.activeSheetId, 0, 0)?.indent).toBe(indent);
});
