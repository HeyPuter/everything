import { expect, test } from '@playwright/test';
import { boot, openImage, tool } from './helpers';

// The font picker in the type tool's options bar.
test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
});

const family = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => (await import('/src/features/type/session.ts')).typeDefaults(window.photoStudio).style.family);

test('a font can be chosen again after the picker was used once', async ({ page }) => {
  const pick = async (name: string) => {
    await page.locator('#type-family').click();
    await page.locator(`.type-font-picker [data-family="${name}"]`).click();
    await expect(page.locator('.type-font-picker')).toHaveCount(0);
  };
  await pick('Crimson Pro');
  expect(await family(page)).toBe('Crimson Pro');
  await pick('Caveat');
  expect(await family(page)).toBe('Caveat');
  // Closing with Escape also leaves the next picker working.
  await page.locator('#type-family').click();
  await page.locator('.type-font-search').press('Escape');
  await pick('Inter');
  expect(await family(page)).toBe('Inter');
});
