// Color panel, color picker and Swatches panel interaction details.
import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 90, '#808080', 'a.png');
});

test('the Color panel keeps its hue and brightness while stepping through grays and black', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setForeground('#0080ff'));
  const hue = () => page.locator('#color-hue').inputValue();
  const plane = page.locator('#color-plane');
  await plane.focus();
  // Down to (almost) no saturation, where 8-bit values no longer pin the hue, and back.
  for (let i = 0; i < 99; i++) await page.keyboard.press('ArrowLeft');
  expect(await hue()).toBe('210');
  for (let i = 0; i < 99; i++) await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#0080ff');
  // Through black and back keeps the saturation.
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowDown');
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#000000');
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowUp');
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#0080ff');
  // A color set elsewhere still moves the controls.
  await page.evaluate(() => window.photoStudio.setForeground('#ff0000'));
  expect(await hue()).toBe('0');
  await expect(page.locator('#color-value')).toHaveValue('#ff0000');
});

test('swatches are buttons that the keyboard can use, set as background and remove', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.runCommand('window.panel.swatches'));
  const grid = page.getByRole('group', { name: 'Swatches' });
  const swatch = (hex: string) => grid.getByRole('button', { name: `Swatch ${hex}`, exact: true });
  await expect(swatch('#4d4d4d')).toHaveCount(1);
  const count = await page.locator('[data-swatch]').count();
  await swatch('#4d4d4d').focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#4d4d4d');
  await swatch('#999999').focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(await page.evaluate(() => window.photoStudio.background)).toBe('#999999');
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#4d4d4d');
  // Delete removes the focused swatch and keeps the focus in the grid.
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-swatch]')).toHaveCount(count - 1);
  await expect(swatch('#999999')).toHaveCount(0);
  await expect(swatch('#bfbfbf')).toBeFocused();
  await page.evaluate(() => window.photoStudio.runCommand('swatches.reset'));
});
