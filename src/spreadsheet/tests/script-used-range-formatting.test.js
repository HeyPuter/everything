import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

async function used(wb, valuesOnly = false) {
  const logs = [];
  const res = await runScript({ wb, transport: nodeTransport(), timeout: 10000, onLog: (l) => logs.push(l.text), code: `async function main(workbook) {
    const r = await workbook.getActiveWorksheet().getUsedRange(${valuesOnly});
    console.log(r ? r.getAddress() : 'none');
  }` });
  expect(res.error).toBe(null);
  return logs[0].replace(/^.*!/, '');
}

// getUsedRange() counted a formatted cell above or left of the data but not one below or right of it (and found
// nothing on a sheet holding formatting alone), where Office counts formatting on every side.
describe('a script\'s getUsedRange', () => {
  function book() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 1, 1, '1'); wb.setInput(id, 2, 2, '2');
    return { wb, id };
  }
  it('counts formatted cells on every side', async () => {
    const { wb, id } = book();
    wb.applyStyle(id, { r1: 9, c1: 4, r2: 9, c2: 4 }, { bg: '#ffff00' });
    expect(await used(wb)).toBe('B2:E10');
    expect(await used(wb, true)).toBe('B2:C3');
  });
  it('still counts one above and left of the data', async () => {
    const { wb, id } = book();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    expect(await used(wb)).toBe('A1:C3');
  });
  it('finds a sheet holding formatting alone', async () => {
    const wb = new Workbook();
    wb.applyStyle(wb.activeSheetId, { r1: 3, c1: 1, r2: 4, c2: 2 }, { bg: '#ffff00' });
    expect(await used(wb)).toBe('B4:C5');
  });
});

describe('the samples that work on a sheet\'s data', () => {
  it('still find the data, not the formatted cells around it', async () => {
    const { sampleById } = await import('../src/core/scripts.js');
    const wb = new Workbook();
    const id = wb.activeSheetId;
    [['Item', 'Qty'], ['a', '2'], ['b', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    wb.applyStyle(id, { r1: 9, c1: 0, r2: 9, c2: 3 }, { bg: '#ffff00' });
    const res = await runScript({ wb, transport: nodeTransport(), timeout: 10000, code: sampleById('sum-each-column').code });
    expect(res.error).toBe(null);
    expect(wb.getCell(id, 3, 1)?.f).toBe('SUM(B2:B3)');
  });
});
