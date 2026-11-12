import { test, expect } from '@playwright/test';
import { boot, historyLabels, idle, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 80, '#808080');
});

test('Layer Style and Global Light accept typed values between steps', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.command('Unlock', (d) => Object.assign(d.layers[0], { name: 'Layer 0', background: false, locked: undefined })));
  await start(page, 'layer.style-drop-shadow');
  const style = page.locator('dialog.layer-style-dialog[open]');
  await expect(style).toBeVisible();
  const opacity = style.getByRole('spinbutton', { name: 'Opacity value' });
  await opacity.fill('62.5');
  await opacity.press('Tab');
  await style.locator('[data-ok]').click();
  await expect(page.locator('dialog.layer-style-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].style?.dropShadow?.[0]?.opacity)).toBeCloseTo(0.625, 5);

  await start(page, 'layer.global-light');
  const light = page.locator('dialog.global-light-dialog[open]');
  await expect(light).toBeVisible();
  const altitude = light.getByRole('spinbutton', { name: 'Altitude value' });
  await altitude.fill('40.5');
  await altitude.press('Tab');
  await light.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('dialog.global-light-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Global Light');
});
