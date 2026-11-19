import { test, expect, type Page } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, tool } from './helpers';

// Spring-loaded tool keys and Reset Tool / Reset All Tools.

const active = (page: Page) => page.evaluate(() => window.photoStudio.tool);

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080');
  await tool(page, 'Move Tool');
  await page.locator('#viewport').focus();
});

test('a quick tap switches tools for good', async ({ page }) => {
  await page.keyboard.press('b');
  expect(await active(page)).toBe('brush');
});

test('holding a tool key returns to the previous tool on release', async ({ page }) => {
  await page.keyboard.down('b');
  expect(await active(page)).toBe('brush');
  await page.waitForTimeout(450);
  await page.keyboard.up('b');
  await expect.poll(() => active(page)).toBe('move');
});

test('using the tool while its key is held returns after the stroke', async ({ page }) => {
  await page.keyboard.down('b');
  await canvasDrag(page, [
    [40, 40],
    [120, 80],
  ]);
  await page.keyboard.up('b');
  await idle(page);
  await expect.poll(() => active(page)).toBe('move');
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toMatch(/Brush/);
});

test('Reset Tool returns the options of the current tool only', async ({ page }) => {
  await tool(page, 'Brush Tool');
  await page.locator('#brush-size').fill('77');
  await page.locator('#brush-size').press('Enter');
  await tool(page, 'Eraser Tool');
  await page.locator('#brush-size').fill('55');
  await page.locator('#brush-size').press('Enter');
  await tool(page, 'Brush Tool');
  await expect(page.locator('#brush-size')).toHaveValue('77');
  // Right-click the tool icon at the left of the options bar.
  await page.locator('#tool-icon').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset Tool' }).click();
  await expect(page.locator('#brush-size')).toHaveValue('30');
  await tool(page, 'Eraser Tool');
  await expect(page.locator('#brush-size')).toHaveValue('55');
});

test('Reset Tool in the preset picker resets shared selection options', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  await page.locator('#sel-feather').fill('12');
  await page.locator('#sel-feather').press('Enter');
  await page.locator('#marquee-style').selectOption('size');
  await page.locator('#tool-icon').click();
  await page.getByRole('button', { name: 'Reset Tool' }).click();
  await expect(page.locator('#sel-feather')).toHaveValue('0');
  await expect(page.locator('#marquee-style')).toHaveValue('normal');
  await expect(page.locator('#marquee-w')).toBeDisabled();
});

test('Reset All Tools asks first, then resets every tool', async ({ page }) => {
  await tool(page, 'Brush Tool');
  await page.locator('#brush-size').fill('90');
  await page.locator('#brush-size').press('Enter');
  await tool(page, 'Magic Wand Tool');
  await page.locator('#tolerance').fill('5');
  await page.locator('#tolerance').press('Enter');
  await page.evaluate(() => void window.photoStudio.runCommand('tool.reset-all'));
  const dialog = page.getByRole('dialog', { name: 'Reset All Tools' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('#tolerance')).toHaveValue('32');
  await tool(page, 'Brush Tool');
  await expect(page.locator('#brush-size')).toHaveValue('30');
});
