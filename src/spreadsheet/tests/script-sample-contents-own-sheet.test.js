import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { sampleById } from '../src/core/scripts.js';
import { nodeTransport } from './helpers/script-transport.js';

// The Make a table of contents sample found its sheet by name in any case but skipped it only when spelt
// "Contents": with a sheet named "contents" it listed that sheet, a link to itself, among the others.
it('leaves its own sheet out of the list whatever its case', async () => {
  const wb = new Workbook({ sheets: [{ name: 'contents' }, { name: 'Data' }] });
  const res = await runScript({ wb, transport: nodeTransport(), code: sampleById('table-of-contents').code });
  expect(res.error).toBe(null);
  const contents = wb.sheetByName('contents').id;
  expect(wb.sheets).toHaveLength(2);
  expect(wb.getValue(contents, 1, 0)).toBe('Data');
  expect(wb.getValue(contents, 2, 0)).toBe(null);
});
