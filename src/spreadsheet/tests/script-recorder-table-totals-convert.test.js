import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty'], ['pear', '3'], ['fig', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'Fruit' });
  wb.clearHistory();
  return wb;
}
async function replay(json, code) {
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code, transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  return copy;
}

describe('recording a table\'s', () => {
  it('totals row replays as the totals row', async () => {
    const wb = book();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    wb.setTableTotals(wb.activeSheetId, wb.sheet(wb.activeSheetId).tables[0].id, true);
    const copy = await replay(json, rec.stop());
    const id = copy.activeSheetId;
    expect(copy.sheet(id).tables[0].totalsRow).toBeTruthy();
    expect(copy.getValue(id, 3, 1)).toBe(wb.getValue(wb.activeSheetId, 3, 1));
  });

  it('conversion to a range replays as a conversion', async () => {
    const wb = book();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    wb.deleteTable(wb.activeSheetId, wb.sheet(wb.activeSheetId).tables[0].id);
    const copy = await replay(json, rec.stop());
    expect(copy.sheet(copy.activeSheetId).tables).toHaveLength(0);
    expect(copy.getValue(copy.activeSheetId, 1, 0)).toBe('pear');
  });
});
