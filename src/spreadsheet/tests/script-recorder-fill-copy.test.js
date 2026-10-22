import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

const col = (wb) => Array.from({ length: 4 }, (_, r) => wb.getValue(wb.activeSheetId, r, 0));
async function recordFill(values, source, opts) {
  const wb = new Workbook();
  values.forEach((v, r) => wb.setInput(wb.activeSheetId, r, 0, v));
  wb.applyStyle(wb.activeSheetId, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  wb.fill(wb.activeSheetId, source, { r1: 0, c1: 0, r2: 3, c2: 0 }, opts);
  const code = rec.stop();
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code, transport: nodeTransport(), timeout: 10000 });
  expect(res.ok).toBe(true);
  return { wb, copy };
}

describe('recording a fill', () => {
  it('replays Copy Cells as a copy, not a series', async () => {
    const { wb, copy } = await recordFill(['1', '2'], { r1: 0, c1: 0, r2: 1, c2: 0 }, { series: false });
    expect(col(wb)).toEqual([1, 2, 1, 2]);
    expect(col(copy)).toEqual(col(wb));
    expect(copy.styleAt(copy.activeSheetId, 2, 0)?.bold).toBe(true);
  });

  it('replays a Ctrl-drag count of one number as a count', async () => {
    const { wb, copy } = await recordFill(['1'], { r1: 0, c1: 0, r2: 0, c2: 0 }, { invert: true });
    expect(col(wb)).toEqual([1, 2, 3, 4]);
    expect(col(copy)).toEqual(col(wb));
  });

  it('still records an ordinary fill as autoFill', async () => {
    const { wb, copy } = await recordFill(['1', '2'], { r1: 0, c1: 0, r2: 1, c2: 0 });
    expect(col(wb)).toEqual([1, 2, 3, 4]);
    expect(col(copy)).toEqual(col(wb));
  });
});
