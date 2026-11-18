// Adjustment dialogs rebuild their controls after some choices (Curves'
// Pencil, the Auto buttons); the keyboard focus stays on the control used.
import { expect, test } from '@playwright/test';
import { boot, openImage, start } from './helpers';

test('Curves Pencil and Levels Auto keep the keyboard focus', async ({ page }) => {
  await boot(page);
  await openImage(page, 40, 30, '#806040');
  await start(page, 'adjust.curves');
  let dialog = page.getByRole('dialog', { name: 'Curves' });
  const pencil = dialog.getByRole('button', { name: 'Draw the curve freehand' });
  await pencil.focus();
  await page.keyboard.press('Enter');
  await expect(pencil).toHaveAttribute('aria-pressed', 'true');
  await expect(pencil).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await start(page, 'adjust.levels');
  dialog = page.getByRole('dialog', { name: 'Levels' });
  const auto = dialog.getByRole('button', { name: 'Automatic per-channel levels' });
  await auto.focus();
  await page.keyboard.press('Enter');
  await expect(auto).toBeFocused();
});
