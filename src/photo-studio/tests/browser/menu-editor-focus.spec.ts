// Customize Menus rebuilds its contents on every choice; the keyboard focus
// stays on the menu tab or button used.
import { expect, test } from '@playwright/test';
import { boot, start } from './helpers';

test('menu tabs and Restore Defaults keep the keyboard focus', async ({ page }) => {
  await boot(page);
  await start(page, 'edit.menus');
  const dialog = page.getByRole('dialog', { name: /Menus/ });
  const image = dialog.getByRole('tab', { name: 'Image', exact: true });
  await image.focus();
  await page.keyboard.press('Enter');
  await expect(image).toHaveAttribute('aria-selected', 'true');
  await expect(image).toBeFocused();
  const reset = dialog.getByRole('button', { name: 'Restore Defaults' });
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect(reset).toBeFocused();
});
