import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

const run = (wb, code) => runScript({ wb, code, transport: nodeTransport(), timeout: 10000 });

describe('a script setting row heights', () => {
  it('sizes every row of the range, below the data too', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'x');
    const res = await run(wb, `async function main(workbook) { workbook.getActiveWorksheet().getRange('A5:B10').getFormat().setRowHeight(40); }`);
    expect(res.ok).toBe(true);
    expect([4, 7, 9].map((r) => wb.rowHeight(id, r))).toEqual([40, 40, 40]);
    expect(wb.rowHeight(id, 10)).not.toBe(40);
  });

  it('replays recorded row heights below the data', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'x');
    wb.clearHistory();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    for (const r of [4, 5, 6]) wb.setRowHeight(id, r, 40);
    const copy = new Workbook(json);
    expect((await run(copy, rec.stop())).ok).toBe(true);
    expect([4, 5, 6].map((r) => copy.rowHeight(copy.activeSheetId, r))).toEqual([40, 40, 40]);
  });
});
