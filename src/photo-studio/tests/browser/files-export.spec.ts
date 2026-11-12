// Export As: color conversion for formats without profiles.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

test('formats that cannot carry the profile are always converted to sRGB', async ({ page }) => {
  await boot(page);
  await openImage(page, 60, 40, '#c04030');
  await page.evaluate(async () => {
    const { encodeIccProfile } = await import('/src/model/psd-resources.ts');
    const { serializeIcc } = await import('/src/color/icc-write.ts');
    const { builtinProfile } = await import('/src/color/builtin-profiles.ts');
    const icc = encodeIccProfile(serializeIcc(builtinProfile('compatible-rgb-1998')));
    window.photoStudio.command('Assign Profile', (d) => void (d.iccProfile = icc));
    localStorage.setItem('photo-studio-export', JSON.stringify({ format: 'png', convertSrgb: false }));
  });
  await idle(page);
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  const convert = dialog.locator('input[name="convertSrgb"]');
  const label = dialog.locator('label.export-check:has(input[name="convertSrgb"])');
  await expect(convert).not.toBeChecked();
  await expect(convert).toBeEnabled();
  for (const format of ['webp', 'gif', 'bmp']) {
    await dialog.locator('select[name="format"]').selectOption(format);
    await expect(convert).toBeChecked();
    await expect(convert).toBeDisabled();
    await expect(label).toHaveText('Convert to sRGB (required for this format)');
  }
  // The choice made for formats that embed the profile is kept.
  await dialog.locator('select[name="format"]').selectOption('tiff');
  await expect(convert).not.toBeChecked();
  await expect(convert).toBeEnabled();
  await expect(label).toHaveText('Convert to sRGB');
});

