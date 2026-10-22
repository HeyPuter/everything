import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// A sort by fill colour was recorded as a sort by value (the colour key dropped), so b, a, c sorted with the yellow c
// on top replayed as a, b, c.
it('replays a sort by fill colour as it was sorted', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['b', 'a', 'c'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, { bg: '#ffff00' });
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  wb.sortRangeBy(id, { r1: 0, c1: 0, r2: 2, c2: 0 }, [{ col: 0, color: '#ffff00' }]);
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  const col = (w) => [0, 1, 2].map((r) => [w.getValue(w.activeSheetId, r, 0), w.styleAt(w.activeSheetId, r, 0)?.bg ?? null]);
  expect(col(wb)[0]).toEqual(['c', '#ffff00']);
  expect(col(copy)).toEqual(col(wb));
});
