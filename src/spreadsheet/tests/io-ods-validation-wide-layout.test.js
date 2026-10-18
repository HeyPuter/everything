import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A sheet with a dropdown list (or any validation rule) and a column width or hidden column past both the
// rule and the data: Download as .ods counted no cells for the columns past the rule and never moved on,
// writing empty cells until the tab ran out of memory. The run there now reaches the last column declared.

const book = (layout) => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Status');
  wb.addValidation(id, { type: 'list', range: { r1: 1, c1: 1, r2: 3, c2: 1 }, source: 'Open,Closed', strict: true });
  layout(wb, id);
  return wb;
};

it.each([
  ['a column width', (wb, id) => wb.setColWidth(id, 4, 200), (s) => expect(s.colWidths.get(4)).toBe(200)],
  ['a hidden column', (wb, id) => wb.setHidden(id, 'col', [5], true), (s) => expect([...s.hiddenCols]).toEqual([5])],
])('saves a sheet with a list rule and %s past it as .ods', async (_, layout, check) => {
  const wb = book(layout);
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  // Every row declares as many cells as the table has columns.
  const table = content.slice(content.indexOf('<table:table '), content.indexOf('</table:table>'));
  const count = (tags) => tags.reduce((n, tag) => n + Number(/number-columns-repeated="(\d+)"/.exec(tag)?.[1] || 1), 0);
  const columns = count(table.match(/<table:table-column\b[^>]*>/g));
  for (const row of table.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g)) {
    expect(count(row.match(/<table:(?:covered-)?table-cell\b[^>]*>/g))).toBe(columns);
  }
  const back = await workbookFromFile(bytes, 'tracker.ods');
  const sheet = back.sheets[0];
  expect(sheet.validations.map((v) => v.range)).toEqual([{ r1: 1, c1: 1, r2: 3, c2: 1 }]);
  check(sheet);
});
