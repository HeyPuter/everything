import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

function book() {
  const wb = new Workbook();
  ['k', 'a', 'b', 'a', 'b', 'a'].forEach((v, r) => wb.setInput(wb.activeSheetId, r, 0, v));
  wb.clearHistory();
  return wb;
}
const column = (wb, key = 'v') => Array.from({ length: 6 }, (_, r) => (key === 'v' ? wb.getValue(wb.activeSheetId, r, 0) : !!wb.styleAt(wb.activeSheetId, r, 0)?.bold));
// The rows a filter on "a" hides.
const skipRow = (r) => r === 2 || r === 4;

async function replay(json, code) {
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code, transport: nodeTransport(), timeout: 10000 });
  expect(res.ok).toBe(true);
  return copy;
}

describe('recording an edit over a filtered range', () => {
  it('clears only the rows the filter shows when replayed', async () => {
    const wb = book();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    wb.clearRange(wb.activeSheetId, { r1: 1, c1: 0, r2: 5, c2: 0 }, { contents: true, skipRow });
    const code = rec.stop();
    expect(column(wb)).toEqual(['k', null, 'b', null, 'b', null]);
    expect(column(await replay(json, code))).toEqual(column(wb));
  });

  it('formats only the rows the filter shows when replayed', async () => {
    const wb = book();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    wb.applyStyle(wb.activeSheetId, { r1: 1, c1: 0, r2: 5, c2: 0 }, { bold: true }, { skipRow });
    const code = rec.stop();
    expect(column(wb, 'bold')).toEqual([false, true, false, true, false, true]);
    expect(column(await replay(json, code), 'bold')).toEqual(column(wb, 'bold'));
  });
});
