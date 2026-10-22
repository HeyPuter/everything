import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// format_cells formatted only the cells a sheet already had: on a new sheet of 100 rows, B95:B105 came out bold to
// B100 alone, and A150:C150 not at all (reported as "may be locked"), while the model was told it was done.
describe('the assistant formatting cells past the sheet\'s present size', () => {
  it('formats every cell of the range, as one undo step', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const env = { sheetId: () => id, selection: () => null };
    const rows = wb.sheet(id).rows;
    const steps = wb.undoLabels().length;
    expect(runTool(wb, 'format_cells', { range: `B${rows - 5}:B${rows + 5}`, bold: true }, env).ok).toBe(true);
    expect(wb.styleAt(id, rows + 4, 1)?.bold).toBe(true);
    const res = runTool(wb, 'format_cells', { range: `A${rows + 50}:C${rows + 50}`, number_format: 'currency' }, env);
    expect(res.content).not.toMatch(/nothing in the workbook changed/);
    expect(wb.styleAt(id, rows + 49, 2)?.fmt).toBe('currency');
    expect(wb.undoLabels().length).toBe(steps + 2);
  });
});
