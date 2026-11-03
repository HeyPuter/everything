import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A number format whose sections test their own conditions ([>=1000]0.0,"K") was written to .ods as its
// first section alone, which LibreOffice then used for every number: 10 in [>=1000000]0.0,,"M";[>=1000]0.0,"K";0
// showed as 0.0M. Each condition is now a style:map to its section's style, as LibreOffice writes them, and
// the reader puts the tests back.
const VALUES = [-150, -3, 0, 1, 2, 10, 150, 1234, 1234567];

it.each([
  '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0',
  '[Red][<0]0.0;[Blue]0.00',
  '[<-100]0;[>100]0.0;0.00',
  '[=1]"one";[=2]"two";0',
  '[<>0]0;"zero"',
  '[>=1000]#,##0,"K";0;"-"',
  // One test of more than zero: zero goes with the rest, as LibreOffice reads the lone value()>0 map too.
  '[>0]0.0;0',
  '[>0]"up";"flat or down"',
])('shows numbers formatted %s in .ods as here', async (code) => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, VALUES.map((v, c) => ({ r: 0, c, cell: { v, s: { fmt: 'custom', code } } })));
  const back = await workbookFromFile(await (await workbookToOds(wb, { settings: false })).arrayBuffer(), 'conditions.ods');
  expect(VALUES.map((v, c) => back.getDisplay(back.activeSheetId, 0, c))).toEqual(VALUES.map((v, c) => wb.getDisplay(id, 0, c)));
});

it('writes each condition as a map to its section', async () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 10, s: { fmt: 'custom', code: '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0' } } }]);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  expect(xml).toMatch(/<style:map style:condition="value\(\)&gt;=1000000" style:apply-style-name="(\w+P0)"\/><style:map style:condition="value\(\)&gt;=1000" style:apply-style-name="\w+P1"\/>/);
});
