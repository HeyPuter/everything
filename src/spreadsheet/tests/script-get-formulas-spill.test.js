import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// getFormulas gives each cell's formula or its value, but the cells a dynamic array spills into came back null
// though they show values: =SEQUENCE(3) read as ["=SEQUENCE(3)", null, null].
it('gives the values an array formula spills', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=SEQUENCE(3)');
  wb.setInput(id, 0, 1, 'x');
  const logs = [];
  const res = await runScript({ wb, transport: nodeTransport(), timeout: 10000, onLog: (l) => logs.push(l.text), code: `async function main(workbook) {
    console.log(JSON.stringify(await workbook.getActiveWorksheet().getRange('A1:B3').getFormulas()));
  }` });
  expect(res.error).toBe(null);
  expect(JSON.parse(logs[0])).toEqual([['=SEQUENCE(3)', 'x'], [2, null], [3, null]]);
});
