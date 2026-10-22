import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// Table.setShowTotals checked the table it had found before the change, which the workbook replaces when it changes
// it: the totals row was shown, and the script still stopped with "The totals row of Fruit could not be shown."
it('shows and hides a table\'s totals row without reporting a failure', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty'], ['pear', '3'], ['fig', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'Fruit' });
  const run = (on) => runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) { (await workbook.getTable('Fruit')).setShowTotals(${on}); }` });
  expect((await run(true)).error).toBe(null);
  expect(wb.sheet(id).tables[0].totalsRow).toBeTruthy();
  expect((await run(false)).error).toBe(null);
  expect(wb.sheet(id).tables[0].totalsRow).toBeFalsy();
});
