import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => null, distrust() {}, select: () => true };
  return { wb, id, run: (n, a) => runTool(wb, n, a, env), desc: (n, a) => describeCall(wb, n, a, env) };
}

describe('the assistant writing a block it read back', () => {
  it('leaves a linked cell holding the same text as it was, without asking', () => {
    const { wb, id, run, desc } = setup();
    wb.setLink(id, 0, 0, 'https://example.com/report', 'Report');
    wb.setInput(id, 0, 1, '12');
    expect(desc('write_cells', { start_cell: 'A1', values: [['Report', 15]] }).destructive).toBe(true); // B1 changes
    const res = run('write_cells', { start_cell: 'A1', values: [['Report', 15]] });
    expect(res.ok).toBe(true);
    expect(wb.getCell(id, 0, 0)).toMatchObject({ v: 'Report', hyperlink: 'https://example.com/report' });
    expect(wb.getValue(id, 0, 1)).toBe(15);
    expect(JSON.parse(res.content.split('\n')[0])).toMatchObject({ cells: 1, unchanged: 1 });
  });

  it('keeps the mixed formatting of a cell\'s text', () => {
    const { wb, id, run } = setup();
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Bold start', richText: [{ text: 'Bold', bold: true }, { text: ' start' }] } }]);
    const before = JSON.stringify(wb.getCell(id, 0, 0).richText);
    expect(run('write_cells', { start_cell: 'A1', values: [['Bold start']] }).ok).toBe(true);
    expect(JSON.stringify(wb.getCell(id, 0, 0).richText)).toBe(before);
  });
});
