import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A grouped insertion or deletion is made sheet by sheet, and a 3D reference follows an edit on any sheet it
// covers: a span over two grouped sheets moved twice, so =SUM(Sheet1:Sheet2!A5) became A7 after one row went in.
function book() {
  const wb = new Workbook();
  const s1 = wb.activeSheetId, s2 = wb.addSheet('Sheet2').id, s3 = wb.addSheet('Sheet3').id;
  wb.setInput(s1, 4, 0, '1');
  wb.setInput(s2, 4, 0, '2');
  wb.setInput(s3, 0, 0, '=SUM(Sheet1:Sheet2!A5)');
  wb.setInput(s3, 1, 0, '=SUM(Sheet1:Sheet2!A1:A10)');
  wb.addRule(s3, { type: 'formula', value: '=SUM(Sheet1:Sheet2!$A$5)>0', range: { r1: 0, c1: 1, r2: 0, c2: 1 }, style: { bold: true } });
  wb.defineName('Both', 'Sheet1:Sheet2!$A$5');
  wb.setActiveSheet(s1);
  wb.groupSheets([s1, s2]);
  return { wb, s1, s2, s3 };
}

describe('3D references through edits on grouped sheets', () => {
  it('move once when rows are inserted on every grouped sheet', () => {
    const { wb, s1, s3 } = book();
    wb.insertRows(s1, 0, 1);
    expect(wb.getCell(s3, 0, 0).f).toBe('SUM(Sheet1:Sheet2!A6)');
    expect(wb.getCell(s3, 1, 0).f).toBe('SUM(Sheet1:Sheet2!A2:A11)');
    expect(wb.getValue(s3, 0, 0)).toBe(3);
    expect(wb.sheet(s3).rules[0].value).toBe('=SUM(Sheet1:Sheet2!$A$6)>0');
    expect(wb.names.find((n) => n.name === 'Both').ref).toBe('Sheet1:Sheet2!$A$6');
  });

  it('move once when rows are deleted on every grouped sheet', () => {
    const { wb, s1, s3 } = book();
    wb.deleteRows(s1, 0, 1);
    expect(wb.getCell(s3, 0, 0).f).toBe('SUM(Sheet1:Sheet2!A4)');
    expect(wb.getCell(s3, 1, 0).f).toBe('SUM(Sheet1:Sheet2!A1:A9)');
    expect(wb.getValue(s3, 0, 0)).toBe(3);
    wb.undo();
    expect(wb.getCell(s3, 0, 0).f).toBe('SUM(Sheet1:Sheet2!A5)');
  });

  it('still move with an edit on one sheet of the span when the sheets are not grouped', () => {
    const { wb, s1, s3 } = book();
    wb.ungroupSheets();
    wb.insertRows(s1, 0, 1);
    expect(wb.getCell(s3, 0, 0).f).toBe('SUM(Sheet1:Sheet2!A6)');
  });
});
