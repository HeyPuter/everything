import { describe, expect, it } from 'vitest';
import { wrapLines, heightForLines } from '../src/core/textfit.js';
import { measureRows } from '../src/core/row-height.js';
import { Workbook } from '../src/core/workbook.js';

const measure = (t) => [...t].length * 10; // 10px a character

// A cell's wrapped text is laid out by the browser, which breaks lines after hyphens and between the characters
// of Chinese, Japanese and Korean as well as at spaces; the rows were fitted by counting lines broken at spaces
// alone. Most CJK text got a row a line too tall, and hyphenated text could get one a line too short, its last
// line cut off.
describe('wrapped lines break where the browser breaks them', () => {
  it('after a hyphen inside a word or a date, never after the minus of a number', () => {
    // The browser: "xx-" / "yyyyyy" / "zz". Broken at spaces alone it fitted two lines, hiding the third.
    expect(wrapLines('xx-yyyyyy zz', 80, measure)).toEqual(['xx-', 'yyyyyy', 'zz']);
    expect(wrapLines('a well-known fact', 80, measure)).toEqual(['a well-', 'known', 'fact']);
    expect(wrapLines('2024-01-05', 60, measure)).toEqual(['2024-', '01-05']);
    expect(wrapLines('to -5 or -6', 50, measure)).toEqual(['to -5', 'or -6']);
  });

  it('between Chinese, Japanese and Korean characters, keeping closing punctuation off the start of a line', () => {
    expect(wrapLines('ab 日本語', 60, measure)).toEqual(['ab 日本語']);
    expect(wrapLines('日本語。です', 30, measure)).toEqual(['日本', '語。で', 'す']);
    expect(wrapLines('「引用」です', 40, measure)).toEqual(['「引用」', 'です']);
    expect(wrapLines('한국어 텍스트', 40, measure)).toEqual(['한국어', '텍스트']);
  });

  it('keeps the offsets of the lines, for rich text laid out run by run', () => {
    const starts = [];
    wrapLines('ab-cd 日本語', 30, measure, (line, start) => starts.push([line, start]));
    expect(starts).toEqual([['ab-', 0], ['cd', 3], ['日本語', 6]]);
  });

  it('fits a row to the lines the cell shows', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setColWidth(id, 0, 80 + 5); // 80px for the text once the cell's padding is taken
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'xx-yyyyyy zz', s: { wrap: true, size: 10 } } }]);
    const heights = measureRows(wb, id, 0, 0, { textWidth: (t) => measure(t), baseFontSize: 10 });
    expect(heights.get(0)).toBe(heightForLines(3, 10, wb.sheets[0].defaultRowHeight));
  });
});
