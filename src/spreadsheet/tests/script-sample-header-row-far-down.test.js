import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { sampleById } from '../src/core/scripts.js';
import { nodeTransport } from './helpers/script-transport.js';

const run = (wb) => runScript({ wb, transport: nodeTransport(), code: sampleById('header-row').code });

// The Style and freeze the header row sample froze the rows down to the header whatever its row, but panes hold at
// most 50 frozen rows: with the data from row 61 it failed halfway, the header styled and an error reported.
it('styles a header below row 50 without failing, and freezes one above it', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 60, 0, 'Name'); wb.setInput(id, 61, 0, 'pear');
  const res = await run(wb);
  expect(res.error).toBe(null);
  expect(wb.styleAt(id, 60, 0)?.bold).toBe(true);
  expect(wb.sheet(id).frozenRows || 0).toBe(0);

  const near = new Workbook();
  near.setInput(near.activeSheetId, 2, 0, 'Name'); near.setInput(near.activeSheetId, 3, 0, 'pear');
  expect((await run(near)).error).toBe(null);
  expect(near.sheet(near.activeSheetId).frozenRows).toBe(3);
});
