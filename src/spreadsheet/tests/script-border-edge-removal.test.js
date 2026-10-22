import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

const run = (wb, code) => runScript({ wb, code, transport: nodeTransport(), timeout: 10000 });
const edges = (wb, r = 1, c = 1) => {
  const s = wb.styleAt(wb.activeSheetId, r, c) || {};
  const pen = (k) => (s[k] ? { style: s[`${k}Border`]?.bs ?? s.bs ?? 'thin', color: s[`${k}Border`]?.bc ?? s.bc ?? null } : null);
  return { top: pen('bt'), bottom: pen('bb'), left: pen('bl'), right: pen('br') };
};

describe('script borders', () => {
  it('takes one edge off with style "none"', async () => {
    const wb = new Workbook();
    const res = await run(wb, `async function main(workbook) {
      const f = workbook.getActiveWorksheet().getRange('B2').getFormat();
      f.setBorder('outline', { style: 'thin' });
      f.setBorder('top', { style: 'none' });
    }`);
    expect(res.error).toBe(null);
    expect(edges(wb)).toMatchObject({ top: null, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } });
  });

  it('replays a border removed in Format Cells as removed', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.applyBorders(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, 'outer', { style: 'thin', perSide: true });
    wb.clearHistory();
    const json = wb.toJSON();
    const rec = startRecorder(wb);
    wb.applyBorders(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, 'top', { perSide: true, remove: true });
    const copy = new Workbook(json);
    expect((await run(copy, rec.stop())).error).toBe(null);
    expect(edges(wb).top).toBe(null);
    expect(edges(copy)).toEqual(edges(wb));
  });
});
