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

test('Reset Picture & Size keeps a picture in a table cell within the cell', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 2 rows' }).click();
  const available = await cellWidth(page);
  const wide = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 900, height: 600 }), g = canvas.getContext('2d');
    g.fillStyle = '#2F6DB5'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#E8833A'; g.fillRect(100, 100, 400, 300);
    return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer())];
  });
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(wide) });
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  // Made smaller first, so that resetting it changes it.
  await onTab(page, 'picture');
  const ribbon = page.locator('#ribbon-panel-picture');
  await ribbon.getByRole('spinbutton', { name: /width \(in\)$/ }).fill('0.5');
  await ribbon.getByRole('spinbutton', { name: /width \(in\)$/ }).press('Enter');
  await expect.poll(async () => (await drawings(page))[0]).toBe(48);
  await ribbon.getByRole('button', { name: 'Reset Picture', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reset Picture & Size' }).click();
  await expect.poll(async () => (await drawings(page))[0]).not.toBe(48);
  const [width] = await drawings(page);
  expect(width).toBeLessThanOrEqual(Math.ceil(available));
  expect(width).toBeGreaterThan(available * 0.9);
  expect(errors).toEqual([]);
});

test('an icon inserted in a narrow table cell fits the cell', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '8 columns, 1 row' }).click();
  const available = await cellWidth(page);
  expect(available).toBeLessThan(96);
  await toCell(page, 0);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Icons', exact: true }).click();
  const icons = page.getByRole('dialog', { name: 'Icons' });
  await icons.locator('.insert-icon').first().click();
  await icons.getByRole('button', { name: /^Insert/ }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const [width] = await drawings(page);
  expect(width).toBeLessThanOrEqual(Math.ceil(available));
  // Outside tables an icon is an inch square.
  await page.keyboard.press('ControlOrMeta+End');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Icons', exact: true }).click();
  await icons.locator('.insert-icon').first().click();
  await icons.getByRole('button', { name: /^Insert/ }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(2);
  expect((await drawings(page))[1]).toBe(96);
  expect(errors).toEqual([]);
});

test('a signature line inserted in a narrow table cell fits the cell', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 1 row' }).click();
  const available = await cellWidth(page);
  await toCell(page, 0);
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Signature Line', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Signature Line' });
  await dialog.getByRole('textbox', { name: 'Suggested signer', exact: true }).fill('Ada Lovelace');
  await dialog.getByRole('button', { name: 'OK' }).or(dialog.getByRole('button', { name: 'Insert' })).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  expect((await drawings(page))[0]).toBeLessThanOrEqual(Math.ceil(available));
  expect(errors).toEqual([]);
});
