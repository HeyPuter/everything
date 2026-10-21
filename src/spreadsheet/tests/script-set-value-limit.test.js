import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// Range.setValue over more than a million cells is refused, but the refusal came only after the grid of copies of the
// value had been built: over a whole sheet ("A:XFD", or getRange() with no address) that is seventeen billion cells,
// and the script ran until the time limit (two minutes in the app) instead of failing at once with the reason.
describe('Range.setValue past its limit', () => {
  it.each([['getRange("A:XFD")'], ['getRange()'], ['getRange("A:Z")']])('fails at once on %s, saying why', async (range) => {
    const wb = new Workbook();
    const started = Date.now();
    const res = await runScript({ wb, transport: nodeTransport(), timeout: 8000, code: `function main(workbook) {
      workbook.getActiveWorksheet().${range}.setValue(0);
    }` });
    expect(res.timedOut).toBe(false);
    expect(res.error.message).toMatch(/at most 1,000,000 cells/);
    expect(res.error.line).toBe(2);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(null);
  });

  it('still fills a block within the limit', async () => {
    const wb = new Workbook();
    const res = await runScript({ wb, transport: nodeTransport(), code: 'function main(workbook) { workbook.getActiveWorksheet().getRange("B2:C3").setValue(7); }' });
    expect(res.ok).toBe(true);
    expect(wb.getValue(wb.activeSheetId, 2, 2)).toBe(7);
  });
});
