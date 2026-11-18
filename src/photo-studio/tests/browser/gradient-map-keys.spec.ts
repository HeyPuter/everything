import { test, expect } from '@playwright/test';
import { boot, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('deleting a Gradient Map stop from the keyboard keeps the focus on the stops', async ({
  page,
}) => {
  await openImage(page, 120, 80, '#808080');
  await start(page, 'adjust.gradient-map');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  // Add a stop in the middle of the lane.
  const lane = (await dialog.locator('.adj-stop-lane').boundingBox())!;
  await page.mouse.click(lane.x + lane.width / 2, lane.y + lane.height / 2);
  await expect(dialog.locator('.adj-stop')).toHaveCount(3);
  await dialog.locator('.adj-stop[data-i="1"]').focus();
  await page.keyboard.press('Delete');
  await expect(dialog.locator('.adj-stop')).toHaveCount(2);
  await expect(dialog.locator('.adj-stop.sel')).toBeFocused();
  // The arrows keep working on the focused stop.
  await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('.adj-stop.sel')).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
