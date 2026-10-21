import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { sampleById } from '../src/core/scripts.js';
import { nodeTransport } from './helpers/script-transport.js';

// A chart sheet has no rows or columns, so a script showing the rows and columns of every sheet failed on the first
// chart sheet it met ('"Plot" is a chart sheet, which has no cells'): the gallery's own Unhide everything sample failed
// on any workbook holding one, after it had shown the rows of the sheets before it. Showing them there is nothing to do.
describe('showing rows and columns on a chart sheet', () => {
  const book = () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Plot', kind: 'chart' }, { name: 'More' }] });
    wb.setHidden(wb.sheetByName('Data').id, 'row', [2], true);
    wb.setHidden(wb.sheetByName('More').id, 'col', [1], true);
    return wb;
  };

  it('lets the Unhide everything sample run through a workbook with a chart sheet', async () => {
    const wb = book();
    const logs = [];
    const res = await runScript({ wb, transport: nodeTransport(), code: sampleById('unhide-everything').code, onLog: (l) => logs.push(l.text) });
    expect(res.error).toBe(null);
    expect(wb.isHidden(wb.sheetByName('Data').id, 'row', 2)).toBe(false);
    expect(wb.isHidden(wb.sheetByName('More').id, 'col', 1)).toBe(false);
    expect(logs).toEqual(['Checked 3 sheet(s).']);
  });

  it('still refuses to hide rows on a chart sheet', async () => {
    const wb = book();
    const res = await runScript({ wb, transport: nodeTransport(), code: 'function main(workbook) { workbook.getWorksheet("Plot").getRange("1:3").setRowsHidden(true); }' });
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/chart sheet/);
  });
});
