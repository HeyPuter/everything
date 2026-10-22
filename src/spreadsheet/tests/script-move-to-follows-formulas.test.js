import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

async function record(setup, edit) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  setup(wb, id);
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  edit(wb, id);
  const code = rec.stop();
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code, transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  return { wb, copy, id: copy.activeSheetId, code };
}

describe('recording', () => {
  it('replays a move with the formulas that point at the cells following them', async () => {
    const { wb, copy, id, code } = await record((wb, id) => { wb.setInput(id, 0, 0, '5'); wb.setInput(id, 0, 1, '=A1*2'); },
      (wb, id) => wb.moveRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, 2, 0));
    expect(code).toContain('moveTo("A3")');
    expect(wb.getCell(wb.activeSheetId, 0, 1).f).toBe('A3*2');
    expect(copy.getCell(id, 0, 1).f).toBe('A3*2');
    expect(copy.getValue(id, 2, 0)).toBe(5);
    expect(copy.getValue(id, 0, 1)).toBe(10);
  });

});

describe('a script\'s moveTo', () => {
  it('moves cells on the sheet and refuses another sheet', async () => {
    const wb = new Workbook({ sheets: [{ name: 'Sheet1' }, { name: 'Other' }] });
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1'); wb.setInput(id, 1, 0, '2'); wb.setInput(id, 0, 2, '=SUM(A1:A2)');
    const ok = await runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) {
      const moved = workbook.getActiveWorksheet().getRange('A1:A2').moveTo('B5');
      console.log(moved.getAddress());
    }` });
    expect(ok.error).toBe(null);
    expect(wb.getValue(id, 4, 1)).toBe(1);
    expect(wb.getCell(id, 0, 2).f).toBe('SUM(B5:B6)');
    const bad = await runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) {
      workbook.getActiveWorksheet().getRange('B5').moveTo(workbook.getWorksheet('Other').getRange('A1'));
    }` });
    expect(bad.error?.message).toMatch(/own worksheet/);
  });
});
