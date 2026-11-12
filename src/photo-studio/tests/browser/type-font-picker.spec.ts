import { expect, test } from '@playwright/test';
import { boot, canvasClick, openImage, tool } from './helpers';

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

test('the font list works from the keyboard and Escape leaves the text being edited', async ({ page }) => {
  await canvasClick(page, 100, 100);
  await page.keyboard.type('ab');
  const editing = () => page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession());
  await page.locator('#type-family').click();
  const options = page.locator('.type-font-picker [data-family]');
  const second = await options.nth(1).getAttribute('data-family');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  // Letters do not reach tool shortcuts while the list has focus.
  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('type');
  await page.keyboard.press('Enter');
  await expect(page.locator('.type-font-picker')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.styleContext(window.photoStudio).char.family)).toBe(second);
  await page.locator('#type-family').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.locator('.type-font-picker')).toHaveCount(0);
  expect(await editing()).toBe(true);
});
