import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// A typed number keeps 15 significant digits, as in Excel, but was recorded as typed, and the replay kept more:
// 12345678901234567890 typed held 12345678901234500000, and its replay 12345678901234567000.
it('replays a long typed number as the cell holds it', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  wb.setInput(id, 0, 0, '12345678901234567890', { typed: true });
  wb.setInput(id, 1, 0, '42', { typed: true });
  wb.setInput(id, 2, 0, '1/2', { typed: true });
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  for (const r of [0, 1, 2]) {
    expect(copy.getValue(copy.activeSheetId, r, 0)).toBe(wb.getValue(id, r, 0));
    expect(copy.getDisplay(copy.activeSheetId, r, 0)).toBe(wb.getDisplay(id, r, 0));
  }
  expect(wb.getValue(id, 0, 0)).toBe(12345678901234500000);
});
