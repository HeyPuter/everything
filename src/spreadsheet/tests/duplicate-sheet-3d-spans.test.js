import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Duplicating the sheet a 3D span ended at moved the span's end onto the copy: a total
// =SUM(Jan:Feb!B2) on Feb became =SUM(Jan:'Feb (copy)'!B2) on its copy, a span now taking in the
// copy itself, and in other sheets too once the copy is moved, so the copy's totals changed. The span
// still runs between the sheets it named, as in Excel; plain references to the sheet follow the copy.
describe('duplicating a sheet a 3D span ends at', () => {
  it('keeps the span and its total, and points own-sheet references at the copy', () => {
    const wb = new Workbook();
    const jan = wb.activeSheetId;
    wb.renameSheet(jan, 'Jan');
    const feb = wb.addSheet('Feb').id;
    wb.setInput(jan, 1, 1, '10');
    wb.setInput(feb, 1, 1, '5');
    wb.setInput(feb, 4, 1, '=SUM(Jan:Feb!B2)');
    wb.setInput(feb, 5, 1, '=Feb!B2*2');
    wb.defineName('Months', '=SUM(Jan:Feb!$B$2)', 'Feb');
    expect(wb.getValue(feb, 4, 1)).toBe(15);
    const copy = wb.duplicateSheet(feb);
    wb.setInput(copy.id, 1, 1, '100');
    expect(wb.getCell(copy.id, 4, 1).f).toBe('SUM(Jan:Feb!B2)');
    expect(wb.getValue(copy.id, 4, 1)).toBe(15);
    expect(wb.getCell(copy.id, 5, 1).f).toBe("'Feb (copy)'!B2*2");
    expect(wb.names.find((n) => n.sheet === copy.name)?.ref).toBe('SUM(Jan:Feb!$B$2)');
  });

  it('still renames the end of a span when the sheet itself is renamed', () => {
    const wb = new Workbook();
    const one = wb.activeSheetId;
    const two = wb.addSheet('Two').id;
    wb.setInput(one, 0, 0, '=SUM(Sheet1:Two!B2)');
    wb.renameSheet(two, 'Last');
    expect(wb.getCell(one, 0, 0).f).toBe('SUM(Sheet1:Last!B2)');
  });
});
