import { expect, test } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, panel, run, tool } from './helpers';

// The Paths panel: saving, renaming, new paths and their names.
test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
});
const names = (page: import('@playwright/test').Page) => page.evaluate(() => (window.photoStudio.doc.paths ?? []).map((p) => p.name));

test('double-clicking a path renames it, and new paths never repeat a name', async ({ page }) => {
  await tool(page, 'Rectangle Tool');
  await page.selectOption('#vec-mode', 'path');
  await canvasDrag(page, [[50, 50], [200, 200]]);
  const body = await panel(page, 'Paths');
  const rows = body.locator('[data-path-key]');
  // Double-clicking the work path saves it.
  await rows.first().dblclick();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await names(page)).toEqual(['Path 1']);
  // Double-clicking a saved path renames it.
  await rows.first().dblclick();
  await expect(dialog).toHaveCount(1);
  await dialog.locator('input').first().fill('Outline');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await names(page)).toEqual(['Outline']);
  await run(page, 'path.new');
  await run(page, 'path.new');
  expect(await names(page)).toEqual(['Outline', 'Path 2', 'Path 3']);
  // With "Path 2" deleted, the next new path is not a second "Path 3".
  await rows.nth(1).click();
  await run(page, 'path.delete');
  await run(page, 'path.new');
  expect(await names(page)).toEqual(['Outline', 'Path 3', 'Path 4']);
});
