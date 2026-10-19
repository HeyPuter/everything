import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { numFmtToStyle, styleToNumFmt } from '../src/core/format.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const ACCOUNTING = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
afterEach(() => vi.restoreAllMocks());

/** The sheet's cells formatted with the given codes, written as another reader sees the .ods (no settings block). */
async function exported(cells) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  cells.forEach(([value, code], r) => wb.setCells(id, [{ r, c: 0, cell: { v: value, f: null, s: numFmtToStyle(code) } }]));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  const back = await workbookFromFile(bytes, 'formats.ods');
  const shown = (book) => cells.map((_, r) => book.getDisplay(book.activeSheetId, r, 0));
  return { content, errors, before: shown(wb), after: shown(back), codes: cells.map((_, r) => styleToNumFmt(back.getCell(back.activeSheetId, r, 0)?.s)) };
}

// A comma after the digits of a code scales the number by a thousand (#,##0,"K" shows 1,235K
// for 1234567); the writer dropped it, so LibreOffice showed 1,234,567K, a thousand times the
// figure on screen. ODF spells the scaling as a display factor.
it('writes a scaling comma as a display factor and reads it back', async () => {
  const { content, before, after, codes } = await exported([[1234567, '#,##0,"K"'], [1234567, '0.0,,"M"'], [1234567, '#,##0']]);
  expect(before).toEqual(['1,235K', '1.2M', '1,234,567']);
  expect(after).toEqual(before);
  expect(codes).toEqual(['#,##0,"K"', '0.0,,"M"', '#,##0']);
  expect(content).toContain('number:display-factor="1000"');
  expect(content).toContain('number:display-factor="1000000"');
  expect(content.match(/number:grouping="true"/g)).toHaveLength(2);
});

// An accounting code pads with _x and fills with * ; the writer found only the digits
// behind them, so the $ was lost, and it logged an error for the code's other sections on
// every save. The padding has no element in ODF and is dropped; the symbol and digits stay.
it('writes an accounting code with its currency symbol, without logging about its sections', async () => {
  const { content, errors, after, codes } = await exported([[1234.5, ACCOUNTING], [-1234.5, '#,##0.00;[Red]-#,##0.00'], [1234.5, '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)']]);
  expect(errors).not.toHaveBeenCalled();
  expect(after).toEqual(['$1,234.50', '-1,234.50', '1,235']);
  // Its sections are styles of their own, mapped by the value's sign (see io-ods-format-sections.test.js).
  expect(codes[0]).toBe('"$"#,##0.00;"$""("#,##0.00")";"$""-"');
  expect(content).toMatch(/<number:currency-style[^>]*><number:currency-symbol[^>]*>\$<\/number:currency-symbol><number:number[^>]*number:grouping="true"[^>]*number:decimal-places="2"/);
  expect(content).not.toMatch(/<number:text>[^<]*_/);
});

// A currency label after the digits is the Currency format written the way most of Europe writes it, so it
// comes back as that format and is laid out in the regional format of whoever opens the file; any other
// literal after a space stays part of the code it came in.
it('keeps a bracketed currency symbol, a literal after a space, and a fill token\'s literal', async () => {
  const { after } = await exported([[1234.5, '[$€-407]#,##0.00'], [1234.5, '#,##0.00 "€"'], [1234.5, '"abc"* 0'], [1234.5, '"$"#,##0.00'], [1234.5, '#,##0.00 "kg"']]);
  expect(after).toEqual(['€1,234.50', '€1,234.50', 'abc1235', '$1,234.50', '1,234.50 kg']);
});
