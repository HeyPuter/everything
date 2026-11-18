import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, openImage, start } from './helpers';

// Dialogs that preview a computed result on the canvas (Shadows/Highlights,
// HDR Toning, Match Color, Apply Image, …) free the pixels of each preview
// they replace and of the last one when they close.
const tiles = (page: Page) => page.evaluate(() => window.photoStudio.assets.tiles.size);
const shown = (page: Page) =>
  page.evaluate(() => JSON.stringify(window.photoStudio.shownDoc.layers[0].pixels?.tiles));

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Shadows/Highlights previews free their pixels when replaced and closed', async ({ page }) => {
  await openImage(page, 600, 400, '#406080');
  const initial = await tiles(page);
  const dialog = page.locator('dialog.adj-dialog[open]');
  const preview = async (value: string) => {
    const before = await shown(page);
    await dialog
      .locator('input[type=range]')
      .first()
      .evaluate((el: HTMLInputElement, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    await expect.poll(() => shown(page)).not.toBe(before);
  };
  await start(page, 'adjust.shadows-highlights');
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => shown(page))
    .not.toBe(
      JSON.stringify(await page.evaluate(() => window.photoStudio.doc.layers[0].pixels?.tiles)),
    );
  for (const v of ['10', '60', '90']) await preview(v);
  // Only the preview on the canvas keeps its tiles (six for 600 x 400).
  await expect.poll(() => tiles(page)).toBe(initial + 6);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await idle(page);
  await expect.poll(() => tiles(page)).toBe(initial);
  expect(await historyLabels(page)).toEqual([]);
  // OK applies its own result; the preview's pixels still go.
  await start(page, 'adjust.shadows-highlights');
  await expect(dialog).toBeVisible();
  await preview('70');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Shadows/Highlights']);
  await expect.poll(() => tiles(page)).toBe(initial + 6);
});
