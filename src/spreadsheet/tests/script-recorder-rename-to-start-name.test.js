import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// The first edit's sheet was written as the active sheet whenever it bore the start sheet's name: with Sheet1
// renamed Old and Sheet2 renamed Sheet1, an edit on that new Sheet1 replayed on Old.
it('replays edits on the sheet that took the start sheet\'s name', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1' }, { name: 'Sheet2' }] });
  wb.clearHistory();
  const json = wb.toJSON();
  const [s1, s2] = wb.sheets.map((s) => s.id);
  const rec = startRecorder(wb);
  wb.renameSheet(s1, 'Old');
  wb.renameSheet(s2, 'Sheet1');
  wb.setInput(s2, 0, 0, 'here');
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  expect(copy.getValue(copy.sheetByName('Sheet1').id, 0, 0)).toBe('here');
  expect(copy.getValue(copy.sheetByName('Old').id, 0, 0)).toBe(null);
});
