// Reset to Defaults in the shortcut editor shows the default shortcuts; OK
// applies them and Cancel keeps the custom ones.
import { expect, test } from '@playwright/test';
import { boot, start } from './helpers';

test('Reset to Defaults takes effect on OK and is undone by Cancel', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'photo-studio-shortcuts',
        JSON.stringify({ 'edit.undo': 'Alt+Shift+U' }),
      );
    }
  });
  await boot(page);
  const shortcut = () =>
    page.evaluate(async () => {
      const { commands } = await import('/src/app/registry.ts');
      return commands.get('edit.undo')!.shortcut;
    });
  expect(await shortcut()).toBe('Alt+Shift+U');
  const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  const field = dialog.locator('[data-shortcut="edit.undo"]');
  await start(page, 'edit.keyboard-shortcuts');
  await expect(field).toHaveValue('Alt+Shift+U');
  await dialog.getByRole('button', { name: 'Reset to Defaults' }).click();
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue('Mod+Z');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await shortcut()).toBe('Alt+Shift+U');

  await start(page, 'edit.keyboard-shortcuts');
  await dialog.getByRole('button', { name: 'Reset to Defaults' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await shortcut()).toBe('Mod+Z');
});
