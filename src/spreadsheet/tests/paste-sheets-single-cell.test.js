// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';

// Google Sheets copies a single cell as a <span> carrying its value (data-sheets-value), not as a table. With no
// table to read, the paste fell back to the plain text: a cell showing 1.23 for 1.23456 pasted as 1.23, and the
// text 00123 became the number 123. The span is now read as the one cell it is, value and format included.
const cell = (value, format, text) => '<meta charset="utf-8"><google-sheets-html-origin><span style="font-size:10pt;font-family:Arial;font-style:normal;" '
  + `data-sheets-root="1" data-sheets-value="${value.replaceAll('"', '&quot;')}"${format ? ` data-sheets-numberformat="${format.replaceAll('"', '&quot;')}"` : ''}>${text}</span>`;
const paste = (html, text) => cellsFromHtmlRows(parseHtmlClipboard(html, text).rows).map((e) => e.cell);

describe('one cell copied from Google Sheets', () => {
  it('keeps the value behind the shown text', () => {
    const [c] = paste(cell('{"1":3,"3":1.23456}', '{"1":2,"2":"0.00","3":1}', '1.23'), '1.23');
    expect(c.v).toBe(1.23456);
  });

  it('keeps text that reads as a number as text', () => {
    expect(paste(cell('{"1":2,"2":"00123"}', null, '00123'), '00123')[0].v).toBe('00123');
  });

  it('still gives no table for other markup', () => {
    expect(parseHtmlClipboard('<span>hello</span>', 'hello')).toBeNull();
  });
});
