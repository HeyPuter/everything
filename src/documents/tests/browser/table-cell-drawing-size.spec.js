import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A chart or diagram inserted in a table cell is made to fit the cell, as a picture is.
const drawings = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => Math.round(r.image.width / 9525))));
const cellWidth = page => page.evaluate(() => {
  const engine = window.__docs.current.view.engine, cell = engine.model.tables[0].rows[0].cells[0];
  const box = engine.selectionLayout.cells.find(c => c.id === cell.id);
  return box.width - (cell.margins.left + cell.margins.right) / 15;
});
const toCell = (page, row) => page.evaluate(row => {
  const engine = window.__docs.current.view.engine, table = engine.model.tables[0];
  engine.model.selectCell(table.rows[row].cells[0].id); engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus();
}, row);

test('charts and diagrams inserted in a table cell fit the cell', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 2 rows' }).click();
  const available = await cellWidth(page);

  await toCell(page, 0);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByRole('dialog', { name: 'Insert Chart' }).getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);

  await toCell(page, 1);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Basic Process/ }).click();
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(2);

  const widths = await drawings(page);
  for (const width of widths) {
    expect(width).toBeLessThanOrEqual(Math.ceil(available));
    expect(width).toBeGreaterThan(available * 0.9);
  }
  // Outside the table they take the page's text width as before.
  await page.keyboard.press('ControlOrMeta+End');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByRole('dialog', { name: 'Insert Chart' }).getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(3);
  expect((await drawings(page))[2]).toBe(528);
  expect(errors).toEqual([]);
});

test('a drawing canvas inserted in a table cell fits the cell', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 2 rows' }).click();
  const available = await cellWidth(page);
  await toCell(page, 0);
  await onTab(page, 'draw');
  await page.locator('#ribbon-panel-draw').getByRole('button', { name: 'Drawing Canvas', exact: true }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const [width] = await drawings(page);
  expect(width).toBeLessThanOrEqual(Math.ceil(available));
  expect(width).toBeGreaterThan(available * 0.9);
  expect(errors).toEqual([]);
});
