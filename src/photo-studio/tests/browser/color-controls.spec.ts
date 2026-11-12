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

test('a changed Color Table entry announces its new color', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setForeground('#3366cc'));
  await page.evaluate(() => void window.photoStudio.runCommand('image.mode-indexed'));
  await page.locator('#dialog button[type=submit]').click();
  await page.waitForFunction(() => window.photoStudio.doc.mode === 'indexed' && !window.photoStudio.busy);
  const palette = await page.evaluate(() => window.photoStudio.doc.modeData!.palette!);
  await page.evaluate(() => void window.photoStudio.runCommand('image.color-table'));
  const entry = page.locator('.color-table-dialog .ct-swatch').first();
  await expect(entry).toHaveAccessibleName(`Palette entry 0 ${palette[0]}`);
  await entry.click();
  await page.locator('.color-picker-dialog [data-f=hex]').fill('ff0000');
  await page.keyboard.press('Enter');
  await expect(page.locator('.color-picker-dialog')).toHaveCount(0);
  await expect(entry).toHaveAccessibleName('Palette entry 0 #ff0000');
  await page.locator('.color-table-dialog button[type=submit]').click();
  await page.waitForFunction(() => window.photoStudio.doc.modeData?.palette?.[0] === '#ff0000');
});

test('changing the Duotone type keeps the keyboard focus on the Type field', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.runCommand('image.mode-grayscale'));
  await page.waitForFunction(() => window.photoStudio.doc.mode === 'grayscale' && !window.photoStudio.busy);
  await page.evaluate(() => void window.photoStudio.runCommand('image.mode-duotone'));
  const type = page.locator('.duotone-dialog .duo-type');
  await type.focus();
  await type.selectOption('3');
  await expect(page.locator('.duotone-dialog .duo-ink')).toHaveCount(3);
  // The dialog redraws its inks; focus used to fall back to the page.
  await expect(page.locator('.duotone-dialog .duo-type')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.duotone-dialog')).toHaveCount(0);
});

test('double-clicking a channel opens Channel Options and renames it', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.runCommand('window.panel.channels'));
  await page.evaluate(() => window.photoStudio.runCommand('channel.new'));
  const row = page.locator('[data-panel="channels"] .channel-row', { hasText: 'Alpha 1' });
  // The first click selects (and redraws the panel); the second used to be lost.
  await row.locator('.channel-name').dblclick();
  await expect(page.locator('#dialog[open] input[name=name]')).toHaveValue('Alpha 1');
  await page.locator('#dialog[open] input[name=name]').fill('Sky');
  await page.locator('#dialog[open] button[type=submit]').click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.channels?.map((c) => c.name))).toEqual(['Sky']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.undo'));
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.channels?.map((c) => c.name))).toEqual(['Alpha 1']);
});

test('new channels get a name no other channel has', async ({ page }) => {
  const names = () => page.evaluate(() => window.photoStudio.doc.channels?.map((c) => c.name));
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.runCommand('channel.new');
    await e.runCommand('channel.new');
    e.settings.activeChannel = e.doc.channels![0].id;
    await e.runCommand('channel.delete');
    await e.runCommand('channel.new');
  });
  // Used to be Alpha 2 twice.
  expect(await names()).toEqual(['Alpha 2', 'Alpha 1']);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.runCommand('select.all');
    void e.runCommand('select.save');
  });
  await expect(page.locator('#dialog[open] input[name=name]')).toHaveValue('Alpha 3');
  await page.locator('#dialog[open] #cancel-dialog').click();
});

test('correcting an out-of-gamut or web color from the keyboard keeps the focus in the picker', async ({ page }) => {
  const chip = page.locator('.fg-chip');
  for (const [hex, button] of [['0000ff', '.cp-gamut'], ['123457', '.cp-web']] as const) {
    await chip.focus();
    await page.keyboard.press('Enter');
    const hexField = page.locator('.color-picker-dialog [data-f=hex]');
    await hexField.fill(hex);
    const warning = page.locator(`.color-picker-dialog ${button}`);
    await expect(warning).toBeVisible();
    await warning.focus();
    await page.keyboard.press('Enter');
    await expect(warning).toBeHidden();
    // The pressed button disappears; focus used to fall back to the page.
    await expect(hexField).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.color-picker-dialog')).toHaveCount(0);
    await expect(chip).toBeFocused();
  }
});
