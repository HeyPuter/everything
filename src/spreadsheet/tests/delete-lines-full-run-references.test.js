import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Deleting every row keeps one empty row, and the deletion trimmed to it renumbered references one row
// short: a reference to the last row became A1 instead of #REF!, and every reference below landed one row
// low. A band past the sheet's extent was clamped the same way, so references below it moved too little.
describe('references follow the whole deletion asked for', () => {
  it('turns references to every deleted row into #REF! and moves the rest up by all of them', () => {
    const wb = new Workbook();
    const s1 = wb.activeSheetId;
    const s2 = wb.addSheet('Two').id;
    const rows = wb.sheet(s1).rows;
    wb.setInput(s1, rows - 1, 0, 'last');
    wb.setInput(s2, 0, 0, `=Sheet1!A${rows}`);
    wb.setInput(s2, 1, 0, '=Sheet1!A1');
    wb.setInput(s2, 2, 0, `=Sheet1!A${rows + 50}`);
    wb.setInput(s2, 3, 0, `=SUM(Sheet1!A1:A${rows})`);
    wb.addRule(s1, { type: 'formula', value: `=$A$${rows + 5}>0`, range: { r1: rows + 4, c1: 1, r2: rows + 9, c2: 1 }, style: { bold: true } });
    const before = wb.toJSON();
    wb.deleteRows(s1, 0, rows);
    expect([0, 1, 2, 3].map(r => wb.getCell(s2, r, 0).f)).toEqual(['#REF!', '#REF!', 'Sheet1!A50', 'SUM(#REF!)']);
    expect(wb.sheet(s1).rules[0].range).toEqual({ r1: 4, c1: 1, r2: 9, c2: 1 });
    expect(wb.sheet(s1).rules[0].value).toBe('=$A$5>0');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
  });

  it('does the same for columns', () => {
    const wb = new Workbook();
    const s1 = wb.activeSheetId;
    const s2 = wb.addSheet('Two').id;
    wb.setInput(s2, 0, 0, '=Sheet1!Z1');
    wb.setInput(s2, 1, 0, '=Sheet1!AD1');
    wb.deleteCols(s1, 0, wb.sheet(s1).cols);
    expect(wb.getCell(s2, 0, 0).f).toBe('#REF!');
    expect(wb.getCell(s2, 1, 0).f).toBe('Sheet1!D1');
  });

  it('moves references below a band that runs past the sheet by the whole band', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 1, '=A300');
    wb.setInput(id, 1, 1, '=A150');
    wb.deleteRows(id, 50, 150);
    expect(wb.getCell(id, 0, 1).f).toBe('A150');
    expect(wb.getCell(id, 1, 1).f).toBe('#REF!');
    expect(wb.sheet(id).rows).toBe(50);
  });
});
