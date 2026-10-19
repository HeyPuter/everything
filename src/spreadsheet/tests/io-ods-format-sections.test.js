import { expect, it, vi, afterEach } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { styleToNumFmt } from '../src/core/format.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

afterEach(() => vi.restoreAllMocks());

// The .ods writer kept only a format's first section, so negatives lost their red ink and their own
// spelling ((1,235) came out -1,235) and a zero section ("-", or nothing at all) was dropped. Each section
// is now a style of its own, which the last names in style:map conditions on the value's sign, as LibreOffice
// writes them; the reader puts them back in Excel's order, the three-section form included.
const values = [1234.5, -1234.5, 0];
async function roundTrip(code) {
  const wb = new Workbook();
  values.forEach((v, c) => wb.setCells(wb.activeSheetId, [{ r: 0, c, cell: { v, s: { fmt: 'custom', code } } }]));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  const back = await workbookFromFile(bytes, 'sections.ods');
  return { content, errors, before: values.map((_, c) => wb.getDisplay(wb.activeSheetId, 0, c)), after: values.map((_, c) => back.getDisplay(back.activeSheetId, 0, c)), back };
}

it.each([
  ['#,##0.00;[Red]-#,##0.00', ['1,234.50', '-1,234.50', '0.00'], 1],
  ['#,##0;(#,##0)', ['1,235', '(1,235)', '0'], 1],
  ['0;-0;"-"', ['1235', '-1235', '-'], 2],
  ['0;-0;;@', ['1235', '-1235', ''], 2],
  ['0.0%;[Red]-0.0%', ['123450.0%', '-123450.0%', '0.0%'], 1],
  ['#,##0.00\\ "€";\\-#,##0.00\\ "€"', ['1,234.50 €', '-1,234.50 €', '0.00 €'], 1],
])('saves every section of %s', async (code, shown, maps) => {
  const { content, errors, before, after } = await roundTrip(code);
  expect(before).toEqual(shown);
  expect(after).toEqual(shown);
  expect(errors).not.toHaveBeenCalled();
  expect(content.match(/<style:map style:condition="value\(\)&gt;=?0"|<style:map style:condition="value\(\)&lt;0"/g)).toHaveLength(maps);
});

it('keeps the red ink of a negative section', async () => {
  const { content, back } = await roundTrip('#,##0.00;[Red]-#,##0.00');
  expect(content).toMatch(/<number:number-style style:name="N\d+"><style:text-properties fo:color="#ff0000"\/><number:text>-<\/number:text>/);
  expect(styleToNumFmt(back.getCell(back.activeSheetId, 0, 0).s)).toBe('#,##0.00;[Red]"-"#,##0.00');
});

it('reads LibreOffice\'s positive, negative and zero sections in order', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:automatic-styles>
  <number:number-style style:name="N5P0"><number:number number:decimal-places="0" number:min-decimal-places="0" number:min-integer-digits="1" number:grouping="true"/></number:number-style>
  <number:number-style style:name="N5P1"><style:text-properties fo:color="#0000ff"/><number:text>(</number:text><number:number number:decimal-places="0" number:min-decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text>)</number:text></number:number-style>
  <number:number-style style:name="N5"><number:text>zero</number:text><style:map style:condition="value()&gt;0" style:apply-style-name="N5P0"/><style:map style:condition="value()&lt;0" style:apply-style-name="N5P1"/></number:number-style>
  <style:style style:name="ce1" style:family="table-cell" style:data-style-name="N5"/>
 </office:automatic-styles>
 <office:body><office:spreadsheet><table:table table:name="Data"><table:table-row>${values.map((v) => `<table:table-cell table:style-name="ce1" office:value-type="float" office:value="${v}"><text:p>x</text:p></table:table-cell>`).join('')}</table:table-row></table:table></office:spreadsheet></office:body>
</office:document>`;
  const wb = await workbookFromFile(new TextEncoder().encode(xml), 'sections.fods');
  expect(styleToNumFmt(wb.getCell(wb.activeSheetId, 0, 0).s)).toBe('#,##0;[Blue]"("#,##0")";"zero"');
  expect(values.map((_, c) => wb.getDisplay(wb.activeSheetId, 0, c))).toEqual(['1,235', '(1,235)', 'zero']);
});
