// Accessibility of the workspace chrome: dialog names, menu keyboard use,
// focus handling and small-screen layout.
import { test, expect } from '@playwright/test';
import { boot, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'a11y.png');
});

test('every dialog is announced by its title', async ({ page }) => {
  // The shared question dialog, reused for one question after another.
  for (const [id, title] of [['layer.new', 'New Layer'], ['image.duplicate', 'Duplicate Image']]) {
    await start(page, id);
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
  // Dialogs built by features, which only have a heading.
  for (const [id, title] of [['edit.keyboard-shortcuts', 'Keyboard Shortcuts'], ['edit.menus', 'Menus']]) {
    await start(page, id);
    await expect(page.getByRole('dialog', { name: new RegExp(title) })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
});
