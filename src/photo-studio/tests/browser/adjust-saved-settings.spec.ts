import { test, expect } from '@playwright/test';
import { boot, idle, openImage, panel, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    localStorage.removeItem('photo-studio-adjust-presets');
    localStorage.removeItem('photo-studio-adjust-last');
  });
});

const field = (scope: import('@playwright/test').Locator, label: string) =>
  scope.getByRole('spinbutton', { name: `${label} value` });

test('adjustment dialogs save, recall and delete named settings and offer the last used ones', async ({
  page,
}) => {
  await openImage(page, 60, 40, '#808080');
  await start(page, 'adjust.posterize');
  let dialog = page.locator('dialog.adj-dialog[open]');
  const saved = dialog.getByRole('group', { name: 'Saved settings' });
  await expect(saved.getByRole('combobox')).toBeDisabled();
  await field(dialog, 'Levels').fill('7');
  await field(dialog, 'Levels').press('Tab');
  // Name and save: Enter in the name field saves without closing the dialog.
  await saved.getByRole('button', { name: 'Save these settings' }).click();
  await saved.getByRole('textbox', { name: 'Name for these settings' }).fill('Seven');
  await saved.getByRole('textbox', { name: 'Name for these settings' }).press('Enter');
  await expect(dialog).toBeVisible();
  await expect(saved.getByRole('combobox')).toHaveValue('user:Seven');
  // Change, then recall the saved settings.
  await field(dialog, 'Levels').fill('3');
  await field(dialog, 'Levels').press('Tab');
  await saved.getByRole('combobox').selectOption('user:Seven');
  await expect(field(dialog, 'Levels')).toHaveValue('7');
  await field(dialog, 'Levels').fill('5');
  await field(dialog, 'Levels').press('Tab');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);

  // Next time: Last Used recalls what OK applied.
  await start(page, 'adjust.posterize');
  dialog = page.locator('dialog.adj-dialog[open]');
  await expect(field(dialog, 'Levels')).toHaveValue('4');
  await dialog
    .getByRole('group', { name: 'Saved settings' })
    .getByRole('combobox')
    .selectOption('last');
  await expect(field(dialog, 'Levels')).toHaveValue('5');
  // Deleting removes the saved entry.
  const s2 = dialog.getByRole('group', { name: 'Saved settings' });
  await s2.getByRole('combobox').selectOption('user:Seven');
  await s2.getByRole('button', { name: 'Delete saved settings' }).click();
  await expect(s2.getByRole('option', { name: 'Seven' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('holding Alt turns Cancel into Reset and restores the starting settings', async ({ page }) => {
  await openImage(page, 60, 40, '#808080');
  await start(page, 'adjust.brightness-contrast');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await field(dialog, 'Brightness').fill('40');
  await field(dialog, 'Brightness').press('Tab');
  await page.keyboard.down('Alt');
  await expect(dialog.getByRole('button', { name: 'Reset' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await page.keyboard.up('Alt');
  await expect(field(dialog, 'Brightness')).toHaveValue('0');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('adjustment layer Properties offer saved settings too', async ({ page }) => {
  await openImage(page, 60, 40, '#808080');
  await page.evaluate(() =>
    localStorage.setItem(
      'photo-studio-adjust-presets',
      JSON.stringify({ exposure: [{ name: 'Brighter', params: { exposure: 1.5 } }] }),
    ),
  );
  await page.evaluate(async () => {
    const m = await import('/src/features/adjust/user-presets.ts');
    m.resetPresetCache();
  });
  await run(page, 'layer.adj-exposure');
  const props = await panel(page, 'Properties');
  const saved = props.getByRole('group', { name: 'Saved settings' });
  await saved.getByRole('combobox').selectOption('user:Brighter');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.photoStudio.layer?.adjustment?.params as { exposure: number }).exposure,
      ),
    )
    .toBe(1.5);
  await expect(field(props, 'Exposure')).toHaveValue('1.5');
});
