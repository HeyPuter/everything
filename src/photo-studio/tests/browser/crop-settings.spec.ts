import { test, expect } from '@playwright/test';
import { boot, openImage, tool } from './helpers';

// Crop tool settings: the shield over the area that will be cut away.

test('crop settings change the shield over the cropped area', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080');
  await tool(page, 'Crop Tool');
  const shade = page.locator('.crop-shade');
  await expect(shade).toHaveCount(1);
  await page.getByRole('button', { name: 'Crop settings' }).click();
  const pop = page.getByRole('dialog', { name: 'Crop settings' });
  await pop.getByLabel('Shield opacity (%)').fill('80');
  await pop.getByLabel('Shield opacity (%)').press('Tab');
  await expect(shade).toHaveAttribute('style', /opacity:\s*0\.8/);
  await pop.locator('select[data-k="colorMode"]').selectOption('canvas');
  await expect(shade).toHaveAttribute('style', /--canvas/);
  await pop.getByLabel('Enable Crop Shield').uncheck();
  await expect(shade).toHaveCount(0);
  await expect(pop.getByLabel('Shield opacity (%)')).toBeDisabled();
  // Hiding the cropped area covers it completely.
  await pop.getByLabel('Show Cropped Area').uncheck();
  await expect(shade).toHaveAttribute('style', /opacity:\s*1/);
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  // The crop itself is still in progress.
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('crop');
});
