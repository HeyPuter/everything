import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// An .ods carried its cells' number formats and nothing else of their look: Download as .ods opened in
// LibreOffice with every bold header, fill, font, colour, border and alignment gone, and a spreadsheet
// made in LibreOffice opened here as plain text. Each cell's look is now a table-cell style of the file.

const contentOf = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
const save = async (wb) => new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
/** The same file as another program would leave it: without this app's own record of the book in its settings. */
function withoutAppSettings(bytes) {
  const zip = X.CFB.read(bytes, { type: 'array' });
  const settings = X.CFB.find(zip, 'settings.xml');
  settings.content = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>');
  settings.size = settings.content.length;
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

function formattedBook() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Sales', ''], ['North', '1234.5', 'Note']].forEach((row, r) => row.forEach((v, c) => v && wb.setInput(id, r, c, v)));
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 2 }, { bold: true, bg: '#ffff00', color: '#c00000', font: 'georgia', size: 16, align: 'center' });
  wb.applyStyle(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, { fmt: 'number', dec: 2, group: true, italic: true, underline: true, valign: 'top' });
  wb.applyStyle(id, { r1: 1, c1: 2, r2: 1, c2: 2 }, { wrap: true, strike: true, align: 'right', rot: 45 });
  wb.applyBorders(id, { r1: 3, c1: 0, r2: 3, c2: 1 }, 'all', { color: '#0000ff', style: 'medium' });
  return { wb, id };
}

it('writes each cell look as a table-cell style that the cell names', async () => {
  const { wb } = formattedBook();
  const content = contentOf(await save(wb));
  const styleOf = (text) => {
    const cell = content.match(new RegExp(`<table:table-cell\\b[^>]*>(?:(?!</table:table-cell>)[\\s\\S])*<text:p>${text}</text:p>`))[0];
    const name = /table:style-name="([^"]+)"/.exec(cell)[1];
    return content.match(new RegExp(`<style:style style:name="${name}"[^>]*>[\\s\\S]*?</style:style>`))[0];
  };
  const header = styleOf('Region');
  expect(header).toContain('fo:background-color="#ffff00"');
  expect(header).toContain('fo:font-weight="bold"');
  expect(header).toContain('fo:color="#c00000"');
  expect(header).toContain('fo:font-family="Georgia"');
  expect(header).toContain('fo:font-size="12pt"');
  expect(header).toMatch(/style:text-align-source="fix"[\s\S]*fo:text-align="center"/);
  // The number keeps its number format in the same style.
  const sales = styleOf('1234.5');
  expect(sales).toMatch(/style:data-style-name="N\d+"/);
  expect(sales).toContain('fo:font-style="italic"');
  expect(sales).toContain('style:text-underline-style="solid"');
  expect(sales).toContain('style:vertical-align="top"');
  const note = styleOf('Note');
  expect(note).toContain('fo:wrap-option="wrap"');
  expect(note).toContain('style:text-line-through-style="solid"');
  expect(note).toContain('style:rotation-angle="45"');
  expect(note).toContain('fo:text-align="end"');
  // A blank cell is written for its fill or borders, and equal looks share one style.
  expect(content).toMatch(/<table:table-row>(?:(?!<\/table:table-row>)[\s\S])*<table:table-cell table:style-name="([^"]+)"\/>/);
  expect(content).toContain('fo:border-top="1.76pt solid #0000ff"');
  expect(content.match(/fo:background-color="#ffff00"/g)).toHaveLength(1);
});

it('reads the look of a file saved by another program', async () => {
  const { wb, id } = formattedBook();
  const back = await workbookFromFile(withoutAppSettings(await save(wb)), 'report.ods');
  const sid = back.activeSheetId;
  for (const [r, c] of [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [3, 0], [3, 1]]) {
    const { scheme, ...expected } = wb.styleAt(id, r, c) || {};
    expect(back.styleAt(sid, r, c), `${r},${c}`).toEqual(expected);
  }
  expect(back.getValue(sid, 0, 2)).toBe(null);
  expect(back.getDisplay(sid, 1, 1)).toBe('1,234.50');
});

it('reads LibreOffice styles: parents, a column default, painted blank cells, and not the Default style', async () => {
  const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const fods = `<?xml version="1.0" encoding="UTF-8"?><office:document ${ns} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
    <office:styles>
      <style:default-style style:family="table-cell"><style:text-properties fo:font-size="10pt" style:font-name="Liberation Sans"/></style:default-style>
      <style:style style:name="Default" style:family="table-cell"><style:text-properties fo:color="#333333" fo:font-size="10pt"/></style:style>
      <style:style style:name="Heading" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-size="14pt" fo:font-weight="bold" style:font-name="Liberation Serif"/></style:style>
    </office:styles>
    <office:automatic-styles>
      <style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Heading"><style:table-cell-properties fo:background-color="#dde8cb" style:text-align-source="fix" style:repeat-content="false"/><style:paragraph-properties fo:text-align="center"/></style:style>
      <style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:border="0.74pt solid #000000"/></style:style>
      <style:style style:name="ce3" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-style="italic"/></style:style>
      <style:style style:name="ce4" style:family="table-cell" style:parent-style-name="Heading"><style:text-properties fo:font-weight="normal"/></style:style>
    </office:automatic-styles>
    <office:body><office:spreadsheet><table:table table:name="Data">
      <table:table-column table:default-cell-style-name="Default"/><table:table-column table:default-cell-style-name="ce3"/><table:table-column table:number-columns-repeated="2" table:default-cell-style-name="Default"/>
      <table:table-row><table:table-cell table:style-name="ce1" office:value-type="string"><text:p>Title</text:p></table:table-cell><table:table-cell table:style-name="ce1" table:number-columns-repeated="2"/><table:table-cell table:style-name="ce4" office:value-type="string"><text:p>Sub</text:p></table:table-cell></table:table-row>
      <table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell><table:table-cell table:style-name="ce2"/><table:table-cell table:number-columns-repeated="1"/></table:table-row>
    </table:table></office:spreadsheet></office:body></office:document>`;
  const wb = await workbookFromFile(new TextEncoder().encode(fods), 'libre.fods');
  const id = wb.activeSheetId;
  expect(wb.styleAt(id, 0, 0)).toEqual({ size: 14 * 4 / 3, bold: true, font: 'font:Liberation Serif', bg: '#dde8cb', align: 'center' });
  // A blank cell with a fill is kept for it, as LibreOffice shows it; its own style takes nothing from its column's italic.
  expect(wb.styleAt(id, 0, 1)).toEqual({ ...wb.styleAt(id, 0, 0), italic: null });
  expect(wb.activeSheet.colStyles.get(1)).toEqual({ italic: true });
  expect(wb.styleAt(id, 0, 3)).toEqual({ size: 14 * 4 / 3, font: 'font:Liberation Serif' });
  // The Default style's colour and size are the book's base, not a format of each cell.
  expect(wb.styleAt(id, 1, 0)).toBeFalsy();
  expect(wb.styleAt(id, 1, 1)).toEqual({ italic: true });
  expect(wb.styleAt(id, 1, 2)).toEqual({ bs: 'thin', bc: '#000000', bt: true, bb: true, bl: true, br: true });
});
