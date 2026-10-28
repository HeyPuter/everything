import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// The Sort dialog offers every column of the table, also when its first row is a title merged across it.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const texts = page => page.evaluate(() => { const m = window.__docs.current.view.engine.model; return m.tables[0].rows.map(r => r.cells.map(c => m.paragraphs.filter(p => p.cellId === c.id).map(p => p.runs.map(x => x.text).join('')).join('/'))); });

test('Sort offers each column under a merged title row and sorts by the one chosen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 4 rows' }).click();
  for (const [i, value] of ['Stock', '', '', 'Item', 'Shelf', 'Count', 'Pens', 'B', '7', 'Ink', 'A', '30'].entries()) { if (i) await input(page).press('Tab'); if (value) await page.keyboard.type(value); }
  // Merge the title row across the table.
  await page.evaluate(() => { const e = window.__docs.current.view.engine, t = e.model.tables[0]; e.model.setCellBlock({ tableId: t.id, top: 0, bottom: 0, left: 0, right: 3 }); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await onTab(page, 'tableLayout');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Merge Cells', exact: true }).click();
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.selectCell(e.model.tables[0].rows[2].cells[0].id); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  // Rows 2 and 3 only: select them, then Sort by the shelf column.
  await page.evaluate(() => { const e = window.__docs.current.view.engine, t = e.model.tables[0]; e.model.setCellBlock({ tableId: t.id, top: 2, bottom: 3, left: 0, right: 3 }); e.syncInput(); e.paint(); e.onSelection(); e.focus(); });
  await page.locator('.ribbon-card').getByRole('button', { name: 'Sort', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sort' });
  const by = dialog.getByRole('combobox', { name: 'Sort by column' });
  await expect(by.locator('option')).toHaveText(['Column 1', 'Column 2', 'Column 3']);
  await dialog.getByRole('radio', { name: 'A header row' }).check();
  await expect(by.locator('option')).toHaveText(['Item', 'Shelf', 'Count']);
  await dialog.getByRole('radio', { name: 'No header row' }).check();
  await by.selectOption({ label: 'Column 2' });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await texts(page)).toEqual([['Stock'], ['Item', 'Shelf', 'Count'], ['Ink', 'A', '30'], ['Pens', 'B', '7']]);
});
