// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Workbook, cellFromInput } from '../src/core/workbook.js';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';
import { parseRange } from '../src/core/cell.js';

// Typing 5 into a Percent cell means 5% (automatic percent entry), but a paste is not typing: numbers pasted as
// text into a percent column were scaled by their size, so a column of 5, 10 and 0.5 landed as 5%, 10% and 50%,
// one value kept and the others divided by a hundred without a word. As in Excel, a pasted number keeps its
// value (5 shows as 500%); a pasted "12%" is still 0.12, and typing still reads 5 as 5%.
describe('numbers pasted into percent cells', () => {
  const setup = () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyStyle(id, parseRange('A1:A10'), { fmt: 'percent', dec: 0 });
    return { wb, id };
  };

  it('keep the values of pasted text', () => {
    const { wb, id } = setup();
    wb.pasteValues(id, [['5'], ['10'], ['0.5'], ['12%']], 0, 0);
    expect([0, 1, 2, 3].map((r) => wb.getValue(id, r, 0))).toEqual([5, 10, 0.5, 0.12]);
    expect(wb.getDisplay(id, 0, 0)).toBe('500%');
  });

  it('keep the values of a pasted web table', () => {
    const { wb, id } = setup();
    const { rows } = parseHtmlClipboard('<table><tr><td>5</td></tr><tr><td>0.5</td></tr></table>', '5\n0.5');
    const cells = cellsFromHtmlRows(rows, (i, j) => wb.styleAt(id, i, j));
    expect(cells.map((e) => e.cell.v)).toEqual([5, 0.5]);
  });

  it('still read a typed whole number as that many percent', () => {
    const { wb, id } = setup();
    wb.setInput(id, 0, 0, '5');
    expect(wb.getValue(id, 0, 0)).toBe(0.05);
    expect(cellFromInput('5', { fmt: 'percent' }).v).toBe(0.05);
  });
});
