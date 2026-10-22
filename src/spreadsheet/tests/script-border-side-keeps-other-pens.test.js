import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

const pens = (wb, r = 1, c = 1) => {
  const s = wb.styleAt(wb.activeSheetId, r, c) || {};
  const pen = (k) => (s[k] ? [s[`${k}Border`]?.bs ?? s.bs ?? 'thin', s[`${k}Border`]?.bc ?? s.bc ?? null] : null);
  return { top: pen('bt'), bottom: pen('bb'), left: pen('bl'), right: pen('br') };
};
const run = (wb, code) => runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) { const f = workbook.getActiveWorksheet().getRange('B2').getFormat(); ${code} }` });

// The workbook keeps one pen per cell unless a side has its own, so a script setting one side repainted the cell's
// other borders with it: a red thick top border turned the cell's black thin bottom border red and thick.
describe('a script setting one side of a cell\'s border', () => {
  it('leaves the cell\'s other borders as they were', async () => {
    const wb = new Workbook();
    const res = await run(wb, `f.setBorder('bottom', { style: 'thin', color: '#000000' }); f.setBorder('top', { style: 'thick', color: '#ff0000' });`);
    expect(res.error).toBe(null);
    expect(pens(wb)).toEqual({ top: ['thick', '#ff0000'], bottom: ['thin', '#000000'], left: null, right: null });
  });

  it('still repaints a whole box drawn in one go', async () => {
    const wb = new Workbook();
    const res = await run(wb, `f.setBorder('outline', { style: 'thin' }); f.setBorder('outline', { style: 'medium', color: '#00ff00' });`);
    expect(res.error).toBe(null);
    expect(pens(wb).bottom).toEqual(['medium', '#00ff00']);
  });
});
