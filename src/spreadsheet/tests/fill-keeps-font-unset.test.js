import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// In a workbook from Excel (one with its own Normal font) whose columns carry a format, the fill handle and Ctrl+D
// wrote the complete font a copy to another workbook pins on (bold, italic, underline and strike off, black ink)
// into every filled cell, though the source had none of it: a filled #DIV/0! showed in black beside its red
// source, and the cells kept that ink through a later change of the book's look. A fill now carries only what
// the source shows here; a copy for another workbook still takes the complete font.
function book() {
  const wb = new Workbook({ normalFont: { name: 'Calibri', sz: 11 }, sheets: [{ name: 'S',
    cells: { '0,0': { f: '1/0' }, '0,1': { v: 'x' } }, colStyles: { 0: { fmt: 'number', dec: 2 }, 1: { bg: '#ffff00' } } }] });
  return { wb, id: wb.activeSheetId };
}
const FONT_FLAGS = ['bold', 'italic', 'underline', 'strike', 'color'];

it('fills down without pinning a black, regular font on the filled cells', () => {
  const { wb, id } = book();
  wb.fill(id, parseRange('A1:B1'), parseRange('A1:B3'));
  for (const r of [1, 2]) for (const c of [0, 1]) {
    const s = wb.getCell(id, r, c).s || {};
    expect(FONT_FLAGS.filter((k) => k in s)).toEqual([]);
  }
  expect(wb.getCell(id, 2, 0).f).toBe('1/0');
  expect(wb.styleAt(id, 2, 0)).toMatchObject({ fmt: 'number', dec: 2 });
  expect(wb.styleAt(id, 2, 1)).toMatchObject({ bg: '#ffff00' });
  wb.fillDirection(id, parseRange('A1:B5'), 'down');
  expect(FONT_FLAGS.filter((k) => k in (wb.getCell(id, 4, 0).s || {}))).toEqual([]);
});

it('still copies the complete font for another workbook', () => {
  const { wb, id } = book();
  expect(wb.copyRange(id, parseRange('A1:A1'))[0][0].s).toMatchObject({ bold: false, color: '#000000' });
});
