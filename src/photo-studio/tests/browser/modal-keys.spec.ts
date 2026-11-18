// While a modal dialog is open, keys that reach the page instead of the dialog
// (its focused control went away, or Tab left its last control) do not run
// workspace shortcuts behind it, and Tab goes back into the dialog.
import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

test('workspace shortcuts wait while a modal dialog is open', async ({ page }) => {
  await boot(page);
  await openImage(page, 40, 30, '#808080');
  await run(page, 'adjust.invert');
  await page.locator('#viewport').focus();
  await page.keyboard.press('ControlOrMeta+w');
  const dialog = page.getByRole('dialog', { name: /^Save changes to/ });
  await expect(dialog).toBeVisible();
  const state = () =>
    page.evaluate(() => ({
      tool: window.photoStudio.tool,
      hidden: window.photoStudio.root.classList.contains('panels-hidden'),
      history: window.photoStudio.history.labels,
    }));
  const before = await state();
  // The focus leaves the dialog's buttons.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('b');
  await page.keyboard.press('ControlOrMeta+z');
  // Tab passes the end of the page and comes back to the dialog's first button.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await state()).toEqual(before);
  await expect(dialog.getByRole('button', { name: 'Don’t Save' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('b');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('brush');
});
