import { expect, test } from '@playwright/test';
import { boot, canvasDrag, historyLabels, idle, openImage, tool } from './helpers';

// Shape tool number fields: a cleared field keeps the value in use.
test('clearing the stroke width leaves the selected shape stroked', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#ffffff');
  await tool(page, 'Rectangle Tool');
  await canvasDrag(page, [
    [20, 20],
    [160, 140],
  ]);
  const width = page.locator('#vec-stroke-width');
  await width.fill('6');
  await width.press('Enter');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer!.vector!.stroke?.enabled)).toBe(true);
  const labels = await historyLabels(page);
  await page.locator('#vec-stroke-width').fill('');
  await page.locator('#vec-stroke-width').press('Enter');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer!.vector!.stroke?.enabled)).toBe(true);
  expect(await page.locator('#vec-stroke-width').inputValue()).toBe('6');
  expect(await historyLabels(page)).toEqual(labels);
  // Tool settings too: a cleared side count stays as it was.
  await tool(page, 'Polygon Tool');
  const sides = page.locator('#vec-sides');
  await sides.fill('7');
  await sides.press('Enter');
  await page.locator('#vec-sides').fill('');
  await page.locator('#vec-sides').press('Enter');
  await expect(page.locator('#vec-sides')).toHaveValue('7');
});
