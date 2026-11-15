import { test, expect } from '@playwright/test';
import { boot, start } from './helpers';

test('New Document searches presets across categories and shows the background color', async ({
  page,
}) => {
  await boot(page);
  await start(page, 'file.new');
  const dialog = page.locator('dialog.newdoc-window');
  await expect(dialog).toBeVisible();
  // The contents swatch shows the color of the chosen background.
  await dialog.getByLabel('Background contents').selectOption('white');
  await expect(dialog.getByLabel('Custom background color')).toHaveValue('#ffffff');
  await dialog.getByLabel('Background contents').selectOption('transparent');
  await expect(dialog.getByLabel('Custom background color')).toBeHidden();
  const search = dialog.getByRole('searchbox', { name: 'Search presets' });
  await search.fill('a4');
  await expect(dialog.locator('[data-preset="print-a4"]')).toBeVisible();
  // While searching, no category tab is selected.
  await expect(dialog.locator('[data-cat][aria-selected="true"]')).toHaveCount(0);
  // Sizes match too, written with x or ×.
  await search.fill('1080x1080');
  await expect(dialog.locator('[data-preset="web-post"]')).toBeVisible();
  await search.press('Enter');
  await expect(dialog.getByLabel('Width (px)')).toHaveValue('1080');
  await search.fill('no such preset');
  await expect(dialog.locator('.newdoc-empty')).toContainText('No presets match');
  // Escape clears the search first, then a second Escape closes the window.
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-cat]').first().click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
