import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// The .ods writer gives the empty rows of a validation rule one row element, repeated. A row of the
// run with a height or hidden state of its own lost it: the repeat carried the first row's (none), so
// LibreOffice showed the hidden row and every program, this one included, lost the height. A merged
// block ending inside the run was likewise repeated over the rows past it.

const save = async (setup) => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Task');
  wb.addValidation(id, { type: 'list', range: { r1: 1, c1: 1, r2: 5, c2: 1 }, source: 'Open,Done', strict: true });
  setup(wb, id);
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  // One entry per sheet row: the row element's attributes, repeated as often as it says.
  const rows = [...content.matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)]
    .flatMap(([, attrs, body]) => Array(Number(/number-rows-repeated="(\d+)"/.exec(attrs)?.[1] || 1)).fill({ attrs, body }));
  return { rows, back: await workbookFromFile(bytes, 'tasks.ods') };
};

it('keeps a hidden row inside the rule hidden, and only that row', async () => {
  const { rows, back } = await save((wb, id) => wb.setHidden(id, 'row', [3], true));
  expect(rows.map(({ attrs }) => /visibility="collapse"/.test(attrs))).toEqual([false, false, false, true, false, false]);
  expect([...back.sheets[0].hiddenRows]).toEqual([3]);
  expect(back.sheets[0].validations.map((v) => v.range)).toEqual([{ r1: 1, c1: 1, r2: 5, c2: 1 }]);
});

it('keeps the height of a row inside the rule', async () => {
  const { back } = await save((wb, id) => wb.setRowHeight(id, 2, 60));
  const sheet = back.sheets[0];
  expect(sheet.rowHeights.get(2)).toBe(60);
  expect([1, 3, 4, 5].map((r) => sheet.rowHeights.get(r))).toEqual([undefined, undefined, undefined, undefined]);
});

it('covers only the rows of a merged block that ends inside the rule', async () => {
  const { rows, back } = await save((wb, id) => wb.mergeCells(id, { r1: 0, c1: 0, r2: 3, c2: 0 }));
  expect(rows.map(({ body }) => body.trimStart().startsWith('<table:covered-table-cell'))).toEqual([false, true, true, true, false, false]);
  expect(back.sheets[0].merges).toEqual([{ r1: 0, c1: 0, r2: 3, c2: 0 }]);
});
