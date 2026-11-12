import { expect, test } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, tool } from './helpers';

// Live shape fields in the Properties panel.
test('a corner radius larger than the rectangle allows is shown as the radius drawn', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Rectangle Tool');
  await canvasDrag(page, [[220, 30], [380, 120]]);
  const radius = page.locator('.vec-props [data-vec="radius"]');
  await radius.fill('500');
  await radius.press('Enter');
  await idle(page);
  const radii = () => page.evaluate(() => (window.photoStudio.layer!.vector!.live as { radii: number[] }).radii);
  // 160 × 90: a stadium, corners of 45.
  expect(await radii()).toEqual([45, 45, 45, 45]);
  await expect(page.locator('.vec-props [data-vec="radius"]')).toHaveValue('45');
  await page.keyboard.press('Meta+z');
  await idle(page);
  expect(await radii()).toEqual([0, 0, 0, 0]);
});
