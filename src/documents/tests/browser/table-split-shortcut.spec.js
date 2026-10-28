import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Ctrl+Shift+Enter (Cmd+Shift+Return on a Mac) in a table splits it above the caret's row, as Split
// Table does; in the first row it opens a paragraph before the table. A column break in a cell would
// show nothing (breaks in cells do not advance), so the keys would seem to do nothing.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const shape = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model;
  return { tables: m.tables.map(t => t.rows.map(r => r.cells.map(c => m.paragraphs.filter(p => p.cellId === c.id).map(p => p.runs.map(x => x.text).join('')).join('/')))),
    body: m.paragraphs.filter(p => !p.cellId).map(p => p.runs.map(x => x.text).join('')), inCell: !!m.tableContext };
});
async function table(page) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 3 rows' }).click();
  for (const [i, value] of ['a0', 'a1', 'b0', 'b1', 'c0', 'c1'].entries()) { if (i) await input(page).press('Tab'); await page.keyboard.type(value); }
}
const goToCell = (page, r, c) => page.evaluate(([r, c]) => {
  const e = window.__docs.current.view.engine;
  e.model.selectCell(e.model.tables[0].rows[r].cells[c].id); e.syncInput(); e.paint(); e.onSelection(); e.focus();
}, [r, c]);

test('Ctrl+Shift+Enter splits a table, or opens a paragraph above it from the first row', async ({ page }) => {
  await table(page);
  await goToCell(page, 1, 1);
  await input(page).press('ControlOrMeta+Shift+Enter');
  expect(await shape(page)).toEqual({ tables: [[['A0', 'A1']], [['B0', 'B1'], ['C0', 'C1']]], body: ['', ''], inCell: false });
  // The caret waits in the paragraph between the two tables.
  await page.keyboard.type('Between');
  expect((await shape(page)).body).toEqual(['Between', '']);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  expect((await shape(page)).tables).toEqual([[['A0', 'A1'], ['B0', 'B1'], ['C0', 'C1']]]);

  // In the first row of a table at the top of the document: a paragraph opens before the table.
  await goToCell(page, 0, 0);
  await input(page).press('ControlOrMeta+Shift+Enter');
  await page.keyboard.type('Title');
  expect(await shape(page)).toEqual({ tables: [[['A0', 'A1'], ['B0', 'B1'], ['C0', 'C1']]], body: ['Title', ''], inCell: false });
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].cellId || null)).toBe(null);
});
