import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// With Track Changes on, Cut and Delete on selected cells mark the cells' text as deleted rather than erasing it.
const cells = page => page.evaluate(() => {
  const model = window.__docs.current.view.engine.model;
  return model.tables[0].rows.map(row => row.cells.map(cell => model.paragraphs.filter(p => p.cellId === cell.id)
    .flatMap(p => p.runs.map(r => r.text + (r.revision?.type === 'del' ? '(del)' : ''))).join('')));
});
const cut = page => page.evaluate(() => {
  const data = new DataTransfer();
  document.querySelector('[aria-label="Document text"]').dispatchEvent(new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }));
  return data.getData('text/plain');
});
const selectColumn = (page, column) => page.evaluate(column => {
  const engine = window.__docs.current.view.engine, table = engine.model.tables[0];
  engine.model.setCellBlock({ tableId: table.id, top: 0, bottom: 3, left: column, right: column + 1 });
  engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus();
}, column);

test('Cut and Delete on selected cells are tracked with Track Changes on', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 3 rows' }).click();
  for (const [i, value] of ['1', '2', '3', '4', '5', '6', '7', '8', '9'].entries()) { if (i) await input.press('Tab'); await page.keyboard.type(value); }
  const track = (await onTab(page, 'review')).getByRole('button', { name: 'Track Changes', exact: true });
  await track.click();
  await expect(track).toHaveAttribute('aria-pressed', 'true');

  await selectColumn(page, 1);
  expect(await cut(page)).toBe('2\n5\n8');
  expect(await cells(page)).toEqual([['1', '2(del)', '3'], ['4', '5(del)', '6'], ['7', '8(del)', '9']]);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await cells(page)).toEqual([['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']]);

  await selectColumn(page, 2);
  await input.press('Delete');
  expect(await cells(page)).toEqual([['1', '2', '3(del)'], ['4', '5', '6(del)'], ['7', '8', '9(del)']]);
  expect(errors).toEqual([]);
});

test('with Track Changes on, deleting rows explains it cannot be tracked and leaves the table', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 2 rows' }).click();
  for (const [i, value] of ['1', '2', '3', '4'].entries()) { if (i) await input.press('Tab'); await page.keyboard.type(value); }
  const track = (await onTab(page, 'review')).getByRole('button', { name: 'Track Changes', exact: true });
  await track.click();
  await expect(track).toHaveAttribute('aria-pressed', 'true');
  await onTab(page, 'tableLayout');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete Rows' }).click();
  await expect(page.getByText(/Deleting table rows cannot be tracked yet\. Turn off Track Changes/)).toBeVisible();
  expect(await cells(page)).toEqual([['1', '2'], ['3', '4']]);
  // Track Changes off: it deletes.
  await (await onTab(page, 'review')).getByRole('button', { name: 'Track Changes', exact: true }).click();
  await onTab(page, 'tableLayout');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete Rows' }).click();
  await expect.poll(() => cells(page)).toEqual([['1', '2']]);
  expect(errors).toEqual([]);
});
