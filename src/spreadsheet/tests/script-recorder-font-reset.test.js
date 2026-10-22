import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// Putting a cell's font and size back to the workbook's (Default in the font boxes) was recorded as
// setName("Calibri") and setSize(9.75), so the replay pinned Calibri at 13px on a cell meant to follow the workbook.
it('replays a font and size put back to the workbook\'s own', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'x');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { font: 'georgia', size: 20 });
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { font: null, size: null });
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  const own = (w) => { const s = w.getCell(w.activeSheetId, 0, 0)?.s || {}; return [s.font ?? null, s.size ?? null]; };
  expect(own(wb)).toEqual([null, null]);
  expect(own(copy)).toEqual(own(wb));
});
