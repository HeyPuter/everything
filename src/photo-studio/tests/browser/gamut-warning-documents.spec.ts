import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

const overlayHref = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => document.querySelector('image.gamut-warning-overlay')?.getAttribute('href') ?? null,
  );

test('the gamut warning never shows another document’s overlay', async ({ page }) => {
  // Saturated blue is outside the press gamut; mid gray is inside.
  await openImage(page, 40, 30, '#0000ff', 'blue.png');
  await page.evaluate(() => window.photoStudio.runCommand('view.gamut-warning'));
  await expect.poll(() => overlayHref(page), { timeout: 30_000 }).not.toBeNull();
  const blue = await overlayHref(page);
  await openImage(page, 40, 30, '#808080', 'gray.png');
  // Turning the warning on for the gray document shows nothing until its own
  // overlay is ready, then that overlay.
  const shown = await page.evaluate(async () => {
    await window.photoStudio.runCommand('view.gamut-warning');
    return document.querySelector('image.gamut-warning-overlay')?.getAttribute('href') ?? null;
  });
  expect(shown).not.toBe(blue);
  await expect.poll(() => overlayHref(page), { timeout: 30_000 }).not.toBeNull();
  expect(await overlayHref(page)).not.toBe(blue);
});
