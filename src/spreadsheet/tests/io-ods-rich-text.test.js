import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A cell with part of its text formatted (a bold word, a red figure, a superscript) lost that formatting
// in an .ods: the writer wrote the plain text, so LibreOffice showed it plain, and so did this app on
// opening its own download again. The runs are now text:spans naming text styles, read back both ways.

const save = async (wb, settings = true) => new Uint8Array(await (await workbookToOds(wb, { settings })).arrayBuffer());
const contentOf = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [
    { r: 0, c: 0, cell: { v: 'Total due now', f: null, richText: [{ text: 'Total', s: { bold: true } }, { text: ' due ' }, { text: 'now', s: { italic: true, color: '#c00000' } }] } },
    { r: 1, c: 0, cell: { v: 'E = mc2', f: null, richText: [{ text: 'E = mc' }, { text: '2', s: { vertAlign: 'superscript' } }] } },
    { r: 2, c: 0, cell: { v: 'two  spaces\nnext line', f: null, richText: [{ text: 'two  ', s: { underline: true } }, { text: 'spaces\nnext line', s: { strike: true, size: 16, font: 'georgia' } }] } },
  ]);
  return { wb, id };
}

it('writes the runs of a rich-text cell as spans of text styles', async () => {
  const content = contentOf(await save(book().wb, false));
  const style = (name) => content.match(new RegExp(`<style:style style:name="${name}" style:family="text">([\\s\\S]*?)</style:style>`))?.[1];
  const total = content.match(/<text:p><text:span text:style-name="(T\d+)">Total<\/text:span><text:s\/>due<text:s\/><text:span text:style-name="(T\d+)">now<\/text:span><\/text:p>/);
  expect(total).not.toBeNull();
  expect(style(total[1])).toContain('fo:font-weight="bold"');
  expect(style(total[2])).toMatch(/fo:color="#c00000"[\s\S]*fo:font-style="italic"/);
  const power = content.match(/E = mc<text:span text:style-name="(T\d+)">2<\/text:span>/);
  expect(style(power[1])).toContain('style:text-position="super 58%"');
  expect(content).toMatch(/<text:span text:style-name="T\d+">two<text:s text:c="2"\/><\/text:span><text:span text:style-name="T\d+">spaces<text:line-break\/>next line<\/text:span>/);
});

it('reads the runs back, from its own download and as another program wrote them', async () => {
  const { wb, id } = book();
  for (const settings of [true, false]) {
    const back = await workbookFromFile(await save(wb, settings), 'notes.ods');
    const bid = back.activeSheetId;
    for (const r of [0, 1, 2]) {
      expect(back.getValue(bid, r, 0)).toBe(wb.getValue(id, r, 0));
      expect(back.getCell(bid, r, 0).richText, `${settings} ${r}`).toEqual(wb.getCell(id, r, 0).richText);
    }
  }
});

it("reads LibreOffice's spans, nested ones and spaces at their edges included", async () => {
  const fods = `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
    <office:automatic-styles>
      <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold"/></style:style>
      <style:style style:name="T2" style:family="text"><style:text-properties fo:color="#2a6099"/></style:style>
    </office:automatic-styles>
    <office:body><office:spreadsheet><table:table table:name="S"><table:table-row>
      <table:table-cell office:value-type="string"><text:p>A <text:span text:style-name="T1">bold <text:span text:style-name="T2">blue</text:span></text:span> end</text:p><text:p><text:span text:style-name="T2">second</text:span></text:p></table:table-cell>
      <table:table-cell office:value-type="string"><text:p>plain</text:p></table:table-cell>
    </table:table-row></table:table></office:spreadsheet></office:body></office:document>`;
  const wb = await workbookFromFile(new TextEncoder().encode(fods), 'libre.fods');
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 0, 0)).toBe('A bold blue end\nsecond');
  expect(wb.getCell(id, 0, 0).richText).toEqual([
    { text: 'A ' }, { text: 'bold ', s: { bold: true } }, { text: 'blue', s: { bold: true, color: '#2a6099' } }, { text: ' end\n' }, { text: 'second', s: { color: '#2a6099' } }]);
  expect(wb.getCell(id, 0, 1).richText).toBeUndefined();
});
