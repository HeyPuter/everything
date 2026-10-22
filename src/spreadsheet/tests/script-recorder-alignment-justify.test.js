import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// Format Cells offers Fill, Justify, Center Across Selection and Distributed; a recording of one wrote
// setHorizontalAlignment("justify"), which the script API refused, so the replay failed at that line.
describe('a recorded horizontal alignment from Format Cells', () => {
  for (const align of ['fill', 'justify', 'centerContinuous', 'distributed']) {
    it(`replays ${align}`, async () => {
      const wb = new Workbook();
      const id = wb.activeSheetId;
      wb.setInput(id, 0, 0, 'Some text');
      wb.clearHistory();
      const json = wb.toJSON();
      const rec = startRecorder(wb);
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { align });
      const copy = new Workbook(json);
      const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
      expect(res.error).toBe(null);
      expect(copy.styleAt(copy.activeSheetId, 0, 1)?.align).toBe(align);
    });
  }
});
