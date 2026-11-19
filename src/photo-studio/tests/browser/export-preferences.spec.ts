import { expect, test } from '@playwright/test';
import { boot, downloadFrom, menu, openImage, run } from './helpers';

// File → Export → Export Preferences… opens the Export page of Preferences,
// whose quick export settings Quick Export then uses.

test.beforeEach(async ({ page }) => {
  await boot(page);
  // Noise compresses differently at different JPEG qualities.
  await openImage(page, 300, 200, '#808080', 'noise.png');
  await run(page, 'filter.apply.add-noise', {
    params: { amount: 40, distribution: 'gaussian', monochromatic: false },
  });
});

test('opens the export settings and quick-exports with them', async ({ page }) => {
  await menu(page, 'File', 'Export', 'Export Preferences…');
  const dialog = page.locator('dialog.prefs-window');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-page="export"]')).toHaveAttribute('aria-current', 'page');
  const quality = dialog.getByLabel('JPEG and WebP quality');
  // The quick export's own settings wait until they are chosen.
  await expect(quality).toBeDisabled();
  await dialog.getByLabel('Quick export settings').selectOption('own');
  await expect(quality).toBeEnabled();
  await dialog.getByLabel('Quick export format').selectOption('jpeg');
  await quality.fill('95');
  await quality.press('Tab');
  await dialog.getByLabel('Metadata').selectOption('none');
  await expect(dialog.getByLabel('Quick export location')).toContainText(
    'In an assets folder beside the document',
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  // The menu item follows the format; the file is a JPEG at the chosen quality.
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await import('/src/app/registry.ts')).commands.get('file.quick-export-png')!.label,
      ),
    )
    .toBe('Quick Export as JPEG');
  const high = await downloadFrom(page, () => run(page, 'file.quick-export-png'));
  expect(high.name).toMatch(/\.jpg$/);
  expect([...high.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.preferences.quickExportQuality = 20;
    e.preferencesChanged();
  });
  const low = await downloadFrom(page, () => run(page, 'file.quick-export-png'));
  expect(low.bytes.length).toBeLessThan(high.bytes.length * 0.7);
});
