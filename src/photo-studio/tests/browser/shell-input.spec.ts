// Workspace chrome driven from the keyboard and touch: context menus, panel
// menus and canvas gestures.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'shell.png');
});

test('context menus work from the keyboard and keep keys away from the canvas', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('move'));
  const viewport = page.locator('#viewport');
  const box = (await viewport.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? document.activeElement?.id);
  const first = await focused();
  const before = await page.evaluate(() => window.photoStudio.doc);
  await page.keyboard.press('ArrowDown');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toBe(first);
  await page.keyboard.press('End');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('Home');
  expect(await focused()).toBe(first);
  // The arrows moved the focus, not the layer (the Move tool nudges with arrows).
  expect(await page.evaluate((doc) => JSON.stringify(window.photoStudio.doc.layers) === JSON.stringify(doc.layers), before)).toBe(true);
  // Escape closes the menu and gives the focus back to the canvas.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('viewport');
  // Enter runs the focused command (Select → All, the first item without a selection).
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-command'))).toBe('select.all');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 0, y: 0, width: 240, height: 160 });
});

test('a panel menu opened from the keyboard can be navigated and used', async ({ page }) => {
  const button = page.locator('[data-panel-menu]').first();
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  const items = menu.locator(':scope > .menu-item');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});
