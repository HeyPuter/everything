import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// Text that starts with "=" (pasted as text, or kept as text by an apostrophe) was recorded as it reads, and the
// replay typed it in as a formula: the text "=1+1" came back as 2.
describe('recording text that reads like a formula', () => {
  it('replays it as text, alone and in a block', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.clearHistory();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: '=1+1' } }], 'Paste');
    wb.setCells(id, [{ r: 1, c: 0, cell: { v: '=A1' } }, { r: 1, c: 1, cell: { v: '007' } }, { r: 1, c: 2, cell: { v: "'=x" } }], 'Paste');
    wb.setCells(id, [{ r: 2, c: 0, cell: { v: '=B1' } }, { r: 2, c: 1, cell: { v: null, f: 'A1&"!"' } }], 'Paste');
    const copy = new Workbook(json);
    const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
    expect(res.error).toBe(null);
    const cell = (w, r, c) => { const x = w.getCell(w.activeSheetId, r, c); return [x?.v ?? null, x?.f ?? null]; };
    for (const [r, c] of [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1]]) expect(cell(copy, r, c)).toEqual(cell(wb, r, c));
    expect(cell(copy, 0, 0)).toEqual(['=1+1', null]);
  });
});
