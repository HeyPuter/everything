import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { sampleById } from '../src/core/scripts.js';
import { nodeTransport } from './helpers/script-transport.js';

// The Make a table of contents sample wrote each sheet's link as =HYPERLINK("#'Name'!A1", "Name"), doubling a double
// quote in the label but not in the link: for a sheet named Say "hi" the formula broke off mid-string and its cell
// showed an error in place of the link.
it('links to a sheet whose name holds a double quote', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Say "hi"' }] });
  const res = await runScript({ wb, transport: nodeTransport(), code: sampleById('table-of-contents').code });
  expect(res.error).toBe(null);
  const contents = wb.sheetByName('Contents').id;
  expect(wb.getValue(contents, 2, 0)).toBe('Say "hi"');
  expect(wb.getCell(contents, 2, 0).f).toBe(`HYPERLINK("#'Say ""hi""'!A1", "Say ""hi""")`);
  expect(wb.getValue(contents, 1, 0)).toBe('Data');
});
