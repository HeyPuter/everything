import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// The assistant's tools write on the sheet a call names. With the active sheet grouped with another (both tabs
// selected), each cell a tool wrote, cleared or formatted was changed on the other sheet as well, as typing into a
// group is, though the tool reported the one sheet: "Write 1 cell to Model!F6" also wrote Notes!F6.
it('writes, clears and formats the sheet a call names only, whatever sheets are grouped with it', () => {
  const wb = new Workbook({ sheets: [{ name: 'Model' }, { name: 'Notes' }] });
  const [model, notes] = wb.sheets.map((s) => s.id);
  wb.setActiveSheet(model);
  wb.setInput(model, 0, 0, '1');
  wb.setInput(notes, 0, 0, 'Mine'); wb.setInput(notes, 4, 3, 'Kept');
  wb.groupSheets([model, notes]);
  const env = { sheetId: () => model, selection: () => null };
  const before = JSON.stringify([...wb.sheet(notes).cells]);
  expect(runTool(wb, 'write_cells', { start_cell: 'F6', values: [['x']] }, env).ok).toBe(true);
  expect(runTool(wb, 'clear_range', { range: 'A1' }, env).ok).toBe(true);
  expect(runTool(wb, 'format_cells', { range: 'C1', bold: true }, env).ok).toBe(true);
  expect(wb.getValue(model, 5, 5)).toBe('x');
  expect(wb.getValue(model, 0, 0)).toBe(null);
  expect(wb.getCell(model, 0, 2)?.s).toMatchObject({ bold: true });
  expect(JSON.stringify([...wb.sheet(notes).cells])).toBe(before);
});
