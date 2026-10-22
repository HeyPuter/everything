import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// Text wrapping ▸ Clip at the cell's edge was recorded as setWrapText(false), which leaves text overflowing, so the
// replay did not clip; and overflow chosen on a clipped cell replayed with the clip kept.
describe('recording text wrapping', () => {
  for (const [from, patch] of [[null, { wrap: null, clip: true }], [{ clip: true }, { wrap: null, clip: null }], [{ clip: true }, { wrap: true, clip: null }]]) {
    it(`replays ${JSON.stringify(patch)}${from ? ' on a clipped cell' : ''}`, async () => {
      const wb = new Workbook();
      const id = wb.activeSheetId;
      wb.setInput(id, 0, 0, 'A long piece of text');
      if (from) wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, from);
      wb.clearHistory();
      const json = wb.toJSON();
      const rec = startRecorder(wb);
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, patch);
      const copy = new Workbook(json);
      const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
      expect(res.error).toBe(null);
      const mode = (w) => { const s = w.styleAt(w.activeSheetId, 0, 0) || {}; return [!!s.wrap, !!s.clip]; };
      expect(mode(copy)).toEqual(mode(wb));
    });
  }
});
